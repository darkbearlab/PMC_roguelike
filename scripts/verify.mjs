// 在真實瀏覽器裡驗證 §10 死亡→增援→回收裝備的完整流程，以及兩種螢幕寬度的版面。
// v0.11 起會隨機選圖，但這支腳本的座標全部是 mission_01 的，
// 所以網址釘死 map=mission_01 —— 它測的是介面與流程，不是地圖。
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.URL || 'http://localhost:4188/?seed=12345&map=mission_01';
const OUT = process.env.OUT || 'C:/Users/user/AppData/Local/Temp/claude/c--claude-project-PMC-roguelike/32862969-7ed8-48d9-b72a-983b846d6e1c/scratchpad/shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });
const errors = [];
const fail = [];
const ok = (cond, msg) => { console.log((cond ? '✅ ' : '❌ ') + msg); if (!cond) fail.push(msg); };

for (const [w, h, tag] of [[320, 640, '320'], [390, 844, '390']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(tag + ' PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(tag + ' ' + m.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/w${tag}-start.png` });
  await ctx.close();
}

// ---- §10 死亡 → 增援 → 回收 ----
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// 把士兵搬到第二個空投點附近再自盡，觸發「從最近空投點增援」
await page.evaluate(() => {
  const g = window.__game;
  const me = g.state.units.find((u) => u.faction === 'PLAYER');
  me.pos = { x: 3, y: 11 };   // 靠近 D2 (2,11)
  me.hp = 3;
  g.dispatch({ type: 'FIRE', target: { x: 3, y: 11 } });
});
await page.waitForTimeout(400);
await page.screenshot({ path: OUT + '/20-reinforce.png' });

const modalText = await page.locator('#modal-root').textContent();
ok(/已陣亡/.test(modalText), '陣亡後跳出增援選單');
ok(/K-442/.test(modalText), '增援選單列出名冊');
ok(/改為止損撤出/.test(modalText), '增援選單也能直接止損');

await page.locator('#modal-root button[data-pick]').first().click();
await page.waitForFunction(
  () => window.__game.test.isPlayerTurn() || window.__game.state.result !== 'ONGOING',
  null, { timeout: 15000 },
);
await page.waitForTimeout(300);

const after = await page.evaluate(() => {
  const g = window.__game;
  const me = g.state.units.find((u) => u.faction === 'PLAYER');
  return {
    id: me.id, pos: me.pos, nextActAt: me.nextActAt, clock: g.state.clock,
    equipped: me.equipped && me.equipped.typeId, stowed: me.stowed && me.stowed.typeId,
    loot: g.state.loot.map((c) => ({
      kind: c.kind, pos: c.pos,
      w: c.items.filter((x) => x.kind === "WEAPON").map((x) => x.weapon.typeId),
    })),
    casualties: g.state.casualties, deployed: g.state.deployed, roster: g.state.roster.length,
  };
});
console.log('   →', JSON.stringify(after));
// 插隊版 §1.2：D2 (2,11) 就在旁邊，但沒人去啟用過它 —— 接替者只能從起始空投點下來。
// 「最近的空投點」變成「最近的**已啟用**空投點」，這是難度旋鈕交到玩家手上的代價。
ok(after.pos.x === 1 && after.pos.y === 1,
  '未啟用的 D2 不能用，接替者從起始空投點 (1,1) 落地');
ok(after.equipped === 'ar9' && after.stowed === 'rr4',
  'v0.16：替補帶著自己的配裝降落（測試快照給的是 AR-9 + RR-4）');
const bodies = after.loot.filter((c) => c.kind === 'PLAYER_BODY');
ok(bodies.length === 1 && bodies[0].w.sort().join() === 'ar9,rr4', '己方遺體保有死者的全部武器');
ok(after.casualties === 1 && after.deployed === 2 && after.roster === 2, '結算計數正確');
ok(after.nextActAt > after.clock || after.nextActAt >= 10,
  '增援落地後有一段延遲才能行動（§5.2 deploy）');

// 走到屍體上，用情境選單撿回 RR-4
await page.evaluate(() => {
  const g = window.__game;
  const me = g.state.units.find((u) => u.faction === 'PLAYER');
  me.pos = { x: 3, y: 11 };
  g.test.refresh();
  g.test.tap({ x: 3, y: 11 });
});
await page.waitForTimeout(250);
await page.screenshot({ path: OUT + '/21-corpse-menu.png' });
const menu = await page.locator('#tile-menu').textContent();
ok(/的遺體/.test(menu) && /RR-4/.test(menu), '點屍體會列出可拾取的武器');
ok(/DNA/.test(menu), '己方遺體含一份 DNA（§4.4）');
ok(/全部拿走/.test(menu), '有「全部拿走」選項（§4.3）');

const beforePick = await page.evaluate(() => {
  const u = window.__game.state.units.find(x => x.faction === 'PLAYER');
  return { next: u.nextActAt };
});
// v0.16：替補自己也帶著 RR-4，所以 AR-9 那一列的提示會寫「換下 RR-4」——
// 只用「RR-4」+「換為收納」兩個關鍵字會選到錯的按鈕，要比對連在一起的整段。
await page.locator('#tile-menu button[data-do="pickup"]')
  .filter({ hasText: /換為收納 RR-4/ }).first().click();
await page.waitForTimeout(300);
const picked = await page.evaluate(() => {
  const g = window.__game;
  const me = g.state.units.find((u) => u.faction === 'PLAYER');
  return {
    next: me.nextActAt, clock: g.state.clock,
    equipped: me.equipped && me.equipped.typeId, stowed: me.stowed && me.stowed.typeId,
  };
});
ok(picked.equipped === 'rr4' || picked.stowed === 'rr4', '撿回 RR-4');
ok(picked.next > beforePick.next, '拾取有推進自己的下次行動時刻（不是免費的）');
await page.screenshot({ path: OUT + '/22-picked-up.png' });

console.log(errors.length ? '❌ CONSOLE:\n  ' + errors.join('\n  ') : '✅ 沒有 console 錯誤');
if (errors.length) fail.push('console errors');
await browser.close();
process.exit(fail.length ? 1 : 0);
