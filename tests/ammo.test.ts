/**
 * §1 彈藥與 §2 射擊模式。
 *
 * 兩者是同一個決策的兩面：射擊模式若沒有彈藥稀缺就不是決策
 * （火力大的模式永遠划算）。
 */
import { describe, it, expect } from 'vitest';
import { checkLegal, nextFireMode } from '../src/core/commands';
import { effectiveMode, shotsFor } from '../src/core/combat';
import { countAmmo } from '../src/core/inventory';
import { RULES, WEAPONS } from '../src/core/content';
import { advanceToPlayer, player, run, testState, testWeapon, unit } from './helpers';

const OPEN = [
  '##############',
  '#D...........#',
  '#............#',
  '#...........T#',
  '##############',
];

describe('§1.1 只有兩層彈藥：槍內與背包', () => {
  it('初始背包帶 24 發步槍彈與 2 發火箭彈（§1.2）', () => {
    const s = testState(OPEN);
    const bag = player(s).backpack!;
    expect(countAmmo(bag, 'standard_5.56')).toBe(24);
    expect(countAmmo(bag, 'heat_84mm')).toBe(2);
  });

  it('裝填從背包扣除差額', () => {
    let s = testState(OPEN);
    const w = player(s).equipped!;
    w.ammo = 3;
    const before = countAmmo(player(s).backpack, 'standard_5.56');
    s = run(s, { type: 'RELOAD' });
    expect(player(s).equipped!.ammo).toBe(w.magazine);
    expect(countAmmo(player(s).backpack, 'standard_5.56')).toBe(before - (w.magazine - 3));
  });

  it('背包不足時只補部分', () => {
    let s = testState(OPEN);
    const p = player(s);
    p.equipped!.ammo = 0;
    p.backpack!.items = p.backpack!.items.filter((it) => it.ammoTypeId !== 'standard_5.56');
    p.backpack!.items.push({
      id: 'X', kind: 'AMMO', defId: 'standard_5.56', name: '5.56 步槍彈',
      weight: 0.024, qty: 3, ammoTypeId: 'standard_5.56',
    });
    s = run(s, { type: 'RELOAD' });
    expect(player(s).equipped!.ammo).toBe(3);
    expect(countAmmo(player(s).backpack, 'standard_5.56')).toBe(0);
  });

  it('背包彈藥耗盡後無法裝填', () => {
    const s = testState(OPEN);
    const p = player(s);
    p.equipped!.ammo = 0;
    p.backpack!.items = [];
    const legal = checkLegal(s, { type: 'RELOAD' });
    expect(legal.ok).toBe(false);
    expect(legal.reason).toContain('備用彈藥');
  });

  it('不追蹤彈匣個數，也沒有上膛殘彈：狀態裡只有 ammo 與背包堆疊', () => {
    const s = testState(OPEN);
    const json = JSON.stringify(s);
    for (const banned of ['magazines', 'clips', 'chambered', 'inChamber']) {
      expect(json, banned).not.toContain(banned);
    }
  });

  it('內建近戰不吃彈藥，敵人也沒有背包（§1.2 / §3.2）', () => {
    const s = testState(OPEN, [{ archetype: 'RUNNER', pos: { x: 4, y: 1 } }]);
    const e = unit(s, 'E01');
    expect(e.backpack, '敵人不做裝備管理').toBeNull();
    expect(e.equipped, '衝鋒型沒有槍，只有爪').toBeNull();
    expect(e.intrinsic.intrinsic).toBe(true);
    expect(e.intrinsic.weight).toBe(0);
    // §3.2：持槍的敵人備彈是一個數字，不是一個背包
    const t = testState(OPEN, [{ archetype: 'SHOOTER', pos: { x: 4, y: 1 } }]);
    expect(unit(t, 'E01').backpack).toBeNull();
    expect(unit(t, 'E01').equipped).not.toBeNull();
  });
});

describe('§2 射擊模式', () => {
  it('三種模式的時間花費完全相同', () => {
    let s = testState(OPEN, [{ archetype: 'HULK', pos: { x: 5, y: 1 } }]);
    const times: number[] = [];
    for (const m of ['SINGLE', 'BURST', 'AUTO'] as const) {
      let t = testState(OPEN, [{ archetype: 'HULK', pos: { x: 5, y: 1 } }]);
      player(t).equipped!.mode = m;
      t = run(t, { type: 'FIRE', target: { x: 5, y: 1 } });
      times.push(player(t).nextActAt);
    }
    expect(new Set(times).size).toBe(1);
    expect(times[0]).toBe(WEAPONS.find((w) => w.id === 'ar9')!.fireTime);
    expect(s.clock).toBe(0);
  });

  it('耗彈：單發 1、點放 2、連發 3', () => {
    for (const [m, n] of [['SINGLE', 1], ['BURST', 2], ['AUTO', 3]] as const) {
      let s = testState(OPEN, [{ archetype: 'HULK', pos: { x: 5, y: 1 } }]);
      player(s).equipped!.mode = m;
      const before = player(s).equipped!.ammo;
      s = run(s, { type: 'FIRE', target: { x: 5, y: 1 } });
      expect(player(s).equipped!.ammo, m).toBe(before - n);
      expect(RULES.fireModes[m].shots, m).toBe(n);
    }
  });

  it('切換模式不花時間，且循環：單 → 點 → 連 → 單', () => {
    let s = testState(OPEN);
    expect(player(s).equipped!.mode).toBe('SINGLE');
    s = run(s, { type: 'CYCLE_FIRE_MODE' });
    expect(player(s).equipped!.mode).toBe('BURST');
    expect(player(s).nextActAt).toBe(0);
    s = run(s, { type: 'CYCLE_FIRE_MODE' });
    expect(player(s).equipped!.mode).toBe('AUTO');
    s = run(s, { type: 'CYCLE_FIRE_MODE' });
    expect(player(s).equipped!.mode).toBe('SINGLE');
    expect(player(s).nextActAt).toBe(0);
  });

  it('模式記在武器上：換到 RR-4 再換回來仍是先前的設定（§2.5）', () => {
    let s = testState(OPEN);
    s = run(s, { type: 'CYCLE_FIRE_MODE' });
    s = run(s, { type: 'CYCLE_FIRE_MODE' });
    expect(player(s).equipped!.mode).toBe('AUTO');
    s = run(s, { type: 'SWAP_WEAPON' });          // 換成 RR-4
    expect(player(s).equipped!.typeId).toBe('rr4');
    s = advanceToPlayer(s);
    s = run(s, { type: 'SWAP_WEAPON' });          // 換回 AR-9
    expect(player(s).equipped!.typeId).toBe('ar9');
    expect(player(s).equipped!.mode).toBe('AUTO');
  });

  it('重武器沒有模式，切換指令非法（§2.4）', () => {
    const s = testState(OPEN);
    player(s).equipped = testWeapon('rr4');
    expect(testWeapon('rr4').modes).toEqual(['SINGLE']);
    expect(checkLegal(s, { type: 'CYCLE_FIRE_MODE' }).ok).toBe(false);
  });
});

describe('§2.6 彈藥不足時自動降級', () => {
  const withAmmo = (n: number, mode: 'SINGLE' | 'BURST' | 'AUTO') => {
    const s = testState(OPEN);
    const w = player(s).equipped!;
    w.mode = mode;
    w.ammo = n;
    return w;
  };

  it('連發但只剩 2 發 → 降為點放；只剩 1 發 → 降為單發', () => {
    expect(effectiveMode(withAmmo(3, 'AUTO'))).toBe('AUTO');
    expect(effectiveMode(withAmmo(2, 'AUTO'))).toBe('BURST');
    expect(effectiveMode(withAmmo(1, 'AUTO'))).toBe('SINGLE');
    expect(shotsFor(withAmmo(1, 'AUTO'))).toBe(1);
  });

  it('降級不改玩家選的模式 —— 補彈之後就回到原本的火力', () => {
    const w = withAmmo(1, 'AUTO');
    expect(effectiveMode(w)).toBe('SINGLE');
    expect(w.mode).toBe('AUTO');
    w.ammo = 8;
    expect(effectiveMode(w)).toBe('AUTO');
  });

  it('彈藥不足不會讓玩家開不了火', () => {
    const s = testState(OPEN, [{ archetype: 'HULK', pos: { x: 5, y: 1 } }]);
    const w = player(s).equipped!;
    w.mode = 'AUTO';
    w.ammo = 1;
    expect(checkLegal(s, { type: 'FIRE', target: { x: 5, y: 1 } }).ok).toBe(true);
  });

  it('nextFireMode 只在這把槍支援的模式之間輪', () => {
    const rr4 = testWeapon('rr4');
    expect(nextFireMode(rr4)).toBe('SINGLE');
  });
});
