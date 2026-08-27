/**
 * §8.1 命中率、§7.3 姿勢、§8.2 浮動傷害與護甲。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { applyCommand } from '../src/core/commands';
import {
  armorRange, damageRange, hitBreakdown, resetToHitPolicy, toHitChance,
} from '../src/core/combat';
import { RULES, WEAPONS, weaponById } from '../src/core/content';
import { computeVision } from '../src/render/vision';
import { advanceToPlayer, run, testState, player, unit } from './helpers';

afterEach(() => resetToHitPolicy());

//        012345678
//  y=3   #...#...#
const FLANK = ['#########', '#D......#', '#.......#', '#...#...#', '#.......#', '#......T#', '#########'];
const OPEN = ['##########', '#D.......#', '#........#', '#.......T#', '##########'];

const chanceOf = (s: ReturnType<typeof testState>, id = 'E01'): number => {
  const p = player(s);
  return toHitChance(p, unit(s, id), p.equipped!, s);
};

describe('§8.1 命中率公式', () => {
  it('無掩蔽、雙方站姿、射程內 → 就是武器的基礎命中', () => {
    const s = testState(OPEN, [{ archetype: 'RUNNER', pos: { x: 4, y: 1 } }]);
    expect(chanceOf(s)).toBeCloseTo(WEAPONS.find((w) => w.id === 'ar9')!.accuracy, 5);
  });

  it('目標蹲下 → 命中率降低；射手蹲下 → 命中率提高', () => {
    const base = testState(OPEN, [{ archetype: 'RUNNER', pos: { x: 4, y: 1 } }]);
    const b = chanceOf(base);

    const tc = testState(OPEN, [{ archetype: 'RUNNER', pos: { x: 4, y: 1 } }]);
    unit(tc, 'E01').stance = 'CROUCH';
    expect(chanceOf(tc)).toBeCloseTo(b - RULES.combat.stance.targetCrouchPenalty, 5);

    const sc = testState(OPEN, [{ archetype: 'RUNNER', pos: { x: 4, y: 1 } }]);
    player(sc).stance = 'CROUCH';
    expect(chanceOf(sc)).toBeCloseTo(b + RULES.combat.stance.shooterCrouchBonus, 5);
  });

  it('掩蔽降低命中率，且分級正確', () => {
    const s = testState(FLANK, [{ archetype: 'RUNNER', pos: { x: 4, y: 2 } }]);
    player(s).pos = { x: 2, y: 4 };                       // 斜下方 → 目標有部分掩蔽
    const covered = chanceOf(s);
    const bd = hitBreakdown(player(s), unit(s, 'E01'), player(s).equipped!, s);
    expect(bd.coverLevel).toBe('PARTIAL');
    expect(bd.cover).toBe(RULES.combat.cover.partial);

    player(s).pos = { x: 1, y: 2 };                       // 繞到同一列 → 掩蔽消失
    expect(chanceOf(s)).toBeGreaterThan(covered);
    expect(chanceOf(s) - covered).toBeCloseTo(RULES.combat.cover.partial, 5);
  });

  it('射程衰減用曼哈頓距離', () => {
    const near = testState(OPEN, [{ archetype: 'RUNNER', pos: { x: 5, y: 1 } }]);  // 距離 4
    const far = testState(OPEN, [{ archetype: 'RUNNER', pos: { x: 8, y: 1 } }]);   // 距離 7
    const w = WEAPONS.find((x) => x.id === 'ar9')!;
    expect(chanceOf(near)).toBeCloseTo(w.accuracy, 5);                              // 4 <= optimalRange 5
    expect(chanceOf(far)).toBeCloseTo(w.accuracy - 2 * w.falloffPerTile, 5);        // 超出 2 格
  });

  it('命中率不會低於下限 0.15，即使掩蔽加蹲姿加射程衰減全部疊上', () => {
    const s = testState(FLANK, [{ archetype: 'RUNNER', pos: { x: 4, y: 2 } }]);
    player(s).pos = { x: 2, y: 4 };
    unit(s, 'E01').stance = 'CROUCH';
    unit(s, 'E01').evasion = 5;              // 硬灌一個誇張的迴避值
    expect(chanceOf(s)).toBe(RULES.combat.hitFloor);
    expect(RULES.combat.hitFloor).toBe(0.15);
  });
});

describe('§7.3 蹲姿的代價：面向盲區與姿勢時間', () => {
  it('v0.8 移除了蹲姿視野 ×0.6 係數：看多遠不再受姿勢影響', () => {
    expect('crouchSightFactor' in (RULES.combat.stance as object)).toBe(false);
  });

  it('蹲下真的看得比較少 —— 但原因是半平面，不是半徑', () => {
    const s = testState(OPEN);
    const stand = computeVision(s).tiles.reduce((a, b) => a + b, 0);
    player(s).stance = 'CROUCH';
    const crouch = computeVision(s).tiles.reduce((a, b) => a + b, 0);
    expect(crouch).toBeLessThan(stand);
    // 半平面（含垂直線）留下的是一半多一點，不是 0.6 半徑的那種縮法
    expect(crouch).toBeGreaterThan(stand * 0.4);
  });

  it('姿勢改變要花時間了（§5.2），轉向仍然是 0', () => {
    let s = testState(OPEN);
    expect(RULES.time.stance).toBe(3);
    expect(RULES.time.facing).toBe(0);
    s = run(s, { type: 'TOGGLE_STANCE' });
    expect(player(s).nextActAt).toBe(3);
  });

  it('站起來看一圈再蹲回去要花 6 —— 免費掃視被關掉了', () => {
    let s = testState(OPEN);
    s = run(s, { type: 'TOGGLE_STANCE' });     // 蹲
    s = advanceToPlayer(s);
    const at = player(s).nextActAt;
    s = run(s, { type: 'TOGGLE_STANCE' });     // 站起來
    s = advanceToPlayer(s);
    s = run(s, { type: 'TOGGLE_STANCE' });     // 再蹲回去
    expect(player(s).nextActAt - at).toBe(6);
  });
});

describe('§8.2 浮動傷害與護甲', () => {
  it('傷害區間反映 base ± spread 與護甲區間', () => {
    const s = testState(OPEN, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
    const hulk = unit(s, 'E01');
    expect(armorRange(hulk)).toEqual({ min: 12, max: 28 });
    const r = damageRange(weaponById('ar9'), hulk);
    expect(r.min).toBe(RULES.combat.minDamage);   // 25 - 28 觸底
    expect(r.max).toBe(23);                       // 35 - 12
  });

  it('護甲每一發各自擲一次：同一個目標連續受擊，扣的血不會每次都一樣', () => {
    let s = testState(OPEN, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
    player(s).equipped!.magazine = 99;
    player(s).equipped!.ammo = 99;
    const amounts: number[] = [];
    for (let i = 0; i < 30; i++) {
      player(s).nextActAt = s.clock;
      
      unit(s, 'E01').hp = 90;
      const r = applyCommand(s, { type: 'FIRE', target: { x: 4, y: 1 } });
      s = r.state;
      for (const e of r.events) if (e.kind === 'IMPACT') amounts.push(e.amount);
    }
    expect(amounts.length).toBeGreaterThan(10);
    expect(new Set(amounts).size).toBeGreaterThan(1);   // 真的有浮動
    for (const a of amounts) {
      expect(a).toBeGreaterThanOrEqual(RULES.combat.minDamage);
      expect(a).toBeLessThanOrEqual(23);
    }
  });

  it('penetration 欄位存在、全為 0，且公式已就位', () => {
    for (const w of WEAPONS) expect(w.penetration).toBe(0);
    const s = testState(OPEN, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
    const hulk = unit(s, 'E01');
    const w = weaponById('ar9');
    const without = damageRange(w, hulk);
    w.penetration = 20;                       // 只在這個複本上試，不動資料檔
    const with20 = damageRange(w, hulk);
    expect(with20.max).toBeGreaterThan(without.max);
  });
});
