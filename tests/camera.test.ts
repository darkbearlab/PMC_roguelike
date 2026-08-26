/**
 * 攝影機夾制（規格 §12.8）。
 *
 * 這裡的回歸重點：HUD 與控制列是浮在地圖上的，所以夾制必須以「可觸區域」為準。
 * 若照整個視窗夾制，士兵走到地圖下緣時會被壓到控制列底下 ——
 * 而 v0.3 之後射擊與互動全靠點地圖，被蓋住就等於完全不能操作。
 */
import { describe, it, expect } from 'vitest';
import { computeCamera, tileCenter, tileSizeFor } from '../src/render/camera';
import { createInitialState } from '../src/core/setup';
import type { Vec2 } from '../src/core/state';

const map = createInitialState(1).map;
const VIEW_W = 390;
const VIEW_H = 844;
// 實測值：HUD 底部約 70、控制列頂部約 711
const SAFE = { top: 74, bottom: 707 };
const NO_PAN = { x: 0, y: 0 };

function centreOf(focus: Vec2): Vec2 {
  const cam = computeCamera(map, VIEW_W, VIEW_H, focus, NO_PAN, SAFE);
  return tileCenter(cam, focus);
}

/** 地圖四角、四邊中點、正中央 */
const SPOTS: Vec2[] = [
  { x: 1, y: 1 }, { x: 30, y: 1 }, { x: 1, y: 22 }, { x: 30, y: 22 },
  { x: 15, y: 1 }, { x: 15, y: 22 }, { x: 1, y: 11 }, { x: 30, y: 11 },
  { x: 15, y: 11 },
];

describe('攝影機以可觸區域夾制', () => {
  const tile = tileSizeFor(VIEW_W, VIEW_H);

  it('士兵在地圖任何位置，整格都落在可觸區域內', () => {
    for (const spot of SPOTS) {
      const c = centreOf(spot);
      const top = c.y - tile / 2;
      const bottom = c.y + tile / 2;
      expect(top, `(${spot.x},${spot.y}) 上緣`).toBeGreaterThanOrEqual(SAFE.top);
      expect(bottom, `(${spot.x},${spot.y}) 下緣`).toBeLessThanOrEqual(SAFE.bottom);
      expect(c.x - tile / 2, `(${spot.x},${spot.y}) 左緣`).toBeGreaterThanOrEqual(0);
      expect(c.x + tile / 2, `(${spot.x},${spot.y}) 右緣`).toBeLessThanOrEqual(VIEW_W);
    }
  });

  it('士兵的四個正交鄰格也必須點得到（移動與相鄰互動用）', () => {
    for (const spot of SPOTS) {
      const cam = computeCamera(map, VIEW_W, VIEW_H, spot, NO_PAN, SAFE);
      for (const d of [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]) {
        const n = { x: spot.x + d.x, y: spot.y + d.y };
        if (n.x < 0 || n.y < 0 || n.x >= map.width || n.y >= map.height) continue;
        const c = tileCenter(cam, n);
        expect(c.y, `(${spot.x},${spot.y}) 的鄰格 (${n.x},${n.y})`).toBeGreaterThan(SAFE.top);
        expect(c.y, `(${spot.x},${spot.y}) 的鄰格 (${n.x},${n.y})`).toBeLessThan(SAFE.bottom);
      }
    }
  });

  it('地圖比可觸區域大時不會露出可視範圍內的界外區', () => {
    // 地圖 32x24，可觸區域高 633px，格子 33px → 地圖兩軸都比可觸區域大
    for (const spot of SPOTS) {
      const cam = computeCamera(map, VIEW_W, VIEW_H, spot, NO_PAN, SAFE);
      expect(cam.ox).toBeLessThanOrEqual(0);
      expect(cam.ox + map.width * cam.tile).toBeGreaterThanOrEqual(VIEW_W);
      expect(cam.oy).toBeLessThanOrEqual(SAFE.top);
      expect(cam.oy + map.height * cam.tile).toBeGreaterThanOrEqual(SAFE.bottom);
    }
  });

  it('地圖比可觸區域小時置中於可觸區域，而不是置中於視窗', () => {
    const tiny = { ...map, width: 4, height: 4 };
    const cam = computeCamera(tiny, VIEW_W, VIEW_H, { x: 2, y: 2 }, NO_PAN, SAFE);
    const midMap = cam.oy + (tiny.height * cam.tile) / 2;
    expect(midMap).toBeCloseTo((SAFE.top + SAFE.bottom) / 2, 0);
  });

  it('士兵在地圖中央時，鏡頭不夾制，士兵就在可觸區域正中', () => {
    const c = centreOf({ x: 15, y: 11 });
    expect(c.x).toBeCloseTo(VIEW_W / 2, 0);
    expect(c.y).toBeCloseTo((SAFE.top + SAFE.bottom) / 2, 0);
  });
});
