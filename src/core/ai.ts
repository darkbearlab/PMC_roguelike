/**
 * 敵人決策（§9.1）。
 *
 * 硬性要求：AI 必須是決定性的。平手一律以固定規則決勝
 * （鄰居展開順序 N, NE, E, SE, S, SW, W, NW，見 pathfind.ts），不得使用亂數。
 *
 * 一次 stepEnemy() 只做一個動作（移動一格 / 攻擊一次 / 一次狀態轉換），
 * 讓 UI 可以逐步播放敵人回合，玩家看得到發生了什麼。
 */
import type { GameState, Unit, Vec2 } from './state';
import { activePlayerUnit, findUnit } from './state';
import { manhattan, facingToward, sameTile } from './grid';
import { unitsSeeEachOther } from './los';
import { canAttack, performAttack } from './combat';
import { findPath, occupiedBy } from './pathfind';
import { RULES } from './content';
import { pushLog } from './log';

/** CONTINUE = 這個敵人可能還能再動；DONE = 從行動佇列移除。 */
export type StepOutcome = 'CONTINUE' | 'DONE';

/** 敵人回合開始：補滿 AP、清空本回合攻擊次數、SEARCH 計時遞減、建立行動佇列。 */
export function beginEnemyTurn(state: GameState): void {
  const ids = state.units
    .filter((u) => u.faction === 'ENEMY')
    .map((u) => u.id)
    .sort();
  for (const id of ids) {
    const e = findUnit(state, id);
    if (!e) continue;
    e.ap = e.maxAp;
    e.shotsThisTurn = 0;
    if (e.aiState === 'SEARCH' && e.searchTimer > 0) e.searchTimer -= 1;
  }
  state.enemyQueue = ids;
}

/**
 * 偵測（§7.4）：對玩家單位有視線且距離 <= sightRange 則進入 ALERT。
 * 面向不影響視野（360 度）。每一步都重新檢查，讓「移動途中取得視線」也能生效。
 */
function perceive(state: GameState, e: Unit): void {
  const player = activePlayerUnit(state);
  const canSee =
    !!player &&
    manhattan(e.pos, player.pos) <= e.sightRange &&
    unitsSeeEachOther(state.map, e, player);

  if (canSee && player) {
    if (e.aiState !== 'ALERT') pushLog(state, 'AI', e.name + ' 發現目標');
    e.aiState = 'ALERT';
    e.lastKnownTarget = { x: player.pos.x, y: player.pos.y };
    return;
  }
  if (e.aiState === 'ALERT') {
    e.aiState = 'SEARCH';
    e.searchTimer = RULES.ai.searchTimer;
    pushLog(state, 'AI', e.name + ' 失去目標，開始搜索');
  }
}

/**
 * 朝目標走一格。有移動（= 有消耗 AP）回傳 CONTINUE，走不動回傳 DONE。
 *
 * 目標格一律允許被佔據：搜索時的 lastKnownTarget 很可能就是玩家現在站的地方，
 * 若不允許就會整條路徑算不出來、敵人原地發呆。真正的「不能走進去」由下一步的
 * 佔據檢查擋下（走到相鄰就停）。
 */
function moveToward(state: GameState, e: Unit, goal: Vec2): StepOutcome {
  if (e.ap < RULES.ap.moveCost) return 'DONE';
  const path = findPath(state, e.pos, goal, { allowGoalOccupied: true, ignoreUnitIds: [e.id] });
  if (!path || path.length === 0) return 'DONE';
  const next = path[0];
  // 下一步是目標本人所在的格 → 走不進去，維持原地。
  if (occupiedBy(state, next, [e.id])) return 'DONE';

  const f = facingToward(e.pos, next);
  if (f) e.facing = f;
  e.pos = { x: next.x, y: next.y };
  e.ap -= RULES.ap.moveCost;
  return 'CONTINUE';
}

/**
 * 執行一個敵人的單一動作。
 * 保證：回傳 CONTINUE 時一定有消耗 AP，因此驅動迴圈不會空轉。
 */
export function stepEnemy(state: GameState, enemyId: string): StepOutcome {
  const e = findUnit(state, enemyId);
  if (!e || e.faction !== 'ENEMY') return 'DONE';

  perceive(state, e);
  if (e.ap <= 0) return 'DONE';

  // ---- IDLE：原地不動（MVP 不做巡邏）----
  if (e.aiState === 'IDLE') return 'DONE';

  // ---- ALERT ----
  if (e.aiState === 'ALERT') {
    const player = activePlayerUnit(state);
    if (!player) {
      // 目標已陣亡：退回搜索最後已知位置，本回合到此為止。
      e.aiState = 'SEARCH';
      e.searchTimer = RULES.ai.searchTimer;
      return 'DONE';
    }
    const weapon = e.equipped;
    if (canAttack(state, e, player.pos, weapon).ok) {
      performAttack(state, e.id, player.pos);
      return 'CONTINUE';
    }
    // 已達本回合攻擊上限且目標仍在射程內 → 原地待命，不做無意義的位移。
    if (weapon && e.shotsThisTurn >= e.attacksPerTurn && manhattan(e.pos, player.pos) <= weapon.range) {
      return 'DONE';
    }
    return moveToward(state, e, player.pos);
  }

  // ---- SEARCH ----
  if (
    e.searchTimer <= 0 ||
    !e.lastKnownTarget ||
    sameTile(e.pos, e.lastKnownTarget)
  ) {
    e.aiState = 'IDLE';
    e.lastKnownTarget = null;
    pushLog(state, 'AI', e.name + ' 放棄搜索');
    return 'DONE';
  }
  return moveToward(state, e, e.lastKnownTarget);
}
