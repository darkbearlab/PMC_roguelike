/**
 * §15 驗收：把 toHitChance 覆寫為回傳 0，驗證整條未命中路徑走得通。
 *
 * 未命中必須：不扣血、照扣 AP 與彈藥、照樣產生噪音、戰鬥紀錄顯示未命中。
 * 這條路徑在 MVP 不可能自然發生，但它是活的程式碼，不是空分支。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { applyCommand } from '../src/core/commands';
import { resetToHitPolicy, resolveAttack, setToHitPolicy, toHitChance } from '../src/core/combat';
import { testState, player, unit } from './helpers';

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
      { archetype: 'RUNNER', pos: { x: 6, y: 3 } }, // 噪音半徑 6 內的 IDLE 敵人
    ]);

  it('MVP 預設固定必中（chance = 1.0）', () => {
    const s = build();
    expect(toHitChance(player(s), unit(s, 'E01'), player(s).equipped!, s)).toBe(1);
  });

  it('命中率為 0 時：不扣血，但照扣 AP 與彈藥', () => {
    setToHitPolicy(() => 0);
    let s = build();
    const hpBefore = unit(s, 'E01').hp;
    const ammoBefore = player(s).equipped!.ammo;
    s = applyCommand(s, { type: 'FIRE', target: { x: 4, y: 1 } });

    expect(unit(s, 'E01').hp).toBe(hpBefore);
    expect(player(s).equipped!.ammo).toBe(ammoBefore - 1);
    expect(player(s).ap).toBe(1);
    expect(player(s).shotsThisTurn).toBe(1);
  });

  it('命中率為 0 時：照樣產生噪音', () => {
    setToHitPolicy(() => 0);
    let s = build();
    s = applyCommand(s, { type: 'FIRE', target: { x: 4, y: 1 } });
    expect(unit(s, 'E02').aiState).toBe('SEARCH');
    expect(unit(s, 'E02').lastKnownTarget).toEqual({ x: 1, y: 1 });
  });

  it('命中率為 0 時：戰鬥紀錄顯示未命中', () => {
    setToHitPolicy(() => 0);
    let s = build();
    s = applyCommand(s, { type: 'FIRE', target: { x: 4, y: 1 } });
    const miss = s.log.filter((l) => l.kind === 'MISS');
    expect(miss).toHaveLength(1);
    expect(miss[0].text).toContain('未命中');
    expect(s.log.some((l) => l.kind === 'DAMAGE')).toBe(false);
  });

  it('命中與否都會抽掉一個亂數，RNG 序列長度一致', () => {
    let hit = testState(ROOM, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
    hit = applyCommand(hit, { type: 'FIRE', target: { x: 4, y: 1 } });
    const hitDraws = hit.rng.count;

    setToHitPolicy(() => 0);
    let miss = testState(ROOM, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
    miss = applyCommand(miss, { type: 'FIRE', target: { x: 4, y: 1 } });

    expect(miss.rng.count).toBe(hitDraws);
    expect(hitDraws).toBe(1);
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
