/**
 * 視線計算（§7）—— 本作的戰術核心。
 *
 * 判定一律是「對稱」的：A 看得到 B 與 B 看得到 A 永遠一致。
 * 實作方式是雙向各跑一次 Bresenham，兩邊都通才算看得見。
 * 非對稱視線是這類遊戲最常見的 bug 來源，這裡刻意用最笨但最穩的方法擋掉。
 */
import type { MapData, Stance, Unit, Vec2 } from './state';
import { tileAt } from './map';
import { chebyshev, sameTile } from './grid';

/** 整數 Bresenham 直線，含頭尾兩端。 */
export function bresenham(a: Vec2, b: Vec2): Vec2[] {
  const pts: Vec2[] = [];
  let x0 = a.x;
  let y0 = a.y;
  const x1 = b.x;
  const y1 = b.y;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;

  for (;;) {
    pts.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return pts;
}

/**
 * 單向射線檢查。不對外公開 —— 對外一律用對稱版本。
 *
 * 半身掩體規則（§7.2）：
 *   一條視線若通過某個 HALF_COVER 格，且線段任一端的單位正緊鄰（8 鄰域）
 *   該掩體格並處於 CROUCH，則該視線被阻擋。
 *
 * 推論出來的效果正是我們要的：
 *   蹲在半身掩體後 → 雙向都看不見；站起來 → 可以越過掩體開火，但自己也暴露。
 */
function rayClear(
  map: MapData,
  from: Vec2,
  fromStance: Stance,
  to: Vec2,
  toStance: Stance,
): boolean {
  const cells = bresenham(from, to);
  // 頭尾兩端不參與遮擋判定：站著的那一格不會擋住自己。
  for (let i = 1; i < cells.length - 1; i++) {
    const c = cells[i];
    const t = tileAt(map, c);
    if (t === 'WALL') return false;
    if (t === 'HALF_COVER') {
      if (fromStance === 'CROUCH' && chebyshev(from, c) === 1) return false;
      if (toStance === 'CROUCH' && chebyshev(to, c) === 1) return false;
    }
  }
  return true;
}

/** 對稱視線判定。兩個方向結果不同時一律視為不可見。 */
export function hasLineOfSight(
  map: MapData,
  from: Vec2,
  fromStance: Stance,
  to: Vec2,
  toStance: Stance,
): boolean {
  if (sameTile(from, to)) return true;
  return (
    rayClear(map, from, fromStance, to, toStance) &&
    rayClear(map, to, toStance, from, fromStance)
  );
}

/** 兩個單位之間是否互相看得見（採各自的姿勢）。 */
export function unitsSeeEachOther(map: MapData, a: Unit, b: Unit): boolean {
  return hasLineOfSight(map, a.pos, a.stance, b.pos, b.stance);
}

/**
 * 單位對某一格是否有視線。格上沒有單位時，另一端以 STAND 計算
 * （空格本身不會蹲，掩體只可能因為「我這一端蹲著」而擋住）。
 */
export function unitSeesTile(map: MapData, u: Unit, tile: Vec2, tileStance: Stance = 'STAND'): boolean {
  return hasLineOfSight(map, u.pos, u.stance, tile, tileStance);
}

/** 供渲染畫視線用；不做遮擋判定，只回傳經過的格子。 */
export function sightPath(from: Vec2, to: Vec2): Vec2[] {
  return bresenham(from, to);
}
