/**
 * 敵人決策（§9.1）。
 *
 * v0.7 起沒有「敵人回合」：排程器輪到某個敵人時，它**選一個動作**執行，
 * 然後依該動作的時間花費往後推。決策邏輯本身沒有改動，改的只是
 * 「這回合有幾點 AP 可用」變成「這次輪到我，選一個動作」。
 *
 * 硬性要求：
 *  - AI 必須是決定性的。平手一律以固定規則決勝（N, E, S, W），不得使用亂數。
 *  - **AI 不得選擇 0 成本動作**（姿勢、面向），否則排程器會無限迴圈（§5.4）。
 */
import type { EventSink } from './events';
import type { GameState, Unit, Vec2 } from './state';
import { activePlayerUnit, findUnit } from './state';
import { facingToward, manhattan, sameTile } from './grid';
import { unitsSeeEachOther } from './los';
import { effectiveSightRange } from './stance';
import { canAttack, performAttack } from './combat';
import { findPath, occupiedBy } from './pathfind';
import { spend } from './scheduler';
import { RULES } from './content';
import { pushLog } from './log';

/**
 * 敵人偵測（§7.4）：對玩家有視線且在有效視野內。
 * 回傳「應該轉換到哪個狀態」，或 null 代表不需要轉換。
 */
function desiredState(state: GameState, e: Unit): 'ALERT' | 'SEARCH' | null {
  const player = activePlayerUnit(state);
  const canSee =
    !!player &&
    manhattan(e.pos, player.pos) <= effectiveSightRange(e) &&
    unitsSeeEachOther(state.map, e, player);

  if (canSee) return e.aiState === 'ALERT' ? null : 'ALERT';
  if (e.aiState === 'ALERT') return 'SEARCH';
  return null;
}

/**
 * 執行一次狀態轉換，並回傳它花掉的時間（§9.2）。
 *
 * 取代了 v0.6 的「兩段式察覺」特例規則：
 *  - IDLE → ALERT 要花該原型的轉換時間，這一下就是玩家的反應窗口
 *  - SEARCH → ALERT **花 0**，可以立刻接續攻擊 ——
 *    這保留了 v0.6 §4.2 的漏洞修正（反覆進出視線無法製造無限安全的騷擾迴圈），
 *    但現在它是時間成本的自然結果，不是特例。
 *  - ALERT → SEARCH 花 0
 */
function transitionCost(e: Unit, to: 'ALERT' | 'SEARCH'): number {
  if (to === 'ALERT') return e.aiState === 'SEARCH' ? 0 : e.transitionTime;
  return 0;
}

function applyTransition(
  state: GameState, e: Unit, to: 'ALERT' | 'SEARCH', events?: EventSink,
): number {
  const from = e.aiState;
  const cost = transitionCost(e, to);
  events?.push({
    kind: 'AI_STATE', unitId: e.id, pos: { x: e.pos.x, y: e.pos.y }, from, to,
  });
  const player = activePlayerUnit(state);
  if (to === 'ALERT') {
    e.aiState = 'ALERT';
    if (player) e.lastKnownTarget = { x: player.pos.x, y: player.pos.y };
    pushLog(state, 'AI', e.name + (cost > 0 ? ' 發現目標（尚未進入狀況）' : ' 重新鎖定目標'));
  } else {
    e.aiState = 'SEARCH';
    e.searchTimer = RULES.ai.searchTime;
    pushLog(state, 'AI', e.name + ' 失去目標，開始搜索');
  }
  return cost;
}

/** 朝目標走一格。走得動回傳花費的時間，走不動回傳 null。 */
function moveToward(state: GameState, e: Unit, goal: Vec2): number | null {
  const path = findPath(state, e.pos, goal, { allowGoalOccupied: true, ignoreUnitIds: [e.id] });
  if (!path || path.length === 0) return null;
  const next = path[0];
  if (occupiedBy(state, next, [e.id])) return null;
  const f = facingToward(e.pos, next);
  if (f) e.facing = f;
  e.pos = { x: next.x, y: next.y };
  return e.moveTime;
}

/**
 * 排程器輪到這個敵人：選一個動作執行，並回傳它花掉的時間。
 *
 * 保證回傳 > 0（或在完全無事可做時回傳等待時間），
 * 否則排程器會卡在同一個單位上。
 */
export function takeEnemyAction(state: GameState, enemyId: string, events?: EventSink): number {
  const e = findUnit(state, enemyId);
  if (!e || e.faction !== 'ENEMY') return RULES.time.wait;

  // 這一次行動一開始就先清掉「剛轉換完」；只有真的做了耗時的轉換才會再設回 true。
  e.transitioning = false;

  // 1. 需要換狀態的話，這一次的行動就是換狀態（可能花 0，那就接著做事）
  const want = desiredState(state, e);
  if (want) {
    const cost = applyTransition(state, e, want, events);
    if (cost > 0) {
      e.transitioning = true;    // 玩家的反應窗口：已經發現你，但這一下用掉了
      return cost;
    }
  }

  // 2. IDLE：原地不動（MVP 不做巡邏）。仍然要花時間，否則排程器會空轉。
  if (e.aiState === 'IDLE') return RULES.time.wait;

  // 3. ALERT：能打就打，不能打就靠近
  if (e.aiState === 'ALERT') {
    const player = activePlayerUnit(state);
    if (!player) {
      applyTransition(state, e, 'SEARCH', events);
      return RULES.time.wait;
    }
    if (canAttack(state, e, player.pos, e.equipped).ok) {
      const weapon = e.equipped;
      performAttack(state, e.id, player.pos, events);
      return weapon ? weapon.fireTime : RULES.time.wait;
    }
    const moved = moveToward(state, e, player.pos);
    return moved ?? RULES.time.wait;
  }

  // 4. SEARCH：往最後已知位置走，時間耗盡就放棄
  if (
    e.searchTimer <= 0 ||
    !e.lastKnownTarget ||
    sameTile(e.pos, e.lastKnownTarget)
  ) {
    events?.push({
      kind: 'AI_STATE', unitId: e.id, pos: { x: e.pos.x, y: e.pos.y }, from: e.aiState, to: 'IDLE',
    });
    e.aiState = 'IDLE';
    e.lastKnownTarget = null;
    pushLog(state, 'AI', e.name + ' 放棄搜索');
    return RULES.time.wait;
  }
  const moved = moveToward(state, e, e.lastKnownTarget);
  const cost = moved ?? RULES.time.wait;
  e.searchTimer -= cost;         // 搜索是時間量，不是回合數
  return cost;
}

/** 排程器驅動用：讓這個敵人做一件事並付出時間代價。 */
export function stepEnemy(state: GameState, enemyId: string, events?: EventSink): void {
  const cost = takeEnemyAction(state, enemyId, events);
  spend(state, enemyId, Math.max(1, cost));
}
