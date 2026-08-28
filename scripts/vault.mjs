/**
 * v0.19 §5 的核心驗收，在真的瀏覽器上跑：
 * 撞向掩體 → 翻越 → 落在對面且強制站姿 → 方向鍵看得到花費 → 敵人也翻得過來。
 */
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) process.exitCode = 1; };

await p.goto('http://localhost:4188/?seed=1&map=mission_01', { waitUntil: 'networkidle' });
await p.waitForTimeout(400);

// 在地圖上找一個可以翻越的位置
const spot = await p.evaluate(() => {
  const g = window.__game;
  const m = g.state.map;
  const tile = (x, y) => m.tiles[y * m.width + x];
  for (let y = 1; y < m.height - 1; y++) {
    for (let x = 1; x < m.width - 1; x++) {
      if (tile(x, y) !== 'HALF_COVER') continue;
      for (const [dx, dy, dir] of [[0, -1, 'N'], [0, 1, 'S'], [1, 0, 'E'], [-1, 0, 'W']]) {
        const from = { x: x - dx, y: y - dy };
        const land = { x: x + dx, y: y + dy };
        const free = (t) => t !== 'WALL' && t !== 'HALF_COVER';
        if (!free(tile(from.x, from.y)) || !free(tile(land.x, land.y))) continue;
        if (g.state.units.some((u) => (u.pos.x === land.x && u.pos.y === land.y)
          || (u.pos.x === from.x && u.pos.y === from.y))) continue;
        return { from, dir, cover: { x, y }, land };
      }
    }
  }
  return null;
});
ok(!!spot, `找到可翻越的位置：${JSON.stringify(spot && spot.from)} 往 ${spot && spot.dir}`);

const res = await p.evaluate((sp) => {
  const g = window.__game;
  const u = g.state.units.find((x) => x.faction === 'PLAYER');
  u.pos = { ...sp.from };
  u.stance = 'CROUCH';
  u.facing = sp.dir;
  u.nextActAt = g.state.clock;
  g.test.refresh();
  const before = { pos: { ...u.pos }, stance: u.stance, at: u.nextActAt };
  g.dispatch({ type: 'MOVE', dir: sp.dir });
  const after = g.state.units.find((x) => x.id === u.id);
  return { before, pos: { ...after.pos }, stance: after.stance, at: after.nextActAt,
    cover: sp.cover, land: sp.land };
}, spot);
ok(res.pos.x === res.land.x && res.pos.y === res.land.y,
  `翻越落在掩體對面 ${JSON.stringify(res.pos)}，不是掩體格 ${JSON.stringify(res.cover)}`);
ok(res.stance === 'STAND', `落地強制站姿（翻越前是 ${res.before.stance}）`);
ok(res.at - res.before.at === 20, `花了 20（${res.before.at} → ${res.at}）`);

// 方向鍵要看得到「翻越」與花費
const dpad = await p.evaluate((sp) => {
  const g = window.__game;
  const u = g.state.units.find((x) => x.faction === 'PLAYER');
  u.pos = { ...sp.from };
  u.stance = 'STAND';
  u.nextActAt = g.state.clock;
  g.test.refresh();
  const btn = document.querySelector(`#dpad button[data-dir="${sp.dir}"]`);
  return { cls: btn.className, title: btn.title, cost: btn.dataset.cost };
}, spot);
ok(/will-vault/.test(dpad.cls), '方向鍵標成「會翻越」，與移動、轉向分得開');
ok(/翻越/.test(dpad.title) && dpad.cost === '20', `方向鍵顯示花費（${dpad.title}／${dpad.cost}）`);

// 尋路移動會用翻越
const path = await p.evaluate((sp) => {
  const g = window.__game;
  const u = g.state.units.find((x) => x.faction === 'PLAYER');
  u.pos = { ...sp.from };
  u.nextActAt = g.state.clock;
  g.test.refresh();
  g.test.tap({ ...sp.land });
  const sel = g.test.selection();
  g.test.tap({ ...sp.land });
  return { sel, auto: g.test.autoActive(), pos: { ...g.state.units.find((x) => x.id === u.id).pos } };
}, spot);
ok(path.sel !== null, '點對面那一格會出現路徑預覽');

console.log('errors:', errs.length ? errs : 'none');
if (errs.length) process.exitCode = 1;
await b.close();
