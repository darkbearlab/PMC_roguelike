/**
 * 合約清單（§18）。
 *
 * 這一組測試守的是 v0.14 唯一一條真正重要的規則：
 * **標籤與難度由地圖統計值推導，不得手寫。**
 * 手寫的東西會在地圖被改掉之後開始說謊，而地圖一定會被改掉。
 */
import { describe, expect, it } from 'vitest';
import type { MapStats } from '../src/core/map';
import {
  contractsFromSeed, deriveDifficulty, deriveTags, generateContracts, makeContract, statsOf,
} from '../src/core/contracts';
import { CONTRACTS, CONTRACT_RULES, MAPS } from '../src/core/content';
import { createRng } from '../src/core/rng';

const BASE: MapStats = {
  walkable: 500, coverDensity: 0.15, dirCoverEW: 0.35, dirCoverNS: 0.35, openness: 0.83,
  mainDist: 48, routeLen: 50, directRun: 3, forcedRun: 1, estRun: 1000,
  enemyCount: 10, shooterRatio: 0.4, hulks: 2, caches: 3,
};

describe('合約清單的產生（§18.1）', () => {
  it('一次三份，地圖不重複', () => {
    for (const seed of [1, 7, 42, 999, 123456]) {
      const list = contractsFromSeed(seed);
      expect(list).toHaveLength(CONTRACT_RULES.listSize);
      expect(new Set(list.map((c) => c.mapId)).size).toBe(list.length);
    }
  });

  it('相同種子產生完全相同的清單（含任務種子）', () => {
    const a = contractsFromSeed(20250826);
    const b = contractsFromSeed(20250826);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('「返回合約清單」拿到的是新的一批，但整條序列仍由初始種子決定', () => {
    const runs = [0, 1].map(() => {
      const rng = createRng(555);
      return [0, 1, 2].map(() => generateContracts(rng).map((c) => c.mapId + ':' + c.missionSeed));
    });
    // 同一個種子，三批的內容逐字相同
    expect(runs[0]).toEqual(runs[1]);
    // 但三批彼此不一樣 —— 否則「返回清單」等於什麼都沒發生
    const [first, second] = runs[0];
    expect(first.join()).not.toBe(second.join());
  });

  it('每份合約都指向真的存在的地圖與簡報', () => {
    for (const c of contractsFromSeed(31)) {
      expect(MAPS.some((m) => m.id === c.mapId)).toBe(true);
      expect(CONTRACTS[c.mapId]).toBeTruthy();
      expect(c.brief.code).toBeTruthy();
      expect(c.brief.notes.length).toBeGreaterThan(0);
      expect(c.brief.methods.length).toBeGreaterThan(0);
    }
  });

  it('目標數量直接數地圖地形，不另外維護一份資料', () => {
    for (const raw of MAPS) {
      const c = makeContract(raw, 1);
      expect(c.objectives.main).toBe(1);
      expect(c.objectives.secondary).toBe(2);
      expect(c.objectives.caches).toBe(raw.caches?.length ?? 0);
    }
  });
});

describe('地形標籤由統計值推導（§18.2）', () => {
  it('改掉統計值，標籤就跟著改 —— 這是這一版的重點', () => {
    const bare = deriveTags({ ...BASE, coverDensity: 0.02 }).map((t) => t.id);
    const covered = deriveTags({ ...BASE, coverDensity: 0.3 }).map((t) => t.id);
    expect(bare).toContain('BARE');
    expect(bare).not.toContain('COVERED');
    expect(covered).toContain('COVERED');
    expect(covered).not.toContain('BARE');
  });

  it('狹窄與開闊讀的是 openness，不是掩體密度', () => {
    // 掩體密度一樣，只有建築寬窄不同
    expect(deriveTags({ ...BASE, openness: 0.7 }).map((t) => t.id)).toContain('NARROW');
    expect(deriveTags({ ...BASE, openness: 0.95 }).map((t) => t.id)).toContain('WIDE');
  });

  it('顯示上限是資料檔說了算', () => {
    // 把每一條門檻都撞穿，觸發的條數一定超過上限
    const everything: MapStats = {
      ...BASE, coverDensity: 0.02, openness: 0.7, shooterRatio: 1,
      forcedRun: 9, directRun: 20, estRun: 3000, caches: 0, hulks: 5,
    };
    expect(deriveTags(everything).length).toBe(CONTRACT_RULES.maxTags);
  });

  it('依 priority 排序，通用標籤排在後面才不會擠掉有資訊量的', () => {
    const ids = deriveTags({
      ...BASE, coverDensity: 0.02, shooterRatio: 1, caches: 0, hulks: 5, openness: 0.7,
    }).map((t) => t.id);
    expect(ids[0]).toBe('BARE');      // priority 10
    expect(ids).not.toContain('HEAVY'); // priority 90，四張圖都會觸發，最先被擠掉
  });

  it('四張圖各自都拿得到看得懂的標籤', () => {
    for (const raw of MAPS) {
      const tags = deriveTags(statsOf(raw));
      expect(tags.length).toBeGreaterThanOrEqual(CONTRACT_RULES.minTags);
      expect(tags.length).toBeLessThanOrEqual(CONTRACT_RULES.maxTags);
    }
  });
});

describe('難度評級由統計值推導（§18.3）', () => {
  it('敵人更多、掩體更少 → 分數更高', () => {
    const base = deriveDifficulty(BASE).score;
    expect(deriveDifficulty({ ...BASE, enemyCount: 16 }).score).toBeGreaterThan(base);
    expect(deriveDifficulty({ ...BASE, coverDensity: 0.02 }).score).toBeGreaterThan(base);
    expect(deriveDifficulty({ ...BASE, shooterRatio: 0.9 }).score).toBeGreaterThan(base);
  });

  it('補給點更多 → 分數更低', () => {
    expect(deriveDifficulty({ ...BASE, caches: 6 }).score)
      .toBeLessThan(deriveDifficulty({ ...BASE, caches: 0 }).score);
  });

  it('級距一定落得到，極端值也不會掉出表外', () => {
    for (const s of [{ ...BASE }, { ...BASE, enemyCount: 0, coverDensity: 0.9, caches: 20 },
      { ...BASE, enemyCount: 99, coverDensity: 0, forcedRun: 40 }]) {
      const d = deriveDifficulty(s);
      expect(CONTRACT_RULES.difficulty.bands.some((b) => b.rating === d.rating)).toBe(true);
      expect(d.label).toBeTruthy();
    }
  });

  it('四張圖的評級彼此分得開 —— 全部一樣就等於沒有評級', () => {
    const ratings = MAPS.map((m) => deriveDifficulty(statsOf(m)).rating);
    expect(new Set(ratings).size).toBeGreaterThanOrEqual(3);
  });
});

describe('資料檔的完整性', () => {
  it('每張圖都有統計值 —— 缺了就是沒跑 map:build', () => {
    for (const raw of MAPS) expect(() => statsOf(raw)).not.toThrow();
  });

  it('每張圖都有一份手寫簡報，欄位齊全', () => {
    for (const raw of MAPS) {
      const b = CONTRACTS[raw.id];
      expect(b, raw.id + ' 缺少簡報').toBeTruthy();
      for (const k of ['code', 'title', 'client', 'purpose', 'attachment', 'flavour'] as const) {
        expect(String(b[k]).length, raw.id + '.' + k).toBeGreaterThan(0);
      }
    }
  });

  it('合約編號不重複', () => {
    const codes = MAPS.map((m) => CONTRACTS[m.id].code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('簡報裡不出現任何報酬金額（§18 明確不做經濟）', () => {
    const money = /(報酬|酬金|價金|新台幣|信用點|\$|元整|[0-9][0-9,]{2,}\s*(元|點))/;
    for (const raw of MAPS) {
      const b = CONTRACTS[raw.id];
      const all = [b.purpose, b.attachment, b.flavour, ...b.notes, ...b.methods].join('\n');
      expect(money.test(all), raw.id + ' 的簡報提到了金額').toBe(false);
    }
  });

  it('標籤與難度的每一個 stat 都真的存在於 MapStats', () => {
    const keys = new Set(Object.keys(statsOf(MAPS[0])));
    for (const t of CONTRACT_RULES.tags) expect(keys.has(t.stat), t.id).toBe(true);
    for (const t of CONTRACT_RULES.difficulty.terms) expect(keys.has(t.stat), t.stat).toBe(true);
  });
});
