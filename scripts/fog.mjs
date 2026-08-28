/**
 * 插隊版 §5 的核心驗收，在真的瀏覽器上跑：
 * 迷霧三態 → 走路揭開 → 尋路只走已探索 → 目標穿透迷霧 → 空投點要先啟用。
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

// —— §3.1 一開場地圖大半是黑的，但腳下已經亮了 ——
const start = await p.evaluate(() => {
  const g = window.__game;
  const s = g.state;
  const known = s.explored.split('').filter((c) => c === '1').length;
  const u = s.units.find((x) => x.faction === 'PLAYER');
  const i = u.pos.y * s.map.width + u.pos.x;
  return { known, total: s.explored.length, here: s.explored[i], goal: { ...s.objectives.main.pos } };
});
ok(start.known > 0 && start.known < start.total * 0.35,
  `開場只探索了 ${start.known}/${start.total} 格（${(start.known / start.total * 100).toFixed(0)}%）`);
ok(start.here === '1', '腳下這一格是亮的');

// —— §3.2 目標穿透迷霧：位置一開始就知道，路才是未知的 ——
const goalHidden = await p.evaluate((goal) => {
  const s = window.__game.state;
  return s.explored[goal.y * s.map.width + goal.x] === '0';
}, start.goal);
ok(goalHidden, `主目標 (${start.goal.x},${start.goal.y}) 位在未探索區 —— 但畫面仍然畫得出它`);

// —— §3.3 尋路只走已探索的地方 ——
const path = await p.evaluate((goal) => {
  const g = window.__game;
  g.test.tap({ ...goal });
  return { sel: g.test.selection() };
}, start.goal);
ok(path.sel === null, '點未探索的目標格不會給出路徑 —— 尋路走不進黑地');

// —— §3.4 走一步就揭開新的地 ——
const reveal = await p.evaluate(() => {
  const g = window.__game;
  const before = g.state.explored.split('').filter((c) => c === '1').length;
  const seen = new Set();
  for (const d of ['S', 'S', 'E', 'E', 'S', 'E']) {
    g.dispatch({ type: 'MOVE', dir: d });
    while (!g.test.isPlayerTurn()) g.dispatch({ type: 'ADVANCE' });
    seen.add(g.state.explored.split('').filter((c) => c === '1').length);
  }
  const after = g.state.explored.split('').filter((c) => c === '1').length;
  return { before, after };
});
ok(reveal.after > reveal.before, `走了幾步，已探索 ${reveal.before} → ${reveal.after} 格`);

// —— §1 空投點：沒啟用之前不能當降落點，啟用要花時間也會出聲 ——
await p.goto('http://localhost:4188/?seed=1&map=mission_01', { waitUntil: 'networkidle' });
await p.waitForTimeout(400);
const drop = await p.evaluate(() => {
  const g = window.__game;
  const s = g.state;
  const tile = (x, y) => s.map.tiles[y * s.map.width + x];
  const home = s.map.startDropPoint;
  for (let y = 0; y < s.map.height; y++) {
    for (let x = 0; x < s.map.width; x++) {
      if (tile(x, y) !== 'DROP_POINT') continue;
      if (x === home.x && y === home.y) continue;
      return { x, y };
    }
  }
  return null;
});
ok(!!drop, `地圖上有非起始空投點：${JSON.stringify(drop)}`);

const act = await p.evaluate((d) => {
  const g = window.__game;
  const u = g.state.units.find((x) => x.faction === 'PLAYER');
  u.pos = { x: d.x, y: d.y };
  u.nextActAt = g.state.clock;
  g.test.refresh();
  const optsBefore = window.__core.activatedDropOptions(g.state).length;
  const kindBefore = window.__core.interactKindAt(g.state, d);
  const t0 = u.nextActAt;
  g.dispatch({ type: 'INTERACT', pos: { ...d } });
  const after = g.state.units.find((x) => x.id === u.id);
  return {
    optsBefore, kindBefore,
    optsAfter: window.__core.activatedDropOptions(g.state).length,
    kindAfter: window.__core.interactKindAt(g.state, d),
    cost: after.nextActAt - t0,
    activated: g.state.activatedDrops.slice(),
    log: g.state.log.slice(-3).map((l) => l.text),
  };
}, drop);
ok(act.kindBefore === 'ACTIVATE_DROP', '未啟用的空投點提供「啟用空投點」互動');
ok(act.optsBefore === 1, `啟用之前只有起始空投點可以降落（${act.optsBefore} 個）`);
ok(act.optsAfter === 1, `站在上面時它不算可用降落點 —— 有人佔著就不能空投（${act.optsAfter} 個）`);
ok(act.kindAfter === null, '已啟用的空投點不會再問一次');
ok(act.cost === 20, `啟用花了 20（${act.cost}）`);
ok(act.log.some((t) => /空投點.*已啟用/.test(t)), '紀錄裡寫了：' + act.log.filter((t) => /空投點/.test(t)));

// —— §2 接替者選單只列已啟用的空投點 ——
const picker = await p.evaluate((d) => {
  const g = window.__game;
  const u = g.state.units.find((x) => x.faction === 'PLAYER');
  u.pos = { ...g.state.map.startDropPoint };   // 讓開，換人來降落
  const opts = window.__core.activatedDropOptions(g.state);
  return { n: opts.length, list: opts.map((o) => o.x + ',' + o.y), d };
}, drop);
ok(picker.n === 1 && picker.list[0] === drop.x + ',' + drop.y,
  `人走開之後這裡就能空投了：${picker.list.join(' / ')}`);

console.log('errors:', errs.length ? errs : 'none');
if (errs.length) process.exitCode = 1;
await b.close();
