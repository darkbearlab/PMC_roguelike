/**
 * 難度診斷 §3：人類遊玩指標的輸出與煙霧測試。
 *
 * 兩種用法：
 *  1. 直接跑 —— 用一隻粗糙的機器人在真的瀏覽器裡打一場，證明三個數字算得出來
 *  2. 真人玩完之後開主控台打 `__game.test.metricsLine()`，或看戰鬥紀錄最後一行
 *
 * **這支腳本本身量到的數字沒有代表性** —— 機器人對資訊系統免疫（§2.3）。
 * 它存在的意義是「儀器接好了、讀得出來」，真正的數據要靠真人玩。
 *
 *   node scripts/diag-metrics.mjs
 */
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) process.exitCode = 1; };

const MAP = process.env.MAP || 'mission_01';
const SEED = process.env.SEED || '1';
await p.goto(`http://localhost:4188/?seed=${SEED}&map=${MAP}`, { waitUntil: 'networkidle' });
await p.waitForTimeout(400);

ok(await p.evaluate(() => typeof window.__game.test.metricsLine === 'function'),
  '儀器接上了（test.metricsLine）');

// 讓玩家走進敵群，然後把行動權交給敵人 —— 這一段只是要製造「挨打」這件事，
// 好證明三個數字算得出來。**它不是難度量測**（機器人對資訊系統免疫，§2.3）。
const trace = await p.evaluate(async () => {
  const g = window.__game;
  const sleep = () => new Promise((r) => setTimeout(r, 0));
  const foes = g.state.units.filter((u) => u.faction === 'ENEMY');
  const target = foes[Math.floor(foes.length / 2)];
  const me = g.state.units.find((u) => u.faction === 'PLAYER');
  me.maxHp = 100000;
  me.hp = 100000;
  me.pos = { x: target.pos.x, y: target.pos.y + 1 };
  g.test.refresh();
  for (let i = 0; i < 3000 && g.state.result === 'ONGOING'; i++) {
    if (g.state.pendingReinforcement) {
      g.dispatch({ type: 'DEPLOY_REINFORCEMENT', soldierId: g.state.roster[0] });
      continue;
    }
    if (!g.test.isPlayerTurn()) { g.dispatch({ type: 'ADVANCE' }); continue; }
    // 玩家原地待命：把舞台完全讓給敵人，統計才收得到「誰在打我」
    g.dispatch({ type: 'WAIT' });
    if (i % 200 === 0) await sleep();
    const cur = g.state.units.find((u) => u.faction === 'PLAYER');
    if (cur && cur.hp < 90000) break;         // 挨夠了就停
  }
  return { result: g.state.result, clock: g.state.clock,
    metrics: g.test.metrics(), line: g.test.metricsLine() };
});

console.log('');
console.log('地圖 ' + MAP + '　種子 ' + SEED + '　結果 ' + trace.result + '　時刻 ' + trace.clock);
console.log(trace.line);
console.log('');
const m = trace.metrics;
ok(m.totalDamage > 0, '有挨到打，統計才有東西（總傷害 ' + m.totalDamage + '）');
ok(m.fromUnidentified <= m.totalDamage && m.fromUnseen <= m.totalDamage,
  '三個數字的分子不會超過分母');
ok(m.threatCounts.length === m.hits, '每次挨打都記了一筆「同時瞄著我的敵人數」');
if (m.totalDamage > 0) {
  const pctU = (m.fromUnidentified / m.totalDamage) * 100;
  const pctS = (m.fromUnseen / m.totalDamage) * 100;
  const avg = m.threatCounts.reduce((a, x) => a + x, 0) / (m.threatCounts.length || 1);
  console.log('');
  console.log('判讀（§4）：');
  console.log('  ① 未識別武器 ' + pctU.toFixed(0) + '%　'
    + (pctU > 50 ? '→ 難度來自**不確定性**，不是殺傷力' : '→ 不是主要來源'));
  console.log('  ② 從未見過　 ' + pctS.toFixed(0) + '%　'
    + (pctS > 50 ? '→ 難度來自**迷霧與開場暴露**' : '→ 不是主要來源'));
  console.log('  ③ 同時瞄著我 ' + avg.toFixed(2) + '　'
    + (avg >= 3 ? '→ 難度來自**地圖與敵人初始配置**' : '→ 不是主要來源'));
  console.log('');
  console.log('※ 這一組是機器人跑出來的，**對資訊類難度沒有代表性**（§2.3）。');
  console.log('　 真正的數據要靠真人玩完之後看戰鬥紀錄最後一行。');
}

console.log('');
console.log('errors:', errs.length ? errs : 'none');
if (errs.length) process.exitCode = 1;
await b.close();
