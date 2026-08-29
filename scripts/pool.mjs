/**
 * §2 物品池與 §4 可讀性，在真的瀏覽器上跑：
 * 抽走一把補給站就少一把 → 敵人手上拿著真的槍 → 認出來才顯示 → 損益表的資產區塊。
 */
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) process.exitCode = 1; };
const meta = () => p.evaluate(() => JSON.parse(JSON.stringify(window.__meta())));

await p.goto('http://localhost:4188/?seed=1&reset=1', { waitUntil: 'networkidle' });
await p.waitForTimeout(400);
const m0 = await meta();
const poolBefore = m0.legacyStock.map((w) => w.instanceId);
ok(poolBefore.length > 0, `物品池：${m0.legacyStock.map((w) => w.name).join('、')}`);
ok(m0.legacyStock.every((w) => typeof w.instanceId === 'string'),
  '架上擺的是**實例**，不是型號 —— 買走的就是那一把');

// 先把兩把槍配給首發，否則他赤手空拳出門，資產區塊就沒有東西可列
await p.evaluate(() => {
  const m = window.__meta();
  const s0 = m.roster[0];
  window.__metaApi.assignWeapon(m, m.armoury[0].instanceId, s0.id, 'equipped');
  window.__metaApi.assignWeapon(m, m.armoury[1].instanceId, s0.id, 'stowed');
});
await p.evaluate(() => window.__company());
await p.waitForTimeout(250);

// 出擊 → 抽武器
await p.locator('button[data-go]').click();
await p.waitForTimeout(400);
await p.locator('.c-card button[data-toggle]').first().click();
await p.waitForTimeout(200);
await p.locator('.c-card.open button[data-go]').click();
await p.waitForTimeout(300);
await p.locator('button[data-deploy]').first().click();
await p.waitForTimeout(700);

const mine = await p.evaluate(() => {
  const u = window.__game.state.units.find((x) => x.faction === 'PLAYER');
  return { eq: u.equipped && u.equipped.name, st: u.stowed && u.stowed.name };
});
ok(!!mine.eq && !!mine.st, `首發帶著自己的兩把槍出門（${mine.eq} ＋ ${mine.st}）`);

const foes = await p.evaluate(() => window.__game.state.units
  .filter((u) => u.faction === 'ENEMY')
  .map((u) => ({
    id: u.id, arch: u.archetype,
    gun: u.equipped && u.equipped.typeId, inst: u.equipped && u.equipped.instanceId,
    mode: u.equipped && u.equipped.mode, reserve: u.reserveAmmo,
    intrinsic: u.intrinsic && u.intrinsic.name,
  })));
ok(foes.every((f) => !!f.intrinsic), '每個敵人都有內建武器（§1）');
const armed = foes.filter((f) => f.gun);
ok(armed.length > 0, `${armed.length}/${foes.length} 名敵人拿著真的槍：`
  + armed.map((f) => f.gun + '/' + f.mode).join('、'));
ok(armed.every((f) => f.reserve > 0), '持槍的敵人有有限的攜行彈藥（§3.2）');
ok(foes.filter((f) => !f.gun).length > 0, '衝鋒型與裝甲型不抽武器，只有內建近戰');

const m1 = await meta();
const poolAfter = m1.legacyStock.map((w) => w.instanceId);
const taken = poolBefore.filter((id) => !poolAfter.includes(id));
const onFoes = armed.map((f) => f.inst);
ok(taken.every((id) => onFoes.includes(id)),
  `**抽走一把，補給站就少一把**（池子 ${poolBefore.length} → ${poolAfter.length}，`
  + `被抽走的 ${taken.length} 把全部在敵人手上）`);
ok(poolAfter.length <= poolBefore.length, '池子只會變少，不會憑空長出東西');
// 不變量的另一面：**沒有任何一把槍同時在架上又在敵人手上**
ok(armed.every((f) => !poolAfter.includes(f.inst)),
  '沒有一把槍同時擺在架上又掛在敵人身上 —— 一把槍只能在一個地方');

// §4.2 識別：一開場看不出敵人拿什麼
const ident = await p.evaluate(() => ({
  list: window.__game.state.identifiedWeapons.slice(),
  conspicuous: window.__game.state.units
    .filter((u) => u.faction === 'ENEMY' && u.equipped && u.equipped.conspicuous)
    .map((u) => u.equipped.typeId),
}));
ok(ident.list.length === ident.conspicuous.length,
  `一開場只有藏不住的武器是已識別的（${ident.conspicuous.join('、') || '無'}）`);

// 走近就認得出來
const near = await p.evaluate(() => {
  const g = window.__game;
  const foe = g.state.units.find((u) => u.faction === 'ENEMY' && u.equipped);
  if (!foe) return null;
  const me = g.state.units.find((u) => u.faction === 'PLAYER');
  me.pos = { x: foe.pos.x, y: foe.pos.y + 1 };
  me.nextActAt = g.state.clock;
  g.dispatch({ type: 'WAIT' });
  return { id: foe.equipped.instanceId, known: g.state.identifiedWeapons.slice() };
});
ok(!!near && near.known.includes(near.id), '走到旁邊就認得出他拿什麼（§4.2）');

// §5 損益表的資產區塊
await p.evaluate(() => {
  const g = window.__game;
  const u = g.state.units.find((x) => x.faction === 'PLAYER');
  g.state.objectives.main.done = true;
  u.hp = u.maxHp;
  u.pos = { ...g.state.map.startDropPoint };
  u.nextActAt = g.state.clock;
  // 手上留一把、丟掉一把 → 資產區塊兩邊都要看得到
  u.stowed = null;
  g.dispatch({ type: 'INTERACT', pos: { ...u.pos } });
});
await p.waitForTimeout(900);
const summary = await p.locator('#modal-root').innerText();
ok(/資產變動/.test(summary), '損益表有資產區塊（§5.2）');
ok(/損失/.test(summary), '資產區塊列出損失的槍');
ok(!/資產淨變動[\s\S]{0,40}本次合約損益（現金）/.test(summary),
  '資產淨變動不參與現金損益的加總');
ok(/本次合約損益（現金）/.test(summary), '現金與資產分成兩條底線');

console.log('errors:', errs.length ? errs : 'none');
if (errs.length) process.exitCode = 1;
await b.close();
