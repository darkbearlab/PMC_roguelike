/**
 * 移動合法性與尋路（§5.3 / §6）。
 *
 * 所有移動成本一律 1 AP（含斜向），所以最短路徑用 BFS 就是最佳解，
 * 不需要 A*。鄰居展開順序固定為 N, NE, E, SE, S, SW, W, NW，
 * 保證平手時的結果完全決定性（§9.1 要求 AI 不得用亂數決勝）。
 */
import type { GameState, Vec2 } from './state';
import { blocksMovement, inBounds } from './map';
import { DIRECTIONS, DIR_VEC, sameTile } from './grid';
import { RULES } from './content';

export interface PathOptions {
  /** 目標格即使被單位佔據也允許作為終點（AI 追人時用）。 */
  allowGoalOccupied?: boolean;
  /** 這些單位視為不存在（通常是移動者自己）。 */
  ignoreUnitIds?: string[];
}

/** 地形是否可站（不含單位佔據）。 */
export function terrainPassable(state: GameState, pos: Vec2): boolean {
  return inBounds(state.map, pos) && !blocksMovement(state.map, pos);
}

export function occupiedBy(state: GameState, pos: Vec2, ignoreUnitIds: string[] = []): string | null {
  const u = state.units.find(
    (x) => x.pos.x === pos.x && x.pos.y === pos.y && !ignoreUnitIds.includes(x.id),
  );
  return u ? u.id : null;
}

/**
 * 斜向切角規則（§5.3）。
 *
 * STRICT   ：任一相鄰正交格為阻擋物就禁止斜穿（標準「禁止切角」）。
 * GAP_ONLY ：只有當兩個正交格都是阻擋物時才禁止（§5.3 的字面解）。
 *
 * 預設 STRICT。要改的話動 data/rules.json 的 movement.diagonalCornerRule 一個字串即可，
 * 程式碼不用動。屍體不算阻擋物（§10.2），這裡只看地形。
 */
export function diagonalAllowed(state: GameState, from: Vec2, to: Vec2): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 || dy === 0) return true;
  const sideA = blocksMovement(state.map, { x: from.x + dx, y: from.y });
  const sideB = blocksMovement(state.map, { x: from.x, y: from.y + dy });
  return RULES.movement.diagonalCornerRule === 'GAP_ONLY'
    ? !(sideA && sideB)
    : !(sideA || sideB);
}

/** 單步移動是否合法：相鄰、地形可通行、無單位佔據、不切角。 */
export function canStep(
  state: GameState,
  from: Vec2,
  to: Vec2,
  opts: PathOptions = {},
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return false;
  if (!terrainPassable(state, to)) return false;
  if (occupiedBy(state, to, opts.ignoreUnitIds ?? [])) return false;
  return diagonalAllowed(state, from, to);
}

const key = (p: Vec2): number => p.y * 1024 + p.x;

/**
 * BFS 最短路。回傳不含起點、含終點的座標序列；無路可走回傳 null。
 * 路徑長度即為所需 AP（每步 1 AP）。
 */
export function findPath(
  state: GameState,
  from: Vec2,
  goal: Vec2,
  opts: PathOptions = {},
): Vec2[] | null {
  if (sameTile(from, goal)) return [];
  if (!terrainPassable(state, goal)) return null;

  const ignore = opts.ignoreUnitIds ?? [];
  const prev = new Map<number, Vec2 | null>();
  prev.set(key(from), null);
  const queue: Vec2[] = [from];
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    for (const d of DIRECTIONS) {
      const v = DIR_VEC[d];
      const nxt = { x: cur.x + v.x, y: cur.y + v.y };
      const k = key(nxt);
      if (prev.has(k)) continue;
      if (!terrainPassable(state, nxt)) continue;
      if (!diagonalAllowed(state, cur, nxt)) continue;

      const isGoal = sameTile(nxt, goal);
      if (occupiedBy(state, nxt, ignore) && !(isGoal && opts.allowGoalOccupied)) continue;

      prev.set(k, cur);
      if (isGoal) {
        const path: Vec2[] = [];
        let node: Vec2 | null = nxt;
        while (node && !sameTile(node, from)) {
          path.push(node);
          node = prev.get(key(node)) ?? null;
        }
        path.reverse();
        return path;
      }
      queue.push(nxt);
    }
  }
  return null;
}

/** 找出最靠近 origin、且沒有單位佔據的指定地形格（增援落點用，§10.1）。 */
export function nearestFreeTileOfType(
  state: GameState,
  origin: Vec2,
  candidates: Vec2[],
): Vec2 | null {
  let best: Vec2 | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    if (occupiedBy(state, c)) continue;
    // 以實際步行距離為準；走不到的落點退回用直線距離排序（仍然決定性）。
    const path = findPath(state, origin, c);
    const walk = path ? path.length : Number.POSITIVE_INFINITY;
    const straight = Math.max(Math.abs(c.x - origin.x), Math.abs(c.y - origin.y));
    const score = walk === Number.POSITIVE_INFINITY ? 100000 + straight : walk;
    // 平手時取 y 小、再取 x 小的，保持決定性。
    if (
      score < bestScore ||
      (score === bestScore && best !== null && (c.y < best.y || (c.y === best.y && c.x < best.x)))
    ) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}
