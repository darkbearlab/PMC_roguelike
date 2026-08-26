/** 攝影機：玩家單位永遠鎖在畫面正中央。 */
import type { Vec2 } from '../core/state';
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
 * 玩家單位永遠在畫面正中央 —— 攝影機不夾在地圖範圍內。
 * 因此地圖邊界外會露出畫面，由 renderer 畫成「界外岩層」（§6 邊界視同 WALL）。
 *
 * @param pan 暫時的手動平移。任何指令執行後都會歸零，鏡頭自動回到士兵身上。
 */
export function computeCamera(
  viewW: number,
  viewH: number,
  focus: Vec2,
  pan: Vec2,
): Camera {
  const tile = tileSizeFor(viewW, viewH);
  return {
    tile,
    ox: viewW / 2 - (focus.x + 0.5) * tile + pan.x,
    oy: viewH / 2 - (focus.y + 0.5) * tile + pan.y,
  };
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
