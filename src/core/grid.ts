/**
 * 格子與方向的純工具。core/ 內不得 import 任何 DOM / Canvas / 瀏覽器 API。
 */
import type { Vec2, Facing } from './state';

export const DIRECTIONS: Facing[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

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

/** 切比雪夫距離。本作所有「距離」一律指這個（8 向移動下的真實步數）。 */
export function chebyshev(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function isAdjacent(a: Vec2, b: Vec2): boolean {
  return !sameTile(a, b) && chebyshev(a, b) === 1;
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
