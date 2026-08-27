/**
 * §5 撤離與收工。
 *
 * 「我東西撿夠了、主目標太硬、我走了」必須是一個可以做的決定 ——
 * 系統不禁止，只標價。
 */
import { describe, it, expect } from 'vitest';
import { checkLegal, interactKindAt } from '../src/core/commands';
import { run, testState, player } from './helpers';

const ROOM = [
  '##############',
  '#D...........#',
  '#............#',
  '#...........T#',
  '##############',
];

describe('§5.1 隨時可以撤離', () => {
  it('主目標未完成也能撤離，判定為 ABORTED，但戰利品照樣帶出', () => {
    let s = testState(ROOM);
    expect(s.objectives.main.done).toBe(false);
    expect(interactKindAt(s, { x: 1, y: 1 })).toBe('EXTRACT');
    s = run(s, { type: 'INTERACT', pos: { x: 1, y: 1 } });
    expect(s.result).toBe('ABORTED');
    expect(s.extracted.some((it) => it.kind === 'AMMO')).toBe(true);
    expect(s.extracted.filter((it) => it.kind === 'WEAPON')).toHaveLength(2);
  });

  it('主目標完成後撤離 → SUCCESS，一樣帶出', () => {
    let s = testState(ROOM);
    s.objectives.main.done = true;
    s = run(s, { type: 'INTERACT', pos: { x: 1, y: 1 } });
    expect(s.result).toBe('SUCCESS');
    expect(s.extracted.length).toBeGreaterThan(0);
  });

  it('背包裡的搜刮物一起帶出', () => {
    let s = testState(ROOM);
    player(s).backpack!.items.push({
      id: 'X', kind: 'VALUABLE', defId: 'CORE', name: '動力核心', weight: 6, qty: 2, value: 5,
    });
    s = run(s, { type: 'INTERACT', pos: { x: 1, y: 1 } });
    const core = s.extracted.find((it) => it.defId === 'CORE');
    expect(core).toBeTruthy();
    expect(core!.qty).toBe(2);
  });

  it('相鄰格也能撤離（與既有互動規則一致）', () => {
    const s = testState(ROOM);
    player(s).pos = { x: 2, y: 1 };
    expect(checkLegal(s, { type: 'INTERACT', pos: { x: 1, y: 1 } }).ok).toBe(true);
  });
});

describe('§5.3 / §5.4 止損與全滅都不帶東西出去', () => {
  it('止損：戰場上的一切全部損失', () => {
    let s = testState(ROOM);
    s = run(s, { type: 'ABORT' });
    expect(s.result).toBe('ABORTED');
    expect(s.extracted).toHaveLength(0);
  });

  it('全滅：一樣什麼都沒帶出來', () => {
    let s = testState(ROOM);
    s.roster = [];
    player(s).hp = 3;
    s = run(s, { type: 'FIRE', target: player(s).pos });
    expect(s.result).toBe('WIPED');
    expect(s.extracted).toHaveLength(0);
  });

  it('撤離與止損是兩件事：撤離是走出去，止損是不要了', () => {
    let out = testState(ROOM);
    out = run(out, { type: 'INTERACT', pos: { x: 1, y: 1 } });
    let quit = testState(ROOM);
    quit = run(quit, { type: 'ABORT' });
    expect(out.result).toBe(quit.result);              // 兩者都是 ABORTED
    expect(out.extracted.length).toBeGreaterThan(0);   // 但一個帶了東西回來
    expect(quit.extracted).toHaveLength(0);            // 另一個沒有
  });
});
