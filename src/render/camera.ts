/** 攝影機：士兵原則上置中，但接近地圖邊緣時停止捲動（邊界夾制）。 */
import type { MapData, Vec2 } from '../core/state';
import { clamp } from '../core/grid';

export interface Camera {
  tile: number;   // 每格的 CSS 像素
  ox: number;     // 地圖 (0,0) 在畫布上的左上角 x
  oy: number;
}

/** 視野內大約要看到幾格（取畫布短邊）。 */
const TARGET_TILES_ACROSS = 12;
const MIN_TILE = 18;
const MAX_TILE = 46;

export function tileSizeFor(viewW: number, viewH: number): number {
  const raw = Math.min(viewW, viewH) / TARGET_TILES_ACROSS;
  return Math.round(clamp(raw, MIN_TILE, MAX_TILE));
}

/**
 * v0.3：邊界夾制。士兵原則上置中，但接近地圖邊緣時鏡頭停住，
 * 避免角落時大面積畫面浪費在界外區。地圖比視窗小的那個軸則置中。
 *
 * @param pan 暫時的手動平移。任何指令執行後都會歸零。
 */
export function computeCamera(
  map: MapData,
  viewW: number,
  viewH: number,
  focus: Vec2,
  pan: Vec2,
): Camera {
  const tile = tileSizeFor(viewW, viewH);
  const mapW = map.width * tile;
  const mapH = map.height * tile;

  let ox = viewW / 2 - (focus.x + 0.5) * tile + pan.x;
  let oy = viewH / 2 - (focus.y + 0.5) * tile + pan.y;

  ox = mapW <= viewW ? (viewW - mapW) / 2 : clamp(ox, viewW - mapW, 0);
  oy = mapH <= viewH ? (viewH - mapH) / 2 : clamp(oy, viewH - mapH, 0);

  return { tile, ox, oy };
}

export function tileToScreen(cam: Camera, t: Vec2): Vec2 {
  return { x: cam.ox + t.x * cam.tile, y: cam.oy + t.y * cam.tile };
}

export function tileCenter(cam: Camera, t: Vec2): Vec2 {
  return { x: cam.ox + (t.x + 0.5) * cam.tile, y: cam.oy + (t.y + 0.5) * cam.tile };
}

export function screenToTile(cam: Camera, sx: number, sy: number): Vec2 {
  return {
    x: Math.floor((sx - cam.ox) / cam.tile),
    y: Math.floor((sy - cam.oy) / cam.tile),
  };
}
