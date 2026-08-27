/**
 * 姿勢的完整效果（§7.3）。
 *
 * 蹲下：提高自身命中率、降低被命中率。
 * 代價有兩個，都不是視野半徑：
 *   1. **面向生效**（§7.5）—— 蹲下只看得見前方半平面，後面全是盲區
 *   2. **改變姿勢要花時間**（§5.2 的 time.stance）
 *
 * v0.5 曾用「蹲姿視野 ×0.6」當作代價，v0.8 移除：那是在面向還沒生效時的補丁，
 * 和 180 度視野疊在一起會把蹲姿削過頭，而且它懲罰的是「看多遠」，
 * 面向懲罰的是「看哪裡」—— 後者才是要玩家做的決定。
 */
import type { Unit } from './state';
import { RULES } from './content';

/** 射手蹲姿的命中加成（穩定度）。 */
export function shooterStanceBonus(u: Unit): number {
  return u.stance === 'CROUCH' ? RULES.combat.stance.shooterCrouchBonus : 0;
}

/** 目標蹲姿的被命中減免（正值代表要從命中率裡扣掉）。 */
export function targetStancePenalty(u: Unit | null): number {
  return u && u.stance === 'CROUCH' ? RULES.combat.stance.targetCrouchPenalty : 0;
}
