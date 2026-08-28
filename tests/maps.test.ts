/**
 * §13.1～§13.4：四張地圖、隨機選圖、驗證門檻。
 *
 * 這四張圖不是為了內容變多，是**三個對照實驗加一個基準**。
 * 這一組測試盯的是「它們真的不一樣」以及「選圖是決定性的」。
 */
import { describe, it, expect } from 'vitest';
import { MAPS, RULES, mapById } from '../src/core/content';
import { createInitialState } from '../src/core/setup';
import { parseMap, findTiles } from '../src/core/map';
import { findPath } from '../src/core/pathfind';
import { manhattan } from '../src/core/grid';

describe('§13.1 四張地圖', () => {
  it('剛好四張，id 與名稱都不重複', () => {
    expect(MAPS).toHaveLength(4);
    expect(new Set(MAPS.map((m) => m.id)).size).toBe(4);
    expect(new Set(MAPS.map((m) => m.name)).size).toBe(4);
  });

  it('每一張都符合共同要求：一個主目標、兩個次要、三個以上空投點、8～10 隻敵人', () => {
    for (const raw of MAPS) {
      const m = parseMap(raw);
      expect(findTiles(m, 'TERMINAL'), raw.id).toHaveLength(1);
      expect(findTiles(m, 'SUPPLY'), raw.id).toHaveLength(RULES.mapRules.secondaryObjectives);
      expect(findTiles(m, 'DROP_POINT').length, raw.id)
        .toBeGreaterThanOrEqual(RULES.mapRules.minDropPoints);
      expect(raw.enemies.length, raw.id).toBeGreaterThanOrEqual(RULES.mapRules.enemies.min);
      expect(raw.enemies.length, raw.id).toBeLessThanOrEqual(RULES.mapRules.enemies.max);
      expect((raw.caches ?? []).length, raw.id)
        .toBeGreaterThanOrEqual(RULES.mapRules.minCaches);
    }
  });

  it('每隻敵人都指定了初始面向，三種原型都有出現', () => {
    for (const raw of MAPS) {
      for (const e of raw.enemies) expect(e.facing, raw.id + ' ' + e.archetype).toBeTruthy();
      const kinds = new Set(raw.enemies.map((e) => e.archetype));
      for (const need of ['RUNNER', 'SHOOTER', 'HULK']) {
        expect(kinds.has(need), raw.id + ' 缺少 ' + need).toBe(true);
      }
    }
  });

  it('主目標離起點夠遠', () => {
    for (const raw of MAPS) {
      const m = parseMap(raw);
      const t = findTiles(m, 'TERMINAL')[0];
      expect(manhattan(raw.startDropPoint, t), raw.id)
        .toBeGreaterThanOrEqual(RULES.mapRules.minMainDistance);
    }
  });

  it('不移除敵人也走得到主目標 —— 一隻敵人不該塞死唯一路線', () => {
    for (const raw of MAPS) {
      const s = createInitialState(1, raw);
      const path = findPath(s, s.map.startDropPoint, s.objectives.main.pos, {
        ignoreUnitIds: [s.units[0].id],
      });
      expect(path, raw.id + ' 的主目標被敵人塞死了').not.toBeNull();
    }
  });

  it('四張圖仍然肉眼可區分，不是「差不多但長得不一樣」', () => {
    const st = (id: string) => mapById(id)!.stats!;
    // 掩體最密與最疏之間差五倍以上
    const densities = MAPS.map((raw) => raw.stats!.coverDensity);
    expect(Math.max(...densities) / Math.min(...densities)).toBeGreaterThan(5);
    // 管廊是最窄的那張
    expect(st('mission_02').walkable).toBe(Math.min(...MAPS.map((r) => r.stats!.walkable)));
    // 倉儲區是掩體最密的那張
    expect(st('mission_04').coverDensity).toBe(Math.max(...densities));
    // v0.13 的沉澱池不再是「沒有掩體」，而是「有掩體但抄近路要暴露很久」——
    // 所以它的直線暴露明顯高於最短的那張
    expect(st('mission_03').directRun).toBeGreaterThan(st('mission_01').directRun);
  });

  it('§13.5 的兩條新約束：每張圖都符合', () => {
    for (const raw of MAPS) {
      const gap = Math.abs(raw.stats!.dirCoverEW - raw.stats!.dirCoverNS) * 100;
      expect(gap, raw.id + ' 方向性掩蔽差距').toBeLessThanOrEqual(RULES.mapRules.dirCoverGap);
      // 預估完成路徑（下限估計）落在區間內
      expect(raw.stats!.estRun, raw.id + ' 預估耗時')
        .toBeGreaterThanOrEqual(RULES.mapRules.estRunTime.min);
      expect(raw.stats!.estRun, raw.id + ' 預估耗時')
        .toBeLessThanOrEqual(RULES.mapRules.estRunTime.max);
    }
  });

  it('mission_04 的掩體方向與 mission_01 相反 —— 這是 v0.10 卡住的那件事', () => {
    // 掩蔽只看**朝向射手那一側**的鄰格：水平成排的掩體對東西向交火沒用。
    const dirCover = (id: string): { ew: number; ns: number } => {
      const m = parseMap(mapById(id)!);
      const at = (x: number, y: number): string =>
        (x < 0 || y < 0 || x >= m.width || y >= m.height ? 'WALL' : m.tiles[y * m.width + x]);
      const block = (x: number, y: number): boolean =>
        at(x, y) === 'WALL' || at(x, y) === 'HALF_COVER';
      let n = 0; let ew = 0; let ns = 0;
      for (let y = 0; y < m.height; y++) {
        for (let x = 0; x < m.width; x++) {
          if (block(x, y)) continue;
          n++;
          if (block(x - 1, y) || block(x + 1, y)) ew++;
          if (block(x, y - 1) || block(x, y + 1)) ns++;
        }
      }
      return { ew: ew / n, ns: ns / n };
    };
    const one = dirCover('mission_01');
    const four = dirCover('mission_04');
    expect(one.ns).toBeGreaterThan(one.ew);      // 水平成排 → 對南北向射手有掩蔽
    expect(four.ew).toBeGreaterThan(four.ns);    // 縱向貨架 → 對東西向交火有掩蔽
  });
});

describe('§13.2 隨機選圖', () => {
  it('沒指定地圖時由種子挑，相同種子挑到同一張', () => {
    for (const seed of [1, 42, 999, 20260826, 7777]) {
      const a = createInitialState(seed);
      const b = createInitialState(seed);
      expect(a.map.id, String(seed)).toBe(b.map.id);
    }
  });

  it('不同種子挑得到不同的圖 —— 不是永遠第一張', () => {
    const ids = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) ids.add(createInitialState(seed).map.id);
    expect(ids.size).toBeGreaterThan(1);
  });

  it('指定地圖時就用指定的那張', () => {
    for (const raw of MAPS) {
      expect(createInitialState(7, raw).map.id).toBe(raw.id);
    }
  });

  it('選圖沒有污染後續的亂數序列：同一張圖 + 同一個種子 → 完全相同的狀態', () => {
    const a = createInitialState(123, MAPS[2]);
    const b = createInitialState(123, MAPS[2]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('mapById 找得到、找不到時回傳 null', () => {
    expect(mapById('mission_03')!.id).toBe('mission_03');
    expect(mapById('nope')).toBeNull();
  });
});
