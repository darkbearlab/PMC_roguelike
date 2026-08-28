/**
 * v0.18 §4 的核心情境，在真的瀏覽器上跑一次：
 * A 陣亡 → B 空投 → B 走到屍體旁 → 騰位置 → 接手 RR-4 → 撤離 →
 * **結算後 RR-4 回到軍械庫，而且仍是同一個 instanceId。**
 *
 * 這是本次改動的存在理由，所以它自己一支腳本。
 */
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) process.exitCode = 1; };

// 公司 → 配裝：給兩個人各一把槍，才有東西可以接手
await p.goto('http://localhost:4188/?seed=1&reset=1', { waitUntil: 'networkidle' });
await p.waitForTimeout(400);
await p.evaluate(() => {
  const m = window.__meta();
  // 直接用局外層的 API 配裝，介面部分由 company.mjs 驗
  const mod = window.__metaApi;
  const [a, c] = m.roster;
  mod.assignWeapon(m, m.armoury.find((w) => w.typeId === 'rr4').instanceId, a.id, 'equipped');
  mod.assignWeapon(m, m.armoury.find((w) => w.typeId === 'ar9').instanceId, c.id, 'equipped');
  mod.assignWeapon(m, m.armoury.find((w) => w.typeId === 'p9').instanceId, c.id, 'stowed');
  mod.moveAmmo(m, a.id, 'heat_84mm', 2);
  mod.moveAmmo(m, c.id, 'standard_5.56', 24);
});
const rr4 = await p.evaluate(() => {
  const m = window.__meta();
  return m.roster[0].loadout.equippedWeaponId;
});
ok(!!rr4, `A 手上那把 RR-4 的實例是 ${rr4}`);

// 接合約 → 派 A 出去
await p.locator('button[data-go]').click();
await p.waitForTimeout(400);
await p.locator('.c-card button[data-toggle]').first().click();
await p.waitForTimeout(200);
await p.locator('.c-card.open button[data-go]').click();
await p.waitForTimeout(300);
await p.locator('button[data-deploy]').first().click();
await p.waitForTimeout(600);
ok(await p.evaluate(() => window.__game.state.units.find((u) => u.faction === 'PLAYER').equipped?.instanceId) === rr4,
  'A 帶著那把 RR-4 上場');

// 1. A 陣亡
const dead = await p.evaluate(() => {
  const g = window.__game;
  const a = g.state.units.find((u) => u.faction === 'PLAYER');
  a.hp = 3;
  g.dispatch({ type: 'FIRE', target: { ...a.pos } });
  const body = g.state.loot.find((c) => c.kind === 'PLAYER_BODY');
  return { pos: { ...body.pos }, ids: body.items.filter((i) => i.kind === 'WEAPON').map((i) => i.weapon.instanceId) };
});
ok(dead.ids.includes(rr4), 'RR-4 留在 A 的屍體上');

// 2-3. B 空投，走到屍體旁
await p.waitForTimeout(300);
await p.locator('#modal-root button[data-pick]').first().click();
await p.waitForTimeout(400);
const bState = await p.evaluate((bodyPos) => {
  const g = window.__game;
  const u = g.state.units.find((x) => x.faction === 'PLAYER');
  u.pos = { ...bodyPos };
  u.nextActAt = g.state.clock;
  g.test.refresh();
  return { equipped: u.equipped?.name ?? null, stowed: u.stowed?.name ?? null };
}, dead.pos);
ok(!!bState.equipped && !!bState.stowed,
  `B 帶著自己的配裝降落（${bState.equipped} ＋ ${bState.stowed}）—— 兩個欄位都滿了`);

// 4. 開背包 → 把收納欄的槍移進背包（二次確認）
await p.locator('#controls button[data-act="BAG"]').click();
await p.waitForTimeout(250);
const hasGear = await p.locator('#tile-menu').innerText();
ok(/裝備/.test(hasGear) && /收納/.test(hasGear), '滿版背包畫面裡有裝備欄');
const moveBtn = p.locator('#tile-menu button[data-do="gear"][data-from="STOWED"][data-to="BACKPACK"]');
const label = await moveBtn.innerText();
ok(/費時/.test(label), `搬裝備的按鈕有顯示花費（${label.replace(/\n/g, ' ')}）`);
await moveBtn.click();
await p.waitForTimeout(150);
const armed = await moveBtn.innerText();
ok(/再按一次確認/.test(armed), '第一下只是備妥，需要二次確認');
const clockBefore = await p.evaluate(() =>
  window.__game.state.units.find((x) => x.faction === 'PLAYER').nextActAt);
await moveBtn.click();
await p.waitForTimeout(300);
const moved = await p.evaluate(() => {
  const u = window.__game.state.units.find((x) => x.faction === 'PLAYER');
  return { stowed: u.stowed, bag: u.backpack.items.filter((i) => i.kind === 'WEAPON').length,
    clock: u.nextActAt };
});
ok(moved.stowed === null && moved.bag > 0, '收納欄空出來了，那把槍進了背包');
ok(moved.clock > clockBefore, `搬裝備真的推進了行動時刻（${clockBefore} → ${moved.clock}）`);

// 從屍體把 RR-4 拿到收納欄
const picked = await p.evaluate(async (want) => {
  const g = window.__game;
  const u = g.state.units.find((x) => x.faction === 'PLAYER');
  u.nextActAt = g.state.clock;
  const pile = g.state.loot.find((c) => c.kind === 'PLAYER_BODY');
  const idx = pile.items.findIndex((i) => i.weapon && i.weapon.instanceId === want);
  g.dispatch({ type: 'PICKUP', lootId: pile.id, itemIndex: idx, slot: 'STOWED' });
  // 順手把屍體上的彈藥也拿走
  u.nextActAt = g.state.clock;
  const ai = pile.items.findIndex((i) => i.kind === 'AMMO');
  if (ai >= 0) g.dispatch({ type: 'PICKUP', lootId: pile.id, itemIndex: ai });
  const me = g.state.units.find((x) => x.faction === 'PLAYER');
  return { stowed: me.stowed?.instanceId ?? null };
}, rr4);
ok(picked.stowed === rr4, 'B 接手了 A 那一把 RR-4（同一個 instanceId）');

// 6. 撤離
await p.evaluate(() => {
  const g = window.__game;
  const u = g.state.units.find((x) => x.faction === 'PLAYER');
  u.pos = { ...g.state.map.startDropPoint };
  u.nextActAt = g.state.clock;
  g.dispatch({ type: 'INTERACT', pos: { ...u.pos } });
});
await p.waitForTimeout(500);
await p.locator('#modal-root button[data-list]').click();
await p.waitForTimeout(500);

// 7. 結算後仍是同一把
const back = await p.evaluate((want) => {
  const m = window.__meta();
  const w = m.armoury.find((x) => x.instanceId === want);
  return { found: !!w, type: w?.typeId ?? null, holder: m.roster.find((s) =>
    s.loadout.equippedWeaponId === want || s.loadout.stowedWeaponId === want)?.designation ?? null };
}, rr4);
ok(back.found, `結算後 RR-4 回到軍械庫，instanceId 仍是 ${rr4}（${back.type}）`);
ok(!!back.holder, `而且還在帶它回來的那個人身上（${back.holder}）`);

console.log('errors:', errs.length ? errs : 'none');
if (errs.length) process.exitCode = 1;
await b.close();
