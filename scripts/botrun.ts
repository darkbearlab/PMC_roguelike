/** 跑幾場笨機器人，看看難度落點大概在哪（僅供調參參考，不是測試）。 */
import { createInitialState } from '../src/core/setup';
import { applyCommand, checkLegal } from '../src/core/commands';
import type { Command } from '../src/core/commands';

/** applyCommand 現在回傳 { state, events }（§8.6）；這支探針只看狀態。 */
const run = (s: GameState, c: Command): GameState => applyCommand(s, c).state;
import { findPath } from '../src/core/pathfind';
import { isPlayerTurn } from '../src/core/scheduler';
import { activePlayerUnit, unitAt } from '../src/core/state';
import { canAttack } from '../src/core/combat';
import { facingFromDelta, manhattan } from '../src/core/grid';
import { RULES } from '../src/core/content';
import { countAmmo } from '../src/core/inventory';
import type { Facing, GameState, Vec2 } from '../src/core/state';

function botAction(s: GameState, goal: Vec2): GameState {
  const u = activePlayerUnit(s);
  if (!u) return s;
  // 承諾中的序列：笨機器人一律走完，不中止
  if (u.pendingSequence) return run(s, { type: 'SEQUENCE_STEP' });
  // 腳邊有東西就拿（笨機器人不挑，全拿）
  const pile = s.loot.find(
    (c) => manhattan(c.pos, u.pos) <= 1 && checkLegal(s, { type: 'TAKE_ALL', lootId: c.id }).ok,
  );
  if (pile) return run(s, { type: 'TAKE_ALL', lootId: pile.id });
  if (manhattan(u.pos, goal) <= 1) {
    const acted = run(s, { type: 'INTERACT', pos: goal });
    if (acted !== s) return acted;
    return run(s, { type: 'WAIT' });
  }
  let target: Vec2 | null = null;
  let best = Infinity;
  for (const e of s.units) {
    if (e.faction !== 'ENEMY') continue;
    if (!canAttack(s, u, e.pos, u.equipped).ok) continue;
    const d = manhattan(u.pos, e.pos);
    if (d < best) { best = d; target = e.pos; }
  }
  if (target) return run(s, { type: 'FIRE', target });
  if (u.equipped && u.equipped.ammo === 0) return run(s, { type: 'RELOAD' });
  const path = findPath(s, u.pos, goal, { ignoreUnitIds: [u.id] });
  if (path && path.length > 0 && !unitAt(s, path[0])) {
    const dir = facingFromDelta(path[0].x - u.pos.x, path[0].y - u.pos.y);
    if (dir) {
      const next = run(s, { type: 'MOVE', dir: dir as Facing });
      if (next !== s) return next;
    }
  }
  return run(s, { type: 'WAIT' });
}

/**
 * v0.10 §8.3：戰術 AI 的效果只能靠對照判斷。
 * 同一支笨機器人、同一組種子，開關關掉與打開各跑一次。
 */
const SEEDS = [1, 42, 999, 20260826, 7777];

function runOne(seed: number): {
  seed: number; result: string; clock: number; deployed: number; casualties: number;
  main: boolean; foes: number; ammoUsed: number; carried: number;
} {
  let s = createInitialState(seed);
  let guard = 0;
  while (s.result === 'ONGOING' && guard++ < 20000) {
    if (s.pendingReinforcement) { s = run(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] }); continue; }
    if (!isPlayerTurn(s)) { s = run(s, { type: 'ADVANCE' }); continue; }
    s = botAction(s, s.objectives.main.done ? s.map.startDropPoint : s.objectives.main.pos);
  }
  const foes = s.units.filter((u) => u.faction === 'ENEMY').length;
  // 耗彈量：投入的總攜行量減去還在身上的（背包 + 槍內）
  const start = RULES.backpack.startingItems.find((i) => i.defId === 'AMMO_RIFLE');
  const issued = (start ? start.qty : 0) * s.deployed;
  const me = s.units.find((u) => u.faction === 'PLAYER');
  const left = me
    ? countAmmo(me.backpack, 'RIFLE') + (me.equipped && me.equipped.ammoType === 'RIFLE' ? me.equipped.ammo : 0)
    : 0;
  return {
    seed,
    result: s.result,
    clock: s.clock,
    deployed: s.deployed,
    casualties: s.casualties,
    main: s.objectives.main.done,
    foes,
    ammoUsed: issued - left,
    carried: s.extracted.length,
  };
}

function report(label: string): void {
  console.log('');
  console.log('=== ' + label + ' ===');
  const rows = SEEDS.map(runOne);
  for (const r of rows) {
    console.log(
      `seed ${String(r.seed).padStart(9)} → ${r.result.padEnd(8)}`,
      `時刻 ${String(r.clock).padStart(5)}`,
      `投入 ${r.deployed}`, `陣亡 ${r.casualties}`,
      `主目標 ${r.main ? '✓' : '✗'}`,
      `殘敵 ${String(r.foes).padStart(2)}/10`,
      `耗彈 ${String(r.ammoUsed).padStart(3)}`,
      `帶出 ${r.carried}`,
    );
  }
  const n = rows.length;
  const avg = (f: (r: typeof rows[number]) => number): string => (rows.reduce((a, r) => a + f(r), 0) / n).toFixed(1);
  console.log(
    `平均：時刻 ${avg((r) => r.clock)}`,
    `投入 ${avg((r) => r.deployed)}`,
    `陣亡 ${avg((r) => r.casualties)}`,
    `殘敵 ${avg((r) => r.foes)}`,
    `耗彈 ${avg((r) => r.ammoUsed)}`,
    `｜成功 ${rows.filter((r) => r.result === 'SUCCESS').length}/${n}`,
    `主目標 ${rows.filter((r) => r.main).length}/${n}`,
  );
}

RULES.ai.tacticalBehaviour = false;
report('v0.9 行為（tacticalBehaviour 關）');
RULES.ai.tacticalBehaviour = true;
report('v0.10 戰術 AI（tacticalBehaviour 開）');
