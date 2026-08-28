// @vitest-environment jsdom
/**
 * 屍體壓在目標點上（v0.19 附錄）。
 *
 * 試玩回報：**敵人的屍體與目標點在同一格時，就沒辦法與目標點互動了。**
 *
 * 規則層一直是合法的 —— `INTERACT` 那個指令從頭到尾都通得過。
 * 到不了的是介面：`tapTile` 查搜刮堆優先於查目標點，
 * 於是「敵人剛好死在終端機上」= 那個終端機永遠按不到。
 *
 * 修法是把互動鍵放進掠奪面板，而不是改變點擊的優先順序 ——
 * 屍體上的東西與目標點都在同一格，**兩件事都要做得到**。
 */
import { describe, expect, it } from 'vitest';
import { checkLegal, interactTarget } from '../src/core/commands';
import { lootPanelHtml } from '../src/ui/menus';
import { player, run, testState } from './helpers';
import type { GameState, Vec2 } from '../src/core/state';

const ROOM = [
  '##############',
  '#D...........#',
  '#............#',
  '#..........T.#',
  '##############',
];

/** 在指定位置堆一具屍體。 */
function corpseAt(s: GameState, pos: Vec2): GameState {
  s.loot.push({
    id: 'LBODY', kind: 'ENEMY_BODY', pos: { ...pos }, label: '衝鋒兵-01 的殘骸',
    items: [{
      id: 'IT', kind: 'AMMO', defId: 'standard_5.56', name: '5.56 步槍彈',
      weight: 0.024, qty: 4, ammoTypeId: 'standard_5.56',
    }],
  });
  return s;
}

const terminal = { x: 11, y: 3 };

describe('屍體壓在目標點上', () => {
  it('規則層一直是對的：站在旁邊，INTERACT 合法', () => {
    const s = corpseAt(testState(ROOM), terminal);
    player(s).pos = { x: 10, y: 3 };
    expect(interactTarget(s, player(s), terminal)).toBe('TERMINAL');
    expect(checkLegal(s, { type: 'INTERACT', pos: terminal }).ok).toBe(true);
  });

  it('**掠奪面板上有互動鍵** —— 這是修掉的那個洞', () => {
    const s = corpseAt(testState(ROOM), terminal);
    player(s).pos = { x: 10, y: 3 };
    const html = lootPanelHtml(s, terminal);
    expect(html).toContain('data-do="interact"');
    expect(html).toContain('存取終端');
    expect(html).toContain('費時');
    // 搜刮照樣做得到 —— 沒有拿掉任何東西
    expect(html).toContain('data-do="take-all"');
  });

  it('屍體被拿空之後，互動鍵還在', () => {
    const s = corpseAt(testState(ROOM), terminal);
    player(s).pos = { x: 10, y: 3 };
    s.loot[s.loot.length - 1].items = [];
    const html = lootPanelHtml(s, terminal);
    expect(html).toContain('data-do="interact"');
  });

  it('真的按得下去：主目標完成', () => {
    let s = corpseAt(testState(ROOM), terminal);
    player(s).pos = { x: 10, y: 3 };
    expect(s.objectives.main.done).toBe(false);
    s = run(s, { type: 'INTERACT', pos: terminal });
    expect(s.objectives.main.done).toBe(true);
  });

  it('站在屍體上（屍體又壓在目標點上）也按得到', () => {
    const s = corpseAt(testState(ROOM), terminal);
    player(s).pos = { ...terminal };
    const html = lootPanelHtml(s, terminal);
    expect(html).toContain('data-do="interact"');
    expect(checkLegal(s, { type: 'INTERACT', pos: terminal }).ok).toBe(true);
  });

  it('撤離點被屍體壓住也一樣 —— 那是最要命的一種', () => {
    const s = corpseAt(testState(ROOM), { x: 1, y: 1 });
    s.objectives.main.done = true;             // 完成主目標才會開放撤離
    player(s).pos = { x: 1, y: 1 };
    expect(interactTarget(s, player(s), { x: 1, y: 1 })).toBe('EXTRACT');
    expect(lootPanelHtml(s, { x: 1, y: 1 })).toContain('data-do="interact"');
  });

  it('沒有目標點的普通屍體不會多出一顆鍵', () => {
    const s = corpseAt(testState(ROOM), { x: 5, y: 2 });
    player(s).pos = { x: 5, y: 1 };
    const html = lootPanelHtml(s, { x: 5, y: 2 });
    expect(html).not.toContain('data-do="interact"');
    expect(html).toContain('data-do="take-all"');
  });
});
