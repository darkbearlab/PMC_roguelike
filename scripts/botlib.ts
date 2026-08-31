/**
 * 機器人的共用實作。`botrun.ts` 與 `diag-factors.ts` 共用同一隻機器人 ——
 * **因子分離的對照組必須跟基準跑同一套邏輯**，否則比較不成立。
 */
import { createInitialState } from '../src/core/setup';
import { applyCommand, checkLegal, isDropActivated } from '../src/core/commands';
import type { Command } from '../src/core/commands';

/** applyCommand 現在回傳 { state, events }（§8.6）；這支探針只看狀態。 */
const run = (s: GameState, c: Command): GameState => applyCommand(s, c).state;
import { findPath, stepDirection, terrainPassable } from '../src/core/pathfind';
import { isExplored } from '../src/core/fog';
import { isPlayerTurn } from '../src/core/scheduler';
import { activePlayerUnit, unitAt } from '../src/core/state';
import { canAttack, canAttackAny } from '../src/core/combat';
import { facingFromDelta, manhattan, sameTile } from '../src/core/grid';
import { MAPS, RULES } from '../src/core/content';
import type { RawMap } from '../src/core/map';
import { countAmmo, effectiveMoveTime } from '../src/core/inventory';
import { playerDefence } from '../src/core/cover';
import { interruptOf } from '../src/core/sequence';
import type { Facing, GameState, Vec2 } from '../src/core/state';

function botAction(s: GameState, goal: Vec2): GameState {
  const u = activePlayerUnit(s);
  if (!u) return s;
  // 承諾中的序列：笨機器人一律走完，不中止
  // 序列走到一半：須重來的（治療）一旦有人瞄得到就放棄，別把 40 時間丟進火裡
  if (u.pendingSequence) {
    const restart = interruptOf(u.pendingSequence.id) === 'RESTART';
    if (restart && playerDefence(s).threats > 0) return run(s, { type: 'ABORT_SEQUENCE' });
    return run(s, { type: 'SEQUENCE_STEP' });
  }
  // v0.12：血少又沒人瞄得到就包紮。條件刻意簡單 ——
  // 「沒人看得到我」正是封合劑那 40 時間唯一走得完的時候（§4）。
  const hurt = u.hp <= u.maxHp * 0.5;
  if (hurt && playerDefence(s).threats === 0) {
    if (u.preparedId) {
      const used = run(s, { type: 'USE_ITEM' });
      if (used !== s) return used;
    } else {
      const kit = u.backpack?.items.find((it) => it.kind === 'CONSUMABLE');
      if (kit) {
        const prepped = run(s, { type: 'PREPARE', itemId: kit.id });
        if (prepped !== s) return prepped;
      }
    }
  }

  // 腳邊的空投點順手啟用 —— 真人會這麼做，而那正是這一版要量的「保險」
  for (const p of dropsNear(s, u.pos)) {
    if (checkLegal(s, { type: 'INTERACT', pos: p }).ok) {
      return run(s, { type: 'INTERACT', pos: p });
    }
  }

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
    if (!canAttackAny(s, u, e.pos).ok) continue;
    const d = manhattan(u.pos, e.pos);
    if (d < best) { best = d; target = e.pos; }
  }
  if (target) return run(s, { type: 'FIRE', target });
  if (u.equipped && u.equipped.ammo === 0) {
    const reloaded = run(s, { type: 'RELOAD' });
    if (reloaded !== s) return reloaded;
  }
  const step = nextStep(s, u.pos, goal);
  if (step) {
    const dir = stepDirection(u.pos, step);
    if (dir) {
      const next = run(s, { type: 'MOVE', dir: dir as Facing });
      if (next !== s) return next;
    }
  }
  // 迷霧：目標還在黑的地方，就先往最靠近目標的「已知邊緣」走過去，再踏出去一步。
  // **方向鍵不受迷霧限制**，探索本來就是一步一步走出來的。
  if (RULES.fog.enabled) {
    const explored = exploreStep(s, u.pos, goal);
    if (explored) {
      const next = run(s, { type: 'MOVE', dir: explored });
      if (next !== s) return next;
    }
  }
  plan = null;                 // 走不動就重算
  return run(s, { type: 'WAIT' });
}

/** 腳邊（含自己這一格）還沒啟用的空投點。 */
function dropsNear(s: GameState, at: Vec2): Vec2[] {
  const out: Vec2[] = [];
  for (const d of [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]]) {
    const p = { x: at.x + d[0], y: at.y + d[1] };
    if (p.x < 0 || p.y < 0 || p.x >= s.map.width || p.y >= s.map.height) continue;
    if (s.map.tiles[p.y * s.map.width + p.x] !== 'DROP_POINT') continue;
    if (isDropActivated(s, p)) continue;
    out.push(p);
  }
  return out;
}

/**
 * 迷霧下的探索：往最靠近目標的「已知邊緣」推進一步。
 *
 * 邊緣 = 已探索、可通行、而且有一個未探索的鄰居。
 * 站在邊緣上就直接踏進黑的那一格；還沒到就沿著已探索的路走過去。
 * 平手時取離目標近的、再取 y 小 x 小的 —— 保持決定性。
 */
function exploreStep(s: GameState, from: Vec2, goal: Vec2): Facing | null {
  const { width, height } = s.map;
  const dirs: Facing[] = ['N', 'E', 'S', 'W'];
  const dv: Record<string, Vec2> = {
    N: { x: 0, y: -1 }, E: { x: 1, y: 0 }, S: { x: 0, y: 1 }, W: { x: -1, y: 0 },
  };
  const free = (p: Vec2): boolean =>
    p.x >= 0 && p.y >= 0 && p.x < width && p.y < height && terrainPassable(s, p);

  // 站在邊緣上 → 踏進**離目標最近**的那一格黑地。
  // 不挑方向的話它會往北往東亂走，然後在地圖角落把時間燒光。
  let stepDir: Facing | null = null;
  let stepScore = Number.POSITIVE_INFINITY;
  for (const d of dirs) {
    const n = { x: from.x + dv[d].x, y: from.y + dv[d].y };
    if (!free(n) || isExplored(s, n) || unitAt(s, n)) continue;
    const score = manhattan(n, goal);
    if (score < stepScore) { stepScore = score; stepDir = d; }
  }
  if (stepDir) return stepDir;

  // 否則在**已探索且走得到**的範圍內找一個邊緣，往它走一步。
  // 只用一次 BFS：先算出走得到哪裡，再從走得到的那些格子裡挑最靠近目標的邊緣。
  const key = (p: Vec2): number => p.y * 1024 + p.x;
  const prev = new Map<number, Vec2 | null>([[key(from), null]]);
  const queue: Vec2[] = [from];
  let best: Vec2 | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    // 這一格是不是邊緣（有一個未探索的可通行鄰居）
    for (const d of dirs) {
      const n = { x: cur.x + dv[d].x, y: cur.y + dv[d].y };
      if (!free(n) || isExplored(s, n)) continue;
      const score = manhattan(cur, goal);
      if (score < bestScore) { bestScore = score; best = cur; }
      break;
    }
    for (const d of dirs) {
      const n = { x: cur.x + dv[d].x, y: cur.y + dv[d].y };
      if (!free(n) || !isExplored(s, n)) continue;
      if (unitAt(s, n)) continue;
      const k = key(n);
      if (prev.has(k)) continue;
      prev.set(k, cur);
      queue.push(n);
    }
  }
  if (!best || sameTile(best, from)) return null;

  // 沿 parent 鏈回推到第一步
  let node: Vec2 = best;
  for (;;) {
    const parent = prev.get(key(node)) ?? null;
    if (!parent) return null;
    if (sameTile(parent, from)) return stepDirection(from, node);
    node = parent;
  }
}

/**
 * 機器人的路徑記憶。
 *
 * 每個動作都重算最短路的話，遇到會移動的擋路者就會在兩格之間來回震盪：
 * 在 A 算出要走 B，走到 B 時敵人剛好挪開／擋住，又算出要走回 A。
 * 實測在 mission_03 上真的發生了，跑掉兩萬次迴圈還沒走到終點。
 *
 * 真人玩家不會這樣 —— 他用的是自動移動，那會**沿著一條算好的路徑走**（§12.4）。
 * 這裡照做：算一次、沿著走，走不動了才重算。
 */
let plan: Vec2[] | null = null;

function nextStep(s: GameState, from: Vec2, goal: Vec2): Vec2 | null {
  const valid = plan
    && plan.length > 0
    && manhattan(from, plan[0]) <= 2      // 翻越那一步是兩格（v0.19）
    && stepDirection(from, plan[0]) !== null
    && !unitAt(s, plan[0]);
  if (!valid) {
    const me = activePlayerUnit(s)!;
    // 迷霧開著時，機器人只能走已探索的路 —— 它現在也要探索（§6 的量測就是這件事）
    const fresh = findPath(s, from, goal, {
      ignoreUnitIds: [me.id],
      stepCost: effectiveMoveTime(me),
      vaultCost: RULES.time.vault,
      exploredOnly: RULES.fog.enabled,
    });
    plan = fresh && fresh.length > 0 && !unitAt(s, fresh[0]) ? fresh : null;
  }
  if (!plan || plan.length === 0) return null;
  return plan.shift() ?? null;
}

/**
 * v0.10 §8.3：戰術 AI 的效果只能靠對照判斷。
 * 同一支笨機器人、同一組種子，開關關掉與打開各跑一次。
 */
/**
 * 固定的五個種子。v0.15 學到的事：**五個種子不夠**。
 * 同一份數值在這五個上是 4/5，換二十個種子卻是 16/20 ——
 * 判斷一次改動有沒有造成系統性偏移時，用 `SEEDS=` 換一組大樣本再比。
 *   SEEDS=1,138,275,412,... npx tsx scripts/botrun.ts
 */
export const SEEDS = process.env.SEEDS
  ? process.env.SEEDS.split(',').map(Number)
  : [1, 42, 999, 20260826, 7777];

export function runOne(seed: number, map?: RawMap): {
  seed: number; result: string; clock: number; deployed: number; casualties: number;
  main: boolean; foes: number; ammoUsed: number; carried: number;
} {
  let s = createInitialState(seed, map);
  plan = null;
  let guard = 0;
  while (s.result === 'ONGOING' && guard++ < 20000) {
    if (s.pendingReinforcement) { s = run(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] }); continue; }
    if (!isPlayerTurn(s)) { s = run(s, { type: 'ADVANCE' }); continue; }
    s = botAction(s, s.objectives.main.done ? s.map.startDropPoint : s.objectives.main.pos);
  }
  const foes = s.units.filter((u) => u.faction === 'ENEMY').length;
  // 耗彈量：投入的總攜行量減去還在身上的（背包 + 槍內）
  const start = RULES.backpack.startingItems.find((i) => i.defId === 'standard_5.56');
  const issued = (start ? start.qty : 0) * s.deployed;
  const me = s.units.find((u) => u.faction === 'PLAYER');
  const left = me
    ? countAmmo(me.backpack, 'standard_5.56')
      + (me.equipped && me.equipped.calibre === '5.56' ? me.equipped.ammo : 0)
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

