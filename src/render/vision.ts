/**
 * 可見性快取。渲染層唯讀 GameState，這裡只是把 core/los 的結果攤平成陣列。
 * 只在 state 物件換掉時重算（applyCommand 每次都回傳新物件）。
 */
import type { GameState, Vec2 } from '../core/state';
import { activePlayerUnit } from '../core/state';
import { hasLineOfSight } from '../core/los';
import { manhattan } from '../core/grid';

export interface Vision {
  /** index = y * width + x */
  tiles: Uint8Array;
  origin: Vec2 | null;
  /** 快取鍵：可見性只跟「誰在看、站在哪、什麼姿勢」有關，敵人怎麼動都不影響。 */
  key: string;
}

/** 目前可見性的識別碼。相同 => 不必重算。 */
export function visionKey(state: GameState): string {
  const u = activePlayerUnit(state);
  if (!u) return 'none';
  return u.id + ':' + u.pos.x + ',' + u.pos.y + ':' + u.stance + ':' + u.sightRange;
}

export function computeVision(state: GameState): Vision {
  const { width, height } = state.map;
  const tiles = new Uint8Array(width * height);
  const key = visionKey(state);
  const u = activePlayerUnit(state);
  if (!u) return { tiles, origin: null, key };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = { x, y };
      if (manhattan(u.pos, p) > u.sightRange) continue;
      if (hasLineOfSight(state.map, u.pos, u.stance, p, 'STAND')) tiles[y * width + x] = 1;
    }
  }
  return { tiles, origin: { x: u.pos.x, y: u.pos.y }, key };
}

export function isVisible(v: Vision, map: { width: number }, p: Vec2): boolean {
  return v.tiles[p.y * map.width + p.x] === 1;
}
