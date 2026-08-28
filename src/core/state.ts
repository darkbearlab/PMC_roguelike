/**
 * GameState 型別定義（§4）。
 *
 * 整份狀態必須可以完整序列化為 JSON —— 沒有 Map/Set/class instance/函式。
 * 相同的初始狀態 + 相同的指令序列 ⇒ 完全相同的結果（§3.1）。
 */
import type { RngState } from './rng';
import type { DeployedSoldier } from './meta';

export type Vec2 = { x: number; y: number };
export type Stance = 'STAND' | 'CROUCH';
export type Facing = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

export type TileType =
  | 'FLOOR'       // 可通行，不擋視線
  | 'WALL'        // 不可通行，永遠擋視線
  | 'HALF_COVER'  // 不可通行，視線規則見 §7
  | 'DROP_POINT'  // 可通行，增援落點
  | 'TERMINAL'    // 可通行，主目標互動點
  | 'SUPPLY'      // 可通行，次要目標互動點
  | 'LOOT';       // 可通行，搜刮點（§4.1）

/**
 * 口徑（v0.15 §1）。背包裡追蹤的是**總發數**，不是彈匣個數。
 *
 * 口徑是獨立的資料實體（`rules.json` 的 `calibres`），武器以 `calibre` 引用它。
 * 共用是刻意的設計：AR-9 與 LMG-5 同吃 5.56、兩把霰彈槍同吃 12ga ——
 * 六把槍若各吃各的，配裝就沒有取捨；分開之後取捨才會落在
 * **「餵幾種彈藥」**而不是「哪把槍比較強」。
 */
export type Calibre = '5.56' | '7.62' | '12ga' | '9mm' | '84mm';

/**
 * 機構型式（v0.15 附錄 B §2.3）。**本版不參與任何判斷。**
 *
 * 存在的目的是日後的彈藥相容性規則：彈藥能不能用**不只看口徑，還要看機構**。
 * 破爛的中折式沒有複雜機構可以被打壞，所以能塞任何東西進去；
 * 泵動槍的抽殼機構會被鋼索切段毀掉。
 *
 * **這讓「粗糙」成為一種能力，而不只是比較爛** —— 那是土製武器存在的意義。
 */
export type WeaponAction = 'BREAK' | 'PUMP' | 'BOLT' | 'SEMI' | 'AUTO' | 'BREECH';

/** 射擊模式（§2）。時間花費相同，差別只在耗彈與命中。 */
export type FireMode = 'SINGLE' | 'BURST' | 'VOLLEY' | 'AUTO';

/**
 * 裝填方式（v0.15 §3.1）。
 *
 * `FULL` 一次補滿（或補到彈倉上限），`INCREMENTAL` 一次只補一發。
 * **增量裝填不是系列動作** —— 每一發都是一個完整結束的動作，沒有進度要保存，
 * 所以在任何一發之後都可以直接開槍。壓力下填一發打一發，安全時才填滿。
 */
export type ReloadMode = 'FULL' | 'INCREMENTAL';

export type ItemKind = 'AMMO' | 'VALUABLE' | 'DNA' | 'WEAPON' | 'CONSUMABLE';

/**
 * 背包裡的一個堆疊（§3.1）。
 *
 * 武器也是物品（kind 為 'WEAPON'，weapon 欄位帶完整武器狀態），
 * 這樣搜刮面板只要處理一種東西。**放在背包裡的武器不能使用**，
 * 要先換到手持或收納欄。
 */
export interface Item {
  id: string;
  kind: ItemKind;
  /** 對應 data/items.json 的鍵。武器一律用 'WEAPON'。 */
  defId: string;
  name: string;
  /** 每一個的重量。整堆的重量 = weight × qty。 */
  weight: number;
  qty: number;
  /**
   * kind 為 'AMMO' 時，這堆是哪一種**彈藥型別**（v0.15 附錄 B）。
   * 型別引用口徑，而不是拿口徑當彈藥 —— 同一種口徑日後會有多種彈種。
   * 對彈藥而言 `defId === ammoTypeId`。
   */
  ammoTypeId?: string;
  /** kind 為 'VALUABLE' 時的價值。局外層還不存在，本版只列在結算畫面上。 */
  value?: number;
  /** kind 為 'WEAPON' 時的完整武器狀態（含槍內剩餘子彈與射擊模式）。 */
  weapon?: Weapon;
}

/** 背包（§3）。裝備中與收納中的武器**不佔背包**。 */
export interface Backpack {
  items: Item[];
}

export type WeaponClass = 'LIGHT' | 'HEAVY';

/**
 * 詞條（v0.15 附錄 A）。**v0.15 一律為空，不實作任何效果。**
 *
 * 現在加欄位幾乎零成本；等背包、屍體、戰利品、配裝、存檔全部長好之後再改，
 * 會動到每一處。這與命中率鉤子、`penetration` 欄位、`CombatEvent` 事件流
 * 是同一種作法：先留形狀、後填內容。
 */
export interface Affix {
  id: string;
  name: string;
  /** 對型號數值的修正，例如 `{ accuracy: 0.05, reloadTime: -2 }`。 */
  modifiers: Record<string, number>;
}

/**
 * 來歷（v0.15 附錄 A）。**v0.15 一律為空。**
 *
 * `actor` **只存公司或勢力名稱，不得存放帳號或使用者識別** ——
 * 這是日後開放多人時的隱私邊界，現在先立下來。
 */
export interface Provenance {
  event: string;      // 'MANUFACTURED' | 'RECOVERED' | 'SALVAGED' …
  actor: string;      // 公司或勢力名稱
  note?: string;      // 自由文字，日後由文案填寫
}

/**
 * 一把槍的**數值**。型號與實例都用同一組欄位描述，差別在來源：
 * 型號的是資料檔寫死的，實例的是「型號數值套用詞條之後」的結果（見 core/weapon.ts）。
 */
export interface WeaponStats {
  name: string;
  class: WeaponClass;
  damage: number;
  /** 傷害浮動幅度：實際傷害在 damage ± damageSpread 之間均勻取整數（§8.2）。 */
  damageSpread: number;
  /** 穿甲：抵銷同等的護甲擲值。MVP 一律 0（§8.3）。 */
  penetration: number;
  range: number;          // 最大射程（格）
  magazine: number;       // 彈匣容量
  /** 這把槍吃哪一種口徑（v0.15 §19.1）。實際能不能用還要看彈藥型別與機構。 */
  calibre: Calibre;
  /** 機構型式（附錄 B §2.3）。v0.15 不參與任何判斷。 */
  action: WeaponAction;
  /** 計入負重（v0.15）。手持與收納中的武器不佔背包欄位，但仍然要背。 */
  weight: number;
  /** 可用的射擊模式（§8.9）。每把武器自己列出，程式不得寫死。 */
  modes: FireMode[];
  /** 開火的時間花費（§5 排程器）。 */
  fireTime: number;
  /**
   * **一次裝填動作**的時間花費。
   * `FULL` 是補滿的總時間；`INCREMENTAL` 是每一發的時間；
   * 若 reloadSequence 非 null，這個值等於序列各步的總和。
   */
  reloadTime: number;
  /** 裝填方式（v0.15）。 */
  reloadMode: ReloadMode;
  /** 裝填要走的系列動作 id；null = 單一動作即可完成（§5.5）。 */
  reloadSequence: string | null;
  /** 換到手上要花多久。省略時退回 `rules.json` 的 `time.swap[class]`。 */
  swapTime?: number;
  noiseRadius: number;    // 開火噪音半徑（格）
  splash: number;         // 濺射半徑，0 = 無
  accuracy: number;       // 基礎命中率 0..1
  optimalRange: number;   // 此距離內不衰減
  falloffPerTile: number; // 超出 optimalRange 每格扣除的命中率
}

/**
 * 武器**型號**：`data/weapons.json` 的一筆。不可變，全世界共用一份。
 * `ammo` 與 `mode` 在型號上是「出廠預設值」。
 */
export interface WeaponType extends WeaponStats {
  id: string;
  ammo: number;
  mode: FireMode;
}

/**
 * 武器**實例**：世界上實際存在的那一把槍（v0.15 附錄 A）。
 *
 * 玩家持有、掉落、拾取、遺落的都是實例。**兩把同型號的槍是兩個不同的實例**，
 * 可以分別追蹤 —— 這是日後詞條與跨玩家流通的最低前提：
 * 若武器只是「型號引用」，那就沒有任何東西可以被標記或被賦予來歷。
 *
 * 數值欄位是「型號數值套用 `affixes` 之後」的結果，由 core/weapon.ts 的
 * `resolveStats()` 這個唯一的套用點產生。**不要直接改 `affixes`** ——
 * 要改請走 `withAffixes()`，它會重新套用一次。
 */
export interface WeaponInstance extends WeaponStats {
  /** 這一把槍的唯一識別。來源必須是決定性的（狀態流水號），不得用時間或 UUID。 */
  instanceId: string;
  typeId: string;
  /** 槍內剩餘子彈（背包裡的總量另外算，§1.1）。 */
  ammo: number;
  /** 目前選定的模式。**記在實例上**，換槍再換回來時維持（§8.9）。 */
  mode: FireMode;
  /**
   * 可續行序列（`RESUMABLE`）的進度：已經完成幾個步驟（§5.6）。
   *
   * **進度存在武器上，不是存在單位上。** 退殼退了就是退了 ——
   * 收起來、換另一把、之後再換回來，那顆彈殼也不會自己跳回去。
   */
  reloadProgress: number;
  /** v0.15 一律為空。見 Affix。 */
  affixes: Affix[];
  /** v0.15 一律為空。見 Provenance。 */
  provenance: Provenance[];
}

/** 舊名。程式碼一律用 WeaponInstance，這個別名只是為了讓引用逐步遷移。 */
export type Weapon = WeaponInstance;

export type AiState = 'IDLE' | 'ALERT' | 'SEARCH';

export interface Unit {
  id: string;
  faction: 'PLAYER' | 'ENEMY';
  archetype: string;       // 'SOLDIER' | 'RUNNER' | 'HULK' | 'SHOOTER'
  name: string;
  pos: Vec2;
  hp: number;
  maxHp: number;
  armor: number;
  /** 護甲浮動幅度。**每次受擊各自擲一次**，不是生成時擲一次（§8.2）。 */
  armorSpread: number;
  aim: number;             // 命中修正，MVP 一律 0，見 §8.1
  evasion: number;         // 迴避修正，MVP 一律 0，見 §8.1
  stance: Stance;
  facing: Facing;
  sightRange: number;
  equipped: Weapon | null;   // 手上的武器
  stowed: Weapon | null;     // 收起來的武器
  /** 背包（§3）。敵人沒有背包，一律 null。 */
  backpack: Backpack | null;
  aiState: AiState;
  lastKnownTarget: Vec2 | null;
  searchTimer: number;
  /**
   * 這個單位下次可以行動的時刻（§5 排程器）。取代了 ap / maxAp。
   * 主迴圈永遠挑 nextActAt 最小的單位行動。
   */
  nextActAt: number;
  /** 移動一格的時間花費。 */
  moveTime: number;
  /** 狀態轉換的時間花費（§9.2）。玩家為 0。 */
  transitionTime: number;
  /**
   * 剛完成一次狀態轉換、還沒做過其他事。
   * 這就是玩家的反應窗口：敵人已經發現你，但它這一下用掉了，還沒輪到它開火。
   */
  transitioning: boolean;
  /** 進行中的系列動作（§5.5）。非 null 時，這個單位輪到時只能執行下一步。 */
  pendingSequence: Sequence | null;
  /**
   * 準備欄（§12.19）：現在身上「隨手可用」的那一件消耗品的 item id。
   *
   * 東西**仍然放在背包裡**，這裡只是一個標記 —— 所以重量、陣亡遺留、
   * 撤離帶出全部自動跟著背包走，不需要另一套規則。
   *
   * 準備要花時間（§5.2 的 time.prepare）。免費的話準備欄就只是多一次點擊，
   * 玩家會在需要時免費換上想要的東西，等同於直接從背包使用。
   */
  preparedId: string | null;
  /** 已宣告、下次輪到必定執行的動作（§9.4）。玩家單位一律 null。 */
  declared: Declaration | null;
  /** SEARCH 收尾還要巡視幾次（§9.3）。 */
  patrolLeft: number;
}

/**
 * 敵人宣告的下一個動作（§9.4）。
 *
 * **宣告具有拘束力**：下次輪到它時執行這個，不重新評估。
 * 這是口令機制的回報所在 —— 玩家聽到「繞右邊，開火」之後移動破壞它的射線，
 * 那一發就整個浪費掉。代價是 AI 依據稍舊的資訊行動，這是刻意的取捨：
 * 可被預測、可被玩弄的敵人，比反應完美的敵人有趣得多。
 *
 * 它是規則狀態（會決定下一次真的做什麼），所以進 GameState；
 * 顯示與動畫狀態不進（§12.18）。
 */
export type DeclKind =
  | 'SPOT'          // 剛發現目標（轉入警戒的那一聲）
  | 'ADVANCE'       // 因為要靠近而移動
  | 'FLANK'         // 因為要繞掉目標的掩蔽而移動
  | 'TAKE_COVER'    // 因為要替自己找掩蔽而移動
  | 'FIRE'
  | 'CROUCH'
  | 'RELOAD'
  | 'SEARCH_MOVE'
  | 'PATROL'        // 警戒巡視：原地轉 90 度
  | 'HOLD'          // 原地不動
  | 'LOST';         // 宣告在執行時失效

export interface Declaration {
  kind: DeclKind;
  /** 移動類：要走到哪一格。 */
  to?: Vec2;
  /** 射擊類：要打哪裡。 */
  target?: Vec2;
  /** 巡視類：要轉到哪個方向。 */
  facing?: Facing;
  /** FLANK 專用：繞畫面的左邊還是右邊（給口令用）。 */
  side?: 'LEFT' | 'RIGHT';
}

/**
 * 系列動作被打斷之後會怎樣（§5.6）。
 *
 * 判準是**已經完成的物理狀態改變會不會自己消失**：
 * 退殼退了就是退了，不會自己裝回去；包紮包到一半被打斷，那塊敷料就廢了。
 */
export type SequenceInterrupt =
  | 'RESUMABLE'   // 進度保留，下次從中斷的步驟接續（機械性動作）
  | 'RESTART';    // 進度歸零，已花費的時間不退還（生理性、精密性動作）

/**
 * 系列動作（§5.5）。效果只在整套走完時發生 ——
 * 走到一半的單位是暴露的、可被打斷的。
 */
export interface Sequence {
  /** 對應 data/rules.json 的 sequences 鍵值，例如 'RR4_RELOAD'。 */
  id: string;
  /** 目前進行到第幾步（0 起算）。 */
  index: number;
}

/**
 * 可搜刮的一堆東西（§4.1）。三種來源共用同一個型別、同一套兩段式點擊文法：
 * 己方屍體、敵人屍體、地圖搜刮點。
 *
 * 分成三個型別的話，搜刮面板要寫三份、拾取指令要開三條路 —— 沒有理由。
 */
export type LootKind = 'PLAYER_BODY' | 'ENEMY_BODY' | 'CACHE';

export interface LootPile {
  id: string;
  kind: LootKind;
  pos: Vec2;
  /** UI 標題，例如「K-441 的遺體」「補給箱」。 */
  label: string;
  items: Item[];
}

export interface MapData {
  id: string;
  name: string;
  width: number;
  height: number;
  /** 扁平陣列，index = y * width + x。 */
  tiles: TileType[];
  startDropPoint: Vec2;
}

export interface Objective {
  id: string;
  pos: Vec2;
  done: boolean;
}

export type LogKind =
  | 'INFO' | 'MOVE' | 'ATTACK' | 'HIT' | 'MISS' | 'DAMAGE'
  | 'DEATH' | 'NOISE' | 'AI' | 'OBJECTIVE' | 'MISSION';

export interface LogEntry {
  /** 事件發生的世界時刻（取代原本的回合數）。 */
  at: number;
  kind: LogKind;
  text: string;
}

/** 玩家單位陣亡後、尚未從名冊補人的暫停狀態（§10.1）。 */
export interface PendingReinforcement {
  deathPos: Vec2;
  deadUnitId: string;
}

export interface GameState {
  /**
   * 世界時刻。取代了 turn ——「回合」在 v0.7 之後不存在。
   * 每次有單位行動時，clock 前進到該單位的 nextActAt。
   */
  clock: number;
  map: MapData;
  units: Unit[];
  /** 戰場上所有可搜刮的東西（§4）。屍體與搜刮點共用這一份。 */
  loot: LootPile[];
  roster: string[];          // 尚未投入的士兵 id
  activePlayerUnitId: string | null;
  objectives: {
    main: Objective;
    secondary: Objective[];
  };
  casualties: number;
  deployed: number;          // 累計投入士兵數（結算畫面用）
  /**
   * 派遣快照（v0.16 §1.1）。**任務期間唯讀** —— 替補從這裡取自己的配裝。
   * 局外層的 MetaState 不進 GameState，任務仍然是純函數。
   */
  deployment: DeployedSoldier[];
  /** 本場的個人統計，結束後併進服役紀錄（§4.4）。soldierId → 數字。 */
  stats: Record<string, { kills: number; damageTaken: number }>;
  /** 這一場陣亡的士兵 id。局外層據此永久移除（§5.1）。 */
  deadSoldierIds: string[];
  /** 走出撤離點的那一位。止損與全滅都是 null。 */
  extractedBy: string | null;
  rngSeed: number;
  rng: RngState;
  result: 'ONGOING' | 'SUCCESS' | 'ABORTED' | 'WIPED';
  pendingReinforcement: PendingReinforcement | null;
  /**
   * 撤離時帶出去的東西（§5.1）。只有真的走出撤離點才會有內容；
   * 止損與全滅一律是空的 —— 那兩種情況戰場上的一切都損失（§5.3 / §5.4）。
   */
  extracted: Item[];
  /** 下一個要配發的實體流水號，讓 id 產生保持決定性（不用亂數）。 */
  nextEntitySerial: number;
  log: LogEntry[];
}

// ===================== 選取器（唯讀） =====================

export function findUnit(state: GameState, id: string | null): Unit | null {
  if (!id) return null;
  return state.units.find((u) => u.id === id) ?? null;
}

export function activePlayerUnit(state: GameState): Unit | null {
  return findUnit(state, state.activePlayerUnitId);
}

export function unitAt(state: GameState, pos: Vec2): Unit | null {
  return state.units.find((u) => u.pos.x === pos.x && u.pos.y === pos.y) ?? null;
}

export function lootAt(state: GameState, pos: Vec2): LootPile | null {
  return state.loot.find((c) => c.pos.x === pos.x && c.pos.y === pos.y) ?? null;
}

export function enemies(state: GameState): Unit[] {
  return state.units.filter((u) => u.faction === 'ENEMY');
}

export function isMissionOver(state: GameState): boolean {
  return state.result !== 'ONGOING';
}

/** 尚留在戰場上、未回收的東西（結算與 HUD 損益用）。 */
export function abandonedItems(state: GameState): Item[] {
  return state.loot.flatMap((c) => c.items);
}
