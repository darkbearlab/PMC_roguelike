// 用系統 Chrome 開實際頁面截圖，驗證手機直向版面。
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.URL || 'http://localhost:4173/?seed=12345';
const OUT = process.env.OUT || 'C:/Users/user/AppData/Local/Temp/claude/c--claude-project-PMC-roguelike/32862969-7ed8-48d9-b72a-983b846d6e1c/scratchpad/shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.screenshot({ path: OUT + '/01-start.png' });

// 走幾步：南 → 南 →（自動進敵人回合）
for (let i = 0; i < 6; i++) {
  const btn = page.locator('#dpad button[data-dir="S"]');
  if (await btn.isEnabled()) await btn.click();
  await page.waitForTimeout(500);
}
await page.screenshot({ path: OUT + '/02-moved.png' });

// 點自己看詳細狀態面板
const box = await page.locator('#map').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(300);
await page.screenshot({ path: OUT + '/03-self-panel.png' });

// 開紀錄
await page.locator('#actions button[data-act="LOG"]').click();
await page.waitForTimeout(200);
await page.screenshot({ path: OUT + '/04-log.png' });
await page.locator('#actions button[data-act="LOG"]').click();

// 止損確認
await page.evaluate(() => {
  const g = window.__game;
  const me = g.state.units.find((u) => u.faction === 'PLAYER');
  me.hp = 3;
  g.dispatch({ type: 'FIRE', target: { ...me.pos } });
});
await page.waitForTimeout(200);
await page.screenshot({ path: OUT + '/05-abort.png' });
await page.locator('#modal-root button[data-abort]').click();
await page.waitForTimeout(200);
await page.locator('#modal-root button[data-yes]').click();
await page.waitForTimeout(300);
await page.screenshot({ path: OUT + '/06-summary.png' });

const state = await page.evaluate(() => {
  const g = window.__game;
  return { clock: g.state.clock, result: g.state.result, pos: g.state.units[0] && g.state.units[0].pos };
});
console.log('state:', JSON.stringify(state));
console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close();
