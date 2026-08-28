/**
 * 地圖解析與地形查詢（§13）。地圖是手工資料檔，不做程序化生成。
 */
import type { MapData, TileType, Vec2, Facing } from './state';

export interface RawMap {
  id: string;
  name: string;
  width: number;
  height: number;
  legend: Record<string, string>;
  tiles: string[];
  startDropPoint: Vec2;
  /** facing 是**初始面向**（§13.3）。未指定時預設為南。 */
  enemies: { archetype: string; pos: Vec2; facing?: Facing }[];
  /** 地圖搜刮點的內容（§13.4）。座標必須是 LOOT 地形。 */
  caches?: { pos: Vec2; label?: string; items: { defId: string; qty: number }[] }[];
  /**
   * 驗證器算出來的統計值（§13.5），由 `npm run map:build` 一併寫進 JSON。
   *
   * 合約清單的地形標籤與難度評級都**由這些值推導，不得手寫** ——
   * 手寫的標籤會在地圖被修改後開始說謊，而地圖一定會被修改；統計值不會。
   *
   * 測試用的臨時地圖沒有這一塊 —— 它們不進合約清單。
   */
  stats?: MapStats;
}

export interface MapStats {
  walkable: number;
  coverDensity: number;
  /** 對東西向／南北向射手提供得出掩蔽的可通行格比例。 */
  dirCoverEW: number;
  dirCoverNS: number;
  /** 周圍八格不是牆的比例。量的是建築的寬窄，與掩體多寡無關（v0.14）。 */
  openness: number;
  mainDist: number;
  routeLen: number;
  /** 走最短路徑要連續暴露幾格。 */
  directRun: number;
  /** 在所有走法之中最好的那一條，還是得連續暴露幾格。 */
  forcedRun: number;
  /** 預估完成路徑的時間（下限估計）。 */
  estRun: number;
  enemyCount: number;
  shooterRatio: number;
  hulks: number;
  caches: number;
}

const VALID_TILES = new Set<TileType>([
  'FLOOR', 'WALL', 'HALF_COVER', 'DROP_POINT', 'TERMINAL', 'SUPPLY', 'LOOT',
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
