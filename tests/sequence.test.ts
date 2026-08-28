/**
 * §5.5 系列動作：效果只在整套走完時發生，走到一半的單位是暴露的、可被打斷的。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { describe as describeSequence, sequenceDef } from '../src/core/sequence';
import { advanceToPlayer, freezeCombat, player, run, testState, testWeapon, thawCombat } from './helpers';

const OPEN = [
  '##############',
  '#D...........#',
  '#............#',
  '#...........T#',
  '##############',
];

beforeAll(() => freezeCombat());
afterAll(() => thawCombat());

const withRR4 = () => {
  const s = testState(OPEN);
  const p = player(s);
  p.equipped = testWeapon('rr4');
  p.equipped.ammo = 0;
  p.stowed = null;
  return s;
};

describe('RR-4 裝填是兩步序列', () => {
  it('定義是兩步，總花費 20 —— 與原本的單一動作相同', () => {
    const def = sequenceDef('RR4_RELOAD')!;
    expect(def.steps).toHaveLength(2);
    expect(def.steps.reduce((a, b) => a + b.time, 0)).toBe(20);
    expect(testWeapon('rr4').reloadTime).toBe(20);
  });

  it('效果只在整套走完時發生', () => {
    let s = withRR4();
    s = run(s, { type: 'RELOAD' });
    expect(player(s).pendingSequence).not.toBeNull();
    expect(player(s).equipped!.ammo).toBe(0);

    s = run(s, { type: 'SEQUENCE_STEP' });
    expect(player(s).equipped!.ammo).toBe(0);
    expect(player(s).pendingSequence!.index).toBe(1);

    s = run(s, { type: 'SEQUENCE_STEP' });
    expect(player(s).equipped!.ammo).toBe(1);
    expect(player(s).pendingSequence).toBeNull();
  });

  it('兩步各花 10，總共推進 20', () => {
    let s = withRR4();
    s = run(s, { type: 'RELOAD' });
    expect(player(s).nextActAt).toBe(0);          // 開始序列本身不花時間
    s = run(s, { type: 'SEQUENCE_STEP' });
    expect(player(s).nextActAt).toBe(10);
    s = advanceToPlayer(s);
    s = run(s, { type: 'SEQUENCE_STEP' });
    expect(player(s).nextActAt).toBe(20);
  });

  it('承諾中的單位只能繼續或中止，不能做別的事', () => {
    let s = withRR4();
    s = run(s, { type: 'RELOAD' });
    expect(run(s, { type: 'MOVE', dir: 'E' })).toBe(s);
    expect(run(s, { type: 'WAIT' })).toBe(s);
    expect(run(s, { type: 'TOGGLE_STANCE' })).toBe(s);
    expect(run(s, { type: 'SEQUENCE_STEP' })).not.toBe(s);
  });

  it('可以中止：已花費的時間不退還，效果不發生，中止本身不花時間', () => {
    let s = withRR4();
    s = run(s, { type: 'RELOAD' });
    s = run(s, { type: 'SEQUENCE_STEP' });
    const spent = player(s).nextActAt;
    expect(spent).toBe(10);

    s = advanceToPlayer(s);
    s = run(s, { type: 'ABORT_SEQUENCE' });
    expect(player(s).pendingSequence).toBeNull();
    expect(player(s).equipped!.ammo).toBe(0);
    expect(player(s).nextActAt).toBe(spent);
  });

  it('中止之後就可以做別的事了', () => {
    let s = withRR4();
    s = run(s, { type: 'RELOAD' });
    s = run(s, { type: 'ABORT_SEQUENCE' });
    expect(run(s, { type: 'MOVE', dir: 'E' })).not.toBe(s);
  });

  it('單位死亡時序列作廢 —— 走到一半的人是可以被打死的', () => {
    // 相鄰的衝鋒兵，士兵血量剛好一擊致命
    let s = testState(OPEN, [{ archetype: 'RUNNER', pos: { x: 2, y: 1 } }]);
    const p = player(s);
    p.equipped = testWeapon('rr4');
    p.equipped.ammo = 0;
    p.stowed = null;
    p.hp = 20;

    s = run(s, { type: 'RELOAD' });
    s = run(s, { type: 'SEQUENCE_STEP' });        // 承諾了第一步，還沒裝好
    expect(s.units[0].pendingSequence).not.toBeNull();

    // 讓敵人動到把他打死為止
    let guard = 0;
    while (s.result === 'ONGOING' && !s.pendingReinforcement && guard++ < 50) {
      s = advanceToPlayer(s);
      if (s.pendingReinforcement || s.result !== 'ONGOING') break;
      s = run(s, { type: 'SEQUENCE_STEP' });
    }
    expect(s.pendingReinforcement).not.toBeNull();          // 真的被打死了
    expect(s.units.some((u) => u.pendingSequence !== null)).toBe(false);
    // 裝填沒有完成，那把 RR-4 是空的躺在屍體上
    expect(s.loot[0].items.some(
      (it) => it.kind === 'WEAPON' && it.weapon!.typeId === 'rr4' && it.weapon!.ammo === 0,
    )).toBe(true);
  });

  it('UI 描述帶得出進度，玩家看得出正在蓄勢', () => {
    let s = withRR4();
    s = run(s, { type: 'RELOAD' });
    const first = describeSequence(player(s).pendingSequence!);
    expect(first).toContain('開栓退殼');
    expect(first).toContain('1/2');
    s = run(s, { type: 'SEQUENCE_STEP' });
    const second = describeSequence(player(s).pendingSequence!);
    expect(second).toContain('裝入彈藥');
    expect(second).toContain('2/2');
  });

  it('AR-9 沒有序列，一個動作就裝好', () => {
    let s = testState(OPEN);
    player(s).equipped!.ammo = 0;
    s = run(s, { type: 'RELOAD' });
    expect(player(s).pendingSequence).toBeNull();
    expect(player(s).equipped!.ammo).toBe(8);
  });

  it('本版只有 RR-4 裝填用序列，沒有別的動作被改成序列', () => {
    let s = testState(OPEN);
    for (const cmd of [
      { type: 'MOVE' as const, dir: 'E' as const },
      { type: 'WAIT' as const },
      { type: 'SWAP_WEAPON' as const },
    ]) {
      const after = run(s, cmd);
      expect(after.units[0].pendingSequence, cmd.type).toBeNull();
      s = advanceToPlayer(after);
    }
  });
});
