/**
 * v0.17 §5：量測動畫對**真實牆鐘時間**的影響。
 *
 * 同一張圖、同一個種子、同一套政策（走向主目標 → 看得到就打 → 回撤離點），
 * 只有動畫旋鈕不同，跑兩次對照。
 *
 * 這不是機器人基準（那支在 scripts/botrun.ts，完全不碰畫面）——
 * **這一支量的就是畫面**：同樣的一場任務，真人要坐在那裡看多久。
 *
 *   node scripts/pace.mjs
 */
import { chromium } from 'playwright-core';

const URL = process.env.URL || 'http://localhost:4188';
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });

/** 在頁面裡跑一步政策，回傳現況。 */
const POLICY = () => {
  const g = window.__game;
  const s = g.state;
  const me = s.units.find((u) => u.faction === 'PLAYER');
  const out = {
    over: s.result !== 'ONGOING',
    pending: !!s.pendingReinforcement,
    auto: g.test.autoActive(),
    playerTurn: g.test.isPlayerTurn(),
    clock: s.clock,
    mainDone: s.objectives.main.done,
  };
  if (out.over) return out;
  if (out.pending) {
    g.dispatch({ type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] });
    return out;
  }
  if (!out.playerTurn || out.auto || !me) return out;

  // 打得到就打
  const foe = s.units
    .filter((u) => u.faction === 'ENEMY')
    .filter((u) => g.test.canFireAt(u.pos))
    .sort((a, c) => (Math.abs(a.pos.x - me.pos.x) + Math.abs(a.pos.y - me.pos.y))
      - (Math.abs(c.pos.x - me.pos.x) + Math.abs(c.pos.y - me.pos.y)))[0];
  if (foe) {
    if (me.equipped && me.equipped.ammo <= 0) g.dispatch({ type: 'RELOAD' });
    else g.dispatch({ type: 'FIRE', target: { ...foe.pos } });
    return out;
  }
  // 否則走向目標
  const goal = out.mainDone ? s.map.startDropPoint : s.objectives.main.pos;
  const d = Math.abs(goal.x - me.pos.x) + Math.abs(goal.y - me.pos.y);
  if (d <= 1) { g.dispatch({ type: 'INTERACT', pos: { ...goal } }); return out; }
  g.test.tap({ ...goal });
  g.test.tap({ ...goal });
  return out;
};

async function run(preset) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto(`${URL}/?seed=1&map=mission_01`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(300);
  // 這支腳本量的是動畫的牆鐘成本，不是迷霧。先把地圖攤開，
  // 否則「點目標 → 自動尋路」走不進未探索區，整場一步都不會動（插隊版 §3.3）。
  await p.evaluate(() => {
    const g = window.__game;
    g.state.explored = '1'.repeat(g.state.map.width * g.state.map.height);
  });
  if (preset) {
    await p.evaluate((v) => {
      const c = window.__game.test.config();
      c.animation.playerMoveMs = v.player;
      c.animation.enemyMoveMs = v.enemy;
      c.animation.panMs = v.pan;
    }, preset);
  }
  const t0 = Date.now();
  const deadline = t0 + 15 * 60 * 1000;
  let last = null;
  for (;;) {
    last = await p.evaluate(POLICY);
    if (last.over) break;
    if (Date.now() > deadline) break;
    await p.waitForTimeout(40);
  }
  const ms = Date.now() - t0;
  const st = await p.evaluate(() => ({
    clock: window.__game.state.clock, result: window.__game.state.result,
    casualties: window.__game.state.casualties,
  }));
  await ctx.close();
  return { ms, ...st };
}

const CASES = [
  ['預設　　（玩家 80／敵人 180／平移 220）', null],
  ['全部 0　（等同 v0.16）　　　　　　　　', { player: 0, enemy: 0, pan: 0 }],
  ['刻意調慢（玩家 300／敵人 500／平移 600）', { player: 300, enemy: 500, pan: 600 }],
];
const out = [];
for (const [label, preset] of CASES) out.push([label, await run(preset)]);
const fmt = (r) => `${(r.ms / 1000).toFixed(1)} 秒　${r.result}　遊戲時刻 ${r.clock}　陣亡 ${r.casualties}`;
for (const [label, r] of out) console.log(label + '：', fmt(r));
const base = out[1][1].ms;
for (const [label, r] of out) {
  if (r === out[1][1]) continue;
  const d = (r.ms - base) / 1000;
  console.log(`  ${label.trim()} 對「全部 0」：${d >= 0 ? '+' : ''}${d.toFixed(1)} 秒`
    + (Math.abs(d) > 120 ? '　⚠️ 超過兩分鐘' : '　（兩分鐘以內）'));
}
await b.close();
