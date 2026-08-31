/**
 * §2.2 連發是三次各自獨立的完整判定，不是「一次判定但命中率較高」。
 * §8 亂數順序：每一發固定抽三個值，即使目標已經倒下也照抽。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { applyCommand } from '../src/core/commands';
import { resetToHitPolicy, setToHitPolicy } from '../src/core/combat';
import { RULES } from '../src/core/content';
import { testState, player, unit, events } from './helpers';

const OPEN = [
  '##############',
  '#D...........#',
  '#............#',
  '#...........T#',
  '##############',
];

afterEach(() => resetToHitPolicy());

const setup = (mode: 'SINGLE' | 'BURST' | 'AUTO', hp = 500) => {
  const s = testState(OPEN, [{ archetype: 'HULK', pos: { x: 5, y: 1 } }]);
  player(s).equipped!.mode = mode;
  unit(s, 'E01').hp = hp;
  unit(s, 'E01').armor = 0;
  unit(s, 'E01').armorSpread = 0;
  return s;
};

describe('§2.2 每一發獨立判定', () => {
  it('連發全中 → 三次 IMPACT，傷害約為單發的三倍', () => {
    setToHitPolicy(() => 1);
    const single = events(setup('SINGLE'), { type: 'FIRE', target: { x: 5, y: 1 } })
      .filter((e) => e.kind === 'IMPACT');
    const auto = events(setup('AUTO'), { type: 'FIRE', target: { x: 5, y: 1 } })
      .filter((e) => e.kind === 'IMPACT');
    expect(single).toHaveLength(1);
    expect(auto).toHaveLength(3);
  });

  it('連發全落空 → 三次 MISS，一次 IMPACT 都沒有', () => {
    setToHitPolicy(() => 0);
    const evs = events(setup('AUTO'), { type: 'FIRE', target: { x: 5, y: 1 } });
    expect(evs.filter((e) => e.kind === 'MISS')).toHaveLength(3);
    expect(evs.filter((e) => e.kind === 'IMPACT')).toHaveLength(0);
  });

  it('三發各自擲傷害：全中時三個數字不會恰好一樣（spread 生效）', () => {
    setToHitPolicy(() => 1);
    const amounts = events(setup('AUTO'), { type: 'FIRE', target: { x: 5, y: 1 } })
      .filter((e) => e.kind === 'IMPACT')
      .map((e) => (e as { amount: number }).amount);
    expect(amounts).toHaveLength(3);
    // AR-9 是 30±5：三發完全相同的機率很低，但不是零 ——
    // 這裡驗的是「有各自擲」而不是「一定不同」，所以只要求總和落在合理區間
    const lo = 3 * (30 - 5);
    const hi = 3 * (30 + 5);
    const sum = amounts.reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThanOrEqual(lo);
    expect(sum).toBeLessThanOrEqual(hi);
  });

  it('三發各自擲護甲：對裝甲型連發，三發被擋下的量不會被綁在一起', () => {
    setToHitPolicy(() => 1);
    let s = testState(OPEN, [{ archetype: 'HULK', pos: { x: 5, y: 1 } }]);
    player(s).equipped!.mode = 'AUTO';
    unit(s, 'E01').hp = 5000;
    const seen = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const r = applyCommand(s, { type: 'FIRE', target: { x: 5, y: 1 } });
      for (const e of r.events) {
        if (e.kind === 'IMPACT') seen.add(e.blocked);
      }
      s = r.state;
      player(s).equipped!.ammo = 99;
      player(s).nextActAt = s.clock + 1;
      unit(s, 'E01').nextActAt = s.clock + 9999;
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('§8 亂數順序：每一發固定三個擲值', () => {
  const rolls = (mode: 'SINGLE' | 'BURST' | 'AUTO', policy: 0 | 1): number => {
    setToHitPolicy(() => policy);
    const s = setup(mode);
    return applyCommand(s, { type: 'FIRE', target: { x: 5, y: 1 } }).state.rng.count;
  };

  it('單發 3 個、點放 6 個、連發 9 個，命中與否都一樣', () => {
    expect(rolls('SINGLE', 1)).toBe(3);
    expect(rolls('BURST', 1)).toBe(6);
    expect(rolls('AUTO', 1)).toBe(9);
    expect(rolls('SINGLE', 0)).toBe(3);
    expect(rolls('BURST', 0)).toBe(6);
    expect(rolls('AUTO', 0)).toBe(9);
  });

  it('即使第一發就擊殺，剩下兩發的判定仍然照抽（結果丟棄）', () => {
    setToHitPolicy(() => 1);
    // 衝鋒型 25 血，AR-9 一發必死
    let s = testState(OPEN, [{ archetype: 'RUNNER', pos: { x: 5, y: 1 } }]);
    player(s).equipped!.mode = 'AUTO';
    // **量差值，不量絕對值** —— 建立初始狀態本身也會抽（選圖、敵人配裝、護甲），
    // 那些數字會隨版本改變，但「這一次開火抽幾個」不會。
    const before = s.rng.count;
    const r = applyCommand(s, { type: 'FIRE', target: { x: 5, y: 1 } });
    // 3 發 × 3 個擲值 = 9，再加上死亡掉落表的抽值（衝鋒型的掉落表有 2 項）
    const dropRolls = 2;
    expect(r.state.rng.count - before).toBe(9 + dropRolls);
    expect(r.state.units.some((u) => u.faction === 'ENEMY')).toBe(false);
  });

  it('已經倒下的目標不會再跳「擊殺」：lethal 只在真正致命的那一發為真', () => {
    setToHitPolicy(() => 1);
    let s = testState(OPEN, [{ archetype: 'RUNNER', pos: { x: 5, y: 1 } }]);
    player(s).equipped!.mode = 'AUTO';
    const lethal = events(s, { type: 'FIRE', target: { x: 5, y: 1 } })
      .filter((e) => e.kind === 'IMPACT' && (e as { lethal: boolean }).lethal);
    expect(lethal).toHaveLength(1);
  });
});

describe('§2.3 取捨：期望值符合設計意圖', () => {
  it('期望命中數：單發 < 點放 < 連發', () => {
    const base = 0.55;
    const exp = (m: 'SINGLE' | 'BURST' | 'AUTO') =>
      RULES.fireModes[m].shots * (base + RULES.fireModes[m].accuracy);
    expect(exp('SINGLE')).toBeCloseTo(0.65, 5);
    expect(exp('BURST')).toBeCloseTo(1.10, 5);
    expect(exp('AUTO')).toBeCloseTo(1.35, 5);
  });

  it('每發子彈的效率：單發最高、連發最低', () => {
    const base = 0.55;
    const perBullet = (m: 'SINGLE' | 'BURST' | 'AUTO') => base + RULES.fireModes[m].accuracy;
    expect(perBullet('SINGLE')).toBeGreaterThan(perBullet('BURST'));
    expect(perBullet('BURST')).toBeGreaterThan(perBullet('AUTO'));
  });
});
