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
    const boxes = [];
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (el.disabled) continue;
      // 被浮動面板／modal 蓋住的按鈕本來就點不到，那是遮擋不是尺寸問題，跳過。
      const centre = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!(centre === el || el.contains(centre))) continue;

      const name = `<${el.tagName.toLowerCase()}> "${(el.textContent || '').trim().slice(0, 10)}"`;
      // §6.5 之一：命中區 >= 48x48 CSS px
      if (r.width < 48 || r.height < 48) {
        bad.push(`${tag}: ${name} 只有 ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      boxes.push({ name, r });
    }
    // §6.5 之二：相鄰按鈕的命中區不得互相重疊
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r;
        const b = boxes[j].r;
        const overlapW = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapH = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapW > 0.5 && overlapH > 0.5) {
          bad.push(`${tag}: ${boxes[i].name} 與 ${boxes[j].name} 命中區重疊 `
            + `${Math.round(overlapW)}x${Math.round(overlapH)}px`);
        }
      }
    }
    const doc = document.documentElement;
    return { bad, checked: boxes.length, tag, hScroll: doc.scrollWidth > doc.clientWidth };
  }, label);
}

const results = [];
results.push(await audit('主畫面'));

// 情境卡片（點自己）
await p.evaluate(() => {
  const g = window.__game;
  g.test.tap({ ...g.state.units.find(u => u.faction === 'PLAYER').pos });
});
await p.waitForTimeout(150);
results.push(await audit('自己的詳細狀態'));
await p.evaluate(() => window.__game.test.tap({ x: -1, y: -1 }));

// 技能摺疊選單
await p.locator('#controls button[data-act="SKILL"]').click();
await p.waitForTimeout(150);
results.push(await audit('技能選單'));
await p.locator('#controls button[data-act="SKILL"]').click();

// 紀錄面板
await p.locator('#btn-log').click();
await p.waitForTimeout(150);
results.push(await audit('紀錄面板'));
await p.locator('#btn-log').click();

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

const bad = results.flatMap(r => r.bad);
const scroll = results.filter(r => r.hScroll);
console.log(bad.length ? '❌ 觸控區過小:\n  ' + bad.join('\n  ') : '✅ 所有可點擊元素 >= 48x48 CSS px 且命中區互不重疊 (320px 寬視窗)');
console.log(scroll.length ? '❌ 有水平捲動 ' + JSON.stringify(scroll[0]) : '✅ 沒有水平捲動');
await b.close();
