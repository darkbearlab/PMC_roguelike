/**
 * 面向視野（§7.5）—— v0.8 讓 `facing` 從美術欄位變成真正的規則。
 *
 * 這一層刻意**不對稱**，而且刻意與 core/los.ts 分開：
 *
 *   遮蔽（los.ts）  「中間有沒有東西擋著」  幾何射線  **對稱**
 *   面向（本檔）    「我有沒有朝那邊看」    半平面    **不對稱**
 *
 * 對稱性是遮蔽的正確性條件（非對稱視線是這類遊戲最常見的 bug）；
 * 不對稱則是面向的**全部意義** —— 背刺（§8.8）就是靠這個不對稱成立的。
 * 兩者混在同一個函式裡的話，兩邊都會壞掉。
 */
import type { MapData, Stance, Unit, Vec2 } from './state';
import { DIR_VEC, manhattan } from './grid';
import { hasLineOfSight } from './los';

/**
 * 這個單位的視野受不受面向限制。
 *
 * 站立的玩家是全方位；蹲下就有盲區；**敵人永遠有盲區**（§7.5）。
 * 這個不對稱是刻意的，理由記在規格 §9 的「已知的難度偏移」。
 */
export function usesFieldOfView(u: Unit): boolean {
  return u.stance === 'CROUCH' || u.faction === 'ENEMY';
}

/**
 * 面向的前方半平面，**含垂直於面向的那一條線**。
 *
 * 面向北時 DIR_VEC.N = (0,-1)，內積 = -dy >= 0 也就是 dy <= 0：
 *   - 正東、正西（dy = 0）→ 看得見
 *   - 後方三格（dy = 1）→ 盲區
 *
 * 「含垂直線」不是為了好寫，是它自動長出正確的形狀：
 * 不含的話蹲下就看不到自己身旁的兩格，蹲在牆邊會瞎得很莫名其妙。
 * 反過來說，半平面本身已經夠了，不需要再補一條周邊視覺規則。
 */
export function withinFieldOfView(u: Unit, target: Vec2): boolean {
  if (!usesFieldOfView(u)) return true;
  const f = DIR_VEC[u.facing];
  return (target.x - u.pos.x) * f.x + (target.y - u.pos.y) * f.y >= 0;
}

/** 完整的「這個單位看得見那一格嗎」：距離 → 面向 → 遮蔽。 */
export function canSee(
  map: MapData, u: Unit, target: Vec2, targetStance: Stance = 'STAND',
): boolean {
  if (manhattan(u.pos, target) > u.sightRange) return false;
  if (!withinFieldOfView(u, target)) return false;
  return hasLineOfSight(map, u.pos, u.stance, target, targetStance);
}

/**
 * a 看得見 b 嗎（各採自己的姿勢）。
 *
 * **這個關係不對稱**，不要拿它當「互相看得見」用 ——
 * 「a 看得見 b 但 b 看不見 a」正是背刺成立的那個情況。
 */
export function unitSees(map: MapData, a: Unit, b: Unit): boolean {
  return canSee(map, a, b.pos, b.stance);
}

/**
 * 背刺是否成立（§8.8）：目標對攻擊者**沒有視線**。
 *
 * 用的是目標自己的視野規則（射程、面向、姿勢、遮蔽全算），反過來看攻擊者。
 * 因此有三種成立方式，都是同一條規則的結果：
 *   1. 繞到背後（面向盲區）
 *   2. 目標被牆擋住看不到你（遮蔽）
 *   3. 你在它的視野距離之外開槍（射程）—— 狙擊本來就是背刺
 */
export function isBackstab(map: MapData, attacker: Unit, target: Unit | null): boolean {
  if (!target) return false;
  return !canSee(map, target, attacker.pos, attacker.stance);
}
