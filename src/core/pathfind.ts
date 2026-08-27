/**
 * 移動合法性與尋路（§6）。
 *
 * v0.3 起只能四方向移動、每步花的時間相同，所以最短路徑用 BFS 就是最佳解，不需要 A*。
 * 鄰居展開順序固定為 N, E, S, W，保證平手時的結果完全決定性
 * （§9.1 要求 AI 不得用亂數決勝）。
 *
 * 取消斜向之後，原本的「斜向切角」規則連同它的歧義一起消失了。
 */
import type { GameState, Vec2 } from './state';
import { blocksMovement, inBounds } from './map';
import { DIR_VEC, MOVE_DIRECTIONS, sameTile } from './grid';

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

/** 這一步是不是正交的一格（斜向一律不合法）。 */
export function isOrthogonalStep(from: Vec2, to: Vec2): boolean {
  return Math.abs(to.x - from.x) + Math.abs(to.y - from.y) === 1;
}

/** 單步移動是否合法：正交相鄰、地形可通行、無單位佔據。 */
export function canStep(
  state: GameState,
  from: Vec2,
  to: Vec2,
  opts: PathOptions = {},
): boolean {
  if (!isOrthogonalStep(from, to)) return false;
  if (!terrainPassable(state, to)) return false;
  return !occupiedBy(state, to, opts.ignoreUnitIds ?? []);
}

const key = (p: Vec2): number => p.y * 1024 + p.x;

/**
 * BFS 最短路。回傳不含起點、含終點的座標序列；無路可走回傳 null。
 * 路徑長度 × 該單位的移動時間，就是走完這條路要花的時間（§5.2）。
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
    for (const d of MOVE_DIRECTIONS) {
      const v = DIR_VEC[d];
      const nxt = { x: cur.x + v.x, y: cur.y + v.y };
      const k = key(nxt);
      if (prev.has(k)) continue;
      if (!terrainPassable(state, nxt)) continue;

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
    const straight = Math.abs(c.x - origin.x) + Math.abs(c.y - origin.y);
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
