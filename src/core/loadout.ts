/**
 * 出擊前配裝（v0.15 §5）。純規則層：沒有 DOM，沒有亂數。
 *
 * 為什麼要有它：v0.14 的合約清單會告訴玩家「開闊地形、敵方以遠程為主、
 * 存在重裝目標」——**然後玩家什麼都不能改變**。
 * 有標籤而沒有配裝，比沒有標籤更糟。這一版是把 v0.14 做完：
 * 標籤 → 準備 → 出擊。
 *
 * 配裝的單位是**一對**，不是單一武器（§6）：玩家在選的是組合。
 */
import type { Weapon } from './state';
import { AMMO_TYPES, ITEMS, RULES, ammoTypesForCalibre } from './content';
import { makeWeapon, weaponType } from './weapon';
import { addItem, emptyBackpack, makeItem } from './inventory';

export interface Loadout {
  /** 武器型號 id；null = 空手。兩欄都可以留空。 */
  primary: string | null;
  stowed: string | null;
  /**
   * **彈藥型別 id → 發數**（v0.15 附錄 B §2.2）。
   * 鍵不是口徑 —— 同一種口徑日後會有多種彈種，那時這裡不必再改一次。
   */
  ammo: Record<string, number>;
  /** 消耗品 defId → 數量。 */
  consumables: Record<string, number>;
}

export interface LoadoutCheck {
  weight: number;
  maxWeight: number;
  /** 落在第幾級（0 起算）與該級的移動時間。 */
  tier: number;
  moveCost: number;
  /** 再加多少就會掉到下一級；已在最重級距則為 null。 */
  headroom: number | null;
  overweight: boolean;
  /** 帶了槍卻沒帶對應口徑的彈藥（§5.4）。**只是警告，不阻擋出擊。** */
  warnings: string[];
}

export function defaultLoadout(): Loadout {
  const d = RULES.loadout.default;
  return {
    primary: d.primary,
    stowed: d.stowed,
    ammo: { ...d.ammo },
    consumables: { ...d.consumables },
  };
}

export function cloneLoadout(l: Loadout): Loadout {
  return {
    primary: l.primary,
    stowed: l.stowed,
    ammo: { ...l.ammo },
    consumables: { ...l.consumables },
  };
}

/**
 * 可以選的彈藥就是 `ammo.json` 裡有的那些 —— 新增彈種不用改程式。
 * 依口徑在 `calibres` 中的順序排，同口徑的彈種排在一起。
 */
export function allAmmoTypes(): string[] {
  const order = Object.keys(RULES.calibres);
  return Object.keys(AMMO_TYPES)
    .map((id, i) => ({ id, k: order.indexOf(AMMO_TYPES[id].calibreId) * 1000 + i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.id);
}

/** 可以選的消耗品就是 items.json 裡有 `use` 的東西。 */
export function selectableConsumables(): string[] {
  return Object.entries(ITEMS).filter(([, def]) => !!def.use).map(([id]) => id);
}

/**
 * 介面上這一列叫什麼。
 *
 * 一個口徑只有一種彈種時，顯示口徑名（與 v0.14 以前完全一樣）；
 * 有多種時才把彈種名接上去 —— **玩家不必為了還不存在的東西多讀一行字。**
 */
export function ammoLabel(ammoTypeId: string): string {
  const a = AMMO_TYPES[ammoTypeId];
  const cal = RULES.calibres[a.calibreId].name;
  return ammoTypesForCalibre(a.calibreId).length > 1 ? cal + '　' + a.name : cal;
}

/** 彈藥型別 id 同時就是它在背包裡的 defId。 */
function ammoWeight(ammoTypeId: string, qty: number): number {
  return AMMO_TYPES[ammoTypeId].weightPerRound * qty;
}

export function loadoutWeight(l: Loadout): number {
  let w = 0;
  if (l.primary) w += weaponType(l.primary).weight;
  if (l.stowed) w += weaponType(l.stowed).weight;
  for (const id of allAmmoTypes()) {
    const n = l.ammo[id] ?? 0;
    if (n > 0) w += ammoWeight(id, n);
  }
  for (const [id, n] of Object.entries(l.consumables)) {
    const def = ITEMS[id];
    if (def && n > 0) w += def.weight * n;
  }
  return Math.round(w * 1000) / 1000;
}

/**
 * 檢查一份配裝（§5.3 / §5.4）。
 *
 * **只有超重會阻擋。**帶了 DMR-7 卻不帶 7.62 只會得到一行警告 ——
 * 依本作一路以來的原則：系統不禁止，只標價。
 */
export function checkLoadout(l: Loadout): LoadoutCheck {
  const weight = loadoutWeight(l);
  const tiers = RULES.backpack.weightTiers;
  let tier = tiers.length - 1;
  for (let i = 0; i < tiers.length; i++) {
    if (weight <= tiers[i].maxWeight) { tier = i; break; }
  }
  const warnings: string[] = [];
  for (const id of [l.primary, l.stowed]) {
    if (!id) continue;
    const w = weaponType(id);
    if (w.magazine >= 99) continue;
    // 餵得到的型別加起來都是 0 才算「沒帶彈」—— 日後同口徑有多種彈種時這一句不必改
    const fed = ammoTypesForCalibre(w.calibre)
      .reduce((a, t) => a + (l.ammo[t.id] ?? 0), 0);
    if (fed <= 0) {
      warnings.push(w.name + ' 沒有備用彈藥（' + RULES.calibres[w.calibre].name
        + '）—— 打完槍內的 ' + w.magazine + ' 發就沒有了');
    }
  }
  if (!l.primary && !l.stowed) warnings.push('沒有帶任何武器');

  return {
    weight,
    maxWeight: RULES.backpack.maxWeight,
    tier,
    moveCost: tiers[tier].moveCost,
    headroom: tier < tiers.length - 1 ? Math.round((tiers[tier].maxWeight - weight) * 1000) / 1000 : null,
    overweight: weight > RULES.backpack.maxWeight,
    warnings,
  };
}

/** 配裝轉成實際的武器與背包內容。呼叫端負責提供物品流水號。 */
export function equipFromLoadout(
  serial: { nextEntitySerial: number },
  l: Loadout,
): { equipped: Weapon | null; stowed: Weapon | null; backpack: ReturnType<typeof emptyBackpack> } {
  const bag = emptyBackpack();
  for (const id of allAmmoTypes()) {
    const n = l.ammo[id] ?? 0;
    if (n > 0) addItem(bag, makeItem(serial as never, id, n));
  }
  for (const [id, n] of Object.entries(l.consumables)) {
    if (n > 0 && ITEMS[id]) addItem(bag, makeItem(serial as never, id, n));
  }
  return {
    equipped: l.primary ? makeWeapon(serial, l.primary) : null,
    stowed: l.stowed ? makeWeapon(serial, l.stowed) : null,
    backpack: bag,
  };
}

/** 一份配裝裡每一項的重量明細，供介面列出來。 */
export function loadoutBreakdown(l: Loadout): { label: string; weight: number }[] {
  const out: { label: string; weight: number }[] = [];
  if (l.primary) { const w = weaponType(l.primary); out.push({ label: w.name, weight: w.weight }); }
  if (l.stowed) { const w = weaponType(l.stowed); out.push({ label: w.name, weight: w.weight }); }
  for (const id of allAmmoTypes()) {
    const n = l.ammo[id] ?? 0;
    if (n > 0) out.push({ label: ammoLabel(id) + ' ×' + n, weight: ammoWeight(id, n) });
  }
  for (const [id, n] of Object.entries(l.consumables)) {
    const def = ITEMS[id];
    if (def && n > 0) out.push({ label: def.name + ' ×' + n, weight: def.weight * n });
  }
  return out;
}

