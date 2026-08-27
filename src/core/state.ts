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
  | 'SUPPLY';     // 可通行，次要目標互動點

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
  ammo: number;           // 目前彈藥
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

export interface Corpse {
  id: string;
  pos: Vec2;
  unitId: string;            // 原本的士兵編號，用於 UI 顯示
  weapons: Weapon[];         // 死亡時攜帶的所有武器
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
  corpses: Corpse[];
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

export function corpseAt(state: GameState, pos: Vec2): Corpse | null {
  return state.corpses.find((c) => c.pos.x === pos.x && c.pos.y === pos.y) ?? null;
}

export function enemies(state: GameState): Unit[] {
  return state.units.filter((u) => u.faction === 'ENEMY');
}

export function isMissionOver(state: GameState): boolean {
  return state.result !== 'ONGOING';
}

/** 尚留在戰場上、未回收的武器（結算與 HUD 損益用）。 */
export function abandonedWeapons(state: GameState): Weapon[] {
  return state.corpses.flatMap((c) => c.weapons);
}
