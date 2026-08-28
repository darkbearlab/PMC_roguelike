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
import type { Calibre, Weapon } from './state';
import { ITEMS, RULES, weaponById } from './content';
import { addItem, emptyBackpack, makeItem } from './inventory';

export interface Loadout {
  /** 武器 id；null = 空手。兩欄都可以留空。 */
  primary: string | null;
  stowed: string | null;
  /** 各口徑要帶幾發。 */
  ammo: Partial<Record<Calibre, number>>;
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

/** 可以選的口徑就是 `calibres` 裡有的那些 —— 新增口徑不用改程式。 */
export function allCalibres(): Calibre[] {
  return Object.keys(RULES.calibres) as Calibre[];
}

/** 可以選的消耗品就是 items.json 裡有 `use` 的東西。 */
export function selectableConsumables(): string[] {
  return Object.entries(ITEMS).filter(([, def]) => !!def.use).map(([id]) => id);
}

function ammoItemId(c: Calibre): string {
  return RULES.calibres[c].itemId;
}

function ammoWeight(c: Calibre, qty: number): number {
  const def = ITEMS[ammoItemId(c)];
  return (def ? def.weight : RULES.calibres[c].weightPerRound) * qty;
}

export function loadoutWeight(l: Loadout): number {
  let w = 0;
  if (l.primary) w += weaponById(l.primary).weight;
  if (l.stowed) w += weaponById(l.stowed).weight;
  for (const [c, n] of Object.entries(l.ammo)) {
    if (n && n > 0) w += ammoWeight(c as Calibre, n);
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
    const w = weaponById(id);
    if (w.magazine >= 99) continue;
    if ((l.ammo[w.calibre] ?? 0) <= 0) {
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
  for (const c of allCalibres()) {
    const n = l.ammo[c] ?? 0;
    if (n > 0) addItem(bag, makeItem(serial as never, ammoItemId(c), n));
  }
  for (const [id, n] of Object.entries(l.consumables)) {
    if (n > 0 && ITEMS[id]) addItem(bag, makeItem(serial as never, id, n));
  }
  return {
    equipped: l.primary ? weaponById(l.primary) : null,
    stowed: l.stowed ? weaponById(l.stowed) : null,
    backpack: bag,
  };
}

/** 一份配裝裡每一項的重量明細，供介面列出來。 */
export function loadoutBreakdown(l: Loadout): { label: string; weight: number }[] {
  const out: { label: string; weight: number }[] = [];
  if (l.primary) { const w = weaponById(l.primary); out.push({ label: w.name, weight: w.weight }); }
  if (l.stowed) { const w = weaponById(l.stowed); out.push({ label: w.name, weight: w.weight }); }
  for (const c of allCalibres()) {
    const n = l.ammo[c] ?? 0;
    if (n > 0) out.push({ label: RULES.calibres[c].name + ' ×' + n, weight: ammoWeight(c, n) });
  }
  for (const [id, n] of Object.entries(l.consumables)) {
    const def = ITEMS[id];
    if (def && n > 0) out.push({ label: def.name + ' ×' + n, weight: def.weight * n });
  }
  return out;
}

