# 複製人 PMC 戰術 Roguelike — MVP

單場戰鬥的可玩驗證版。手機直向瀏覽器優先，TypeScript + Canvas 2D + Vite，零遊戲引擎相依。

**線上版（手機直接開）**：https://darkbearlab.github.io/PMC_roguelike/

推到 `main` 就會自動跑測試 → 建置 → 部署，手機重新整理即可拿到新版。
資產檔名帶 hash，不會吃到舊快取；戰鬥紀錄面板（`誌`）頂端會顯示 `build <commit>`，
可以直接確認手機上跑的是哪一版。

```bash
npm install
npm run dev        # http://localhost:5173  （手機同網段可用 --host 顯示的網址開）
npm run test       # 91 個測試：core/ 規則層、UI 接線、整張正式地圖的整合測試
npm run typecheck
npm run build
npm run map:build  # 重新產生並驗證 mission_01（會檢查連通性與 §13.1 的設計要求）
```

CI（`.github/workflows/deploy.yml`）在每次 push 到 `main` 時跑：
型別檢查 → 測試 → 「地圖 JSON 與 `scripts/build_map.mjs` 必須一致」→ 建置 → 部署 →
**線上健檢**（部署完直接抓線上頁面，確認它真的是這次的 commit）。

> 最後那一步是有原因的：GitHub 內建的 legacy Jekyll builder 曾經跟這個 workflow
> 搶著部署並且贏了，線上被換成 repo 根目錄那份**未經建置**的 `index.html`
> （script 還指著 `/src/main.ts`，於是整頁空白）。以前那是靜悄悄的，現在 CI 會直接變紅。
> 若真的再發生，去 **Settings → Pages** 把 Source 改回 **GitHub Actions**。

用 `?seed=12345` 固定亂數種子重現同一場（§14）。開發者主控台會印出當場的 seed。

---

## 架構

```
src/
  core/          純函式規則層。不 import 任何 DOM / Canvas / 瀏覽器 API。
    state.ts       GameState 型別與唯讀選取器
    commands.ts    Command 型別、checkLegal()、applyCommand()   ← 規則層唯一入口
    los.ts         視線（對稱 Bresenham + 半身掩體規則）
    combat.ts      命中管線、傷害、濺射、噪音
    ai.ts          敵人 IDLE / ALERT / SEARCH 狀態機
    pathfind.ts    BFS 尋路、斜向切角規則
    rng.ts         可播種 xoshiro128**
    map.ts / setup.ts / content.ts / grid.ts / log.ts
  render/        Canvas 繪製與可見性快取，唯讀 GameState
  ui/            觸控輸入、HUD、情境選單、Modal
  data/          rules.json / weapons.json / actors.json / maps/mission_01.json
```

### 四條硬性要求的落實方式

| 要求 | 做法 | 驗證 |
|---|---|---|
| `core/` 純且決定性 | `applyCommand(state, cmd) => newState`。內部先 `structuredClone` 再改複製品；非法指令回傳**原本那個物件**（identity 不變） | `determinism.test.ts` |
| 亂數一律經過 `core/rng.ts` | 產生器的完整內部狀態存在 `GameState.rng`（含 `count`），JSON 還原後可接著抽出相同序列 | `determinism.test.ts`（含掃描 `src/` 確認沒有 `Math.random()`） |
| 渲染／UI 唯讀 | 兩層都只讀 `GameState`，所有改動都發 Command | `determinism.test.ts` 掃描 `core/` 沒有瀏覽器 API |
| 狀態可完整序列化 | 沒有 Map / Set / class instance / 函式 | `determinism.test.ts` |

---

## 本作的心臟：視線與姿勢（§7）

視線是**對稱**的：雙向各跑一次 Bresenham，兩邊都通才算看得見。單向不一致一律判定為不可見。

半身掩體規則實作在 `core/los.ts`：

> 一條視線若通過某個 `HALF_COVER` 格，且線段任一端的單位正緊鄰（8 鄰域）該掩體格並處於 `CROUCH`，則該視線被阻擋。

實測（`(7,9)` 中央大廳）：站著看得到 103 格，蹲下剩 61 格。姿勢與面向都是 0 AP，代價完全體現在能力上而不是行動點上。
UI 上蹲下的士兵會畫成較小的圓＋底部橫線；看不見的敵人只留下虛線 `?` 幽靈標在最後已知位置。

---

## 命中管線（§8.1）

MVP 每一發都必中，但**擲骰管線是完整活著的**：

- `toHitChance()` 委派給一個可切換的策略。`data/rules.json → combat.alwaysHit` 設成 `false` 就啟用 `rolledHitChance`（§8.1 的預留公式），程式碼與 UI 一律不用動。
- **無論命中率是多少都會抽一個亂數**，讓 MVP 與日後啟用擲骰的 RNG 序列長度一致。
- 未命中路徑是真的程式碼，不是空分支：不扣血、照扣 AP 與彈藥、照樣產生噪音、紀錄顯示「未命中」。
  `misspath.test.ts` 與 `ui.test.ts` 都會把命中率強制設為 0 走完整條路徑。
- 射擊確認面板固定有 `命中率 / 傷害 / 剩餘 AP` 三欄，MVP 顯示 `100%`，欄位現在就佔好版面。

---

## 對規格的補充與判斷（請 review）

規格裡的型別是最小集合，實作時補了幾個**必要**欄位，其餘一律照抄。以下是全部差異：

**資料模型的增補**

| 位置 | 增加 | 為什麼非加不可 |
|---|---|---|
| `Unit` | `name` | UI 與戰鬥紀錄要顯示（`衝鋒型-01`） |
| `Unit` | `shotsThisTurn` / `attacksPerTurn` | §9 射手型「每回合上限 1 次」沒有欄位就做不出來 |
| `GameState` | `rng` | §14 要求產生器狀態隨 state 序列化。`rngSeed` 照規格保留 |
| `GameState` | `deployed` | §11.4 結算要「投入士兵數」 |
| `GameState` | `enemyQueue` | 敵人回合改成逐步播放（見下） |
| `GameState` | `pendingReinforcement` | §10.1 第 4 點的「暫停等玩家選人」需要一個可序列化的暫停狀態。`phase` 的三個值維持原樣 |
| `GameState` | `log` | §8.1 要求戰鬥紀錄能顯示未命中 |
| `Objective` | `pos` | 互動時要比對站在哪一格 |
| `MapData` | `tiles` 是扁平的 `TileType[]` | 由 JSON 的字串列解析而來，查詢 O(1) |

**行為上的判斷**

1. **`ENEMY_STEP` 指令**：敵人回合不是一次算完，而是一個動作一個 Command。UI 用計時器逐步送出，玩家看得到「誰往哪裡走了」——否則「衝鋒型比你快」這件事在畫面上不成立。看不見的敵人動作會自動快轉，不讓玩家乾等。

2. **斜向切角（§5.3）—— 這一條有歧義，請確認**。規格正文寫「不得穿越兩個對角的 WALL／HALF_COVER 之間的縫隙」（= 兩側都是阻擋物才禁止），括號卻寫「禁止切角」（= 標準規則，任一側是阻擋物就禁止）。目前採**標準規則（STRICT）**，因為驗收清單寫的是「斜向切角禁止」。改回字面解只要動 `data/rules.json → movement.diagonalCornerRule: "GAP_ONLY"`，程式碼不用動。

3. **丟棄武器**：§10.2 的「丟棄免費」只在「兩個欄位都滿、要撿第三把」時才需要，所以併進 `PICKUP` 指令——被換下來的槍免費留在同一具屍體上，總成本仍是 1 AP。沒有獨立的丟棄指令。

4. **噪音只喚醒 IDLE**：照 §8.3 字面實作。已經在 ALERT / SEARCH 的敵人不會因為新槍聲更新 `lastKnownTarget`。若試玩覺得怪，改 `core/combat.ts` 的 `emitNoise()` 一個條件即可。

5. **敵人開火的噪音半徑設為 0**（`data/actors.json`）。讓噪音機制純粹是「玩家自己的選擇引來了誰」，避免敵人互相喚醒造成雪崩。想打開就把 `noiseRadius` 調大。

6. **`toHitChance` 的 `target` 放寬為 `Unit | null`**：濺射武器日後要能對空地開砲（`impactPos` 與目標格分離的意義就在這）。MVP 的 UI 只提供對敵人開火，core 不擋。`canAttack()` 也不檢查目標陣營——§8.2 明講不做友軍傷害豁免。

7. **AI 追擊目標格允許被佔據**：搜索時的 `lastKnownTarget` 往往就是玩家現在站的地方；若不允許，整條路徑會算不出來、敵人原地發呆。實際「不能走進去」由下一步的佔據檢查擋下（走到相鄰就停）。這是寫 `ai.test.ts` 的噪音追擊測試時抓到的 bug。

8. **右下角是 6 顆鍵不是 4 顆**：§12.2 畫的是 `蹲／火／彈／換`，但 §5.2 還有「與目標物互動」這個動作，所以補上 `用`（互動）與 `誌`（戰鬥紀錄）。方向鍵正中央是 `待`（等待）。

9. **HUD 只顯示武器型號**（`AR-9 制式步槍` → `AR-9`），完整名稱在點自己的詳細面板裡。手機寬度放不下。

10. **止損不在 HUD 上**（§11.3 說「任何時候都可以按」）。改成只在**當前士兵陣亡**的那個當下、於增援選單裡出現，讓止損變成必須先付出一條人命才做得到的決定。二次確認與戰況損益都照 §11.3 保留。要改回隨時可按，把按鈕加回 HUD 並接上 `Game.askAbort()` 即可。

11. **士兵永遠鎖在畫面正中央**，攝影機不夾在地圖範圍內。因此地圖邊界外會露出畫面 —— 界外照 §6「地圖邊界視同 WALL」畫成岩層斜紋，外加一圈虛線標出可作戰範圍，再用暈影把邊角壓暗。

---

## 可調數值都在 `data/`

程式碼裡沒有任何平衡數字。§17 的旋鈕對應：

| 旋鈕 | 位置 |
|---|---|
| 玩家 AP / HP / 視野 | `actors.json → SOLDIER` |
| AR-9 彈匣、傷害、噪音半徑 | `weapons.json` |
| HULK 護甲、RUNNER AP、SHOOTER 每回合次數 | `actors.json` |
| 名冊人數與編號 | `rules.json → roster` |
| 各動作 AP 成本、換槍成本 | `rules.json → ap` |
| 命中率總開關與下限 | `rules.json → combat` |
| 斜向切角規則 | `rules.json → movement` |
| SEARCH 持續回合 | `rules.json → ai` |
| 空投點數量／間距、敵人配置 | `scripts/build_map.mjs` → `npm run map:build` |

---

## 地圖 mission_01「廢棄水處理廠」

`scripts/build_map.mjs` 以明確的牆段／門／掩體列描述地圖，產生 `src/data/maps/mission_01.json` 並驗證寬度、連通性與 §13.1 的每一條要求。這不是程序化生成——每一段牆、每一個門、每一個敵人座標都是手填的；腳本只是不讓我數錯 32 個字元。

```
   01234567890123456789012345678901
 0 ################################
 1 #D.......#...........#.........#     A 起始室（唯一出口在南邊 (5,8)）
 2 #........#...........#.......S.#     E 東北室：次要目標 1
 3 #........#.....................#
 5 #.+++++..#.++++++++..#.........#     成排半身掩體 = 可連續蹲行推進的路線
 8 #####.########.#######.........#
 9 #....................#..#......#     C 中央大廳
10 #....++++++++........#.........#
11 #.D..............+++...........#     D2 空投點；(21,11) 是通往開闊地的咽喉
13 ###.#############.####.........#
14 #........#...........#.+++++...#     F 開闊地：射手型的舞台，掩體極少
16 #.++++++.#.++++++++..#.D.......#     D3 空投點就在開闊地裡，回程要付代價
18 #....................####.######
20 #........#..++++++++.#.+++++...#
21 #.S......#...................T.#     次要目標 2（西南）／主目標（東南角）
23 ################################
```

- 3 個空投點，最遠的離起點 20 格以上。
- `TERMINAL` 在離起點最遠的一端（最短路徑 > 20 步）。
- 兩個 `SUPPLY` 都在主路線之外，繞路一定比直達遠（`integration.test.ts` 會驗）。
- 10 個敵人：RUNNER ×4、SHOOTER ×4、HULK ×2。其中一隻 HULK 就守在終端室裡，兩個入口都繞不過去——逼玩家面對「要不要換重武器」。
- 一隻笨機器人（不用掩體、不蹲、只會直線推進）跑完全場：**成功、69 回合、投入 2 人、陣亡 1 人、遺留 2 件裝備**。會玩的人應該要明顯更省。

---

## 驗收清單 (§15) 對應

| 驗收項目 | 驗證位置 |
|---|---|
| 方向鍵移動、AP 扣減、歸零自動換敵人回合 | `movement.test.ts`、`ui.test.ts` |
| 蹲在半身掩體後雙向看不見 | `los.test.ts`、`ai.test.ts` |
| 站起來可越過同一掩體射擊 | `los.test.ts` |
| 輕武器一回合兩槍／重武器一槍 | `combat.test.ts` |
| 輕武器打裝甲型 1 點、重武器 10 點 | `combat.test.ts` |
| 換重武器就沒 AP 開火 | `combat.test.ts` |
| 開火噪音讓 IDLE 敵人轉 SEARCH 並前往開火點 | `ai.test.ts` |
| 衝鋒型比玩家快，風箏流不成立 | `ai.test.ts` |
| 陣亡留屍體與重武器，新士兵只帶步槍從最近空投點出現 | `mission.test.ts` |
| 走回屍體處花 1 AP 撿回重武器 | `mission.test.ts` |
| 名冊耗盡 → WIPED | `mission.test.ts` |
| 止損隨時可按、二次確認、正確結算 | `mission.test.ts`、`ui.test.ts` |
| 完成主目標後回初始空投點撤離成功 | `mission.test.ts` |
| 射擊前顯示視線與預期傷害，需二次點擊 | `menu.test.ts` |
| 射擊面板有「命中率」欄位顯示 100% | `menu.test.ts` |
| 視線對稱性／AP 扣減／傷害護甲／禁止切角 | `los.test.ts`、`movement.test.ts`、`combat.test.ts` |
| **命中率強制為 0 的未命中路徑**（含 UI 不崩潰） | `misspath.test.ts`、`ui.test.ts` |
| 相同種子＋相同指令序列 → 相同最終狀態 | `determinism.test.ts`、`integration.test.ts` |
| 全程沒有 `Math.random()` | `determinism.test.ts` |
| 觸控區 ≥ 48×48 CSS px、無水平捲動 | `scripts/a11y.mjs`（320px 視窗實測通過） |
| 浮動面板不會蓋住正中央的士兵 | `ui.test.ts` |

`scripts/` 底下另有三支開發輔助腳本（需要 `npm run preview` 先起服務）：
`shot.mjs` 截圖、`playthrough.mjs` 走一段實戰、`a11y.mjs` 觸控區稽核、`botrun.ts` 難度探針。

---

---

## 版面（v0.2 起）

地圖是**滿版**底層，HUD 與控制列全部半透明浮在上面 —— 地圖可視面積從 64% 變成 100%。

- **HUD**（上）：AP 圓點、HP、武器彈藥、姿勢、名冊、殘敵，第二行是戰況損益。毛玻璃，不擋視線。
- **控制列**（下）：左下八向方向鍵＋中央 `待`，右下六顆動作鍵。容器本身 `pointer-events: none`，
  按鈕之間的空隙點得到底下的地圖。按鈕視覺縮小到 42–48px，命中區靠 `::after` 外擴 4px 補回 ≥48×48；
  `--btn-gap` 必須 ≥ 8px，否則相鄰按鈕的命中區會互相重疊、搶走對方的角落（這是 `scripts/a11y.mjs` 抓到的）。
- **情境／紀錄面板**：不再是佔半個畫面的抽屜，改成浮動小卡。
  目標在士兵下方就靠上、否則靠下，`max-height` 還留了餘裕確保卡片邊緣**永遠不會越過畫面正中線**——
  士兵鎖在正中央，所以他和目標都保證看得見。

## 這一版刻意沒做

§2.2 與 §16 的全部內容：合成、DNA、世代、經濟、伺服器、多人、程序化地圖、音效、存檔。
架構上唯一為未來預留的就是 `core/` 的純粹與決定性（合約計分日後要在伺服器端重跑同一套規則），其餘一律沒有預留。
