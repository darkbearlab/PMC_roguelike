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
    /**
     * 敵人行動時攝影機要不要跟過去。
     *
     * - `OFF`（預設）：完全不跟，鏡頭一直待在玩家身上
     * - `SNAP`：瞬間跳過去（v0.16 以前的行為）
     * - `PAN`：平滑平移過去（v0.17 加的）
     *
     * 預設是 OFF，因為一輪十隻敵人、鏡頭在不同單位之間來回追尾會讓人暈。
     * **看得到敵人在做什麼，代價不該是玩家的生理不適。**
     */
    followActingUnit: 'OFF' | 'SNAP' | 'PAN';
  };
  /**
   * 任務結束回到公司時自動補給（v0.18 附錄）。
   * 放在介面設定而不是存檔裡 —— 改它不會讓既有存檔失效。
   */
  autoResupplyOnReturn: boolean;
  /** 掠奪選單自動關閉的曼哈頓距離門檻。 */
  lootCloseDistance: number;
}

export const UI: UiConfig = uiJson as unknown as UiConfig;
