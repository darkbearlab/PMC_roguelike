/**
 * 格子與方向的純工具。core/ 內不得 import 任何 DOM / Canvas / 瀏覽器 API。
 */
import type { Vec2, Facing } from './state';

/** 八向。`facing` 是八向（v0.8 起會決定蹲姿與敵人的視野，見 core/sight.ts），移動不是。 */
export const DIRECTIONS: Facing[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * 移動與尋路的四個方向。順序同時也是 AI 平手時的決勝順序（§9.1）。
 * v0.3 起取消斜向移動：玩家與敵人一律只能上下左右。
 */
export const MOVE_DIRECTIONS: Facing[] = ['N', 'E', 'S', 'W'];

/** 方向向量。DIRECTIONS 的順序同時也是 AI 平手時的決勝順序（§9.1）。 */
export const DIR_VEC: Record<Facing, Vec2> = {
  N: { x: 0, y: -1 },
  NE: { x: 1, y: -1 },
  E: { x: 1, y: 0 },
  SE: { x: 1, y: 1 },
  S: { x: 0, y: 1 },
  SW: { x: -1, y: 1 },
  W: { x: -1, y: 0 },
  NW: { x: -1, y: -1 },
};

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function sameTile(a: Vec2, b: Vec2): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * 曼哈頓距離。v0.3 起，本作所有「多遠」一律指這個 ——
 * 取消斜向移動之後，走過去要幾步，距離就算幾格。
 * 射程、視野、噪音半徑、濺射半徑、AI 判斷全部用它。
 */
export function manhattan(a: Vec2, b: Vec2): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * 切比雪夫距離。**只**用於 core/los.ts 的半身掩體 8 鄰域判定 ——
 * 那是「有沒有被擋住」的幾何判定，不是「多遠」，兩者是不同的檢查（§7）。
 * 不要拿它做任何距離比較。
 */
export function chebyshev(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** 正交相鄰（曼哈頓距離 1）。 */
export function isAdjacent(a: Vec2, b: Vec2): boolean {
  return manhattan(a, b) === 1;
}

/** 由位移推回八向名稱；非八向位移回傳 null。 */
export function facingFromDelta(dx: number, dy: number): Facing | null {
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  if (sx === 0 && sy === 0) return null;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return null;
  for (const d of DIRECTIONS) {
    const v = DIR_VEC[d];
    if (v.x === sx && v.y === sy) return d;
  }
  return null;
}

/** 由 from 指向 to 的粗略八向（用於美術朝向，距離不限）。 */
export function facingToward(from: Vec2, to: Vec2): Facing | null {
  return facingFromDelta(Math.sign(to.x - from.x), Math.sign(to.y - from.y));
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
