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
import { AMMO_TYPES, ITEMS, RULES, ammoTypesForCalibre, archetype } from './content';
import { makeWeapon } from './weapon';
import { makeLocalEnemyWeapon } from './setup';
import { createRng, nextFloat, nextInt } from './rng';
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
  /**
   * **物品池**（§2.1）：世界上還沒被任何人拿著的遺產武器實例。
   *
   * 它同時就是**補給站的現貨** —— 不是型錄，是架上真的擺著的那幾把。
   *
   * **不變量**：世界上每一把遺產武器實例，在任何時刻都恰好存在於一個地方 ——
   * 玩家軍械庫、玩家士兵身上、戰場地面、這個池子、或某個敵人手上。
   * 敵人生成時是從這裡**抽出**，不是在掉落表上擲出（§2.1）。
   * **抽走一把，補給站就少一把。**總量不增不減，只是換位置。
   *
   * 這兩者看起來很像，經濟上完全相反：若實作成機率生成，
   * v0.20 §2.2 的遺產武器結構性稀缺當場失效。
   */
  legacyStock: WeaponInstance[];
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
  const w = stampProvenance(meta, makeWeapon(serialOf(meta), typeId), 'ISSUED');
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
  /**
   * 這一場敵人手上的武器，**依地圖敵人順序**（§2.3）。
   *
   * 抽取發生在局外層而不是任務裡，因為抽走一把補給站就少一把 ——
   * 那是 `MetaState` 的事。任務只收到抽好的結果，
   * 所以「相同種子 + 相同快照 ⇒ 相同結果」這條硬性要求不受影響。
   */
  enemyWeapons?: (WeaponInstance | null)[];
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
  /**
   * 任務結束時**還留在戰場上**的每一把槍（§2.4）：敵人手上的、屍體堆裡的、
   * 還有沒走出撤離點的人身上的。依機率洗回池子，其餘永久銷毀。
   *
   * 需要完整實例而不只是 id —— 玩家那幾把已經從軍械庫被移除了，之後查不到。
   */
  leftBehind: WeaponInstance[];
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
  // 世界一開始就有的那幾把遺產武器。**之後不會再憑空多出來** ——
  // 池子只會因為玩家賣出、敵人陣亡後被回收而變多（§2.4）。
  for (const typeId of rollLegacyStock(createRng(meta.stockSeed))) {
    meta.legacyStock.push(stampProvenance(meta, makeWeapon(serialOf(meta), typeId), 'FOUND'));
  }
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

/**
 * 在武器的來歷上蓋一個章（§4.5）。
 *
 * `Provenance.actor` **只存公司或勢力名稱，不得存放帳號或使用者識別** ——
 * 這是日後開放多人時的隱私邊界，從第一天就立下來。
 *
 * 這個章是 §4.5 的全部意義所在：三場之後在敵人手上再看到它時，
 * 那個人不再是一個射手，是一筆你的資產。
 */
export function stampProvenance(
  meta: MetaState, w: WeaponInstance, event: string,
): WeaponInstance {
  const actor = RULES.meta.companyName;
  if (!w.provenance.some((p) => p.event === event && p.actor === actor)) {
    w.provenance.push({ event, actor });
  }
  void meta;
  return w;
}

/** 這把槍曾經是我們的嗎（§4.5）。 */
export function wasOurs(w: WeaponInstance): boolean {
  return w.provenance.some((p) => p.actor === RULES.meta.companyName);
}

/**
 * 為一張地圖的敵人抽武器（§2.3）。**會改動 `meta.legacyStock`。**
 *
 * 規則：
 *  1. 只有 `armed` 的原型參與抽取。衝鋒型與裝甲型用內建武器（§1），不抽。
 *  2. 依權重抽取，**權重明顯偏向土製** —— 土製不在池子裡，
 *     它現在還做得出來，所以「抽到土製」的實作是生成一把新的。
 *  3. 池中沒有遺產武器可抽時，一律生成土製 —— 敵人不會空手站在那裡。
 *
 * **不排除任何武器類型**，包含無後座力砲。威脅由 §4 的可讀性處理，
 * 不由排除處理：一發即死沒問題，看不到它要來才有問題。
 */
export function drawEnemyWeapons(
  meta: MetaState, seed: number, archetypes: string[],
): (WeaponInstance | null)[] {
  const rng = createRng(seed >>> 0);
  const serial = serialOf(meta);
  const out: (WeaponInstance | null)[] = [];
  for (const id of archetypes) {
    if (!archetype(id).armed) { out.push(null); continue; }
    const wantLocal = nextFloat(rng) < RULES.enemyWeapons.localBias;
    if (!wantLocal && meta.legacyStock.length > 0) {
      out.push(meta.legacyStock.splice(nextInt(rng, meta.legacyStock.length), 1)[0]);
    } else {
      out.push(makeLocalEnemyWeapon(serial, rng));
    }
  }
  meta.instanceCounter = serial.nextEntitySerial;
  return out;
}

/**
 * 任務結束後，戰場上沒被帶走的武器怎麼辦（§2.4）。
 *
 * **改變了 v0.16 起「留在戰場上的東西即永久失去」這條規則。**
 * 現在它依機率回到池中，其餘永久銷毀。三件事同時成立：
 *
 *  - **你的損失是真的** —— 要花錢買回來，或在某個敵人手上再遇到它
 *  - **世界的總量是守恆的** —— 拾荒者把它撿走、洗回市場，
 *    那是這個世界唯一的物流方式
 *  - **銷毀機率讓遺產武器的總量緩慢下降**，那是世界層級的消耗閥，
 *    不是玩家層級的耐久度
 *
 * 彈藥與消耗品維持現行規則（未帶走即失去）—— 它們本來就是消耗品。
 */
export function recoverBattlefieldWeapons(m: MetaState, r: MissionResult): void {
  const back = new Set(
    r.extracted.filter((it) => it.kind === 'WEAPON' && it.weapon)
      .map((it) => it.weapon!.instanceId),
  );
  const rng = createRng(m.stockSeed);
  const left: WeaponInstance[] = [];
  for (const w of r.leftBehind ?? []) {
    if (back.has(w.instanceId)) continue;
    if (!isLegacy(w.typeId)) continue;         // 土製的沒有回收價值，作坊再做一把就好
    if (nextFloat(rng) < RULES.enemyWeapons.recoverChance) left.push(w);
  }
  m.stockSeed = nextInt(rng, 0x7fffffff);
  for (const w of left) {
    if (m.legacyStock.some((x) => x.instanceId === w.instanceId)) continue;
    if (m.armoury.some((x) => x.instanceId === w.instanceId)) continue;
    m.legacyStock.push(w);
  }
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
  // 戰場上還躺著／還被拿著的每一把槍（§2.4）。撤離點外面的一律算「留在戰場上」——
  // 屍體堆裡的、敵人手上的、沒走出去的人身上的，對這個世界而言沒有差別。
  const onField: WeaponInstance[] = [];
  for (const u of state.units) {
    if (u.id === state.extractedBy) continue;
    for (const w of [u.equipped, u.stowed]) if (w && !w.intrinsic) onField.push(w);
    for (const it of u.backpack?.items ?? []) if (it.weapon) onField.push(it.weapon);
  }
  for (const pile of state.loot) {
    for (const it of pile.items) if (it.weapon) onField.push(it.weapon);
  }
  return {
    mapName: meta.mapName,
    contractCode: meta.contractCode,
    rating: meta.rating,
    mainDone: state.objectives.main.done,
    secondaryDone: state.objectives.secondary.filter((o) => o.done).length,
    issued: out.flatMap((d) => d.items.map((e) => ({ ...e }))),
    issuedWeaponIds: out.flatMap((d) =>
      [d.equipped, d.stowed].filter(Boolean).map((w) => w!.instanceId)),
    leftBehind: onField.map((w) => JSON.parse(JSON.stringify(w)) as WeaponInstance),
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
    if (!w || w.intrinsic) continue;
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
/** 資產變動的一列（§5.2）。取得與損失分開列，不合併成一個淨數字。 */
export interface AssetLine {
  name: string;
  qty: number;
  value: number;
}

export interface MissionLedger {
  reward: number;
  secondary: number;
  salvage: number;
  soldiersLost: number;
  weaponsLost: number;
  suppliesLost: number;
  /** 真的入帳的金額（reward + secondary）。 */
  creditsEarned: number;
  /**
   * **現金損益**（§5.2）。合約報酬、獎金、雜物估值，減掉陣亡與物資消耗。
   *
   * **不含武器。**撿回一把 DMR 是資產不是收入，那筆錢要賣掉才存在；
   * 加進損益會誤導，完全不顯示則會讓回收看起來像白忙一場。
   */
  net: number;
  /** 撿到、搶到、帶回來的槍（§5.2）。 */
  assetsGained: AssetLine[];
  /** 帶出去沒帶回來的槍。 */
  assetsLost: AssetLine[];
  /** 資產淨變動（估值，未實現）。**刻意不計入 net。** */
  assetNet: number;
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

  // ---- 資產變動（§5.2）。**與現金損益分開，兩條底線。** ----
  //
  // 撿回一把 DMR 是資產不是收入，那筆錢要賣掉才存在。加進損益會誤導；
  // 完全不顯示則會讓「冒著命回去撿」看起來像白忙一場。
  // 這剛好就是損益表與資產負債表的差別 —— 用會計格式講死人正是本作的文體。
  const issuedWeapons = new Set(r.issuedWeaponIds);
  const assetsGained: AssetLine[] = [];
  for (const it of r.extracted) {
    if (it.kind !== 'WEAPON' || !it.weapon) continue;
    if (issuedWeapons.has(it.weapon.instanceId)) continue;   // 自己帶出去的不算「取得」
    assetsGained.push({
      name: it.weapon.name, qty: 1, value: sellValue(weaponPrice(it.weapon.typeId)),
    });
  }
  const assetsLost: AssetLine[] = [];
  for (const id of r.issuedWeaponIds) {
    if (broughtBack.has(id)) continue;
    const w = meta.armoury.find((x) => x.instanceId === id);
    if (w) assetsLost.push({ name: w.name, qty: 1, value: sellValue(weaponPrice(w.typeId)) });
  }
  const assetNet = assetsGained.reduce((a, x) => a + x.value, 0)
    - assetsLost.reduce((a, x) => a + x.value, 0);

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
    // **武器不進現金損益**（§5.2）—— 它在下面的資產區塊裡。
    net: creditsEarned + salvage - soldiersLost - suppliesLost,
    assetsGained,
    assetsLost,
    assetNet,
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

  // §2.1 的不變量取代了 v0.20 §2.4 的「每 N 場重抽現貨」。
  //
  // **重抽會憑空生出武器，也會憑空消滅武器** —— 那正是這一版要拔掉的東西。
  // 現貨現在只會因為三件事改變：玩家買走、玩家賣回、以及戰場上未回收的武器
  // 依機率洗回池子（下面那一段）。補給站因此可能長期空著，那是真的稀缺。
  recoverBattlefieldWeapons(m, r);

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

/**
 * 買一把槍。
 *
 * `key` 對遺產武器是**實例 id**（架上就是那一把，不是一個型號），
 * 對土製武器是型號 id（現在還做得出來，要幾把有幾把）。
 *
 * 遺產武器買走之後就從池子裡消失 —— 它換了位置，不是被複製。
 */
export function buyWeapon(meta: MetaState, key: string): WeaponInstance | null {
  const i = meta.legacyStock.findIndex((w) => w.instanceId === key);
  if (i >= 0) {
    const w = meta.legacyStock.splice(i, 1)[0];
    meta.credits -= weaponPrice(w.typeId);
    stampProvenance(meta, w, 'PURCHASED');
    meta.armoury.push(w);
    return w;
  }
  if (isLegacy(key)) return null;                // 遺產武器沒有現貨就是買不到
  meta.credits -= weaponPrice(key);
  return grantWeapon(meta, key);
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
  const w = meta.armoury[i];
  const got = sellValue(weaponPrice(w.typeId));
  meta.armoury.splice(i, 1);
  meta.credits += got;
  // 賣掉的遺產武器**回到池子** —— 它沒有消失，只是換了位置（§2.1）。
  // 所以三場之後在某個射手手上看到自己賣掉的那把，是這條規則的直接後果。
  if (isLegacy(w.typeId)) meta.legacyStock.push(w);
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
