/**
 * 呈現層與介面的旋鈕（v0.17）。
 *
 * **這些值刻意不放在 `core/`。**規則層對「攝影機平移要花幾毫秒」沒有意見，
 * 也不能有意見 —— 把任何一個值設為 0，最終狀態必須完全相同（§0.1）。
 * 放在這裡也順便讓「core/ 完全未改動」這條驗收項是字面上成立的。
 */
import uiJson from '../data/ui.json';

export interface UiConfig {
  animation: {
    /** 玩家移動一格的位移動畫長度（毫秒）。0 = 瞬間完成。 */
    playerMoveMs: number;
    /** 敵人移動一格。預設慢於玩家：敵人的動作是要給玩家看的。 */
    enemyMoveMs: number;
    /** 攝影機平移一次的長度。平移期間該單位不行動。 */
    panMs: number;
    /** 離畫面邊緣幾格以內算「太靠邊」，需要平移。 */
    edgeMargin: number;
  };
  /** 掠奪選單自動關閉的曼哈頓距離門檻。 */
  lootCloseDistance: number;
}

export const UI: UiConfig = uiJson as unknown as UiConfig;
