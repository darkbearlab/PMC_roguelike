/**
 * 地圖解析與地形查詢（§13）。地圖是手工資料檔，不做程序化生成。
 */
import type { MapData, TileType, Vec2 } from './state';

export interface RawMap {
  id: string;
  name: string;
  width: number;
  height: number;
  legend: Record<string, string>;
  tiles: string[];
  startDropPoint: Vec2;
  enemies: { archetype: string; pos: Vec2 }[];
}

const VALID_TILES = new Set<TileType>([
  'FLOOR', 'WALL', 'HALF_COVER', 'DROP_POINT', 'TERMINAL', 'SUPPLY',
]);

export function parseMap(raw: RawMap): MapData {
  if (raw.tiles.length !== raw.height) {
    throw new Error(`地圖 ${raw.id}: 列數 ${raw.tiles.length} 與 height ${raw.height} 不符`);
  }
  const tiles: TileType[] = new Array(raw.width * raw.height);
  for (let y = 0; y < raw.height; y++) {
    const row = raw.tiles[y];
    if (row.length !== raw.width) {
      throw new Error(`地圖 ${raw.id}: 第 ${y} 列寬度 ${row.length} 與 width ${raw.width} 不符`);
    }
    for (let x = 0; x < raw.width; x++) {
      const t = raw.legend[row[x]] as TileType | undefined;
      if (!t || !VALID_TILES.has(t)) {
        throw new Error(`地圖 ${raw.id}: (${x},${y}) 未知的圖例字元 '${row[x]}'`);
      }
      tiles[y * raw.width + x] = t;
    }
  }
  return {
    id: raw.id,
    name: raw.name,
    width: raw.width,
    height: raw.height,
    tiles,
    startDropPoint: { ...raw.startDropPoint },
  };
}

export function inBounds(map: MapData, pos: Vec2): boolean {
  return pos.x >= 0 && pos.y >= 0 && pos.x < map.width && pos.y < map.height;
}

/** 地圖邊界視同 WALL（§6）。 */
export function tileAt(map: MapData, pos: Vec2): TileType {
  if (!inBounds(map, pos)) return 'WALL';
  return map.tiles[pos.y * map.width + pos.x];
}

/** 地形是否阻擋移動。WALL 與 HALF_COVER 不可通行（§6）。 */
export function blocksMovement(map: MapData, pos: Vec2): boolean {
  const t = tileAt(map, pos);
  return t === 'WALL' || t === 'HALF_COVER';
}

export function isHalfCover(map: MapData, pos: Vec2): boolean {
  return tileAt(map, pos) === 'HALF_COVER';
}

export function findTiles(map: MapData, type: TileType): Vec2[] {
  const out: Vec2[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (map.tiles[y * map.width + x] === type) out.push({ x, y });
    }
  }
  return out;
}
