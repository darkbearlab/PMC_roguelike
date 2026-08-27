/**
 * §11.1 相鄰格互動，以及僅存的兩張浮動小卡（自己／屍體）。
 * 射擊與移動的預覽已改為畫在戰場上，不再有面板，相關測試移到 ui.test.ts。
 */
import { describe, it, expect } from 'vitest';
import { corpsePanelHtml, selfPanelHtml } from '../src/ui/menus';
import { checkLegal, interactKindAt } from '../src/core/commands';
import { run, testState, player } from './helpers';

const ROOM = [
  '##############',
  '#D..........T#',
  '#............#',
  '#S..........S#',
  '##############',
];

describe('§11.1 相鄰格互動', () => {
  const T = { x: 12, y: 1 };

  it('站在終端格上可以互動', () => {
    const s = testState(ROOM);
    player(s).pos = { ...T };
    expect(checkLegal(s, { type: 'INTERACT', pos: T }).ok).toBe(true);
  });

  it('站在正交相鄰格即可互動，不需站上去', () => {
    for (const p of [{ x: 11, y: 1 }, { x: 12, y: 2 }]) {
      const s = testState(ROOM);
      player(s).pos = p;
      expect(checkLegal(s, { type: 'INTERACT', pos: T }).ok, JSON.stringify(p)).toBe(true);
    }
  });

  it('斜向相鄰不算相鄰（曼哈頓距離 2）', () => {
    const s = testState(ROOM);
    player(s).pos = { x: 11, y: 2 };
    const r = checkLegal(s, { type: 'INTERACT', pos: T });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('相鄰');
  });

  it('隔兩格不能互動', () => {
    const s = testState(ROOM);
    player(s).pos = { x: 10, y: 1 };
    expect(checkLegal(s, { type: 'INTERACT', pos: T }).ok).toBe(false);
  });

  it('從相鄰格完成主目標，AP 扣 1，並轉向目標', () => {
    const s = testState(ROOM);
    player(s).pos = { x: 11, y: 1 };
    const after = run(s, { type: 'INTERACT', pos: T });
    expect(after.objectives.main.done).toBe(true);
    expect(after.units[0].nextActAt).toBe(10);   // 互動花 10
    expect(after.units[0].facing).toBe('E');
  });

  it('次要目標認的是被點的那一格，不是腳下那一格', () => {
    const s = testState(ROOM);
    player(s).pos = { x: 2, y: 3 };   // (1,3) 與 (12,3) 都是 SUPPLY
    const after = run(s, { type: 'INTERACT', pos: { x: 1, y: 3 } });
    const done = after.objectives.secondary.filter((o) => o.done);
    expect(done).toHaveLength(1);
    expect(done[0].pos).toEqual({ x: 1, y: 3 });
  });

  it('interactKindAt 只看格子本身，不看距離', () => {
    const s = testState(ROOM);
    expect(interactKindAt(s, T)).toBe('TERMINAL');
    expect(interactKindAt(s, { x: 1, y: 3 })).toBe('SUPPLY');
    expect(interactKindAt(s, { x: 1, y: 1 })).toBeNull();   // 主目標未完成，不能撤離
    expect(interactKindAt(s, { x: 5, y: 2 })).toBeNull();
  });
});

describe('僅存的兩張浮動小卡', () => {
  it('點自己 → 詳細狀態，含兩把武器', () => {
    const html = selfPanelHtml(testState(ROOM));
    expect(html).toContain('詳細狀態');
    expect(html).toContain('AR-9 制式步槍');
    expect(html).toContain('RR-4 無後座力砲');
    expect(html).toContain('曼哈頓');
  });

  it('站在撤離點且主目標完成時，自己的卡片提供撤離', () => {
    let s = testState(ROOM);
    player(s).pos = { x: 12, y: 1 };
    s = run(s, { type: 'INTERACT', pos: { x: 12, y: 1 } });
    player(s).pos = { x: 1, y: 1 };
    expect(selfPanelHtml(s)).toContain('撤離');
  });

  it('點屍體 → 列出可拾取的武器', () => {
    let s = testState(ROOM);
    player(s).hp = 3;
    player(s).pos = { x: 5, y: 2 };
    s = run(s, { type: 'FIRE', target: { x: 5, y: 2 } });
    s = run(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] });
    const html = corpsePanelHtml(s, { x: 5, y: 2 });
    expect(html).toContain('的遺體');
    expect(html).toContain('AR-9 制式步槍');
    expect(html).toContain('RR-4 無後座力砲');
    expect(html).toContain('需站在該格');
  });
});
