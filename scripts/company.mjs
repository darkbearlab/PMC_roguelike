/** v0.16 端對端：公司 → 配裝 → 合約 → 派遣 → 打完 → 結算套回 → 重新載入仍在。 */
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const ok = (c, m) => console.log((c ? '✅ ' : '❌ ') + m) || (c || (process.exitCode = 1));
const meta = () => p.evaluate(() => JSON.parse(JSON.stringify(window.__meta())));

await p.goto('http://localhost:4188/?seed=1&reset=1', { waitUntil: 'networkidle' });
await p.waitForTimeout(400);
const m0 = await meta();
ok(m0.roster.length === 4 && m0.armoury.length === 4, `新公司：名冊 ${m0.roster.length} 人、軍械庫 ${m0.armoury.length} 把`);
ok(m0.armoury.length < m0.roster.length * 2, '東西不夠分（四個人配不滿兩把）');

// 逐人配裝：第一個人拿第一把槍與一些彈藥
await p.locator('button[data-kit]').first().click();
await p.waitForTimeout(200);
await p.locator('.l-list button[data-slot="equipped"]').nth(1).click();
await p.waitForTimeout(150);
await p.locator('button[data-move="ammo"][data-key="standard_5.56"][data-d="1"]').click();
await p.waitForTimeout(150);
const m1 = await meta();
const s0 = m1.roster[0];
ok(!!s0.loadout.equippedWeaponId, '武器指派給了第一個人：' + s0.loadout.equippedWeaponId);
ok((s0.loadout.ammo['standard_5.56'] ?? 0) > 0, '彈藥從共用庫存分了出去');
ok(m1.ammoStock['standard_5.56'] < m0.ammoStock['standard_5.56'], '共用庫存跟著減少');

// 同一把槍不能給兩個人
await p.locator('button[data-back]').click();
await p.waitForTimeout(150);
await p.locator('button[data-kit]').nth(1).click();
await p.waitForTimeout(200);
await p.locator(`.l-list button[data-slot="equipped"][data-id="${s0.loadout.equippedWeaponId}"]`).first().click();
await p.waitForTimeout(200);
const m2 = await meta();
ok(m2.roster[0].loadout.equippedWeaponId === null
  && m2.roster[1].loadout.equippedWeaponId === s0.loadout.equippedWeaponId,
  '搶過來之後原持有者手上就空了 —— 同一把槍只能給一個人');

// 重新載入：狀態還在
await p.locator('button[data-back]').click();
await p.waitForTimeout(200);
await p.goto('http://localhost:4188/?seed=1', { waitUntil: 'networkidle' });
await p.waitForTimeout(400);
const m3 = await meta();
ok(m3.roster[1].loadout.equippedWeaponId === s0.loadout.equippedWeaponId, '重新載入後配裝還在');
ok(m3.instanceCounter === m2.instanceCounter, '實例計數器一起持久化了（' + m3.instanceCounter + '）');

// 打一場：接合約 → 派遣 → 直接止損
await p.locator('button[data-go]').click();
await p.waitForTimeout(400);
await p.locator('.c-card button[data-toggle]').first().click();
await p.waitForTimeout(200);
await p.locator('.c-card.open button[data-go]').click();
await p.waitForTimeout(300);
const deployName = await p.locator('button[data-deploy]').first().innerText();
await p.locator('button[data-deploy]').nth(1).click();   // 派帶槍的那一位
await p.waitForTimeout(600);
const inMission = await p.evaluate(() => !!window.__game && window.__game.state.result === 'ONGOING');
ok(inMission, '進入任務');
const who = await p.evaluate(() => {
  const u = window.__game.state.units.find((x) => x.faction === 'PLAYER');
  return { id: u.id, gun: u.equipped && u.equipped.instanceId };
});
ok(who.gun === s0.loadout.equippedWeaponId, '出場的人帶著他自己那一把（' + who.gun + '）');

// 走到撤離點 = 起始空投點，直接撤離
await p.evaluate(() => {
  const g = window.__game;
  const u = g.state.units.find((x) => x.faction === 'PLAYER');
  u.pos = { ...g.state.map.startDropPoint };
  g.dispatch({ type: 'INTERACT', pos: { ...u.pos } });
});
await p.waitForTimeout(500);
await p.locator('#modal-root button[data-list]').click();
await p.waitForTimeout(500);
const m4 = await meta();
ok(m4.missionLog.length === 1, '任務紀錄寫進公司：' + JSON.stringify(m4.missionLog[0]));
ok(m4.armoury.some((w) => w.instanceId === who.gun), '帶出來的槍回到軍械庫，instanceId 不變');
ok(m4.roster.find((s) => s.id === who.id).serviceRecord.missions === 1, '服役紀錄 +1 次出勤');
console.log('   deployName =', deployName.replace(/\n/g, ' '));
console.log('errors:', errs.length ? errs : 'none');
if (errs.length) process.exitCode = 1;
await b.close();
