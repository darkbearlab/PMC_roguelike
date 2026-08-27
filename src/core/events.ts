/**
 * 戰鬥事件（§8.6）。
 *
 * 規則層每次套用指令時，除了回傳新的 GameState，另外回傳一份**決定性的**事件清單，
 * 描述「這次指令發生了什麼」。渲染層消費它來播動畫。
 *
 * 硬性界線：
 *  - 事件本身是純資料，可序列化，由狀態轉換推導而來，因此完全決定性。
 *  - **動畫的時間軸與播放狀態不進 GameState**，只活在 render/effects.ts 裡。
 *  - core/ 不知道有動畫這回事，也不引入任何瀏覽器 API。
 */
import type { AiState, Vec2 } from './state';

export type CombatEvent =
  /** 開火：從射手到目標的彈道。hit 決定彈道畫成命中還是打偏。 */
  | { kind: 'SHOT'; from: Vec2; to: Vec2; hit: boolean; weaponId: string; splash: number }
  /**
   * 命中並造成傷害。
   * `blocked` = 被護甲吃掉的量（原始傷害 − 實際傷害），用來把
   * 「打中但沒用」和「沒打中」在畫面上分開 —— 這是 §12.9 的硬性要求。
   */
  | { kind: 'IMPACT'; unitId: string; pos: Vec2; amount: number; blocked: number; lethal: boolean }
  /** 未命中。impactPos 供渲染層畫彈著偏移。 */
  | { kind: 'MISS'; pos: Vec2; impactPos: Vec2 }
  /** 擊殺。與一般命中分開，讓渲染層給不同的表現。 */
  | { kind: 'KILL'; unitId: string; pos: Vec2; faction: 'PLAYER' | 'ENEMY'; name: string }
  /** 噪音波及範圍（曼哈頓半徑）。 */
  | { kind: 'NOISE'; pos: Vec2; radius: number }
  /** 敵人警戒狀態改變。 */
  | { kind: 'AI_STATE'; unitId: string; pos: Vec2; from: AiState; to: AiState }
  /** 彈匣打空。不要只在 HUD 上默默歸零。 */
  | { kind: 'AMMO_OUT'; unitId: string; pos: Vec2 }
  | { kind: 'RELOAD'; unitId: string; pos: Vec2; weaponName: string }
  | { kind: 'OBJECTIVE'; pos: Vec2; text: string }
  | { kind: 'DEPLOY'; unitId: string; pos: Vec2 }
  /**
   * 敵人口令（§9.5）。**只在玩家聽得到時才會發出** —— 可聽範圍的判定屬於規則層，
   * 不能丟給渲染層決定，否則「聽不到」就變成畫面上的巧合而不是規則。
   *
   * `pos` 給渲染層用：看得見的敵人把口令畫在頭上，聽得見但看不見的
   * 只換算成方向指示（§12.18）—— 聽覺不該洩漏精確座標。
   */
  | { kind: 'CALLOUT'; unitId: string; pos: Vec2; code: string; text: string };

/** 事件收集器。傳進規則層的函式，由它們往裡面 push。 */
export type EventSink = CombatEvent[];

/** 指令套用的完整結果。 */
export interface CommandResult {
  state: GameStateLike;
  events: CombatEvent[];
}

// 避免 events.ts 反向依賴 state.ts 的完整型別造成循環，這裡只需要一個佔位。
type GameStateLike = import('./state').GameState;
