/**
 * 掩蔽（§7.2b）。
 *
 * **這與「遮蔽」是兩個互不相干的檢查，不要混在一起：**
 *
 *   遮蔽 = 看不看得見 → 幾何射線（core/los.ts）→ 二元
 *   掩蔽 = 好不好打中 → 目標鄰格掃描（本檔）  → 三級
 *
 * 掩蔽刻意不走射線。現有模型裡射線通過 WALL 就直接阻擋，不存在
 * 「射線切到牆但仍看得見」的中間狀態，所以要讓牆提供掩蔽，來源必須是另一個檢查。
 *
 * 判定：看目標**朝向射手那一側**的正交鄰格（最多兩格）有幾格是阻擋物。
 * 因此**射手換一個角度就能消除或降低目標的掩蔽** —— 側翼是掩蔽的解法，
 * 這是整個機制最重要的戰術產出。
 */
import type { GameState, MapData, Unit, Vec2 } from './state';
import { activePlayerUnit } from './state';
import { blocksMovement } from './map';
import { unitSees } from './sight';
import { manhattan } from './grid';
import { RULES } from './content';

export type CoverLevel = 'NONE' | 'PARTIAL' | 'GOOD';

export interface CoverInfo {
  level: CoverLevel;
  /** 造成掩蔽的那 1～2 格。UI 要把它們標出來，玩家才知道該繞哪邊（§12.10）。 */
  tiles: Vec2[];
  /** 命中率減免（正值代表要從命中率裡扣掉）。 */
  penalty: number;
}

const LEVEL_OF: CoverLevel[] = ['NONE', 'PARTIAL', 'GOOD'];

export function coverPenalty(level: CoverLevel): number {
  if (level === 'PARTIAL') return RULES.combat.cover.partial;
  if (level === 'GOOD') return RULES.combat.cover.good;
  return 0;
}

/**
 * 目標 T 面對射手 S 時的掩蔽。
 *
 * WALL 與 HALF_COVER 在掩蔽上一視同仁 —— 兩者的差別只存在於遮蔽
 * （蹲在半身掩體後會整個消失，蹲在牆邊不會）。
 * 地圖界外視同 WALL，所以貼著邊界站也有掩蔽。
 */
export function coverAgainst(map: MapData, target: Vec2, shooter: Vec2): CoverInfo {
  const dx = shooter.x - target.x;
  const dy = shooter.y - target.y;
  const tiles: Vec2[] = [];

  // 只取「朝向射手」的那一側，所以最多兩格；正對齊的那一軸沒有候選格
  if (dx !== 0) {
    const c = { x: target.x + Math.sign(dx), y: target.y };
    if (blocksMovement(map, c)) tiles.push(c);
  }
  if (dy !== 0) {
    const c = { x: target.x, y: target.y + Math.sign(dy) };
    if (blocksMovement(map, c)) tiles.push(c);
  }

  const level = LEVEL_OF[Math.min(tiles.length, 2)];
  return { level, tiles, penalty: coverPenalty(level) };
}

export const COVER_LABEL: Record<CoverLevel, string> = {
  NONE: '無掩蔽',
  PARTIAL: '部分掩蔽',
  GOOD: '良好掩蔽',
};

/**
 * 玩家目前的防禦狀態（§12.11）。
 *
 * 掩蔽取決於射手的方位，所以「玩家有沒有掩蔽」沒有單一答案。
 * **本作採用最差情況**：在所有「現在看得到玩家」的敵人之中，取掩蔽最低的那一個。
 * 玩家因此永遠不會被自己的 HUD 騙 —— 顯示良好掩蔽就代表每個看得到你的人都難打。
 */
export interface DefenceState {
  level: CoverLevel;
  /** 目前有幾個敵人看得到玩家。0 代表沒人瞄得到。 */
  threats: number;
  crouched: boolean;
}

const RANK: Record<CoverLevel, number> = { NONE: 0, PARTIAL: 1, GOOD: 2 };

export function playerDefence(state: GameState): DefenceState {
  const me = activePlayerUnit(state);
  if (!me) return { level: 'NONE', threats: 0, crouched: false };

  let worst: CoverLevel | null = null;
  let threats = 0;
  for (const e of state.units) {
    if (e.faction !== 'ENEMY') continue;
    // 「看得到你的敵人」現在是有方向的：背對你的那個不算（§7.5）
    if (!unitSees(state.map, e, me)) continue;
    threats++;
    const lvl = coverAgainst(state.map, me.pos, e.pos).level;
    if (worst === null || RANK[lvl] < RANK[worst]) worst = lvl;
  }
  return {
    level: worst ?? coverBestGuess(state, me),
    threats,
    crouched: me.stance === 'CROUCH',
  };
}

/** 沒有人看得到玩家時，仍然給一個參考值：對地圖上最近的敵人而言的掩蔽。 */
function coverBestGuess(state: GameState, me: Unit): CoverLevel {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const e of state.units) {
    if (e.faction !== 'ENEMY') continue;
    const d = manhattan(e.pos, me.pos);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best ? coverAgainst(state.map, me.pos, best.pos).level : 'NONE';
}
