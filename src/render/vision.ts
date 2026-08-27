/**
 * 可見性快取。渲染層唯讀 GameState，這裡只是把 core 的判定攤平成陣列。
 *
 * v0.8 起這份可見性含**面向半平面**（§7.5），所以蹲下時它只涵蓋前方。
 *
 * 它只決定**單位**畫不畫得出來。地形一律照畫（§12.13）——
 * 蹲姿視野只有 180 度，地形若跟著消失，玩家一蹲下就會失去空間感。
 */
import type { GameState, Vec2 } from '../core/state';
import { activePlayerUnit } from '../core/state';
import { canSee } from '../core/sight';

export interface Vision {
  /** index = y * width + x；1 = 現在看得見 */
  tiles: Uint8Array;
  origin: Vec2 | null;
  /** 快取鍵：可見性只跟「誰在看、站在哪、什麼姿勢、面向哪」有關。 */
  key: string;
}

/** 目前可見性的識別碼。相同 => 不必重算。 */
export function visionKey(state: GameState): string {
  const u = activePlayerUnit(state);
  if (!u) return 'none';
  return u.id + ':' + u.pos.x + ',' + u.pos.y + ':' + u.stance + ':' + u.facing;
}

export function computeVision(state: GameState): Vision {
  const { width, height } = state.map;
  const tiles = new Uint8Array(width * height);
  const key = visionKey(state);
  const u = activePlayerUnit(state);
  if (!u) return { tiles, origin: null, key };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // canSee 一次做完距離、面向、遮蔽三件事（§7.5）
      if (canSee(state.map, u, { x, y })) tiles[y * width + x] = 1;
    }
  }
  return { tiles, origin: { x: u.pos.x, y: u.pos.y }, key };
}

/** 現在看得見。**單位**的繪製一律用這個；地形不用（§12.13）。 */
export function isVisible(v: Vision, map: { width: number }, p: Vec2): boolean {
  return v.tiles[p.y * map.width + p.x] === 1;
}
