/**
 * 武器型號與實例（v0.15 附錄 A）。
 *
 * **一把槍必須是一個「實例」，不是一個型號引用。**
 *
 * 專案有一條長期路線：武器將來會有詞條而變得獨一無二，並且會在伺服器端流通 ——
 * 玩家陣亡遺落的槍，經拾荒者回收後重新洗進獎勵池，可能出現在另一個玩家的任務裡。
 * 那條路線的最低前提就是這件事：若武器只是型號引用，就沒有任何東西
 * 可以被追蹤、被標記、被賦予來歷 —— 追蹤到的只是一個名字。
 *
 * 設定上的依據：**精密製造隨企業撤走了。這顆星球上的每一把槍都是撤離之前製造的，
 * 總數固定，而且只會減少。**槍不會被生產，只會流通。
 *
 * v0.15 不實作任何詞條效果、產生或掉落。這一版只把形狀留好。
 */
import type {
  Affix, Provenance, WeaponInstance, WeaponStats, WeaponType,
} from './state';
import { WEAPONS } from './content';

export function weaponType(id: string): WeaponType {
  const t = WEAPONS.find((w) => w.id === id);
  if (!t) throw new Error(`未知的武器型號 id: ${id}`);
  return t;
}

/** 型號的靜態數值。把 id 與出廠預設的 ammo／mode 拿掉，剩下的就是數值本體。 */
export function baseStats(t: WeaponType): WeaponStats {
  const { id: _id, ammo: _ammo, mode: _mode, ...stats } = t;
  return stats;
}

/**
 * **詞條套用點**（附錄 A §3）。
 *
 *   基礎型號數值 → 套用詞條 → 得到實際數值
 *
 * v0.15 的 `affixes` 一律為空，所以實際數值必然等於型號數值 ——
 * `tests/weapon-instance.test.ts` 有一條專門守這件事，
 * 這樣日後真的填入詞條時，就知道套用點確實在生效而不是被繞過去了。
 *
 * `modifiers` 的鍵對應 `WeaponStats` 的數值欄位，值為**加法**修正。
 * 非數值欄位（name、class、modes…）不受詞條影響。
 */
export function resolveStats(base: WeaponStats, affixes: Affix[]): WeaponStats {
  if (affixes.length === 0) return { ...base };
  const out = { ...base } as WeaponStats & Record<string, unknown>;
  for (const a of affixes) {
    for (const [key, delta] of Object.entries(a.modifiers)) {
      const cur = out[key];
      if (typeof cur === 'number') out[key] = cur + delta;
    }
  }
  return out as WeaponStats;
}

/**
 * 實例識別碼。**必須是決定性的** —— 不得用時間戳或 `crypto.randomUUID()`，
 * 否則「相同種子 + 相同指令序列 ⇒ 相同結果」這條硬性要求就破了（§3.1）。
 * 走的是與物品、屍體同一個流水號，而那個計數器本身在 GameState 裡。
 */
export interface Serial { nextEntitySerial: number }

function nextInstanceId(serial: Serial): string {
  return 'W' + serial.nextEntitySerial++;
}

/**
 * 造一把新的槍。`ammo`／`mode` 取型號的出廠預設值。
 * @param affixes v0.15 一律不傳。留著是為了讓套用點從第一天就走得到。
 */
export function makeWeapon(
  serial: Serial,
  typeId: string,
  affixes: Affix[] = [],
  provenance: Provenance[] = [],
): WeaponInstance {
  const t = weaponType(typeId);
  return {
    ...resolveStats(baseStats(t), affixes),
    instanceId: nextInstanceId(serial),
    typeId: t.id,
    ammo: t.ammo,
    mode: t.mode,
    reloadProgress: 0,
    affixes,
    provenance,
  };
}

/**
 * 由一份型號資料直接造實例（敵人的 `attack` 寫在 actors.json，不在 weapons.json）。
 */
export function makeWeaponFrom(
  serial: Serial,
  t: WeaponType,
  affixes: Affix[] = [],
  provenance: Provenance[] = [],
): WeaponInstance {
  return {
    ...resolveStats(baseStats(t), affixes),
    instanceId: nextInstanceId(serial),
    typeId: t.id,
    ammo: t.ammo,
    mode: t.mode,
    reloadProgress: 0,
    affixes,
    provenance,
  };
}

/**
 * 換一組詞條。**這是改動 `affixes` 的唯一支援路徑** ——
 * 它會重新走一次套用點，所以實例上的數值不會與詞條脫節。
 * 實例識別碼保持不變：還是同一把槍。
 */
export function withAffixes(w: WeaponInstance, affixes: Affix[]): WeaponInstance {
  const t = weaponType(w.typeId);
  return {
    ...w,
    ...resolveStats(baseStats(t), affixes),
    affixes,
  };
}

/**
 * 複製成**另一把**槍（新的 instanceId）。
 * 只用在「造一把一樣的新槍」，不是用在搬動既有的那一把 ——
 * 搬動（撿起、換手、掉落）要保留原本的 instanceId，否則追蹤就斷了。
 */
export function duplicateWeapon(serial: Serial, w: WeaponInstance): WeaponInstance {
  return {
    ...w,
    instanceId: nextInstanceId(serial),
    affixes: w.affixes.map((a) => ({ ...a, modifiers: { ...a.modifiers } })),
    provenance: w.provenance.map((p) => ({ ...p })),
  };
}
