// §12.1：所有可點擊元素的觸控區不得小於 48×48 CSS px。
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const ctx = await b.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
await p.goto(process.env.URL || 'http://localhost:4188/?seed=1', { waitUntil: 'networkidle' });
await p.waitForTimeout(300);

async function audit(label) {
  return p.evaluate((tag) => {
    const bad = [];
    let checked = 0;
    // 量的是「實際命中區」而不是視覺方框：按鈕視覺縮小了，命中區靠 ::after 外擴，
    // 所以用 elementFromPoint 測 48x48 的四角才準。
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (el.disabled) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // 被浮動面板／modal 蓋住的按鈕本來就點不到，那是遮擋不是尺寸問題，跳過。
      const centre = document.elementFromPoint(cx, cy);
      if (!(centre === el || el.contains(centre))) continue;
      checked++;
      const corners = [[-23.5, -23.5], [23.5, -23.5], [-23.5, 23.5], [23.5, 23.5]];
      const miss = corners.filter(([dx, dy]) => {
        const hit = document.elementFromPoint(cx + dx, cy + dy);
        return !(hit === el || el.contains(hit));
      });
      if (miss.length) {
        bad.push(`${tag}: <${el.tagName.toLowerCase()}> "${(el.textContent || '').trim().slice(0, 12)}" `
          + `視覺 ${Math.round(r.width)}x${Math.round(r.height)}，48x48 命中測試漏 ${miss.length}/4 角`);
      }
    }
    const doc = document.documentElement;
    return { bad, checked, tag, hScroll: doc.scrollWidth > doc.clientWidth };
  }, label);
}

const results = [];
results.push(await audit('主畫面'));

// 開啟情境選單（點自己）
await p.evaluate(() => {
  const g = window.__game;
  g.selection = { ...g.state.units.find(u => u.faction === 'PLAYER').pos };
  g.updateMenu();
});
await p.waitForTimeout(150);
results.push(await audit('情境選單'));

// 紀錄面板
await p.locator('#actions button[data-act="LOG"]').click();
await p.waitForTimeout(150);
results.push(await audit('紀錄面板'));
await p.locator('#actions button[data-act="LOG"]').click();

// 止損只在「當前士兵陣亡」時出現：製造一次陣亡
await p.evaluate(() => {
  const g = window.__game;
  const me = g.state.units.find((u) => u.faction === 'PLAYER');
  me.hp = 3;
  g.dispatch({ type: 'FIRE', target: { ...me.pos } });
});
await p.waitForTimeout(300);
results.push(await audit('增援選單'));

await p.locator('#modal-root button[data-abort]').click();
await p.waitForTimeout(200);
results.push(await audit('止損確認'));
await p.locator('#modal-root button[data-yes]').click();
await p.waitForTimeout(250);
results.push(await audit('結算畫面'));

for (const r of results) console.log(`   ${r.tag}: 檢查了 ${r.checked} 個可點擊元素`);
const bad = results.flatMap(r => r.bad);
const scroll = results.filter(r => r.hScroll);
console.log(bad.length ? '❌ 觸控區過小:\n  ' + bad.join('\n  ') : '✅ 所有可點擊元素 >= 48x48 CSS px (320px 寬視窗)');
console.log(scroll.length ? '❌ 有水平捲動 ' + JSON.stringify(scroll[0]) : '✅ 沒有水平捲動');
await b.close();
