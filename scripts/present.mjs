/** v0.17 驗收：動畫可打斷、攝影機只在必要時平移、選單規則。 */
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const ctx = await b.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) process.exitCode = 1; };

await p.goto('http://localhost:4188/?seed=1&map=mission_01', { waitUntil: 'networkidle' });
await p.waitForTimeout(400);

// --- §1.3 動畫可被下一個輸入打斷 ---
// 把動畫調長到 2 秒，連走四步。若每一步都要等動畫，這裡會花掉 8 秒。
const burst = await p.evaluate(() => {
  const g = window.__game;
  g.test.config().animation.playerMoveMs = 2000;
  const id = g.state.units.find((u) => u.faction === 'PLAYER').id;
  const t = Date.now();
  const from = { ...g.state.units.find((u) => u.id === id).pos };
  for (let i = 0; i < 4; i++) {
    // 保持行動權，測的是「輸入不被動畫擋住」而不是排程器
    const u = g.state.units.find((x) => x.id === id);
    u.nextActAt = g.state.clock;
    g.dispatch({ type: 'MOVE', dir: 'S' });
  }
  const u = g.state.units.find((x) => x.id === id);
  const drawn = g.test.renderPosOf(id);
  g.test.config().animation.playerMoveMs = 80;
  return { ms: Date.now() - t, from, pos: { ...u.pos }, drawn };
});
ok(burst.pos.y === burst.from.y + 4, `連按四下真的走了四格（y ${burst.from.y} → ${burst.pos.y}）`);
ok(burst.ms < 200, `連按不黏：四步只花了 ${burst.ms}ms（每步動畫 2000ms 也擋不住）`);
ok(Math.abs(burst.drawn.y - (burst.pos.y - 1)) < 0.2,
  '§1.3 前面三步被瞬移吃掉，只剩最後一步在滑');

// --- §1.2 旋鈕設為 0 = 瞬間完成 ---
const instant = await p.evaluate(() => {
  const g = window.__game;
  g.test.config().animation.playerMoveMs = 0;
  const u = g.state.units.find((x) => x.faction === 'PLAYER');
  const from = { ...u.pos };
  u.nextActAt = g.state.clock;
  g.dispatch({ type: 'MOVE', dir: 'S' });
  const drawn = g.test.renderPosOf(u.id);
  const now = g.state.units.find((x) => x.id === u.id).pos;
  return { from, drawn, now };
});
ok(instant.drawn.x === instant.now.x && instant.drawn.y === instant.now.y,
  '旋鈕 0：畫的位置就是邏輯位置，等同瞬間完成');

// --- §1.1 旋鈕非 0 時，畫的位置會落後邏輯位置 ---
const sliding = await p.evaluate(() => {
  const g = window.__game;
  g.test.config().animation.playerMoveMs = 400;
  const u = g.state.units.find((x) => x.faction === 'PLAYER');
  u.nextActAt = g.state.clock;
  g.dispatch({ type: 'MOVE', dir: 'N' });
  const drawn = g.test.renderPosOf(u.id);
  const now = { ...g.state.units.find((x) => x.id === u.id).pos };
  g.test.config().animation.playerMoveMs = 80;
  return { drawn, now };
});
ok(sliding.drawn.y > sliding.now.y, `動畫中畫的位置落後邏輯位置（畫 y=${sliding.drawn.y.toFixed(2)}、實際 y=${sliding.now.y}）`);

// --- §2.2 目標在畫面中央時不需要平移（重新載入，避免被前面的測試污染）---
await p.goto('http://localhost:4188/?seed=1&map=mission_01', { waitUntil: 'networkidle' });
await p.waitForTimeout(400);
const pan = await p.evaluate(async () => {
  const g = window.__game;
  const me = g.state.units.find((u) => u.faction === 'PLAYER');
  // 挪到地圖中央，避免鏡頭被地圖邊界夾住而永遠「靠邊」
  me.pos = { x: Math.floor(g.state.map.width / 2), y: Math.floor(g.state.map.height / 2) };
  g.test.refresh();
  // needsPan 比對的是**上一幀算出來的鏡頭**，所以要先讓它畫一幀
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return {
    centre: g.test.needsPan({ ...me.pos }),
    nearby: g.test.needsPan({ x: me.pos.x + 1, y: me.pos.y }),
    faraway: g.test.needsPan({ x: me.pos.x + 12, y: me.pos.y }),
  };
});
ok(pan.centre === false && pan.nearby === false,
  '§2.2 目標舒服地待在畫面內 → 不平移也不等待');
ok(pan.faraway === true, '§2.2 目標在畫面外 → 才平移（僅在 followActingUnit = PAN 時才會用到）');

// --- §4.2 選單全螢幕（同樣重新載入）---
await p.goto('http://localhost:4188/?seed=1&map=mission_01', { waitUntil: 'networkidle' });
await p.waitForTimeout(400);
const sheets = [];
await p.evaluate(() => {
  const g = window.__game;
  g.test.tap({ ...g.state.units.find((u) => u.faction === 'PLAYER').pos });
});
await p.waitForTimeout(200);
sheets.push(['士兵資訊', await p.locator('#tile-menu').evaluate((e) => e.classList.contains('sheet--full'))]);
await p.evaluate(() => window.__game.test.tap({ x: -1, y: -1 }));
await p.locator('#controls button[data-act="BAG"]').click();
await p.waitForTimeout(200);
sheets.push(['背包', await p.locator('#tile-menu').evaluate((e) => e.classList.contains('sheet--full'))]);
await p.locator('#tile-menu button[data-do="close"]').click();
await p.locator('#btn-log').click();
await p.waitForTimeout(200);
sheets.push(['日誌', await p.locator('#log-panel').evaluate((e) => e.classList.contains('sheet--full'))]);
await p.locator('#btn-log').click();
for (const [name, full] of sheets) ok(full, `${name}是全螢幕（不消耗時間的介面）`);

// --- §4.4 掠奪選單的兩個關閉條件 ---
await p.goto('http://localhost:4188/?seed=1&map=mission_01', { waitUntil: 'networkidle' });
await p.waitForTimeout(400);
const loot = await p.evaluate(async () => {
  const g = window.__game;
  const me = g.state.units.find((u) => u.faction === 'PLAYER');
  const near = { x: me.pos.x + 1, y: me.pos.y };
  g.state.loot.push({
    id: 'LTEST', kind: 'CACHE', pos: { ...near }, label: '測試箱',
    items: [{ id: 'IT', kind: 'VALUABLE', defId: 'SCRAP', name: '廢金屬', weight: 4, qty: 1, value: 1 }],
  });
  g.test.refresh();
  g.test.tap({ ...near });
  const opened = g.test.selection();
  // 條件一：拿空
  g.state.loot.find((c) => c.id === 'LTEST').items = [];
  g.test.refresh();
  const afterEmpty = g.test.selection();
  // 條件二：走遠
  g.state.loot.find((c) => c.id === 'LTEST').items = [
    { id: 'IT2', kind: 'VALUABLE', defId: 'SCRAP', name: '廢金屬', weight: 4, qty: 1, value: 1 },
  ];
  g.test.tap({ ...near });
  const reopened = g.test.selection();
  g.state.units.find((u) => u.faction === 'PLAYER').pos = { x: near.x + 3, y: near.y };
  g.test.refresh();
  const afterWalk = g.test.selection();
  return { opened, afterEmpty, reopened, afterWalk };
});
ok(loot.opened && loot.opened.startsWith('LOOT'), '點容器會開掠奪選單');
ok(loot.afterEmpty === null, '§4.4 條件一：容器被拿空 → 自動關閉');
ok(loot.reopened && loot.reopened.startsWith('LOOT'), '重新打開');
ok(loot.afterWalk === null, '§4.4 條件二：走離相鄰範圍 → 自動關閉');

// --- 攝影機在敵人回合完全不動（試玩回報：追尾會暈）---
await p.goto('http://localhost:4188/?seed=1&map=mission_01', { waitUntil: 'networkidle' });
await p.waitForTimeout(400);
ok(await p.evaluate(() => window.__game.test.config().animation.followActingUnit === 'OFF'),
  '預設是 OFF');

// 往前走幾步引出敵人回合，全程取樣鏡頭原點
const trace = await p.evaluate(async () => {
  const g = window.__game;
  let enemyFrames = 0;
  let worst = 0;          // 敵人回合期間，鏡頭焦點離玩家最遠有多少格
  let spotSet = 0;
  const sample = () => {
    if (g.test.isPlayerTurn()) return;
    enemyFrames++;
    if (g.test.spotlight()) spotSet++;
    const me = g.state.units.find((u) => u.faction === 'PLAYER');
    if (!me) return;
    const f = g.test.focus();
    worst = Math.max(worst, Math.abs(f.x - me.pos.x) + Math.abs(f.y - me.pos.y));
  };
  for (let i = 0; i < 12; i++) {
    g.test.tap({ ...g.state.objectives.main.pos });
    g.test.tap({ ...g.state.objectives.main.pos });
    for (let k = 0; k < 40; k++) {
      await new Promise((r) => requestAnimationFrame(r));
      sample();
      if (g.state.result !== 'ONGOING') break;
    }
    if (g.state.result !== 'ONGOING' || g.state.pendingReinforcement) break;
  }
  return { enemyFrames, worst, spotSet };
});
ok(trace.enemyFrames > 10, `有取樣到敵人回合（${trace.enemyFrames} 幀）`);
console.log('   trace →', JSON.stringify(trace));
ok(trace.spotSet === 0, '敵人回合期間不會把鏡頭焦點交給敵人（spotlight 一直是 null）');
// v0.19：翻越一次移動兩格，所以玩家自己那一步的滑動最長是 2 格
ok(trace.worst < 2.01,
  `敵人回合期間鏡頭一直待在玩家身上（最遠離開 ${trace.worst.toFixed(2)} 格，只是玩家自己那一步的滑動）`);
console.log('errors:', errs.length ? errs : 'none');
if (errs.length) process.exitCode = 1;
await b.close();
