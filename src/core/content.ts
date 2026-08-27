/**
 * 資料檔載入（§17：所有可調數值都在 data/ 的 JSON，不寫死在程式碼裡）。
 * import JSON 不涉及任何瀏覽器 API，core/ 的純粹性不受影響。
 */
import rulesJson from '../data/rules.json';
import weaponsJson from '../data/weapons.json';
import actorsJson from '../data/actors.json';
import itemsJson from '../data/items.json';
import calloutsJson from '../data/callouts.json';
import mission01Json from '../data/maps/mission_01.json';
import mission02Json from '../data/maps/mission_02.json';
import mission03Json from '../data/maps/mission_03.json';
import mission04Json from '../data/maps/mission_04.json';

import type { FireMode, Weapon, WeaponClass } from './state';
import type { RawMap } from './map';

export interface Rules {
  roster: { size: number; idPrefix: string };
  /** v0.7 排程器的時間成本。程式碼中不得寫死任何時間值。 */
  time: {
    move: number;
    wait: number;
    pickup: number;
    interact: number;
    stance: number;
    facing: number;
    deploy: number;
    swap: Record<WeaponClass, number>;
  };
  /** §3 背包與負重。 */
  backpack: {
    maxWeight: number;
    weightTiers: { maxWeight: number; moveCost: number }[];
    startingItems: { defId: string; qty: number }[];
    reinforcementItems: { defId: string; qty: number }[];
  };
  /** §2 射擊模式。三種時間花費相同，差別在耗彈與命中。 */
  fireModes: Record<FireMode, { label: string; shots: number; accuracy: number }>
    & { order: FireMode[] };
  /** §4 搜刮。 */
  loot: { takeTime: number; dnaDefId: string };
  /** §13.5 地圖驗證的門檻。現在防手滑，將來是程序化拼接的約束條件。 */
  mapRules: {
    minDropPoints: number;
    dropSpacing: { min: number; max: number };
    coverDensity: { min: number; max: number };
    maxExposedRun: number;
    maxForcedExposure: number;
    maxOrphanTiles: number;
    secondaryObjectives: number;
    minMainDistance: number;
    enemies: { min: number; max: number };
    minCaches: number;
  };
  sequences: Record<string, unknown>;
  ai: {
    searchTime: number;
    /** v0.10 總開關。關掉就回到 v0.9 的敵人行為。 */
    tacticalBehaviour: boolean;
    patrolTurnTime: number;
    searchWrapUpTurns: number;
    calloutRange: number;
  };
  combat: {
    enableToHitRoll: boolean;
    hitFloor: number;
    hitCeil: number;
    minDamage: number;
    stance: { shooterCrouchBonus: number; targetCrouchPenalty: number };
    backstab: { bonus: number; ignoreCover: boolean };
    cover: { partial: number; good: number };
  };
  movement: { _comment: string };
  presentation: { enemyStepMs: number; playerMoveStepMs: number };
  log: { maxEntries: number };
}

export interface ActorArchetype {
  name: string;
  faction: 'PLAYER' | 'ENEMY';
  hp: number;
  armor: number;
  armorSpread: number;
  time: { move: number; transition: number };
  sightRange: number;
  aim: number;
  evasion: number;
  attack?: Weapon;
  /** 敵人屍體的掉落表（§4.2）。抽值順序固定：由上而下各抽一次。 */
  loot?: { defId: string; qty: number; chance: number }[];
  /** 落點評分的權重（§9.2）。權重必須依原型不同，否則三種敵人會退化成同一種打法。 */
  ai?: {
    approach: number;
    selfCover: number;
    targetExposure: number;
    canShoot: number;
    crouchInCover: boolean;
  };
}

/** data/items.json 的一筆定義。 */
export interface ItemDef {
  name: string;
  kind: string;
  weight: number;
  ammoType?: string;
  value?: number;
}

export const RULES: Rules = rulesJson as unknown as Rules;
export const WEAPONS: Weapon[] = weaponsJson as unknown as Weapon[];
export const ACTORS: Record<string, ActorArchetype> = actorsJson as unknown as Record<string, ActorArchetype>;
/**
 * 四張手刻地圖（§13.1）。順序固定 —— 隨機選圖用的是索引，
 * 換順序就會改變同一個種子選到的圖。
 *
 * 三張新圖不是為了內容變多，是**三個對照實驗**：
 * 走廊密集、開闊地、掩體密集。mission_01 保留作為與既有數據的基準。
 */
export const MAPS: RawMap[] = [
  mission01Json, mission02Json, mission03Json, mission04Json,
] as unknown as RawMap[];

export const MISSION_01: RawMap = MAPS[0];

export function mapById(id: string): RawMap | null {
  return MAPS.find((m) => m.id === id) ?? null;
}
export const ITEMS: Record<string, ItemDef> = Object.fromEntries(
  Object.entries(itemsJson as Record<string, unknown>)
    .filter(([k]) => !k.startsWith('_')),
) as Record<string, ItemDef>;

/** 敵人口令的文字（§9.5）。理由碼 → 文字，全部在資料檔。 */
export const CALLOUTS: Record<string, string> = Object.fromEntries(
  Object.entries(calloutsJson as Record<string, string>).filter(([k]) => !k.startsWith('_')),
);

/** 射擊模式的循環順序（§2.5：點一下循環切換）。 */
export function fireModeOrder(): FireMode[] {
  return RULES.fireModes.order;
}

export function weaponById(id: string): Weapon {
  const w = WEAPONS.find((x) => x.id === id);
  if (!w) throw new Error(`未知的武器 id: ${id}`);
  return cloneWeapon(w);
}

export function archetype(id: string): ActorArchetype {
  const a = ACTORS[id];
  if (!a) throw new Error(`未知的單位原型: ${id}`);
  return a;
}

/** 武器是可變狀態（ammo），每個實例都必須是獨立複本。 */
export function cloneWeapon(w: Weapon): Weapon {
  return { ...w };
}
