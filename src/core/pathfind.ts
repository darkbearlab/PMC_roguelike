/**
 * 移動合法性與尋路（§6）。
 *
 * v0.3 起只能四方向移動、每步花的時間相同，所以最短路徑用 BFS 就是最佳解，不需要 A*。
 * 鄰居展開順序固定為 N, E, S, W，保證平手時的結果完全決定性
 * （§9.1 要求 AI 不得用亂數決勝）。
 *
 * 取消斜向之後，原本的「斜向切角」規則連同它的歧義一起消失了。
 */
import type { Facing, GameState, Vec2 } from './state';
import { blocksMovement, inBounds, isHalfCover } from './map';
import { DIR_VEC, MOVE_DIRECTIONS, facingFromDelta, sameTile } from './grid';

export interface PathOptions {
  /** 目標格即使被單位佔據也允許作為終點（AI 追人時用）。 */
  allowGoalOccupied?: boolean;
  /** 這些單位視為不存在（通常是移動者自己）。 */
  ignoreUnitIds?: string[];
  /**
   * 一步與一次翻越各值多少（v0.19）。省略時都算 1 ——
   * 那等同 v0.18 以前的 BFS 行為，路徑長度就是步數。
   * 要算**時間**的地方（尋路預覽、AI）請傳實際的時間成本。
   */
  stepCost?: number;
  vaultCost?: number;
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
 * 翻越（v0.19 §1.1）：從 `from` 跨過相鄰的半身掩體，落在掩體正對面那一格。
 *
 * **翻越是跨過去，不是站上去。**任何單位都不得停留在半身掩體格上 ——
 * 否則就得回答「站在半身掩體上的人算不算有掩蔽」「他看不看得過去」，
 * 那會弄壞整組視線與掩蔽規則（§7）。跨過去完全迴避這個問題。
 *
 * `WALL` 永遠不可翻越。
 *
 * @returns 落地格；不合法時回傳 null。
 */
export function vaultTarget(
  state: GameState, from: Vec2, dir: Facing, opts: PathOptions = {},
): Vec2 | null {
  const v = DIR_VEC[dir];
  if (v.x !== 0 && v.y !== 0) return null;                    // 只走正交
  const over = { x: from.x + v.x, y: from.y + v.y };
  if (!inBounds(state.map, over) || !isHalfCover(state.map, over)) return null;
  const land = { x: over.x + v.x, y: over.y + v.y };
  if (!terrainPassable(state, land)) return null;
  if (occupiedBy(state, land, opts.ignoreUnitIds ?? [])) return null;
  return land;
}

/** 這一步是不是翻越（兩格、正交、中間隔著半身掩體）。 */
export function isVaultStep(state: GameState, from: Vec2, to: Vec2): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) + Math.abs(dy) !== 2) return false;
  if (dx !== 0 && dy !== 0) return false;
  const over = { x: from.x + dx / 2, y: from.y + dy / 2 };
  return isHalfCover(state.map, over);
}

/**
 * 最短「時間」路徑。回傳不含起點、含終點的座標序列；無路可走回傳 null。
 *
 * v0.19 之前每一步花的時間都一樣，所以 BFS 就是最佳解。
 * **翻越（20）比走一步（10）貴**，所以改成一致成本搜尋（Dijkstra）——
 * 否則「兩格但比較貴」的邊會被 BFS 當成兩格的捷徑而永遠優先。
 *
 * 鄰居展開順序固定為 N, E, S, W（再加上同順序的翻越），
 * 同成本時先到先得，所以結果完全決定性（§9.1 要求 AI 不得用亂數決勝）。
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
  const stepCost = opts.stepCost ?? 1;
  const vaultCost = opts.vaultCost ?? 1;
  const prev = new Map<number, Vec2 | null>();
  const cost = new Map<number, number>();
  prev.set(key(from), null);
  cost.set(key(from), 0);

  // 節點少（一張圖幾百格），用線性取最小即可 —— 決定性比常數時間重要。
  //
  // **同成本時取先發現的**：這讓所有邊等價時的展開順序與 v0.18 的 BFS 完全相同，
  // 也就是「加入翻越」不會順手把每一條既有路徑的決勝順序都換掉。
  let seq = 0;
  const open: { p: Vec2; n: number }[] = [{ p: from, n: seq++ }];
  const build = (end: Vec2): Vec2[] => {
    const path: Vec2[] = [];
    let node: Vec2 | null = end;
    while (node && !sameTile(node, from)) {
      path.push(node);
      node = prev.get(key(node)) ?? null;
    }
    path.reverse();
    return path;
  };

  while (open.length > 0) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) {
      const a = cost.get(key(open[i].p)) ?? 0;
      const b = cost.get(key(open[bi].p)) ?? 0;
      if (a < b || (a === b && open[i].n < open[bi].n)) bi = i;
    }
    const cur = open.splice(bi, 1)[0].p;
    const curCost = cost.get(key(cur)) ?? 0;
    if (sameTile(cur, goal)) return build(cur);

    for (const d of MOVE_DIRECTIONS) {
      const v = DIR_VEC[d];
      // 走一步；走不了就看能不能翻過去（§1.1）
      const stepTo = { x: cur.x + v.x, y: cur.y + v.y };
      const vaultTo = vaultTarget(state, cur, d, opts);
      const edges: { to: Vec2; c: number }[] = [];
      if (terrainPassable(state, stepTo)) edges.push({ to: stepTo, c: stepCost });
      if (vaultTo) edges.push({ to: vaultTo, c: vaultCost });

      for (const e of edges) {
        const k = key(e.to);
        const isGoal = sameTile(e.to, goal);
        if (occupiedBy(state, e.to, ignore) && !(isGoal && opts.allowGoalOccupied)) continue;
        const next = curCost + e.c;
        if (cost.has(k) && next >= (cost.get(k) as number)) continue;
        cost.set(k, next);
        prev.set(k, cur);
        open.push({ p: e.to, n: seq++ });
      }
    }
  }
  return null;
}

/**
 * 路徑上的下一步該按哪個方向（v0.19）。
 *
 * 翻越那一步在路徑上是**兩格**，`facingFromDelta` 會拒絕它 ——
 * 所以走路徑的地方（自動移動、機器人、AI）一律走這個函式，不要自己算 delta。
 */
export function stepDirection(from: Vec2, to: Vec2): Facing | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx !== 0 && dy !== 0) return null;
  const n = Math.abs(dx) + Math.abs(dy);
  if (n !== 1 && n !== 2) return null;
  return facingFromDelta(Math.sign(dx), Math.sign(dy));
}

/**
 * 一條路徑要花多少時間（v0.19）。翻越那一步比較貴，所以不能再用「步數 × 移動時間」。
 */
export function pathTime(
  state: GameState, from: Vec2, path: Vec2[], stepTime: number, vaultTime: number,
): number {
  let total = 0;
  let cur = from;
  for (const p of path) {
    total += isVaultStep(state, cur, p) ? vaultTime : stepTime;
    cur = p;
  }
  return total;
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
