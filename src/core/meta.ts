/**
 * 局外層的持久狀態（v0.16 §1）。
 *
 * **這一版是分水嶺。**專案至此蓋好的核心機制 —— 陣亡掉落、屍體回收、
 * 帶著戰利品提早撤離、止損、名冊耗盡 —— 在此之前全部沒有作用，
 * 因為下一場一切都會回來。「要不要冒險走回去撿自己的屍體」是本作的核心決策，
 * 而它到目前為止一次都沒有真正發生過。這一版是把電接上去。
 *
 * **`MetaState` 不得混入 `GameState`。**任務仍然是純函數：
 *
 *     mission(派遣快照, 種子, 玩家輸入) → 任務結果
 *
 * 任務期間完全不讀寫 `MetaState`；結束後才由這一層把結果套用回去。
 */
import type { Item, WeaponInstance } from './state';
import type { CarriedKit } from './loadout';
import { kitWeight } from './loadout';
import { AMMO_TYPES, ECONOMY, ITEMS, RULES, ammoTypesForCalibre } from './content';
import { makeWeapon } from './weapon';
import { createRng, nextInt } from './rng';
import {
  ammoPrice, consumablePrice, contractReward, debtTier, isLegacy, itemPrice, rollLegacyStock,
  secondaryReward, sellValue, soldierPrice, weaponPrice,
} from './economy';
import type { Serial } from './weapon';

/**
 * 一名士兵的配裝。
 *
 * **武器欄位引用的是實例 id，不是型號** —— 同一把槍不可能同時在兩個人身上。
 * 這是 v0.16 最重要的約束，也是配裝從「選裝備」變成「分配資源」的原因。
 */
export interface Loadout {
  equippedWeaponId: string | null;
  stowedWeaponId: string | null;
  /** 彈藥型別 id → 發數。從共用庫存分配出去的部分。 */
  ammo: Record<string, number>;
  /** 消耗品 defId → 數量。 */
  consumables: Record<string, number>;
}

/**
 * 服役紀錄（§4.4）。**這是純數值士兵唯一的人格來源。**
 * 玩家的感情不是對角色設定產生的，是對「這傢伙活下來了」產生的。
 */
export interface ServiceRecord {
  missions: number;
  kills: number;
  damageTaken: number;
  contracts: string[];
}

export interface Soldier {
  id: string;
  /** `編號-世代`。世代機制尚未實作，全部為 Gen.1（§4.3）。 */
  designation: string;
  hp: number;
  maxHp: number;
  loadout: Loadout;
  serviceRecord: ServiceRecord;
}

/** 一場任務的簡短歷史紀錄。 */
export interface MissionRecord {
  mapName: string;
  contractCode: string;
  outcome: string;
  clock: number;
  deployed: number;
  casualties: number;
  /** v0.20：這一趟的損益（只計入實際入帳的報酬，見 MissionLedger）。 */
  net?: number;
}

export interface MetaState {
  /** §7.2：載入時版本不符就提示重置，**不要遷移**。 */
  schemaVersion: number;
  /**
   * 實例識別碼的計數器（§1.2）。**必須一起持久化** ——
   * 否則重新載入頁面之後會產生重複的 instanceId，
   * 而武器實例的整個追蹤機制會從根部壞掉。
   */
  instanceCounter: number;
  roster: Soldier[];
  /** 公司持有、未指派給任何人的武器。 */
  armoury: WeaponInstance[];
  /** 未分配的共用彈藥庫存：ammoTypeId → 數量。 */
  ammoStock: Record<string, number>;
  consumableStock: Record<string, number>;
  /** 帶回來的值錢物品與 DNA。本階段沒有用途，只是列著。 */
  salvage: Record<string, number>;
  missionLog: MissionRecord[];

  // ---- v0.20 經濟層 ----
  /**
   * 信用點。**可以為負** —— 沒有破產結束遊戲（§4.2）。
   * 發行機構已經不存在了，但所有帳目仍以它計價。
   */
  credits: number;
  /** 完成的合約數。遺產武器的現貨綁定它，**不綁定真實時間**（§2.4）。 */
  contractsCompleted: number;
  /** 補給站現在有的遺產武器（型號 id）。不是型錄，是現貨。 */
  legacyStock: string[];
  /** 抽現貨用的種子。存進來才能在重新載入之後接得下去。 */
  stockSeed: number;
  /** 待閱讀的董事會信件（級距 id）。 */
  mail: string[];
}

// ============================================================================
// 建立與查詢
// ============================================================================

export function emptyLoadout(): Loadout {
  return { equippedWeaponId: null, stowedWeaponId: null, ammo: {}, consumables: {} };
}

/** 實例計數器與 MetaState 綁在一起，所以取號要透過它（§1.2）。 */
function serialOf(meta: MetaState): Serial {
  return {
    get nextEntitySerial(): number { return meta.instanceCounter; },
    set nextEntitySerial(v: number) { meta.instanceCounter = v; },
  } as Serial;
}

/** 造一把新槍並放進軍械庫。補給站與新公司的起始配備都走這裡。 */
export function grantWeapon(meta: MetaState, typeId: string): WeaponInstance {
  const w = makeWeapon(serialOf(meta), typeId);
  meta.armoury.push(w);
  return w;
}

export function grantAmmo(meta: MetaState, ammoTypeId: string, qty: number): void {
  meta.ammoStock[ammoTypeId] = (meta.ammoStock[ammoTypeId] ?? 0) + qty;
}

export function grantConsumable(meta: MetaState, defId: string, qty: number): void {
  meta.consumableStock[defId] = (meta.consumableStock[defId] ?? 0) + qty;
}

export function grantSoldier(meta: MetaState, id?: string): Soldier {
  const n = meta.instanceCounter++;
  const sid = id ?? RULES.roster.idPrefix + n;
  const s: Soldier = {
    id: sid,
    designation: sid + ' Gen.1',
    hp: RULES.meta.soldierHp,
    maxHp: RULES.meta.soldierHp,
    loadout: emptyLoadout(),
    serviceRecord: { missions: 0, kills: 0, damageTaken: 0, contracts: [] },
  };
  meta.roster.push(s);
  return s;
}

export function findSoldier(meta: MetaState, id: string): Soldier | null {
  return meta.roster.find((s) => s.id === id) ?? null;
}

export function findWeapon(meta: MetaState, instanceId: string | null): WeaponInstance | null {
  if (!instanceId) return null;
  const inArmoury = meta.armoury.find((w) => w.instanceId === instanceId);
  if (inArmoury) return inArmoury;
  for (const s of meta.roster) {
    for (const id of [s.loadout.equippedWeaponId, s.loadout.stowedWeaponId]) {
      if (id === instanceId) return meta.armoury.find((w) => w.instanceId === id) ?? null;
    }
  }
  return null;
}

/**
 * 誰拿著這把槍。`null` = 還在軍械庫裡。
 * **同一把槍不可能同時在兩個人身上** —— 指派時一定先從別人身上收回。
 */
export function holderOf(meta: MetaState, instanceId: string): Soldier | null {
  return meta.roster.find(
    (s) => s.loadout.equippedWeaponId === instanceId || s.loadout.stowedWeaponId === instanceId,
  ) ?? null;
}

/** 沒有被任何人拿著的武器。 */
export function unassignedWeapons(meta: MetaState): WeaponInstance[] {
  return meta.armoury.filter((w) => holderOf(meta, w.instanceId) === null);
}

/** 某個彈藥型別還剩多少沒分配出去。 */
export function freeAmmo(meta: MetaState, ammoTypeId: string): number {
  return meta.ammoStock[ammoTypeId] ?? 0;
}

export function freeConsumable(meta: MetaState, defId: string): number {
  return meta.consumableStock[defId] ?? 0;
}

/** 把一份配裝展開成 core/loadout.ts 算得動的形狀（實例 + 數量）。 */
export function resolveLoadout(meta: MetaState, l: Loadout): CarriedKit {
  return {
    equipped: findWeapon(meta, l.equippedWeaponId),
    stowed: findWeapon(meta, l.stowedWeaponId),
    ammo: { ...l.ammo },
    consumables: { ...l.consumables },
  };
}

// ============================================================================
// 指派（配裝畫面的四個動作）
// ============================================================================

/**
 * 把一把槍指派給某人的某一格。`soldierId` 為 null = 收回軍械庫。
 * **一定先從原本的持有者身上拔掉** —— 同一把槍不可能同時在兩個人身上（§3.2）。
 */
export function assignWeapon(
  meta: MetaState, instanceId: string, soldierId: string | null, slot: 'equipped' | 'stowed',
): void {
  for (const s of meta.roster) {
    if (s.loadout.equippedWeaponId === instanceId) s.loadout.equippedWeaponId = null;
    if (s.loadout.stowedWeaponId === instanceId) s.loadout.stowedWeaponId = null;
  }
  if (!soldierId) return;
  const to = findSoldier(meta, soldierId);
  if (!to) return;
  // 那一格原本的槍回到軍械庫（只要不指派給任何人，它就自動算未指派）
  if (slot === 'equipped') to.loadout.equippedWeaponId = instanceId;
  else to.loadout.stowedWeaponId = instanceId;
}

/** 把某人某一格的槍收回軍械庫。 */
export function unassignSlot(
  meta: MetaState, soldierId: string, slot: 'equipped' | 'stowed',
): void {
  const s = findSoldier(meta, soldierId);
  if (!s) return;
  if (slot === 'equipped') s.loadout.equippedWeaponId = null;
  else s.loadout.stowedWeaponId = null;
}

/**
 * 從共用庫存調整某人的攜行彈藥。回傳實際變動量。
 * 加得比庫存多就只加到庫存見底；減不會低於 0。
 */
export function moveAmmo(
  meta: MetaState, soldierId: string, ammoTypeId: string, delta: number,
): number {
  const s = findSoldier(meta, soldierId);
  if (!s) return 0;
  const held = s.loadout.ammo[ammoTypeId] ?? 0;
  const stock = freeAmmo(meta, ammoTypeId);
  const applied = delta >= 0 ? Math.min(delta, stock) : -Math.min(-delta, held);
  if (applied === 0) return 0;
  s.loadout.ammo[ammoTypeId] = held + applied;
  meta.ammoStock[ammoTypeId] = stock - applied;
  if (s.loadout.ammo[ammoTypeId] <= 0) delete s.loadout.ammo[ammoTypeId];
  return applied;
}

export function moveConsumable(
  meta: MetaState, soldierId: string, defId: string, delta: number,
): number {
  const s = findSoldier(meta, soldierId);
  if (!s) return 0;
  const held = s.loadout.consumables[defId] ?? 0;
  const stock = freeConsumable(meta, defId);
  const applied = delta >= 0 ? Math.min(delta, stock) : -Math.min(-delta, held);
  if (applied === 0) return 0;
  s.loadout.consumables[defId] = held + applied;
  meta.consumableStock[defId] = stock - applied;
  if (s.loadout.consumables[defId] <= 0) delete s.loadout.consumables[defId];
  return applied;
}

// ============================================================================
// 派遣快照（§1.1）
// ============================================================================

/**
 * 一名可派遣的士兵。**這是任務唯一看得到的東西** ——
 * 任務期間不讀 `MetaState`，替補也是從這份快照裡取。
 */
export interface DeployedSoldier {
  id: string;
  designation: string;
  hp: number;
  maxHp: number;
  equipped: WeaponInstance | null;
  stowed: WeaponInstance | null;
  /** 背包內容的規格，落地時才依任務的流水號展開成 Item。 */
  items: { defId: string; qty: number }[];
}

export interface Deployment {
  soldiers: DeployedSoldier[];
  /** 首發士兵。其餘照 `soldiers` 的順序當替補人選。 */
  firstId: string;
}

const cloneWeaponFor = (w: WeaponInstance | null): WeaponInstance | null =>
  (w ? JSON.parse(JSON.stringify(w)) as WeaponInstance : null);

/**
 * 取一份派遣快照。**深複製武器實例** —— 任務中槍會被打空、會被裝填，
 * 那些改動在結果套用回來之前不可以碰到 `MetaState`。
 */
export function makeDeployment(meta: MetaState, firstId: string): Deployment {
  const soldiers: DeployedSoldier[] = meta.roster.map((s) => ({
    id: s.id,
    designation: s.designation,
    hp: s.hp,
    maxHp: s.maxHp,
    equipped: cloneWeaponFor(findWeapon(meta, s.loadout.equippedWeaponId)),
    stowed: cloneWeaponFor(findWeapon(meta, s.loadout.stowedWeaponId)),
    items: [
      ...Object.entries(s.loadout.ammo).map(([defId, qty]) => ({ defId, qty })),
      ...Object.entries(s.loadout.consumables).map(([defId, qty]) => ({ defId, qty })),
    ].filter((e) => e.qty > 0),
  }));
  return { soldiers, firstId };
}

// ============================================================================
// 把任務結果套用回來（§5）
// ============================================================================

export interface MissionResult {
  mapName: string;
  contractCode: string;
  outcome: 'SUCCESS' | 'ABORTED' | 'WIPED';
  clock: number;
  /** 這一場真的下場過的士兵。 */
  deployedIds: string[];
  /** 陣亡的士兵。永久移除。 */
  deadIds: string[];
  /** 難度評級（報酬倍率用）。 */
  rating: string;
  /** 主目標完成了嗎 —— **完成才給主要報酬**（§3.1）。 */
  mainDone: boolean;
  /** 完成了幾個次要目標。止損撤離時仍然拿得到這一份。 */
  secondaryDone: number;
  /** 這一趟帶出去的物資規格（彈藥與消耗品），用來算消耗。 */
  issued: { defId: string; qty: number }[];
  /** 這一趟帶出去的武器實例 id，用來算遺留損失。 */
  issuedWeaponIds: string[];
  /** 走出撤離點的那一位（止損與全滅都是 null）。 */
  survivorId: string | null;
  /**
   * 他撤離時手上與收納欄裡的是哪兩把（v0.18）。
   *
   * 不靠 `extracted` 的順序去猜 —— 那樣背包裡的手槍會搶走主手，
   * 而玩家冒著命撿回來的那把砲反而變成未指派。
   */
  survivorEquippedId: string | null;
  survivorStowedId: string | null;
  /** 帶出來的東西。武器仍是原本那個 instanceId。 */
  extracted: Item[];
  kills: Record<string, number>;
  damageTaken: Record<string, number>;
}

/**
 * §5：把一場任務的結果套用回公司。
 *
 * 規則只有一條，但它是這一整版的重點：
 * **只有「帶出來的東西」還在。其餘一律永久移除。**
 *
 * - 陣亡的士兵從名冊移除，他身上的武器實例從軍械庫移除（留在戰場上了）
 * - 止損撤出：**人回來，身上與背包的一切留在戰場上**。
 *   若止損不必付代價，它就會嚴格優於走到撤離點 —— 而那一段路正是本作的張力所在。
 * - 生還者的生命值全額恢復。**這是佔位規則**（§5.3）：
 *   跨任務的傷勢需要治療手段，而治療在本作設定中意味著「更換」，那屬於經濟與合成層。
 */
export function applyMissionResult(meta: MetaState, r: MissionResult): MetaState {
  const m = JSON.parse(JSON.stringify(meta)) as MetaState;

  // 服役紀錄先記，因為陣亡者也算出過這一勤（只是不會再有下一次）
  for (const id of r.deployedIds) {
    const s = findSoldier(m, id);
    if (!s) continue;
    s.serviceRecord.missions += 1;
    s.serviceRecord.kills += r.kills[id] ?? 0;
    s.serviceRecord.damageTaken += r.damageTaken[id] ?? 0;
    if (r.contractCode && !s.serviceRecord.contracts.includes(r.contractCode)) {
      s.serviceRecord.contracts.push(r.contractCode);
    }
  }

  // ---- 損失：下場過的人身上的東西一律先歸零，再把帶出來的加回去 ----
  const wentOut = new Set(r.deployedIds);
  for (const s of m.roster) {
    if (!wentOut.has(s.id)) continue;
    s.loadout = emptyLoadout();
  }
  const lostWeapons = new Set<string>();
  for (const s of meta.roster) {
    if (!wentOut.has(s.id)) continue;
    for (const id of [s.loadout.equippedWeaponId, s.loadout.stowedWeaponId]) {
      if (id) lostWeapons.add(id);
    }
  }

  // 陣亡者永久移除
  m.roster = m.roster.filter((s) => !r.deadIds.includes(s.id));

  // ---- 收穫：帶出來的東西 ----
  const survivor = r.survivorId ? findSoldier(m, r.survivorId) : null;
  for (const it of r.extracted) {
    if (it.kind === 'WEAPON' && it.weapon) {
      lostWeapons.delete(it.weapon.instanceId);
      const i = m.armoury.findIndex((w) => w.instanceId === it.weapon!.instanceId);
      if (i >= 0) m.armoury[i] = it.weapon;
      else m.armoury.push(it.weapon);
      // 帶出來的槍留在那個人手上，**而且是他撤離時的那個配置**（v0.18）
      if (survivor) {
        if (it.weapon.instanceId === r.survivorEquippedId) {
          survivor.loadout.equippedWeaponId = it.weapon.instanceId;
        } else if (it.weapon.instanceId === r.survivorStowedId) {
          survivor.loadout.stowedWeaponId = it.weapon.instanceId;
        }
        // 其餘（背包裡的槍）留在軍械庫，等玩家在公司畫面重新分配
      }
    } else if (it.kind === 'AMMO' && it.ammoTypeId) {
      grantAmmo(m, it.ammoTypeId, it.qty);
    } else if (it.kind === 'CONSUMABLE') {
      grantConsumable(m, it.defId, it.qty);
    } else {
      m.salvage[it.defId] = (m.salvage[it.defId] ?? 0) + it.qty;
    }
  }

  // 沒帶出來的槍：永久移除（留在戰場上）
  m.armoury = m.armoury.filter((w) => !lostWeapons.has(w.instanceId));

  // 生還者全額恢復（佔位規則，§5.3）
  for (const s of m.roster) s.hp = s.maxHp;

  m.missionLog.unshift({
    mapName: r.mapName,
    contractCode: r.contractCode,
    outcome: r.outcome,
    clock: r.clock,
    deployed: r.deployedIds.length,
    casualties: r.deadIds.length,
  });
  m.missionLog = m.missionLog.slice(0, RULES.meta.missionLogSize);
  return m;
}

/** 新公司的起始狀態（§7.4）。內容全部來自資料檔。 */
export function newCompany(): MetaState {
  const start = RULES.meta.start;
  const meta: MetaState = {
    schemaVersion: RULES.meta.schemaVersion,
    instanceCounter: 1,
    roster: [],
    armoury: [],
    ammoStock: {},
    consumableStock: {},
    salvage: {},
    missionLog: [],
    credits: RULES.meta.start.credits,
    contractsCompleted: 0,
    legacyStock: [],
    stockSeed: RULES.meta.start.stockSeed,
    mail: [],
  };
  meta.legacyStock = rollLegacyStock(createRng(meta.stockSeed));
  for (let i = 0; i < start.soldiers; i++) grantSoldier(meta);
  for (const t of start.weapons) grantWeapon(meta, t);
  for (const [id, n] of Object.entries(start.ammo)) grantAmmo(meta, id, n as number);
  for (const [id, n] of Object.entries(start.consumables)) grantConsumable(meta, id, n as number);
  return meta;
}

/** 補給站賣得出來的東西（§6）。全部 0 元，內容由資料檔決定。 */
export function supplyCatalogue(): {
  weapons: string[]; ammo: string[]; consumables: string[];
} {
  return {
    weapons: RULES.meta.supply.weapons,
    ammo: RULES.meta.supply.ammo,
    consumables: Object.keys(ITEMS).filter((id) => !!ITEMS[id].use),
  };
}

/** 一次補給的數量（彈藥一次給一整批，不要按 60 下）。 */
export function supplyBatch(ammoTypeId: string): number {
  return RULES.meta.supply.ammoBatch[ammoTypeId] ?? 1;
}



/**
 * 從結束的任務狀態抽出結果（§5）。
 *
 * 只讀 `GameState`，不碰 `MetaState` —— 這是兩層之間唯一的接縫。
 */
export function missionResultOf(
  state: import('./state').GameState,
  meta: { mapName: string; contractCode: string; rating: string },
): MissionResult {
  const kills: Record<string, number> = {};
  const damageTaken: Record<string, number> = {};
  for (const [id, v] of Object.entries(state.stats)) {
    if (v.kills) kills[id] = v.kills;
    if (v.damageTaken) damageTaken[id] = v.damageTaken;
  }
  const survivor = state.extractedBy
    ? state.units.find((u) => u.id === state.extractedBy) ?? null
    : null;
  // 下場過的人 = 快照全部，扣掉還沒被投入的
  const notDeployed = new Set(state.roster);
  const deployedIds = state.deployment
    .map((d) => d.id)
    .filter((id) => !notDeployed.has(id));
  const wentOut = new Set(deployedIds);
  const out = state.deployment.filter((d) => wentOut.has(d.id));
  return {
    mapName: meta.mapName,
    contractCode: meta.contractCode,
    rating: meta.rating,
    mainDone: state.objectives.main.done,
    secondaryDone: state.objectives.secondary.filter((o) => o.done).length,
    issued: out.flatMap((d) => d.items.map((e) => ({ ...e }))),
    issuedWeaponIds: out.flatMap((d) =>
      [d.equipped, d.stowed].filter(Boolean).map((w) => w!.instanceId)),
    outcome: state.result === 'ONGOING' ? 'ABORTED' : state.result,
    clock: state.clock,
    deployedIds,
    deadIds: [...state.deadSoldierIds],
    survivorId: state.extractedBy,
    survivorEquippedId: survivor?.equipped?.instanceId ?? null,
    survivorStowedId: survivor?.stowed?.instanceId ?? null,
    extracted: state.extracted.map((it) => JSON.parse(JSON.stringify(it)) as Item),
    kills,
    damageTaken,
  };
}

// ============================================================================
// 自動補給（v0.18 附錄）
// ============================================================================

/**
 * 這名士兵的彈藥基準：他手上那兩把槍各要幾發。
 *
 * 基準寫在武器上（`resupplyMagazines` × `magazine`）——
 * AR-9 的 3 個彈倉剛好是 24 發，也就是 v0.15 以來的預設攜行量。
 */
export function resupplyTarget(meta: MetaState, s: Soldier): Record<string, number> {
  const want: Record<string, number> = {};
  for (const id of [s.loadout.equippedWeaponId, s.loadout.stowedWeaponId]) {
    const w = findWeapon(meta, id);
    if (!w || w.magazine >= 99) continue;
    const n = w.magazine * (w.resupplyMagazines ?? 1);
    for (const t of ammoTypesForCalibre(w.calibre)) {
      want[t.id] = Math.max(want[t.id] ?? 0, n);
    }
  }
  return want;
}

/**
 * 把一名士兵補到基準（v0.18 附錄）。回傳實際補了幾發。
 *
 * 為什麼需要這個：撤離帶回來的彈藥會併回**共用庫存**，而士兵的攜行量歸零 ——
 * 那個模型是對的（v0.16 §3.2：配裝是分配資源，不是選裝備），
 * 但它的副作用是每一場之後都要手動把彈藥一發一發按回去。
 * **要省掉的是那個手工，不是那個決策。**
 *
 * 兩條界線：
 *  - **只從公司既有的庫存拿**，不會無中生有。庫存不夠就補多少算多少。
 *  - **不會讓他變慢**：補到目前這一級負重的上限就停。
 *    自動的東西不可以悄悄改變他的移動速度。
 */
export function resupplySoldier(meta: MetaState, soldierId: string): number {
  const s = findSoldier(meta, soldierId);
  if (!s) return 0;
  const tiers = RULES.backpack.weightTiers;
  const start = kitWeight(resolveLoadout(meta, s.loadout));
  // 目前落在第幾級 → 這一級的上限就是補給的天花板
  let ceiling = RULES.backpack.maxWeight;
  for (const t of tiers) if (start <= t.maxWeight) { ceiling = t.maxWeight; break; }

  let added = 0;
  const room = (): number => ceiling - kitWeight(resolveLoadout(meta, s.loadout));

  const want = resupplyTarget(meta, s);
  for (const [ammoTypeId, target] of Object.entries(want)) {
    const held = s.loadout.ammo[ammoTypeId] ?? 0;
    let need = target - held;
    if (need <= 0) continue;
    const per = AMMO_TYPES[ammoTypeId]?.weightPerRound ?? 0;
    if (per > 0) need = Math.min(need, Math.floor(room() / per));
    if (need > 0) added += moveAmmo(meta, s.id, ammoTypeId, need);
  }

  for (const [defId, target] of Object.entries(RULES.meta.resupply.consumables)) {
    const held = s.loadout.consumables[defId] ?? 0;
    let need = target - held;
    if (need <= 0) continue;
    const per = ITEMS[defId]?.weight ?? 0;
    if (per > 0) need = Math.min(need, Math.floor(room() / per));
    if (need > 0) added += moveConsumable(meta, s.id, defId, need);
  }
  return added;
}

/**
 * 全員補給（v0.18 附錄）。**依名冊順序**，所以庫存不夠時誰先拿到是決定性的。
 * 沒有配槍的人不補 —— 沒有槍就沒有要餵的東西。
 */
export function resupplyAll(meta: MetaState): number {
  let added = 0;
  for (const s of meta.roster) {
    if (!s.loadout.equippedWeaponId && !s.loadout.stowedWeaponId) continue;
    added += resupplySoldier(meta, s.id);
  }
  return added;
}

// ============================================================================
// 結算損益（v0.20 §5.4）
// ============================================================================

/**
 * 一趟任務的損益表。**這張表就是 v0.20 的重點** ——
 * 玩家必須看得出自己這一趟是賺是賠，以及**賠在哪裡**。
 *
 * 注意兩者的差別：
 *  - `creditsEarned` 是**真的入帳**的錢（合約報酬與次要目標獎金）
 *  - 其餘各欄是**估值** —— 帶出來的戰利品要拿去補給站賣才變成錢，
 *    而遺留的裝備與陣亡的士兵是「這一趟實際上花掉了多少」
 */
export interface MissionLedger {
  reward: number;
  secondary: number;
  salvage: number;
  soldiersLost: number;
  weaponsLost: number;
  suppliesLost: number;
  /** 真的入帳的金額（reward + secondary）。 */
  creditsEarned: number;
  /** 這一趟的淨損益（含估值）。 */
  net: number;
}

const itemValue = (defId: string, qty: number): number =>
  sellValue(itemPrice(defId, qty));

/**
 * 算一趟任務的帳。**必須在 `applyMissionResult` 之前呼叫** ——
 * 遺留的武器要在它們從軍械庫被移除之前估值。
 */
export function missionLedger(meta: MetaState, r: MissionResult): MissionLedger {
  const reward = r.mainDone ? contractReward(r.rating) : 0;
  const secondary = secondaryReward(r.rating, r.secondaryDone);

  const broughtBack = new Set<string>();
  const back = new Map<string, number>();
  for (const it of r.extracted) {
    if (it.kind === 'WEAPON') {
      if (it.weapon) broughtBack.add(it.weapon.instanceId);
      continue;                                  // 槍不算「賣掉的戰利品」，它回到軍械庫
    }
    back.set(it.defId, (back.get(it.defId) ?? 0) + it.qty);
  }

  // 帶出去卻沒帶回來的槍 = 永久損失
  let weaponsLost = 0;
  for (const id of r.issuedWeaponIds) {
    if (broughtBack.has(id)) continue;
    const w = meta.armoury.find((x) => x.instanceId === id);
    if (w) weaponsLost += sellValue(weaponPrice(w.typeId));
  }

  // 物資只算**淨額**：帶出去的扣掉帶回來的。
  //
  // 自己發下去的彈藥不是戰利品 —— 它本來就是公司的資產，帶回來只代表**沒有損耗**，
  // 不代表賺到。從自己屍體上撿回來的更是如此：那趟是去止血的，不是去發財的。
  // （早期版本把所有帶回來的東西都計入 salvage，於是同一批彈藥帶回來
  //   會同時「消耗歸零」又「多一筆收益」，等於認列兩次。）
  const issuedQty = new Map<string, number>();
  for (const e of r.issued) issuedQty.set(e.defId, (issuedQty.get(e.defId) ?? 0) + e.qty);

  let suppliesLost = 0;
  for (const [defId, qty] of issuedQty) {
    const left = qty - (back.get(defId) ?? 0);
    if (left > 0) suppliesLost += itemValue(defId, left);
  }
  // 反過來，帶回來的超出發出去的部分才是真的撿到的：搜刮點、敵人屍體、DNA。
  let salvage = 0;
  for (const [defId, qty] of back) {
    const extra = qty - (issuedQty.get(defId) ?? 0);
    if (extra > 0) salvage += itemValue(defId, extra);
  }

  const soldiersLost = r.deadIds.length * soldierPrice();
  const creditsEarned = reward + secondary;
  return {
    reward,
    secondary,
    salvage,
    soldiersLost,
    weaponsLost,
    suppliesLost,
    creditsEarned,
    net: creditsEarned + salvage - soldiersLost - weaponsLost - suppliesLost,
  };
}

/**
 * 結算一趟任務：算帳 → 套用結果 → 入帳 → 推進現貨 → 該來的信件。
 *
 * **只有合約報酬與獎金真的入帳。**帶回來的戰利品要拿去補給站賣才變成錢 ——
 * 那是玩家的下一個決定，不是自動發生的事。
 */
export function settleMission(
  meta: MetaState, r: MissionResult,
): { meta: MetaState; ledger: MissionLedger } {
  const ledger = missionLedger(meta, r);
  const m = applyMissionResult(meta, r);
  m.credits += ledger.creditsEarned;
  m.contractsCompleted += 1;
  if (m.missionLog[0]) m.missionLog[0].net = ledger.net;

  // 遺產武器的現貨綁定**完成的合約數**，不綁定真實時間（§2.4）
  const every = Math.max(1, ECONOMY.legacyStock.refreshEvery);
  if (m.contractsCompleted % every === 0) {
    const rng = createRng(m.stockSeed);
    m.legacyStock = rollLegacyStock(rng);
    m.stockSeed = nextInt(rng, 0x7fffffff);
  }

  pushMail(m);
  return { meta: m, ledger };
}

/**
 * 該不該寄信（§4.3）。同一級只寄一次 —— 惡化到下一級才會再來一封。
 * **這一版信件本身就是後果，不附帶任何實際懲罰。**
 */
export function pushMail(m: MetaState): void {
  const tier = debtTier(m.credits);
  if (!tier) return;
  if (m.mail.includes(tier)) return;
  m.mail.push(tier);
}

// ============================================================================
// 買賣（v0.20 §3.2 / §4.1）
// ============================================================================

/** 買一名複製人。**信用點可以變成負的** —— 系統不禁止，只標價。 */
export function buySoldier(meta: MetaState): Soldier {
  meta.credits -= soldierPrice();
  return grantSoldier(meta);
}

/** 買一把槍。遺產武器買走之後就從現貨清單上消失 —— 那是現貨，不是型錄。 */
export function buyWeapon(meta: MetaState, typeId: string): WeaponInstance | null {
  if (isLegacy(typeId)) {
    const i = meta.legacyStock.indexOf(typeId);
    if (i < 0) return null;                      // 沒有現貨就是買不到
    meta.legacyStock.splice(i, 1);
  }
  meta.credits -= weaponPrice(typeId);
  return grantWeapon(meta, typeId);
}

export function buyAmmo(meta: MetaState, ammoTypeId: string, qty: number): void {
  meta.credits -= ammoPrice(ammoTypeId, qty);
  grantAmmo(meta, ammoTypeId, qty);
}

export function buyConsumable(meta: MetaState, defId: string, qty: number): void {
  meta.credits -= consumablePrice(defId, qty);
  grantConsumable(meta, defId, qty);
}

/** 賣掉一把**沒有人拿著**的槍。有人拿著的不能賣 —— 先在配裝畫面收回來。 */
export function sellWeapon(meta: MetaState, instanceId: string): number {
  const i = meta.armoury.findIndex((w) => w.instanceId === instanceId);
  if (i < 0) return 0;
  if (holderOf(meta, instanceId)) return 0;
  const got = sellValue(weaponPrice(meta.armoury[i].typeId));
  meta.armoury.splice(i, 1);
  meta.credits += got;
  return got;
}

/** 賣掉未分配的彈藥、消耗品或雜物。回傳實際賣到多少。 */
export function sellStock(meta: MetaState, defId: string, qty: number): number {
  const pools: Record<string, number>[] = [meta.ammoStock, meta.consumableStock, meta.salvage];
  const pool = pools.find((x) => (x[defId] ?? 0) > 0);
  if (!pool) return 0;
  const n = Math.min(qty, pool[defId]);
  if (n <= 0) return 0;
  pool[defId] -= n;
  if (pool[defId] <= 0) delete pool[defId];
  const got = sellValue(itemPrice(defId, n));
  meta.credits += got;
  return got;
}
