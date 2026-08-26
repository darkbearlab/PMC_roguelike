/**
 * §15 驗收：把 toHitChance 覆寫為回傳 0，驗證整條未命中路徑走得通。
 *
 * 未命中必須：不扣血、照扣 AP 與彈藥、照樣產生噪音、戰鬥紀錄顯示未命中。
 * 這條路徑在 MVP 不可能自然發生，但它是活的程式碼，不是空分支。
 */
import { describe, it, expect, afterEach } from 'vitest';

import { resetToHitPolicy, resolveAttack, setToHitPolicy, toHitChance } from '../src/core/combat';
import { RULES } from '../src/core/content';
import { run, testState, player, unit } from './helpers';

afterEach(() => resetToHitPolicy());

const ROOM = [
  '##############',
  '#D...........#',
  '#............#',
  '#...........T#',
  '##############',
];

describe('未命中路徑', () => {
  const build = () =>
    testState(ROOM, [
      { archetype: 'HULK', pos: { x: 4, y: 1 } },
      { archetype: 'RUNNER', pos: { x: 5, y: 3 } }, // 曼哈頓距離 6，剛好在噪音半徑內
    ]);

  it('v0.5 起預設已啟用擲骰：命中率不再固定為 1，且不低於下限', () => {
    const s = build();
    const c = toHitChance(player(s), unit(s, 'E01'), player(s).equipped!, s);
    expect(c).toBeLessThan(1);
    expect(c).toBeGreaterThanOrEqual(RULES.combat.hitFloor);
    expect(c).toBeCloseTo(0.85, 5);   // AR-9 基礎命中，近距離無掩蔽、雙方站姿
  });

  it('命中率為 0 時：不扣血，但照扣 AP 與彈藥', () => {
    setToHitPolicy(() => 0);
    let s = build();
    const hpBefore = unit(s, 'E01').hp;
    const ammoBefore = player(s).equipped!.ammo;
    s = run(s, { type: 'FIRE', target: { x: 4, y: 1 } });

    expect(unit(s, 'E01').hp).toBe(hpBefore);
    expect(player(s).equipped!.ammo).toBe(ammoBefore - 1);
    expect(player(s).ap).toBe(1);
    expect(player(s).shotsThisTurn).toBe(1);
  });

  it('命中率為 0 時：照樣產生噪音', () => {
    setToHitPolicy(() => 0);
    let s = build();
    s = run(s, { type: 'FIRE', target: { x: 4, y: 1 } });
    expect(unit(s, 'E02').aiState).toBe('SEARCH');
    expect(unit(s, 'E02').lastKnownTarget).toEqual({ x: 1, y: 1 });
  });

  it('命中率為 0 時：戰鬥紀錄顯示未命中', () => {
    setToHitPolicy(() => 0);
    let s = build();
    s = run(s, { type: 'FIRE', target: { x: 4, y: 1 } });
    const miss = s.log.filter((l) => l.kind === 'MISS');
    expect(miss).toHaveLength(1);
    expect(miss[0].text).toContain('未命中');
    expect(s.log.some((l) => l.kind === 'DAMAGE')).toBe(false);
  });

  it('一次攻擊固定抽三個亂數（命中／傷害／護甲），命中與否都一樣', () => {
    setToHitPolicy(() => 1);
    let hit = testState(ROOM, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
    hit = run(hit, { type: 'FIRE', target: { x: 4, y: 1 } });

    setToHitPolicy(() => 0);
    let miss = testState(ROOM, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
    miss = run(miss, { type: 'FIRE', target: { x: 4, y: 1 } });

    expect(hit.rng.count).toBe(3);
    expect(miss.rng.count).toBe(3);
  });

  it('目標護甲為 0、甚至目標格沒有單位時，護甲擲值一樣照抽', () => {
    setToHitPolicy(() => 1);
    // 護甲 0 的敵人
    let a = testState(ROOM, [{ archetype: 'RUNNER', pos: { x: 4, y: 1 } }]);
    a = run(a, { type: 'FIRE', target: { x: 4, y: 1 } });
    expect(a.rng.count).toBe(3);

    // 目標格空無一物
    let b = testState(ROOM);
    b = run(b, { type: 'FIRE', target: { x: 4, y: 1 } });
    expect(b.rng.count).toBe(3);
  });

  it('關掉擲骰開關也不改變亂數序列長度 —— 這正是紀律存在的理由', () => {
    const before = RULES.combat.enableToHitRoll;
    try {
      RULES.combat.enableToHitRoll = false;
      resetToHitPolicy();
      let s = testState(ROOM, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
      s = run(s, { type: 'FIRE', target: { x: 4, y: 1 } });
      expect(s.rng.count).toBe(3);
    } finally {
      RULES.combat.enableToHitRoll = before;
      resetToHitPolicy();
    }
  });

  it('AttackResult 保留 roll / chance / impactPos，未命中時 impactPos 仍為目標格', () => {
    setToHitPolicy(() => 0);
    const s = testState(ROOM, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
    // 直接走解算層，檢查回傳結構
    const r = resolveAttack(s, player(s).id, { x: 4, y: 1 }, player(s).equipped!);
    expect(r.hit).toBe(false);
    expect(r.chance).toBe(0);
    expect(r.roll).toBeGreaterThanOrEqual(0);
    expect(r.roll).toBeLessThan(1);
    expect(r.impactPos).toEqual({ x: 4, y: 1 });
    expect(r.damageByUnit).toEqual([]);
  });
});
