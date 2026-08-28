/**
 * 增量裝填與齊射（v0.15 §3）。
 *
 * 重點不是「有沒有實作」，而是：
 *   **增量裝填不是系列動作** —— 每一發都是一個完整結束的動作，
 *   所以在任何一發之後都可以直接開槍。這正是泵動散彈槍該有的手感：
 *   壓力下填一發打一發，安全時才填滿。
 */
import { describe, expect, it } from 'vitest';
import { checkLegal, commandTime } from '../src/core/commands';
import { RULES, ammoTypesForCalibre } from '../src/core/content';
import { countAmmo } from '../src/core/inventory';
import { player, run, testState, testWeapon } from './helpers';
import type { GameState } from '../src/core/state';
import { makeItem } from '../src/core/inventory';

const OPEN = [
  '##############',
  '#D...........#',
  '#............#',
  '#...........T#',
  '##############',
];

/** 把玩家手上的槍換成指定型號，背包裡放足量對應口徑的彈藥。 */
function withWeapon(id: string, ammoQty = 40): GameState {
  const s = testState(OPEN);
  const p = player(s);
  const w = testWeapon(id);
  p.equipped = w;
  p.stowed = null;
  p.backpack!.items = [];
  const item = makeItem(s, ammoTypesForCalibre(w.calibre)[0].id, ammoQty);
  p.backpack!.items.push(item);
  return s;
}

describe('§3.1 增量裝填', () => {
  it('一次只補一發，費時是「每發」的時間', () => {
    let s = withWeapon('sg12p');
    const p = player(s);
    p.equipped!.ammo = 0;
    expect(commandTime(s, { type: 'RELOAD' })).toBe(6);
    s = run(s, { type: 'RELOAD' });
    expect(player(s).equipped!.ammo).toBe(1);
    expect(player(s).nextActAt).toBe(6);
    expect(countAmmo(player(s).backpack, 'buckshot_12ga')).toBe(39);
  });

  it('填一發之後可以直接開槍 —— 不是系列動作，沒有承諾', () => {
    let s = withWeapon('sg12p');
    player(s).equipped!.ammo = 0;
    s = run(s, { type: 'RELOAD' });
    expect(player(s).pendingSequence).toBeNull();
    // 沒有 pendingSequence，所以其他動作全部照樣合法
    expect(checkLegal(s, { type: 'MOVE', dir: 'E' }).ok).toBe(true);
    expect(checkLegal(s, { type: 'TOGGLE_STANCE' }).ok).toBe(true);
    expect(checkLegal(s, { type: 'RELOAD' }).ok).toBe(true);
  });

  it('填滿要五次行動，總時間等於一次填滿的槍', () => {
    let s = withWeapon('sg12p');
    player(s).equipped!.ammo = 0;
    for (let i = 0; i < 5; i++) s = run(s, { type: 'RELOAD' });
    expect(player(s).equipped!.ammo).toBe(5);
    expect(player(s).nextActAt).toBe(30);
    expect(checkLegal(s, { type: 'RELOAD' }).ok).toBe(false);   // 滿了
  });

  it('背包空了就填不了', () => {
    const s = withWeapon('sg12p', 0);
    player(s).equipped!.ammo = 0;
    player(s).backpack!.items = [];
    expect(checkLegal(s, { type: 'RELOAD' }).ok).toBe(false);
  });

  it('一次填滿的槍仍然一次填滿（削短型是泵動型的反面）', () => {
    let s = withWeapon('sg12s');
    player(s).equipped!.ammo = 0;
    expect(commandTime(s, { type: 'RELOAD' })).toBe(20);
    s = run(s, { type: 'RELOAD' });
    expect(player(s).equipped!.ammo).toBe(2);      // 一次兩發
    expect(player(s).nextActAt).toBe(20);
  });

  it('AR-9 的裝填行為完全沒被動到', () => {
    let s = withWeapon('ar9');
    player(s).equipped!.ammo = 0;
    s = run(s, { type: 'RELOAD' });
    expect(player(s).equipped!.ammo).toBe(8);
    expect(player(s).nextActAt).toBe(10);
  });
});

describe('§3.2 齊射', () => {
  it('切換模式沿用既有的按鈕與指令，且不花時間', () => {
    let s = withWeapon('sg12s');
    expect(player(s).equipped!.mode).toBe('SINGLE');
    expect(commandTime(s, { type: 'CYCLE_FIRE_MODE' })).toBe(0);
    s = run(s, { type: 'CYCLE_FIRE_MODE' });
    expect(player(s).equipped!.mode).toBe('VOLLEY');
    s = run(s, { type: 'CYCLE_FIRE_MODE' });
    expect(player(s).equipped!.mode).toBe('SINGLE');   // 只循環它自己有的兩種
  });

  it('只有一種模式的武器，切換是非法的（按鈕會是灰的）', () => {
    const s = withWeapon('sg12p');
    const legal = checkLegal(s, { type: 'CYCLE_FIRE_MODE' });
    expect(legal.ok).toBe(false);
    expect(legal.reason).toContain('單發');
  });

  it('齊射吃 2 發，做 2 次獨立判定', () => {
    let s = withWeapon('sg12s');
    s = run(s, { type: 'CYCLE_FIRE_MODE' });
    const w = player(s).equipped!;
    expect(w.ammo).toBe(2);
    expect(RULES.fireModes[w.mode].shots).toBe(2);
  });

  it('齊射的命中修正與點放相同 —— 差別在意圖，不在數值', () => {
    expect(RULES.fireModes.VOLLEY.accuracy).toBe(RULES.fireModes.BURST.accuracy);
  });
});
