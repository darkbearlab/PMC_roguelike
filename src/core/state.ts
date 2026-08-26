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
  range: number;          // 最大射程（格）
  magazine: number;       // 彈匣容量
  ammo: number;           // 目前彈藥
  fireCost: number;       // 開火 AP 成本
  reloadCost: number;     // 裝填 AP 成本
  endsTurn: boolean;      // 開火後是否強制結束回合
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
  aim: number;             // 命中修正，MVP 一律 0，見 §8.1
  evasion: number;         // 迴避修正，MVP 一律 0，見 §8.1
  maxAp: number;
  ap: number;
  stance: Stance;
  facing: Facing;
  sightRange: number;
  equipped: Weapon | null;   // 手上的武器
  stowed: Weapon | null;     // 收起來的武器
  aiState: AiState;
  lastKnownTarget: Vec2 | null;
  searchTimer: number;
  /** 本回合已攻擊次數。SHOOTER 每回合上限 1 次（§9）。 */
  shotsThisTurn: number;
  /** 每回合攻擊次數上限。 */
  attacksPerTurn: number;
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
  turn: number;
  kind: LogKind;
  text: string;
}

/** 玩家單位陣亡後、尚未從名冊補人的暫停狀態（§10.1）。 */
export interface PendingReinforcement {
  deathPos: Vec2;
  deadUnitId: string;
}

export interface GameState {
  turn: number;
  phase: 'PLAYER' | 'ENEMY' | 'MISSION_END';
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
  /** 敵人回合剩餘待行動的單位 id（字典序）。空 = 敵人回合結束。 */
  enemyQueue: string[];
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
  return state.phase === 'MISSION_END';
}

/** 尚留在戰場上、未回收的武器（結算與 HUD 損益用）。 */
export function abandonedWeapons(state: GameState): Weapon[] {
  return state.corpses.flatMap((c) => c.weapons);
}
