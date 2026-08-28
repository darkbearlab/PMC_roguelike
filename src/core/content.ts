/**
 * 資料檔載入（§17：所有可調數值都在 data/ 的 JSON，不寫死在程式碼裡）。
 * import JSON 不涉及任何瀏覽器 API，core/ 的純粹性不受影響。
 */
import rulesJson from '../data/rules.json';
import weaponsJson from '../data/weapons.json';
import actorsJson from '../data/actors.json';
import itemsJson from '../data/items.json';
import ammoJson from '../data/ammo.json';
import calloutsJson from '../data/callouts.json';
import contractsJson from '../data/contracts.json';
import contractRulesJson from '../data/contract-rules.json';
import mission01Json from '../data/maps/mission_01.json';
import mission02Json from '../data/maps/mission_02.json';
import mission03Json from '../data/maps/mission_03.json';
import mission04Json from '../data/maps/mission_04.json';

import type { Calibre, FireMode, WeaponAction, WeaponClass, WeaponType } from './state';
import type { MapStats, RawMap } from './map';
import type { ContractBrief } from './contracts';

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
    /** 把一件消耗品放進準備欄（§12.19）。 */
    prepare: number;
    /** 丟棄。刻意為 0：緊急時減重不該被時間懲罰。 */
    drop: number;
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
  /**
   * §1 口徑（v0.15）。口徑是獨立的資料實體，武器以 `calibre` 引用它 ——
   * 新增武器只要指定口徑，就自動與既有彈藥相容。
   */
  calibres: Record<Calibre, {
    name: string;
    weightPerRound: number;
    /** 本地生產難度（附錄 B §1.3）。設定用，v0.15 不參與任何判斷。 */
    localProduction: 'EASY' | 'HARD' | 'NONE';
  }>;
  /** §2 射擊模式。時間花費相同，差別在耗彈與命中。 */
  fireModes: Record<FireMode, { label: string; full: string; shots: number; accuracy: number }>
    & { order: FireMode[] };
  /** §5 出擊前配裝（v0.15）。可選內容由 weapons/items/calibres 推導，這裡只有預設值與介面參數。 */
  loadout: {
    default: {
      primary: string | null;
      stowed: string | null;
      ammo: Record<string, number>;
      consumables: Record<string, number>;
    };
    /** 鍵是**彈藥型別 id**，不是口徑（附錄 B §2.2）。 */
    ammoStep: Record<string, number>;
    ammoMax: number;
    consumableMax: number;
  };
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
    /** v0.13：預估完成路徑時間（下限估計）的區間。 */
    estRunTime: { min: number; max: number };
    /** v0.13：東西向與南北向掩蔽覆蓋率的差距上限（百分點）。 */
    dirCoverGap: number;
  };
  /** §19 局外層（v0.16）。起始狀態與補給站內容全部在資料檔。 */
  meta: {
    schemaVersion: number;
    soldierHp: number;
    missionLogSize: number;
    start: {
      soldiers: number;
      weapons: string[];
      ammo: Record<string, number>;
      consumables: Record<string, number>;
    };
    supply: {
      weapons: string[];
      ammo: string[];
      ammoBatch: Record<string, number>;
    };
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
  /** 敵人的攻擊也是一份型號資料；實際單位身上掛的是它的實例。 */
  attack?: WeaponType;
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

/**
 * 一種彈藥（v0.15 附錄 B §2）。修正欄位是預留的，v0.15 一律為預設值。
 */
export interface AmmoType {
  name: string;
  calibreId: Calibre;
  weightPerRound: number;
  /** 傷害倍率。v0.15 一律 1.0。 */
  damageModifier: number;
  /** 衰減倍率。v0.15 一律 1.0。 */
  falloffModifier: number;
  /** 濺射半徑。v0.15 一律 0。 */
  splashRadius: number;
  /** 只有這些機構型式打得出來；空陣列 = 不限制。v0.15 一律為空。 */
  allowedActions: WeaponAction[];
}

/** data/items.json 的一筆定義。 */
export interface ItemDef {
  name: string;
  kind: string;
  weight: number;
  ammoTypeId?: string;
  value?: number;
  /**
   * 消耗品的使用方式（§4）。資料驅動：新增品項只要改 items.json。
   * 序列 id 直接用該消耗品的 defId。
   */
  use?: {
    label: string;
    sequenceType: 'RESUMABLE' | 'RESTART';
    steps: { id: string; label: string; time: number }[];
    effects?: { kind: string; amount: number }[];
  };
}

/** 合約清單的推導規則（§18.2 / §18.3）。門檻與權重全在資料檔。 */
export interface ContractRules {
  listSize: number;
  maxTags: number;
  minTags: number;
  tags: {
    id: string; label: string; priority: number;
    stat: keyof MapStats; op: 'gte' | 'lte'; value: number;
  }[];
  difficulty: {
    terms: { stat: keyof MapStats; base: number; weight: number }[];
    bands: { max: number; rating: string; label: string }[];
  };
}

export const RULES: Rules = rulesJson as unknown as Rules;
/** 武器**型號**（v0.15 附錄 A）。世界上實際存在的那幾把是實例，見 core/weapon.ts。 */
export const WEAPONS: WeaponType[] = weaponsJson as unknown as WeaponType[];
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
/** 敵人口令的文字（§9.5）。理由碼 → 文字，全部在資料檔。 */
export const CALLOUTS: Record<string, string> = Object.fromEntries(
  Object.entries(calloutsJson as Record<string, string>).filter(([k]) => !k.startsWith('_')),
);

/**
 * 合約簡報（§18.4）。**手寫文案**，與地圖資料分離 ——
 * 地形標籤與難度評級則相反，一律由統計值推導（§18.2）。
 */
export const CONTRACTS: Record<string, ContractBrief> = Object.fromEntries(
  Object.entries(contractsJson as Record<string, unknown>).filter(([k]) => !k.startsWith('_')),
) as Record<string, ContractBrief>;

export const CONTRACT_RULES: ContractRules = contractRulesJson as unknown as ContractRules;

/**
 * 彈藥型別（v0.15 附錄 B §2）。**彈藥的識別單位是型別，型別引用口徑。**
 *
 * 未來同一種口徑會有多種彈種（12 號徑的鋼珠／獨頭／鋼索切段、5.56 的穿甲彈…），
 * 所以背包、配裝、裝填、搜刮、屍體、結算清單一律以型別 id 為鍵。
 * 現在多一層間接幾乎零成本；等那些全部長好之後再改，會動到每一處。
 */
export const AMMO_TYPES: Record<string, AmmoType> = Object.fromEntries(
  Object.entries(ammoJson as Record<string, unknown>).filter(([k]) => !k.startsWith('_')),
) as Record<string, AmmoType>;

export function ammoType(id: string): AmmoType {
  const a = AMMO_TYPES[id];
  if (!a) throw new Error('未知的彈藥型別 ' + id);
  return a;
}

/** 這個口徑目前有哪些彈藥型別。v0.15 每個口徑剛好一種。 */
export function ammoTypesForCalibre(c: Calibre): { id: string; def: AmmoType }[] {
  return Object.entries(AMMO_TYPES)
    .filter(([, a]) => a.calibreId === c)
    .map(([id, def]) => ({ id, def }));
}

/**
 * 背包裡看得到的東西。
 *
 * 彈藥不寫在 items.json，而是由**彈藥型別**（ammo.json）合成進來 ——
 * 型別 id 同時就是它的 defId，所以搜刮表、地圖補給箱、初始配裝
 * 一律引用型別 id，`makeItem()` 不必知道彈藥是特別的。
 */
export const ITEMS: Record<string, ItemDef> = {
  ...Object.fromEntries(
    Object.entries(itemsJson as Record<string, unknown>).filter(([k]) => !k.startsWith('_')),
  ) as Record<string, ItemDef>,
  ...Object.fromEntries(
    Object.entries(AMMO_TYPES).map(([id, a]) => [id, {
      name: a.name,
      kind: 'AMMO',
      weight: a.weightPerRound,
      ammoTypeId: id,
    } as ItemDef]),
  ),
};

/** 射擊模式的循環順序（§2.5：點一下循環切換）。 */
export function fireModeOrder(): FireMode[] {
  return RULES.fireModes.order;
}



export function archetype(id: string): ActorArchetype {
  const a = ACTORS[id];
  if (!a) throw new Error(`未知的單位原型: ${id}`);
  return a;
}


