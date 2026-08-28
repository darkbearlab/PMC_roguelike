/** 跑幾場笨機器人，看看難度落點大概在哪（僅供調參參考，不是測試）。 */
import { createInitialState } from '../src/core/setup';
import { applyCommand, checkLegal } from '../src/core/commands';
import type { Command } from '../src/core/commands';

/** applyCommand 現在回傳 { state, events }（§8.6）；這支探針只看狀態。 */
const run = (s: GameState, c: Command): GameState => applyCommand(s, c).state;
import { findPath, stepDirection } from '../src/core/pathfind';
import { isPlayerTurn } from '../src/core/scheduler';
import { activePlayerUnit, unitAt } from '../src/core/state';
import { canAttack } from '../src/core/combat';
import { facingFromDelta, manhattan } from '../src/core/grid';
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
  const step = nextStep(s, u.pos, goal);
  if (step) {
    const dir = stepDirection(u.pos, step);
    if (dir) {
      const next = run(s, { type: 'MOVE', dir: dir as Facing });
      if (next !== s) return next;
    }
  }
  plan = null;                 // 走不動就重算
  return run(s, { type: 'WAIT' });
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
    const fresh = findPath(s, from, goal, {
      ignoreUnitIds: [me.id],
      stepCost: effectiveMoveTime(me),
      vaultCost: RULES.time.vault,
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
const SEEDS = process.env.SEEDS
  ? process.env.SEEDS.split(',').map(Number)
  : [1, 42, 999, 20260826, 7777];

function runOne(seed: number, map?: RawMap): {
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

function report(label: string, map?: RawMap): void {
  console.log('');
  console.log('=== ' + label + ' ===');
  const rows = SEEDS.map((seed) => runOne(seed, map));
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

// v0.11：四張圖各跑一次（§13.3）。
// 這是本次最實際的收穫 —— 第一次拿到「同一組數值在四種幾何下的表現」。
for (const m of MAPS) report(m.id + '「' + m.name + '」', m);

// v0.10 的 A/B 仍然保留：戰術 AI 的效果只能靠對照判斷。
// 拿掩體最密的那張圖來比，才看得出 targetExposure 有沒有東西可用。
const arena = MAPS[MAPS.length - 1];
RULES.ai.tacticalBehaviour = false;
report('A/B：' + arena.name + '・tacticalBehaviour 關（= v0.9）', arena);
RULES.ai.tacticalBehaviour = true;
report('A/B：' + arena.name + '・tacticalBehaviour 開（= v0.10）', arena);
