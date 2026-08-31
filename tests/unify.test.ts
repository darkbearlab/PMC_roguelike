/**
 * §2 敵人統一 與 §3 極輕負重級。
 *
 * **上線時必須行為不變**（§2.1）：讓最低階的抽取結果重現現有的三種原型。
 * 這與 v0.4 的 ×10 等價測試、以及內建近戰重構是同一個作法 ——
 * 統一先當作重構做，經驗才是唯一的變數。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ACTORS, ARMOUR, RULES, armourType } from '../src/core/content';
import { effectiveMoveTime, moveCostForWeight } from '../src/core/inventory';
import { weightsFor } from '../src/core/tactics';
import { drawArmour } from '../src/core/setup';
import {
  drawEnemyKit, localBiasFor, newCompany, affixesForTier,
} from '../src/core/meta';
import type { MetaState } from '../src/core/meta';
import { createRng } from '../src/core/rng';
import { freezeCombat, player, testState, thawCombat, unit } from './helpers';

const HALL = [
  '####################',
  '#D.................#',
  '#..................#',
  '#................T.#',
  '####################',
];

beforeAll(() => freezeCombat());
afterAll(() => thawCombat());

const co = (): MetaState => newCompany();

describe('§2.1 上線時必須行為不變', () => {
  it('複製人共用單一基礎數值 —— 同一副身體', () => {
    const a = ACTORS.RUNNER;
    const b = ACTORS.SHOOTER;
    for (const k of ['hp', 'armor', 'armorSpread', 'sightRange', 'aim', 'evasion'] as const) {
      expect(a[k], k).toBe(b[k]);
    }
    expect(a.time).toEqual(b.time);
    expect(a.kind).toBe('HUMAN');
    expect(b.kind).toBe('HUMAN');
  });

  it('差異全部來自裝備：一個抽不到槍、一個抽得到', () => {
    expect(ACTORS.RUNNER.armed).toBeFalsy();
    expect(ACTORS.SHOOTER.armed).toBe(true);
    expect(ACTORS.RUNNER.intrinsic).not.toBe(ACTORS.SHOOTER.intrinsic);
  });

  it('最低階（C）一律抽不到護甲 —— 與統一之前完全相同', () => {
    const rng = createRng(1);
    for (let i = 0; i < 200; i++) expect(drawArmour(rng, 'C')).toBeNull();
  });

  it('沒有派遣快照時（測試與機器人）也一律沒有護甲', () => {
    const s = testState(HALL, [
      { archetype: 'RUNNER', pos: { x: 3, y: 1 } },
      { archetype: 'SHOOTER', pos: { x: 6, y: 1 } },
    ]);
    for (const u of s.units) expect(u.armour, u.id).toBeNull();
  });

  it('只有爪的複製人重現衝鋒型：移動 7、積極型權重', () => {
    const s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 3, y: 1 } }]);
    const e = unit(s, 'E01');
    expect(e.equipped).toBeNull();
    expect(effectiveMoveTime(e), '極輕級').toBe(7);
    expect(weightsFor(e)).toEqual(RULES.ai.desperate);
  });

  it('帶槍的複製人重現射手型：移動 10、保持距離', () => {
    const s = testState(HALL, [{ archetype: 'SHOOTER', pos: { x: 6, y: 1 } }]);
    const e = unit(s, 'E01');
    expect(e.equipped).not.toBeNull();
    expect(effectiveMoveTime(e)).toBe(10);
    expect(weightsFor(e)).toEqual(RULES.ai.ranged);
  });
});

describe('§2.2 只統一人類，不統一機械', () => {
  it('裝甲型改列為機械／遺產單位，保留專屬數值', () => {
    expect(ACTORS.HULK.kind).toBe('MACHINE');
    expect(ACTORS.HULK.hp).not.toBe(ACTORS.RUNNER.hp);
    expect(ACTORS.HULK.armor).toBeGreaterThan(0);
    expect(ACTORS.HULK.sightRange).not.toBe(ACTORS.RUNNER.sightRange);
  });

  it('機械的速度不由負重決定 —— 那層裝甲板卸不下來', () => {
    const s = testState(HALL, [{ archetype: 'HULK', pos: { x: 6, y: 1 } }]);
    const e = unit(s, 'E01');
    expect(effectiveMoveTime(e)).toBe(ACTORS.HULK.time.move);
    expect(effectiveMoveTime(e)).not.toBe(moveCostForWeight(0));
  });

  it('機械保留原型指派的落點權重', () => {
    const s = testState(HALL, [{ archetype: 'HULK', pos: { x: 6, y: 1 } }]);
    expect(weightsFor(unit(s, 'E01'))).toEqual(ACTORS.HULK.ai);
  });

  it('機械不穿護甲：它身上那層是焊死的', () => {
    const m = co();
    const kit = drawEnemyKit(m, 3, ['HULK', 'HULK', 'HULK'], 'S');
    for (const a of kit.armour) expect(a).toBeNull();
  });
});

describe('§2.3 抽取規則', () => {
  it('護甲表大部分是「無」，而且階級越低「無」越重', () => {
    const w = (tier: string): number => {
      const t = ARMOUR.tiers[tier];
      const total = Object.entries(t).filter(([k]) => !k.startsWith('_'))
        .reduce((a, [, n]) => a + n, 0);
      return t.none / total;
    };
    expect(w('C')).toBe(1);
    expect(w('C')).toBeGreaterThan(w('B'));
    expect(w('B')).toBeGreaterThan(w('A'));
    expect(w('A')).toBeGreaterThan(w('S'));
    expect(w('S'), '最高階也是「無」占多數').toBeGreaterThan(0.4);
  });

  it('品質階級同時影響遺產機率', () => {
    expect(localBiasFor('C')).toBeGreaterThan(localBiasFor('B'));
    expect(localBiasFor('B')).toBeGreaterThan(localBiasFor('A'));
    expect(localBiasFor('A')).toBeGreaterThan(localBiasFor('S'));
  });

  it('**池子空了高階抽取也不開天窗** —— 補上土製武器', () => {
    const m = co();
    m.legacyStock = [];
    const kit = drawEnemyKit(m, 9, ['SHOOTER', 'SHOOTER', 'SHOOTER'], 'S');
    for (const w of kit.weapons) expect(w).not.toBeNull();
  });

  it('詞條品質的鉤子存在，但本版一律為空', () => {
    for (const t of ['C', 'B', 'A', 'S']) expect(affixesForTier(t)).toEqual([]);
  });

  it('技能欄位存在且為空', () => {
    const s = testState(HALL, [{ archetype: 'SHOOTER', pos: { x: 6, y: 1 } }]);
    for (const u of s.units) expect(u.skills, u.id).toEqual([]);
  });

  it('護甲計入負重：穿甲的複製人跑得慢', () => {
    const s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 3, y: 1 } }]);
    const e = unit(s, 'E01');
    const fast = effectiveMoveTime(e);
    const heavy = ARMOUR.types[ARMOUR.types.length - 1];
    e.armour = heavy.id;
    expect(effectiveMoveTime(e), '穿上 ' + heavy.name).toBeGreaterThan(fast);
    expect(armourType(heavy.id)!.weight).toBeGreaterThan(0);
  });
});

describe('§3 極輕負重級', () => {
  it('新增一級，移動時間 7', () => {
    expect(RULES.backpack.weightTiers[0].moveCost).toBe(7);
    expect(moveCostForWeight(0)).toBe(7);
  });

  it('門檻設定為僅近戰、無甲、幾乎無彈藥才進得去', () => {
    const cap = RULES.backpack.weightTiers[0].maxWeight;
    // 工兵刀 0 進得去；AR-9 步槍 7 進不去
    expect(moveCostForWeight(0)).toBe(7);
    expect(moveCostForWeight(7)).toBeGreaterThan(7);
    expect(cap).toBeLessThan(7);
  });

  it('玩家同樣適用：脫光了跑很快', () => {
    const s = testState(HALL);
    const me = player(s);
    const loaded = effectiveMoveTime(me);
    me.equipped = null;
    me.stowed = null;
    me.backpack!.items = [];
    expect(effectiveMoveTime(me), '脫光了').toBe(7);
    expect(loaded).toBeGreaterThan(7);
  });

  it('**最輕裝的敵人快於一般裝備的玩家 —— 風箏流不成立**', () => {
    const s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 3, y: 1 } }]);
    expect(effectiveMoveTime(unit(s, 'E01')))
      .toBeLessThan(effectiveMoveTime(player(s)));
  });
});
