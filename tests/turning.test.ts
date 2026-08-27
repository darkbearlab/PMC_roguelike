/**
 * §12.14 蹲姿的「先轉向、再移動」。
 * 蹲姿的視野由面向決定，所以玩家想調整視野時最不該發生的事就是意外離開掩體。
 */
import { describe, it, expect } from 'vitest';
import { checkLegal, commandTime, movePhase } from '../src/core/commands';
import { RULES } from '../src/core/content';
import { advanceToPlayer, run, testState, player } from './helpers';

const OPEN = [
  '#########',
  '#D......#',
  '#.......#',
  '#......T#',
  '#########',
];

/** 士兵北邊是牆：用來驗「面向牆壁也可以轉」。 */
const WALLED = [
  '#########',
  '#.#.....#',
  '#.D.....#',
  '#......T#',
  '#########',
];

describe('§12.14 站立時方向鍵直接移動', () => {
  it('面向跟著移動方向改變，一按就走', () => {
    let s = testState(OPEN);
    expect(player(s).stance).toBe('STAND');
    expect(movePhase(player(s), 'E')).toBe('STEP');
    s = run(s, { type: 'MOVE', dir: 'E' });
    expect(player(s).pos).toEqual({ x: 2, y: 1 });
    expect(player(s).facing).toBe('E');
    expect(player(s).nextActAt).toBe(RULES.time.move);
  });

  it('站立時面向不影響任何規則，所以不需要先轉', () => {
    let s = testState(OPEN);
    player(s).facing = 'N';
    s = run(s, { type: 'MOVE', dir: 'S' });
    expect(player(s).pos).toEqual({ x: 1, y: 2 });
  });
});

describe('§12.14 蹲下時先轉向、再移動', () => {
  it('按非面向的方向 → 只轉向，不移動，不花時間', () => {
    let s = testState(OPEN);
    player(s).stance = 'CROUCH';
    player(s).facing = 'S';
    const at = player(s).nextActAt;

    expect(movePhase(player(s), 'E')).toBe('TURN');
    expect(commandTime(s, { type: 'MOVE', dir: 'E' })).toBe(RULES.time.facing);
    s = run(s, { type: 'MOVE', dir: 'E' });
    expect(player(s).facing).toBe('E');
    expect(player(s).pos).toEqual({ x: 1, y: 1 });     // 沒有移動
    expect(player(s).nextActAt).toBe(at);              // 沒有花時間
  });

  it('再按一次同方向才真的走', () => {
    let s = testState(OPEN);
    player(s).stance = 'CROUCH';
    player(s).facing = 'S';
    s = run(s, { type: 'MOVE', dir: 'E' });            // 轉
    expect(movePhase(player(s), 'E')).toBe('STEP');
    s = run(s, { type: 'MOVE', dir: 'E' });            // 走
    expect(player(s).pos).toEqual({ x: 2, y: 1 });
    expect(player(s).nextActAt).toBe(RULES.time.move);
  });

  it('轉向永遠合法 —— 面向牆壁蹲著也是一種選擇', () => {
    const s = testState(WALLED);
    const u = player(s);
    u.stance = 'CROUCH';
    u.facing = 'S';
    // 北邊 (2,1) 是牆：站著按 N 非法，蹲著按 N 是轉向，合法
    expect(checkLegal(s, { type: 'MOVE', dir: 'N' }).ok).toBe(true);
    expect(movePhase(u, 'N')).toBe('TURN');
    u.stance = 'STAND';
    expect(checkLegal(s, { type: 'MOVE', dir: 'N' }).ok).toBe(false);
  });

  it('轉過去之後撞牆才會被擋下：兩下的意義不同', () => {
    let s = testState(WALLED);
    player(s).stance = 'CROUCH';
    player(s).facing = 'S';
    s = run(s, { type: 'MOVE', dir: 'N' });            // 轉向牆
    expect(player(s).facing).toBe('N');
    expect(checkLegal(s, { type: 'MOVE', dir: 'N' }).ok).toBe(false);
    expect(run(s, { type: 'MOVE', dir: 'N' })).toBe(s); // 非法 → 同一個物件
  });

  it('轉向不讓出行動權：連轉四次時鐘不動', () => {
    let s = testState(OPEN, [{ archetype: 'HULK', pos: { x: 7, y: 3 } }]);
    player(s).stance = 'CROUCH';
    for (const dir of ['N', 'E', 'S', 'W'] as const) s = run(s, { type: 'MOVE', dir });
    expect(s.clock).toBe(0);
    expect(player(s).nextActAt).toBe(0);
  });

  it('站起來之後方向鍵又恢復成直接走', () => {
    let s = testState(OPEN);
    player(s).stance = 'CROUCH';
    player(s).facing = 'S';
    s = run(s, { type: 'TOGGLE_STANCE' });             // 站起來（花 3）
    s = advanceToPlayer(s);
    expect(player(s).stance).toBe('STAND');
    expect(movePhase(player(s), 'E')).toBe('STEP');
  });
});
