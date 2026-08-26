/**
 * 姿勢的完整效果（§7.3）。
 *
 * 蹲下：提高自身命中率、降低被命中率，代價是視野縮短。
 * 若蹲下毫無代價，玩家會永遠蹲著 —— 視野縮短就是那個代價。
 * 姿勢改變仍然不消耗 AP。
 */
import type { Unit } from './state';
import { RULES } from './content';

/** 蹲姿的實際視野範圍（曼哈頓距離）。 */
export function effectiveSightRange(u: Unit): number {
  const f = u.stance === 'CROUCH' ? RULES.combat.stance.crouchSightFactor : 1;
  return Math.max(1, Math.floor(u.sightRange * f));
}

/** 射手蹲姿的命中加成（穩定度）。 */
export function shooterStanceBonus(u: Unit): number {
  return u.stance === 'CROUCH' ? RULES.combat.stance.shooterCrouchBonus : 0;
}

/** 目標蹲姿的被命中減免（正值代表要從命中率裡扣掉）。 */
export function targetStancePenalty(u: Unit | null): number {
  return u && u.stance === 'CROUCH' ? RULES.combat.stance.targetCrouchPenalty : 0;
}
