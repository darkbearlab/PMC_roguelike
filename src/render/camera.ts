/** 攝影機：士兵置中於「點得到」的那塊區域，接近地圖邊緣時停止捲動。 */
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

/** 沒有被浮動 UI 蓋住的可視／可觸區域（畫面座標）。 */
export interface SafeArea {
  top: number;
  bottom: number;
}

/**
 * 邊界夾制（規格 §12.8），但夾的是**可觸區域**而不是整個視窗。
 *
 * HUD 與控制列是浮在地圖上的，若照視窗邊界夾制，士兵走到地圖下緣時會被壓到
 * 控制列底下 —— 而 v0.3 把開火鍵拿掉之後，射擊與互動全靠點地圖，
 * 被蓋住就等於完全不能操作。所以垂直方向改成夾在 HUD 底部與控制列頂部之間：
 * 士兵置中於「看得到也點得到」的那一段，代價是地圖上下緣外會露出一條界外區，
 * 而那條剛好被 UI 蓋住，不佔可視面積。
 *
 * 水平方向沒有常駐的 UI（控制列只在最底下那一條），維持照視窗夾制。
 *
 * @param pan 暫時的手動平移。任何指令執行後都會歸零。
 */
export function computeCamera(
  map: MapData,
  viewW: number,
  viewH: number,
  focus: Vec2,
  pan: Vec2,
  safe: SafeArea,
): Camera {
  const tile = tileSizeFor(viewW, viewH);
  const mapW = map.width * tile;
  const mapH = map.height * tile;

  const top = Math.max(0, Math.min(safe.top, viewH));
  const bottom = Math.max(top + tile, Math.min(safe.bottom, viewH));

  let ox = viewW / 2 - (focus.x + 0.5) * tile + pan.x;
  let oy = (top + bottom) / 2 - (focus.y + 0.5) * tile + pan.y;

  ox = mapW <= viewW ? (viewW - mapW) / 2 : clamp(ox, viewW - mapW, 0);
  oy = mapH <= bottom - top
    ? top + (bottom - top - mapH) / 2
    : clamp(oy, bottom - mapH, top);

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
