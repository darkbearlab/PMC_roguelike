/**
 * 配裝的重量與檢查（v0.15 §19，v0.16 §3 改為逐人）。
 *
 * v0.15 是「一次任務選一套配裝」；v0.16 起**名冊中每一名士兵各自持有自己的配裝**，
 * 而且武器欄位引用的是**實例** —— 同一把槍只能給一個人。
 *
 * 於是配裝從「選裝備」變成**「分配資源」**：
 * 你有三把槍、四個人，就有一個人沒槍；你有 60 發 5.56 和三個人，你要決定怎麼分。
 * 玩家面對的不再是「哪把槍比較強」，而是「我要把有限的東西分給誰」。
 *
 * 這個檔案只管**算重量與給警告**；誰拿哪一把是 core/meta.ts 的事。
 */
import type { WeaponInstance } from './state';
import { AMMO_TYPES, ITEMS, RULES, ammoTypesForCalibre } from './content';

/** 一個人身上的東西。武器是實例，彈藥與消耗品是數量。 */
export interface CarriedKit {
  equipped: WeaponInstance | null;
  stowed: WeaponInstance | null;
  /** 彈藥型別 id → 發數。 */
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
  /** 帶了槍卻沒帶對應口徑的彈藥。**只是警告，不阻擋出擊**（§19.5）。 */
  warnings: string[];
}

export function emptyKit(): CarriedKit {
  return { equipped: null, stowed: null, ammo: {}, consumables: {} };
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

function ammoWeight(ammoTypeId: string, qty: number): number {
  return AMMO_TYPES[ammoTypeId].weightPerRound * qty;
}

export function kitWeight(k: CarriedKit): number {
  let w = 0;
  if (k.equipped) w += k.equipped.weight;
  if (k.stowed) w += k.stowed.weight;
  for (const [id, n] of Object.entries(k.ammo)) {
    if (n > 0 && AMMO_TYPES[id]) w += ammoWeight(id, n);
  }
  for (const [id, n] of Object.entries(k.consumables)) {
    const def = ITEMS[id];
    if (def && n > 0) w += def.weight * n;
  }
  return Math.round(w * 1000) / 1000;
}

/**
 * 檢查一份配裝（§19.5）。
 *
 * **只有超重會阻擋。**帶了 DMR-7 卻不帶 7.62 只會得到一行警告 ——
 * 依本作一路以來的原則：系統不禁止，只標價。
 */
export function checkKit(k: CarriedKit): LoadoutCheck {
  const weight = kitWeight(k);
  const tiers = RULES.backpack.weightTiers;
  let tier = tiers.length - 1;
  for (let i = 0; i < tiers.length; i++) {
    if (weight <= tiers[i].maxWeight) { tier = i; break; }
  }
  const warnings: string[] = [];
  for (const w of [k.equipped, k.stowed]) {
    if (!w || w.intrinsic) continue;
    // 餵得到的型別加起來都是 0 才算「沒帶彈」
    const fed = ammoTypesForCalibre(w.calibre).reduce((a, t) => a + (k.ammo[t.id] ?? 0), 0);
    if (fed <= 0) {
      warnings.push(w.name + ' 沒有備用彈藥（' + RULES.calibres[w.calibre].name
        + '）—— 打完槍內的 ' + w.magazine + ' 發就沒有了');
    }
  }
  if (!k.equipped && !k.stowed) warnings.push('赤手空拳');

  return {
    weight,
    maxWeight: RULES.backpack.maxWeight,
    tier,
    moveCost: tiers[tier].moveCost,
    headroom: tier < tiers.length - 1
      ? Math.round((tiers[tier].maxWeight - weight) * 1000) / 1000
      : null,
    overweight: weight > RULES.backpack.maxWeight,
    warnings,
  };
}

/** 一份配裝裡每一項的重量明細，供介面列出來。 */
export function kitBreakdown(k: CarriedKit): { label: string; weight: number }[] {
  const out: { label: string; weight: number }[] = [];
  if (k.equipped) out.push({ label: k.equipped.name, weight: k.equipped.weight });
  if (k.stowed) out.push({ label: k.stowed.name, weight: k.stowed.weight });
  for (const id of allAmmoTypes()) {
    const n = k.ammo[id] ?? 0;
    if (n > 0) out.push({ label: ammoLabel(id) + ' ×' + n, weight: ammoWeight(id, n) });
  }
  for (const [id, n] of Object.entries(k.consumables)) {
    const def = ITEMS[id];
    if (def && n > 0) out.push({ label: def.name + ' ×' + n, weight: def.weight * n });
  }
  return out;
}
