/**
 * GameState 型別定義（§4）。
 *
 * 整份狀態必須可以完整序列化為 JSON —— 沒有 Map/Set/class instance/函式。
 * 相同的初始狀態 + 相同的指令序列 ⇒ 完全相同的結果（§3.1）。
 */
import type { RngState } from './rng';

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

/** 彈藥種類。背包裡追蹤的是**總發數**，不是彈匣個數（§1.1）。 */
export type AmmoType = 'RIFLE' | 'ROCKET';

/** 射擊模式（§2）。三種時間花費相同，差別只在耗彈與命中。 */
export type FireMode = 'SINGLE' | 'BURST' | 'AUTO';

export type ItemKind = 'AMMO' | 'VALUABLE' | 'DNA' | 'WEAPON';

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
  /** kind 為 'AMMO' 時，這堆是哪一種彈藥。 */
  ammoType?: AmmoType;
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

export interface Weapon {
  id: string;
  name: string;
  class: WeaponClass;
  damage: number;
  /** 傷害浮動幅度：實際傷害在 damage ± damageSpread 之間均勻取整數（§8.2）。 */
  damageSpread: number;
  /** 穿甲：抵銷同等的護甲擲值。MVP 一律 0（§8.3）。 */
  penetration: number;
  range: number;          // 最大射程（格）
  magazine: number;       // 彈匣容量
  ammo: number;           // 槍內剩餘子彈（背包裡的總量另外算，§1.1）
  /** 這把槍吃哪一種彈藥（§1.2）。 */
  ammoType: AmmoType;
  /** 放進背包時佔的重量（§3）。手持與收納中不佔背包。 */
  weight: number;
  /** 可用的射擊模式（§2）。重武器只有 SINGLE。 */
  modes: FireMode[];
  /** 目前選定的模式。**記在武器上**，換槍再換回來時維持（§2.5）。 */
  mode: FireMode;
  /** 開火的時間花費（§5 排程器）。 */
  fireTime: number;
  /** 裝填的時間花費。若 reloadSequence 非 null，這個值等於序列各步的總和。 */
  reloadTime: number;
  /** 裝填要走的系列動作 id；null = 單一動作即可完成（§5.5）。 */
  reloadSequence: string | null;
  noiseRadius: number;    // 開火噪音半徑（格）
  splash: number;         // 濺射半徑，0 = 無
  // --- 命中相關：MVP 不生效，但欄位與管線必須存在，見 §8.1 ---
  accuracy: number;       // 基礎命中率 0..1
  optimalRange: number;   // 此距離內不衰減
  falloffPerTile: number; // 超出 optimalRange 每格扣除的命中率
}

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
