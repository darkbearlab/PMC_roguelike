/**
 * 行動排程器（§5）。
 *
 * v0.7 起沒有「回合」也沒有 AP。每個單位有一個 nextActAt，
 * 主迴圈永遠挑 nextActAt 最小的單位行動：
 *
 *   1. 找出所有存活單位中 nextActAt 最小者
 *   2. clock 前進到該單位的 nextActAt
 *   3. 該單位執行**恰好一個**動作
 *   4. 該單位 nextActAt += 動作的時間花費
 *   5. 回到 1
 *
 * 動作的效果在執行的當下**立即結算**，不模擬前搖。
 * 精準的說法是：「這一槍立刻打出去，但你接下來的 N 個時間單位無法行動」。
 */
import type { GameState, Unit } from './state';
import { findUnit } from './state';

/**
 * 同時刻的順序（§5.3）。必須完全明確，否則決定論會壞。
 *   1. 玩家單位優先
 *   2. 其次依 units 陣列中的索引順序
 * **不得使用亂數。**
 */
function comesFirst(a: Unit, ai: number, b: Unit, bi: number): boolean {
  if (a.nextActAt !== b.nextActAt) return a.nextActAt < b.nextActAt;
  const aPlayer = a.faction === 'PLAYER';
  const bPlayer = b.faction === 'PLAYER';
  if (aPlayer !== bPlayer) return aPlayer;
  return ai < bi;
}

/** 現在輪到誰行動。沒有單位時回傳 null。 */
export function activeUnit(state: GameState): Unit | null {
  let best: Unit | null = null;
  let bestIndex = -1;
  state.units.forEach((u, i) => {
    if (best === null || comesFirst(u, i, best, bestIndex)) {
      best = u;
      bestIndex = i;
    }
  });
  return best;
}

export function activeUnitId(state: GameState): string | null {
  const u = activeUnit(state);
  return u ? u.id : null;
}

/** 現在是不是輪到玩家操作的那個士兵。 */
export function isPlayerTurn(state: GameState): boolean {
  if (state.result !== 'ONGOING' || state.pendingReinforcement) return false;
  const u = activeUnit(state);
  return !!u && u.id === state.activePlayerUnitId;
}

/** 任務是否已經結束。取代了原本的 phase === 'MISSION_END'。 */
export function isMissionOver(state: GameState): boolean {
  return state.result !== 'ONGOING';
}

/**
 * 讓一個單位付出時間代價。這是**唯一**推進單位時刻的地方。
 *
 * cost 為 0 時（姿勢、面向）單位不讓出行動權，仍然是 active ——
 * 這是刻意的，但也代表 AI 絕對不能選 0 成本動作，否則會無限迴圈（§5.4）。
 */
export function spend(state: GameState, unitId: string, cost: number): void {
  const u = findUnit(state, unitId);
  if (!u) return;
  u.nextActAt = state.clock + cost;
  // transitioning 由 ai.ts 自己管：它必須在轉換的那一次行動之後**留著**，
  // 那就是玩家的反應窗口。放在這裡清會把它當場抹掉。
}

/**
 * 把 clock 推進到目前該行動的單位身上。
 * 在執行任何動作之前呼叫，確保 spend() 是以正確的當下時刻計算。
 */
export function syncClock(state: GameState): void {
  const u = activeUnit(state);
  if (u && u.nextActAt > state.clock) state.clock = u.nextActAt;
}
