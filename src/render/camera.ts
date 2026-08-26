/** 攝影機：跟隨玩家單位，允許手動平移，並夾在地圖範圍內。 */
import type { MapData, Vec2 } from '../core/state';
import { clamp } from '../core/grid';

export interface Camera {
  tile: number;   // 每格的 CSS 像素
  ox: number;     // 地圖 (0,0) 在畫布上的左上角 x
  oy: number;
}

/** 視野內大約要看到幾格（取畫布短邊）。 */
const TARGET_TILES_ACROSS = 13;
const MIN_TILE = 18;
const MAX_TILE = 46;

export function tileSizeFor(viewW: number, viewH: number): number {
  const raw = Math.min(viewW, viewH) / TARGET_TILES_ACROSS;
  return Math.round(clamp(raw, MIN_TILE, MAX_TILE));
}

/**
 * @param insetBottom 底部被面板遮住的高度。焦點會置中於「沒被遮住的那塊」，
 *                    但畫面仍然填滿整個 canvas —— 面板背後還是有畫面，只是不再把主角壓在底下。
 */
export function computeCamera(
  map: MapData,
  viewW: number,
  viewH: number,
  focus: Vec2,
  pan: Vec2,
  insetBottom = 0,
): Camera {
  const tile = tileSizeFor(viewW, viewH);
  const mapW = map.width * tile;
  const mapH = map.height * tile;
  const usableH = Math.max(tile * 3, viewH - insetBottom);

  let ox = viewW / 2 - (focus.x + 0.5) * tile + pan.x;
  let oy = usableH / 2 - (focus.y + 0.5) * tile + pan.y;

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
