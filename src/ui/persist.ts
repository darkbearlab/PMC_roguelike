/**
 * 存檔（v0.16 §7）。`localStorage`，**只在回到公司畫面時寫**；任務進行中不寫。
 *
 * **版本不符一律提示重置，不做遷移。**專案迭代很快，存檔格式會被之後每一版打破，
 * 而遷移程式碼的維護成本遠高於重置。
 */
import type { MetaState } from '../core/meta';
import { newCompany } from '../core/meta';
import { RULES } from '../core/content';

const KEY = 'pmc.company.v1';

export type LoadOutcome =
  | { kind: 'LOADED'; meta: MetaState }
  | { kind: 'NEW'; meta: MetaState }
  | { kind: 'VERSION_MISMATCH'; found: number; expected: number };

export function loadCompany(): LoadOutcome {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // 無痕模式之類：當作沒有存檔，遊戲照常開得起來
    return { kind: 'NEW', meta: newCompany() };
  }
  if (!raw) return { kind: 'NEW', meta: newCompany() };
  try {
    const parsed = JSON.parse(raw) as MetaState;
    if (parsed.schemaVersion !== RULES.meta.schemaVersion) {
      return {
        kind: 'VERSION_MISMATCH',
        found: parsed.schemaVersion,
        expected: RULES.meta.schemaVersion,
      };
    }
    return { kind: 'LOADED', meta: parsed };
  } catch {
    return { kind: 'VERSION_MISMATCH', found: -1, expected: RULES.meta.schemaVersion };
  }
}

export function saveCompany(meta: MetaState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(meta));
  } catch {
    // 寫不進去（配額、無痕）就算了 —— 不要因為存檔失敗而讓遊戲中斷
  }
}

export function clearCompany(): void {
  try {
    localStorage.removeItem(KEY);
  } catch { /* 同上 */ }
}
