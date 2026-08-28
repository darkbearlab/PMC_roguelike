/**
 * 戰爭迷霧（純規則）。
 *
 * 三種狀態：
 *  - **未探索**：全黑，地形與單位都看不到
 *  - **已探索、當前不可見**：地形、屍體、容器照畫，**單位不畫**（v0.8 §12.13 已確立）
 *  - **當前可見**：完整
 *
 * 已探索狀態存在 `GameState`，因為它會影響玩家做得到什麼（尋路只能走已探索區域），
 * 而不只是畫面長什麼樣。
 *
 * **目標位置從一開始就是已知的** —— 合約簡報告訴了你要去哪裡；
 * 未知的是路，不是目的地。若目標也藏起來，玩家只會盲目繞圈。
 * **空投點則相反**：未探索的空投點不顯示，必須先找到。
 */
import type { GameState, MapData, Unit, Vec2 } from './state';
import { canSee } from './sight';
import { RULES } from './content';

const idx = (map: { width: number }, p: Vec2): number => p.y * map.width + p.x;

/** 迷霧總開關。關掉時一切視同已探索 —— 機器人基準走這條路（§5.2）。 */
export function fogEnabled(): boolean {
  return RULES.fog.enabled;
}

/** 一張全新的已探索圖。 */
export function blankExplored(map: MapData): string {
  return '0'.repeat(map.width * map.height);
}

export function isExplored(state: GameState, p: Vec2): boolean {
  if (!fogEnabled()) return true;
  const i = idx(state.map, p);
  if (i < 0 || i >= state.explored.length) return false;
  return state.explored[i] === '1';
}

/**
 * 把這個單位現在看得見的格子標成已探索。回傳新增了幾格。
 *
 * 只有玩家單位會探索地圖 —— 敵人看到什麼與玩家知不知道無關。
 */
export function markExplored(state: GameState, u: Unit): number {
  if (!fogEnabled() || u.faction !== 'PLAYER') return 0;
  const { width, height } = state.map;
  const cells = state.explored.split('');
  let added = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (cells[i] === '1') continue;
      if (!canSee(state.map, u, { x, y })) continue;
      cells[i] = '1';
      added++;
    }
  }
  if (added > 0) state.explored = cells.join('');
  return added;
}

/**
 * 這個空投點玩家知道嗎（§3.3）。
 *
 * 起始空投點一律知道 —— 他就是從那裡下來的。
 */
export function knowsDrop(state: GameState, p: Vec2): boolean {
  return isExplored(state, p);
}
