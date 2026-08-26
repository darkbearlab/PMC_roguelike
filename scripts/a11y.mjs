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
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (!el.offsetParent && el.offsetWidth === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.width < 48 || r.height < 48) {
        bad.push(`${tag}: <${el.tagName.toLowerCase()}> "${(el.textContent || '').trim().slice(0, 12)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    const doc = document.documentElement;
    return { bad, hScroll: doc.scrollWidth > doc.clientWidth, sw: doc.scrollWidth, cw: doc.clientWidth };
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

// 止損確認 modal
await p.locator('#btn-abort').click();
await p.waitForTimeout(150);
results.push(await audit('止損確認'));
await p.locator('#modal-root button[data-yes]').click();
await p.waitForTimeout(200);
results.push(await audit('結算畫面'));

const bad = results.flatMap(r => r.bad);
const scroll = results.filter(r => r.hScroll);
console.log(bad.length ? '❌ 觸控區過小:\n  ' + bad.join('\n  ') : '✅ 所有可點擊元素 >= 48x48 CSS px (320px 寬視窗)');
console.log(scroll.length ? '❌ 有水平捲動 ' + JSON.stringify(scroll[0]) : '✅ 沒有水平捲動');
await b.close();
