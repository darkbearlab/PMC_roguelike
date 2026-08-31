/**
 * 士兵經驗、敵人統一與極輕負重級，在真的瀏覽器上跑。
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
await p.waitForTimeout(500);

// ---- §1.6 名冊顯示等級與加成 ----
const roster = await p.locator('#company-root').innerText();
ok(/Lv\.1/.test(roster), '名冊顯示等級');
ok(/新兵，尚無加成/.test(roster), '新兵明說「尚無加成」');
ok(!/生命值 \+/.test(roster), '**加成裡沒有生命值**（§1.4）');

// 灌一點經驗，加成要跟著出現
await p.evaluate(() => {
  const m = window.__meta();
  m.roster[0].xp = 99999;
  window.__company();
});
await p.waitForTimeout(300);
const vet = await p.locator('#company-root').innerText();
ok(/命中 \+/.test(vet) && /迴避 \+/.test(vet) && /動作 ×/.test(vet),
  '老兵顯示命中／迴避／動作三項加成');
ok(/已滿級/.test(vet), '成長有明確上限');
const hpSame = await p.evaluate(() => {
  const m = window.__meta();
  return m.roster[0].maxHp === m.roster[1].maxHp;
});
ok(hpSame, '**老兵與新兵的生命值完全相同**');

// ---- 出擊：敵人統一與極輕負重 ----
await p.evaluate(() => {
  const m = window.__meta();
  const s0 = m.roster[0];
  window.__metaApi.assignWeapon(m, m.armoury[0].instanceId, s0.id, 'equipped');
  window.__company();
});
await p.waitForTimeout(250);
await p.locator('button[data-go]').click();
await p.waitForTimeout(400);
await p.locator('.c-card button[data-toggle]').first().click();
await p.waitForTimeout(200);
await p.locator('.c-card.open button[data-go]').click();
await p.waitForTimeout(300);
await p.locator('button[data-deploy]').first().click();
await p.waitForTimeout(700);

const field = await p.evaluate(() => {
  const g = window.__game;
  const foes = g.state.units.filter((u) => u.faction === 'ENEMY');
  return {
    kinds: [...new Set(foes.map((u) => u.kind))],
    humans: foes.filter((u) => u.kind === 'HUMAN').map((u) => ({
      hp: u.maxHp, sight: u.sightRange, gun: !!u.equipped,
      move: g.test.moveTimeOf(u.id), armour: u.armour, skills: u.skills.length,
    })),
    machine: foes.filter((u) => u.kind === 'MACHINE')
      .map((u) => ({ hp: u.maxHp, move: g.test.moveTimeOf(u.id) }))[0] ?? null,
  };
});
ok(field.kinds.includes('HUMAN') && field.kinds.includes('MACHINE'),
  `場上有人類也有機械（${field.kinds.join('、')}）`);
const hps = [...new Set(field.humans.map((h) => h.hp))];
const sights = [...new Set(field.humans.map((h) => h.sight))];
ok(hps.length === 1 && sights.length === 1,
  `**人類共用單一基礎數值**（hp ${hps.join('/')}、視野 ${sights.join('/')}）`);
ok(field.humans.every((h) => h.skills === 0), '技能欄位存在且為空');
const melee = field.humans.filter((h) => !h.gun);
const armed = field.humans.filter((h) => h.gun);
ok(melee.length > 0 && melee.every((h) => h.move === 7),
  `只有近戰的複製人落在極輕級，移動 7（${melee.length} 人）`);
ok(armed.length > 0 && armed.every((h) => h.move === 10),
  `帶槍的複製人移動 10（${armed.length} 人）`);
ok(field.machine && field.machine.move === 20,
  `機械保留專屬速度（移動 ${field.machine && field.machine.move}）`);

// §3.3 玩家也適用
const mine = await p.evaluate(() => {
  const g = window.__game;
  const u = g.state.units.find((x) => x.faction === 'PLAYER');
  const before = g.test.moveTimeOf(u.id);
  u.equipped = null; u.stowed = null; u.backpack.items = [];
  return { before, after: g.test.moveTimeOf(u.id) };
});
ok(mine.after === 7 && mine.before > 7,
  `玩家也適用：脫光了從 ${mine.before} 變成 ${mine.after}`);

// §1.1 完成目標才給經驗
const xp = await p.evaluate(() => {
  const g = window.__game;
  const u = g.state.units.find((x) => x.faction === 'PLAYER');
  const before = (g.state.stats[u.id] || {}).xp || 0;
  u.pos = { x: g.state.objectives.main.pos.x, y: g.state.objectives.main.pos.y - 1 };
  u.nextActAt = g.state.clock;
  g.dispatch({ type: 'INTERACT', pos: { ...g.state.objectives.main.pos } });
  return { before, after: (g.state.stats[u.id] || {}).xp || 0, id: u.id };
});
ok(xp.after > xp.before, `完成主目標拿到經驗（${xp.before} → ${xp.after}）`);

console.log('errors:', errs.length ? errs : 'none');
if (errs.length) process.exitCode = 1;
await b.close();
