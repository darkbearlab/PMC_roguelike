/**
 * §5 行動排程器。
 */
import { describe, it, expect } from 'vitest';
import { applyCommand, commandTime } from '../src/core/commands';
import { activeUnit, isPlayerTurn, isMissionOver } from '../src/core/scheduler';
import { ACTORS, RULES, WEAPONS } from '../src/core/content';
import { advanceOnce, advanceToPlayer, run, testState, player, unit, unburden } from './helpers';

const OPEN = [
  '##############',
  '#D...........#',
  '#............#',
  '#...........T#',
  '##############',
];

describe('§5.1 主迴圈', () => {
  it('永遠挑 nextActAt 最小的單位行動', () => {
    const s = unburden(testState(OPEN, [{ archetype: 'RUNNER', pos: { x: 6, y: 1 } }]));
    s.units[0].nextActAt = 50;
    s.units[1].nextActAt = 20;
    expect(activeUnit(s)!.id).toBe('E01');
    s.units[1].nextActAt = 80;
    expect(activeUnit(s)!.faction).toBe('PLAYER');
  });

  it('同時刻：玩家優先', () => {
    const s = unburden(testState(OPEN, [{ archetype: 'RUNNER', pos: { x: 6, y: 1 } }]));
    s.units[0].nextActAt = 30;
    s.units[1].nextActAt = 30;
    expect(activeUnit(s)!.faction).toBe('PLAYER');
  });

  it('同時刻且都是敵人：依 units 陣列索引，不含亂數', () => {
    const s = unburden(testState(OPEN, [
      { archetype: 'RUNNER', pos: { x: 6, y: 1 } },
      { archetype: 'RUNNER', pos: { x: 7, y: 1 } },
      { archetype: 'RUNNER', pos: { x: 8, y: 1 } },
    ]));
    s.units.forEach((u) => { u.nextActAt = 40; });
    s.units[0].nextActAt = 999;
    expect(activeUnit(s)!.id).toBe('E01');
    s.units = s.units.filter((u) => u.id !== 'E01');
    expect(activeUnit(s)!.id).toBe('E02');
  });

  it('每個單位輪到時必須做一件事：IDLE 敵人也花時間，不會卡住排程器', () => {
    let s = unburden(testState(OPEN, [{ archetype: 'RUNNER', pos: { x: 12, y: 3 } }]));
    s.units[0].nextActAt = 500;
    const before = unit(s, 'E01').nextActAt;
    s = advanceOnce(s);
    expect(unit(s, 'E01').nextActAt).toBeGreaterThan(before);
  });

  it('動作效果立即結算，nextActAt 隨後推進', () => {
    let s = unburden(testState(OPEN, [{ archetype: 'RUNNER', pos: { x: 4, y: 1 } }]));
    const hp = unit(s, 'E01').hp;
    s = run(s, { type: 'FIRE', target: { x: 4, y: 1 } });
    const foe = s.units.find((u) => u.id === 'E01');
    expect(foe === undefined || foe.hp < hp).toBe(true);
    expect(s.units[0].nextActAt).toBe(WEAPONS.find((w) => w.id === 'ar9')!.fireTime);
  });

  it('clock 是「上一個動作發生的時刻」', () => {
    let s = unburden(testState(OPEN));
    expect(s.clock).toBe(0);
    s = run(s, { type: 'MOVE', dir: 'E' });
    expect(s.clock).toBe(0);
    s = run(s, { type: 'MOVE', dir: 'E' });
    expect(s.clock).toBe(10);
  });
});

describe('§5.2 時間成本全部來自資料檔', () => {
  it('玩家的動作成本', () => {
    const s = unburden(testState(OPEN));
    expect(commandTime(s, { type: 'MOVE', dir: 'E' })).toBe(10);
    expect(commandTime(s, { type: 'WAIT' })).toBe(10);
    expect(commandTime(s, { type: 'INTERACT', pos: { x: 1, y: 1 } })).toBe(10);
    expect(commandTime(s, { type: 'TOGGLE_STANCE' })).toBe(3);   // v0.8
    expect(commandTime(s, { type: 'SET_FACING', facing: 'N' })).toBe(0);
    expect(commandTime(s, { type: 'SWAP_WEAPON' })).toBe(RULES.time.swap.HEAVY);
  });

  it('敵人的速度分級：RUNNER 快於玩家、HULK 慢於玩家', () => {
    expect(ACTORS.RUNNER.time.move).toBe(7);
    expect(ACTORS.SOLDIER.time.move).toBe(10);
    expect(ACTORS.HULK.time.move).toBe(20);
  });

  it('RUNNER 真的追得上：同一段時間裡它走的格數比玩家多', () => {
    const span = 140;
    expect(Math.floor(span / ACTORS.RUNNER.time.move))
      .toBeGreaterThan(Math.floor(span / ACTORS.SOLDIER.time.move));
  });
});

describe('§5.4 零成本動作不會卡住排程器', () => {
  it('玩家連續轉向不前進時間，也不失去行動權', () => {
    let s = unburden(testState(OPEN, [{ archetype: 'HULK', pos: { x: 11, y: 3 } }]));
    const dirs = ['N', 'E', 'S', 'W'] as const;
    for (let i = 0; i < 20; i++) {
      s = run(s, { type: 'SET_FACING', facing: dirs[i % 4] });
    }
    expect(s.clock).toBe(0);
    expect(player(s).nextActAt).toBe(0);
    expect(isPlayerTurn(s)).toBe(true);
  });

  it('姿勢從 v0.8 起不是 0 成本了：連按會真的把時間花掉', () => {
    let s = unburden(testState(OPEN, [{ archetype: 'HULK', pos: { x: 11, y: 3 } }]));
    s = run(s, { type: 'TOGGLE_STANCE' });
    expect(player(s).nextActAt).toBe(3);
  });

  it('AI 不會選 0 成本動作：讓敵人連續行動一千次不會無窮迴圈', () => {
    let s = unburden(testState(OPEN, [
      { archetype: 'RUNNER', pos: { x: 6, y: 1 } },
      { archetype: 'HULK', pos: { x: 9, y: 3 } },
      { archetype: 'SHOOTER', pos: { x: 11, y: 1 } },
    ]));
    s.units[0].nextActAt = 100000;
    let last = -1;
    for (let i = 0; i < 1000; i++) {
      const before = s.clock;
      s = advanceOnce(s);
      if (isMissionOver(s) || s.pendingReinforcement) break;
      expect(s.clock).toBeGreaterThanOrEqual(before);
      last = s.clock;
    }
    expect(last).toBeGreaterThan(0);
  });
});

describe('§6 沒有「回合」這個東西', () => {
  it('GameState 沒有 turn / phase，Unit 沒有 ap / maxAp', () => {
    const s = unburden(testState(OPEN));
    expect('turn' in s).toBe(false);
    expect('phase' in s).toBe(false);
    expect('clock' in s).toBe(true);
    const u = player(s);
    expect('ap' in u).toBe(false);
    expect('maxAp' in u).toBe(false);
    expect('nextActAt' in u).toBe(true);
  });

  it('searchTimer 是時間量而非回合數', () => {
    expect(RULES.ai.searchTime).toBe(30);
    expect(RULES.ai.searchTime).toBe(RULES.time.move * 3);
  });

  it('狀態仍可完整序列化並還原', () => {
    let s = unburden(testState(OPEN, [{ archetype: 'RUNNER', pos: { x: 5, y: 1 } }]));
    s = run(s, { type: 'MOVE', dir: 'E' });
    const round = JSON.parse(JSON.stringify(s));
    expect(JSON.stringify(applyCommand(round, { type: 'ADVANCE' }).state))
      .toBe(JSON.stringify(applyCommand(s, { type: 'ADVANCE' }).state));
  });

  it('結算用的是總耗時', () => {
    let s = unburden(testState(OPEN));
    for (let i = 0; i < 5; i++) s = advanceToPlayer(run(s, { type: 'WAIT' }));
    expect(s.clock).toBeGreaterThan(0);
  });
});
