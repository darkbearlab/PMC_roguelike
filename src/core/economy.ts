/**
 * 經濟層（v0.20）。**純規則，沒有瀏覽器 API，沒有直接的亂數。**
 *
 * 這一版之前，玩家全滅之後免費補滿 —— 緊張感是真的，**但後果不是**。
 * 搜刮回來的武器、DNA、值錢的東西從 v0.9 躺到現在一直沒有用途。
 *
 * 接上去之後：
 *  - 一次全滅才會真的是一次全滅（賠掉的不只是四個人，還有他們身上的槍）
 *  - 「要不要冒險回去撿屍體」第一次有可計算的答案
 *  - 合約清單的迴路才完整：標籤 → 準備 → 風險 → **報酬**
 *
 * 價格結構只有一句話：**人可以再長，好槍不行。**
 */
import type { WeaponInstance } from './state';
import type { RngState } from './rng';
import { createRng, nextInt } from './rng';
import { AMMO_TYPES, ECONOMY, ITEMS, WEAPONS } from './content';

const P = (): number => ECONOMY.baseReward;

/** 四捨五入到整數 —— 帳目上不會出現小數點。 */
const cr = (n: number): number => Math.round(n);

// ---------------------------------------------------------------- 價格

export function isLegacy(typeId: string): boolean {
  return (WEAPONS.find((w) => w.id === typeId)?.origin ?? 'LEGACY') === 'LEGACY';
}

/** 一把槍的買價。查不到就當作土製的下限，不要讓資料缺漏變成免費。 */
export function weaponPrice(typeId: string): number {
  const p = ECONOMY.prices;
  const mult = p.weaponLegacy[typeId] ?? p.weaponLocal[typeId];
  if (mult !== undefined) return cr(mult * P());
  return cr(0.1 * P());
}

export function soldierPrice(): number {
  return cr(ECONOMY.prices.soldier * P());
}

export function ammoPrice(ammoTypeId: string, qty = 1): number {
  return cr((ECONOMY.prices.ammo[ammoTypeId] ?? 0) * P() * qty);
}

export function consumablePrice(defId: string, qty = 1): number {
  return cr((ECONOMY.prices.consumables[defId] ?? 0) * P() * qty);
}

/** 雜物（值錢物品與 DNA）。**唯一的用途就是賣掉** —— 這是它們的第一個用途。 */
export function salvagePrice(defId: string, qty = 1): number {
  return cr((ECONOMY.prices.salvage[defId] ?? 0) * P() * qty);
}

/** 任何一件東西的買價。賣價是它乘上折扣。 */
export function itemPrice(defId: string, qty = 1): number {
  if (AMMO_TYPES[defId]) return ammoPrice(defId, qty);
  if (ITEMS[defId]?.use) return consumablePrice(defId, qty);
  return salvagePrice(defId, qty);
}

export function sellValue(buyPrice: number): number {
  return cr(buyPrice * ECONOMY.sellDiscount);
}

// ---------------------------------------------------------------- 合約報酬

/**
 * 一份合約值多少（§3.1）。
 *
 * **主目標完成才給主要報酬**；次要目標各自另計較小的獎金。
 * 主目標未完成而撤離時只拿得到後者 —— 這讓「東西撿夠了、主目標太硬、我走了」
 * 變成一個算得出來的決定：**你放棄的是主目標的報酬，換到的是活著回來與背包裡的東西。**
 */
export function contractReward(rating: string): number {
  return cr((ECONOMY.rewardByRating[rating] ?? 1) * P());
}

export function secondaryReward(rating: string, done: number): number {
  return cr((ECONOMY.rewardByRating[rating] ?? 1) * P() * ECONOMY.secondaryBonus * done);
}

// ---------------------------------------------------------------- 遺產武器現貨

/**
 * 遺產武器的現貨清單（§2.2）。
 *
 * **不是型錄，是一份會變動的少量現貨** —— 這反映「只有流通、沒有生產」。
 * 不保證你想要的型號會出現，所以玩家會傾向**保住手上那把**，而不是死了再買一把。
 *
 * 更新綁定完成的合約數，**不綁定真實時間**：不要養出「每四小時回來看一次」的習慣。
 */
export function rollLegacyStock(rng: RngState): string[] {
  const pool = WEAPONS.filter((w) => w.origin === 'LEGACY').map((w) => w.id);
  const { min, max } = ECONOMY.legacyStock;
  const n = min + nextInt(rng, Math.max(1, max - min + 1));
  const out: string[] = [];
  const left = [...pool];
  for (let i = 0; i < n && left.length > 0; i++) {
    out.push(left.splice(nextInt(rng, left.length), 1)[0]);
  }
  return out;
}

/** 由種子直接抽一份現貨，方便測試與局外層呼叫。 */
export function legacyStockFromSeed(seed: number): string[] {
  return rollLegacyStock(createRng(seed >>> 0));
}

/**
 * 土製武器隨時買得到 —— 現在還做得出來的東西不需要現貨清單。
 *
 * **內建近戰不上架**（§1.2）：它長在身上，不是一件商品。
 */
export function localCatalogue(): string[] {
  return WEAPONS.filter((w) => w.origin === 'LOCAL' && !w.intrinsic).map((w) => w.id);
}

// ---------------------------------------------------------------- 債務

/**
 * 目前的負債級距（§4.3）。信用點為正時回傳 null。
 *
 * **允許為負，沒有破產結束遊戲。**依本作原則 —— 系統不禁止，只標價 ——
 * 破產不是終局，是一個持續變糟的處境。
 */
export function debtTier(credits: number): string | null {
  if (credits >= 0) return null;
  let tier: string | null = null;
  for (const t of ECONOMY.debtTiers) {
    if (credits <= t.below) tier = t.id;
  }
  return tier;
}

/** 給介面用：級距的顯示名稱。 */
export function debtLabel(id: string): string {
  return ECONOMY.debtTiers.find((t) => t.id === id)?.label ?? id;
}

// ---------------------------------------------------------------- 估值

/** 一把槍實例的估值（賣掉能拿多少）。 */
export function weaponValue(w: WeaponInstance): number {
  return sellValue(weaponPrice(w.typeId));
}
