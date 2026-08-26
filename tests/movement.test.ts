import { describe, it, expect } from 'vitest';
import { checkLegal, movePath } from '../src/core/commands';
import { run, testState, player, placePlayer } from './helpers';

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
    s = run(s, { type: 'MOVE', dir: 'E' });
    expect(player(s).ap).toBe(1);
    expect(player(s).pos).toEqual({ x: 2, y: 1 });
  });

  it('不能斜向移動（v0.3 起只有四方向）', () => {
    const s = testState(OPEN);
    for (const dir of ['NE', 'SE', 'SW', 'NW'] as const) {
      expect(checkLegal(s, { type: 'MOVE', dir }).ok, dir).toBe(false);
      expect(run(s, { type: 'MOVE', dir }), dir).toBe(s);
    }
    for (const dir of ['E', 'S'] as const) {
      expect(checkLegal(s, { type: 'MOVE', dir }).ok, dir).toBe(true);
    }
  });

  it('AP 歸零時自動結束玩家回合，並進入敵人回合', () => {
    let s = testState(OPEN);
    s = run(s, { type: 'MOVE', dir: 'E' });
    expect(s.phase).toBe('PLAYER');
    s = run(s, { type: 'MOVE', dir: 'E' });
    expect(player(s).ap).toBe(0);
    expect(s.phase).toBe('ENEMY');
  });

  it('敵人回合跑完後回到玩家回合，AP 補滿且回合數 +1', () => {
    let s = testState(OPEN);
    s = run(s, { type: 'MOVE', dir: 'E' });
    s = run(s, { type: 'MOVE', dir: 'E' });
    let guard = 0;
    while (s.phase === 'ENEMY' && guard++ < 200) s = run(s, { type: 'ENEMY_STEP' });
    expect(s.phase).toBe('PLAYER');
    expect(s.turn).toBe(2);
    expect(player(s).ap).toBe(2);
  });

  it('改變姿勢與面向免費（§5.2 刻意設計，不要加 AP 成本）', () => {
    let s = testState(OPEN);
    s = run(s, { type: 'TOGGLE_STANCE' });
    expect(player(s).stance).toBe('CROUCH');
    expect(player(s).ap).toBe(2);
    s = run(s, { type: 'SET_FACING', facing: 'N' });
    expect(player(s).facing).toBe('N');
    expect(player(s).ap).toBe(2);
  });

  it('等待消耗全部剩餘 AP 並結束回合', () => {
    let s = testState(OPEN);
    s = run(s, { type: 'WAIT' });
    expect(s.phase).toBe('ENEMY');
  });

  it('AP 不足時移動指令非法，且狀態物件不變', () => {
    let s = testState(OPEN);
    s = run(s, { type: 'MOVE', dir: 'E' });
    const p = player(s);
    p.ap = 0;
    const before = s;
    const after = run(s, { type: 'MOVE', dir: 'E' });
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

  it('四方向移動下沒有「切角」這種走法：對角格必須繞兩步', () => {
    const s = testState(['#####', '#D.T#', '#.#.#', '#...#', '#####']);
    placePlayer(s, { x: 1, y: 2 });
    expect(checkLegal(s, { type: 'MOVE', dir: 'NE' }).ok).toBe(false);
    expect(checkLegal(s, { type: 'MOVE', dir: 'N' }).ok).toBe(true);
    // (1,2) -> (2,1) 走不了斜線，得經過 (1,1) 或 (2,2)，(2,2) 是牆 → 只剩 2 步繞路
    expect(movePath(s, { x: 2, y: 1 })!.length).toBe(2);
  });

  it('尋路成本 = 路徑長度 = 所需 AP（四方向）', () => {
    const s = testState(['#####', '#D.T#', '#.#.#', '#...#', '#####']);
    // (1,1) -> (2,1) -> (3,1)='T' 可通行 -> (3,2)
    expect(movePath(s, { x: 3, y: 2 })!.length).toBe(3);
    // 曼哈頓距離就是無障礙時的步數
    const open = testState(OPEN);
    expect(movePath(open, { x: 4, y: 3 })!.length).toBe(5); // (1,1)->(4,3) = 3+2
  });

  it('單位不可重疊', () => {
    const s = testState(OPEN, [{ archetype: 'HULK', pos: { x: 2, y: 1 } }]);
    expect(checkLegal(s, { type: 'MOVE', dir: 'E' }).ok).toBe(false);
  });
});
