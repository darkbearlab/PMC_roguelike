import { describe, it, expect } from 'vitest';
import { applyCommand, checkLegal, movePath } from '../src/core/commands';
import { testState, player, placePlayer } from './helpers';

const OPEN = [
  '#########',
  '#D......#',
  '#.......#',
  '#.......#',
  '#......T#',
  '#########',
];

describe('§5.2 AP 扣減', () => {
  it('移動 1 格扣 1 AP', () => {
    let s = testState(OPEN);
    expect(player(s).ap).toBe(2);
    s = applyCommand(s, { type: 'MOVE', dir: 'E' });
    expect(player(s).ap).toBe(1);
    expect(player(s).pos).toEqual({ x: 2, y: 1 });
  });

  it('斜向移動成本與正向相同（1 AP）', () => {
    let s = testState(OPEN);
    s = applyCommand(s, { type: 'MOVE', dir: 'SE' });
    expect(player(s).ap).toBe(1);
    expect(player(s).pos).toEqual({ x: 2, y: 2 });
  });

  it('AP 歸零時自動結束玩家回合，並進入敵人回合', () => {
    let s = testState(OPEN);
    s = applyCommand(s, { type: 'MOVE', dir: 'E' });
    expect(s.phase).toBe('PLAYER');
    s = applyCommand(s, { type: 'MOVE', dir: 'E' });
    expect(player(s).ap).toBe(0);
    expect(s.phase).toBe('ENEMY');
  });

  it('敵人回合跑完後回到玩家回合，AP 補滿且回合數 +1', () => {
    let s = testState(OPEN);
    s = applyCommand(s, { type: 'MOVE', dir: 'E' });
    s = applyCommand(s, { type: 'MOVE', dir: 'E' });
    let guard = 0;
    while (s.phase === 'ENEMY' && guard++ < 200) s = applyCommand(s, { type: 'ENEMY_STEP' });
    expect(s.phase).toBe('PLAYER');
    expect(s.turn).toBe(2);
    expect(player(s).ap).toBe(2);
  });

  it('改變姿勢與面向免費（§5.2 刻意設計，不要加 AP 成本）', () => {
    let s = testState(OPEN);
    s = applyCommand(s, { type: 'TOGGLE_STANCE' });
    expect(player(s).stance).toBe('CROUCH');
    expect(player(s).ap).toBe(2);
    s = applyCommand(s, { type: 'SET_FACING', facing: 'N' });
    expect(player(s).facing).toBe('N');
    expect(player(s).ap).toBe(2);
  });

  it('等待消耗全部剩餘 AP 並結束回合', () => {
    let s = testState(OPEN);
    s = applyCommand(s, { type: 'WAIT' });
    expect(s.phase).toBe('ENEMY');
  });

  it('AP 不足時移動指令非法，且狀態物件不變', () => {
    let s = testState(OPEN);
    s = applyCommand(s, { type: 'MOVE', dir: 'E' });
    const p = player(s);
    p.ap = 0;
    const before = s;
    const after = applyCommand(s, { type: 'MOVE', dir: 'E' });
    expect(after).toBe(before);
    expect(checkLegal(s, { type: 'MOVE', dir: 'E' }).ok).toBe(false);
  });
});

describe('§5.3 / §6 地形與切角', () => {
  it('不可走入 WALL 與 HALF_COVER', () => {
    const s = testState(['######', '#D..T#', '#.#+.#', '#....#', '######']);
    placePlayer(s, { x: 1, y: 3 });
    expect(checkLegal(s, { type: 'MOVE', dir: 'N' }).ok).toBe(true);
    placePlayer(s, { x: 1, y: 1 });
    expect(checkLegal(s, { type: 'MOVE', dir: 'S' }).ok).toBe(true);
    placePlayer(s, { x: 2, y: 3 });
    expect(checkLegal(s, { type: 'MOVE', dir: 'N' }).ok).toBe(false); // (2,2) = '#'
    placePlayer(s, { x: 3, y: 3 });
    expect(checkLegal(s, { type: 'MOVE', dir: 'N' }).ok).toBe(false); // (3,2) = '+'
  });

  it('禁止斜穿角落：對角縫隙不可穿越', () => {
    //  y=1 #D.#
    //  y=2 #.##      從 (1,2) 想斜走到 (2,1) 會擦過 (2,2)='#'
    const s = testState(['#####', '#D.T#', '#.#.#', '#...#', '#####']);
    placePlayer(s, { x: 1, y: 2 });
    // (2,2) 是牆 → NE 斜穿被禁止（STRICT 規則）
    expect(checkLegal(s, { type: 'MOVE', dir: 'NE' }).ok).toBe(false);
    // 正交繞路則合法
    expect(checkLegal(s, { type: 'MOVE', dir: 'N' }).ok).toBe(true);
  });

  it('尋路成本 = 路徑長度 = 所需 AP，且不會穿越角落', () => {
    const s = testState(['#####', '#D.T#', '#.#.#', '#...#', '#####']);
    const path = movePath(s, { x: 3, y: 2 });
    expect(path).not.toBeNull();
    // (1,1) -> (2,1) -> (3,1)? (3,1)='T' 可通行 -> (3,2)
    expect(path!.length).toBe(3);
  });

  it('單位不可重疊', () => {
    const s = testState(OPEN, [{ archetype: 'HULK', pos: { x: 2, y: 1 } }]);
    expect(checkLegal(s, { type: 'MOVE', dir: 'E' }).ok).toBe(false);
  });
});
