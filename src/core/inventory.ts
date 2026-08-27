/**
 * 背包、重量與物品堆疊（§3）。
 *
 * 設計上只有兩層彈藥（§1.1）：**槍內剩餘子彈**與**背包內的總發數**。
 * 不追蹤彈匣個數，也沒有上膛殘彈 —— 那是模擬，不是決策。
 *
 * 背包是「你死掉會留在戰場上的東西」（§3.3），所以它同時是負重系統
 * 與死亡懲罰的載體：背得越多走得越慢，走得越慢越容易死，死了全部留在原地。
 */
import type { AmmoType, Backpack, GameState, Item, ItemKind, Unit, Weapon } from './state';
import { ITEMS, RULES } from './content';

export function emptyBackpack(): Backpack {
  return { items: [] };
}

/** 這一堆的總重。 */
export function stackWeight(it: Item): number {
  return it.weight * it.qty;
}

export function totalWeight(bag: Backpack | null): number {
  if (!bag) return 0;
  return bag.items.reduce((a, it) => a + stackWeight(it), 0);
}

/** 背包重量上限（§3.2）。超過就撿不起來。 */
export function maxWeight(): number {
  return RULES.backpack.maxWeight;
}

/**
 * 負重分級（§3.2）。回傳這個重量對應的移動時間。
 *
 * 分級是絕對值不是加成：有背包的單位，移動時間直接由這張表決定。
 * 超過最後一級的重量根本撿不起來，所以永遠落得進表裡。
 */
export function moveCostForWeight(w: number): number {
  const tiers = RULES.backpack.weightTiers;
  for (const t of tiers) if (w <= t.maxWeight) return t.moveCost;
  return tiers[tiers.length - 1].moveCost;
}

/** 這個單位移動一格實際要花的時間。沒有背包（敵人）就用原型的值。 */
export function effectiveMoveTime(u: Unit): number {
  if (!u.backpack) return u.moveTime;
  return moveCostForWeight(totalWeight(u.backpack));
}

/** 目前落在第幾級（0 起算），供 UI 顯示「再撿多少就會變慢」。 */
export function weightTierIndex(w: number): number {
  const tiers = RULES.backpack.weightTiers;
  for (let i = 0; i < tiers.length; i++) if (w <= tiers[i].maxWeight) return i;
  return tiers.length - 1;
}

/** 下一級的門檻重量；已經在最後一級則回傳 null。 */
export function nextTierAt(w: number): number | null {
  const tiers = RULES.backpack.weightTiers;
  const i = weightTierIndex(w);
  return i < tiers.length - 1 ? tiers[i].maxWeight : null;
}

// ============================================================================
// 物品生成
// ============================================================================

/** 依 data/items.json 造一堆物品。id 用狀態的流水號，保持決定性（不用亂數）。 */
export function makeItem(state: GameState, defId: string, qty = 1): Item {
  const def = ITEMS[defId];
  if (!def) throw new Error('未知的物品 ' + defId);
  const it: Item = {
    id: 'I' + state.nextEntitySerial++,
    kind: def.kind as ItemKind,
    defId,
    name: def.name,
    weight: def.weight,
    qty,
  };
  if (def.ammoType) it.ammoType = def.ammoType as AmmoType;
  if (def.value !== undefined) it.value = def.value;
  return it;
}

/** 把一把槍包成背包物品。武器的重量寫在 weapons.json。 */
export function weaponItem(state: GameState, w: Weapon): Item {
  return {
    id: 'I' + state.nextEntitySerial++,
    kind: 'WEAPON',
    defId: 'WEAPON',
    name: w.name,
    weight: w.weight,
    qty: 1,
    weapon: w,
  };
}

// ============================================================================
// 增刪
// ============================================================================

/** 同種類的可堆疊物品（彈藥、值錢物品）才合併；武器與 DNA 各自成堆。 */
function stackable(a: Item, b: Item): boolean {
  if (a.kind === 'WEAPON' || b.kind === 'WEAPON') return false;
  return a.defId === b.defId;
}

/** 放進背包。**不檢查重量** —— 呼叫端要先問過 canCarry()。 */
export function addItem(bag: Backpack, item: Item): void {
  const same = bag.items.find((x) => stackable(x, item));
  if (same) same.qty += item.qty;
  else bag.items.push(item);
}

/** 撿得下嗎（§3.2）。超過上限就撿不起來，不是「撿起來但走不動」。 */
export function canCarry(bag: Backpack | null, item: Item): boolean {
  if (!bag) return false;
  return totalWeight(bag) + stackWeight(item) <= maxWeight();
}

/** 在重量上限內最多能拿幾個。用於「全部拿走」的部分拾取（§4.3）。 */
export function affordableQty(bag: Backpack | null, item: Item): number {
  if (!bag) return 0;
  if (item.weight <= 0) return item.qty;
  const room = maxWeight() - totalWeight(bag);
  return Math.max(0, Math.min(item.qty, Math.floor(room / item.weight)));
}

// ============================================================================
// 彈藥
// ============================================================================

export function countAmmo(bag: Backpack | null, type: AmmoType): number {
  if (!bag) return 0;
  return bag.items
    .filter((it) => it.kind === 'AMMO' && it.ammoType === type)
    .reduce((a, it) => a + it.qty, 0);
}

/**
 * 從背包扣彈藥，回傳**實際扣掉的數量**。
 * 背包不足時就扣多少算多少（§1.1：裝填時補多少算多少）。
 */
export function takeAmmo(bag: Backpack | null, type: AmmoType, want: number): number {
  if (!bag || want <= 0) return 0;
  let left = want;
  for (const it of bag.items) {
    if (left <= 0) break;
    if (it.kind !== 'AMMO' || it.ammoType !== type) continue;
    const n = Math.min(it.qty, left);
    it.qty -= n;
    left -= n;
  }
  bag.items = bag.items.filter((it) => it.qty > 0);
  return want - left;
}
