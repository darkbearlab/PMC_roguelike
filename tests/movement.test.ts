import { describe, it, expect } from 'vitest';
import { isPlayerTurn } from '../src/core/scheduler';
import { checkLegal, commandTime, movePath } from '../src/core/commands';
import { activeUnit } from '../src/core/scheduler';
import { RULES } from '../src/core/content';
import { advanceToPlayer, run, testState, player, placePlayer, unburden } from './helpers';

const OPEN = [
  '#########',
  '#D......#',
  '#.......#',
  '#.......#',
  '#......T#',
  '#########',
];

describe('§5 排程器：時間成本', () => {
  it('移動一格花 10（基準），並把下次行動時刻往後推', () => {
    let s = unburden(testState(OPEN));
    expect(s.clock).toBe(0);
    expect(player(s).nextActAt).toBe(0);
    s = run(s, { type: 'MOVE', dir: 'E' });
    expect(player(s).nextActAt).toBe(10);
    expect(player(s).pos).toEqual({ x: 2, y: 1 });
  });

  it('不能斜向移動（v0.3 起只有四方向）', () => {
    const s = unburden(testState(OPEN));
    for (const dir of ['NE', 'SE', 'SW', 'NW'] as const) {
      expect(checkLegal(s, { type: 'MOVE', dir }).ok, dir).toBe(false);
      expect(run(s, { type: 'MOVE', dir }), dir).toBe(s);
    }
    for (const dir of ['E', 'S'] as const) {
      expect(checkLegal(s, { type: 'MOVE', dir }).ok, dir).toBe(true);
    }
  });

  it('沒有「回合」：動作花完時間就換 nextActAt 最小的單位行動', () => {
    // 敵人在遠處、不會發現玩家，但仍然要照排程輪到它
    let s = unburden(testState(OPEN, [{ archetype: 'HULK', pos: { x: 7, y: 4 } }]));
    expect(isPlayerTurn(s)).toBe(true);          // 同時刻 0，玩家優先（§5.3）
    s = run(s, { type: 'MOVE', dir: 'E' });      // 玩家推到 10，HULK 還在 0
    expect(isPlayerTurn(s)).toBe(false);
    s = advanceToPlayer(s);
    expect(isPlayerTurn(s)).toBe(true);
    // clock 是「上一個動作發生的時刻」。HULK 在時刻 0 行動，所以此刻仍是 0；
    // 等玩家真的做下一件事，clock 才會前進到玩家的 nextActAt。
    expect(s.clock).toBe(0);
    expect(player(s).nextActAt).toBe(10);
    s = run(s, { type: 'MOVE', dir: 'E' });
    expect(s.clock).toBe(10);
    expect(player(s).nextActAt).toBe(20);
  });

  it('同時刻時玩家優先，其次依陣列索引；順序不含亂數', () => {
    const s = unburden(testState(OPEN, [
      { archetype: 'RUNNER', pos: { x: 5, y: 1 } },
      { archetype: 'RUNNER', pos: { x: 6, y: 1 } },
    ]));
    // 全部都在時刻 0
    expect(s.units.every((u) => u.nextActAt === 0)).toBe(true);
    expect(activeUnit(s)!.faction).toBe('PLAYER');
    // 把玩家推遠一點，剩下兩個敵人同時刻 → 取陣列索引小的
    const t = structuredClone(s);
    t.units[0].nextActAt = 99;
    expect(activeUnit(t)!.id).toBe('E01');
  });

  it('面向 0 成本：轉向後不讓出行動權', () => {
    let s = unburden(testState(OPEN, [{ archetype: 'HULK', pos: { x: 7, y: 4 } }]));
    s = run(s, { type: 'SET_FACING', facing: 'N' });
    expect(player(s).facing).toBe('N');
    expect(player(s).nextActAt).toBe(0);
    expect(isPlayerTurn(s)).toBe(true);          // 仍然輪到玩家
  });

  it('v0.8：姿勢改成花 3，因為免費就等於免費掃視一圈', () => {
    let s = unburden(testState(OPEN, [{ archetype: 'HULK', pos: { x: 7, y: 4 } }]));
    s = run(s, { type: 'TOGGLE_STANCE' });
    expect(player(s).stance).toBe('CROUCH');
    expect(player(s).nextActAt).toBe(3);
  });

  it('等待花 10（等同移動一格），不是「用掉剩餘全部」', () => {
    let s = unburden(testState(OPEN));
    s = run(s, { type: 'WAIT' });
    expect(player(s).nextActAt).toBe(RULES.time.wait);
    expect(RULES.time.wait).toBe(RULES.time.move);
  });

  it('還沒輪到玩家時所有玩家指令都非法，且狀態物件不變', () => {
    let s = unburden(testState(OPEN, [{ archetype: 'RUNNER', pos: { x: 7, y: 4 } }]));
    s = run(s, { type: 'MOVE', dir: 'E' });      // 玩家推到 10，換敵人
    expect(isPlayerTurn(s)).toBe(false);
    const before = s;
    expect(run(s, { type: 'MOVE', dir: 'E' })).toBe(before);
    expect(checkLegal(s, { type: 'MOVE', dir: 'E' }).ok).toBe(false);
    expect(checkLegal(s, { type: 'MOVE', dir: 'E' }).reason).toContain('還沒輪到');
  });

  it('所有時間成本都來自資料檔', () => {
    const s = unburden(testState(OPEN));
    expect(commandTime(s, { type: 'MOVE', dir: 'E' })).toBe(RULES.time.move);
    expect(commandTime(s, { type: 'WAIT' })).toBe(RULES.time.wait);
    expect(commandTime(s, { type: 'TOGGLE_STANCE' })).toBe(RULES.time.stance);
    expect(commandTime(s, { type: 'INTERACT', pos: { x: 1, y: 1 } })).toBe(RULES.time.interact);
    expect(RULES.time.stance).toBe(3);   // v0.8：姿勢不再免費
    expect(RULES.time.facing).toBe(0);
  });
});

describe('§5.3 / §6 地形與切角', () => {
  it('不可走入 WALL 與 HALF_COVER', () => {
    const s = unburden(testState(['######', '#D..T#', '#.#+.#', '#....#', '######']));
    placePlayer(s, { x: 1, y: 3 });
    expect(checkLegal(s, { type: 'MOVE', dir: 'N' }).ok).toBe(true);
    placePlayer(s, { x: 1, y: 1 });
    expect(checkLegal(s, { type: 'MOVE', dir: 'S' }).ok).toBe(true);
    placePlayer(s, { x: 2, y: 3 });
    expect(checkLegal(s, { type: 'MOVE', dir: 'N' }).ok).toBe(false); // (2,2) = '#'
    // v0.19：撞向半身掩體不再是「什麼都不會發生」，而是翻越 ——
    // 但**人仍然不會站在掩體格上**，他會落在對面。
    placePlayer(s, { x: 3, y: 3 });
    const before = { ...player(s).pos };
    expect(checkLegal(s, { type: 'MOVE', dir: 'N' }).ok).toBe(true);   // (3,2) = '+' → 翻越
    const after = run(s, { type: 'MOVE', dir: 'N' });
    expect(player(after).pos).toEqual({ x: 3, y: 1 });                 // 跨過去，不是站上去
    expect(player(after).pos).not.toEqual({ x: 3, y: 2 });
    expect(before).toEqual({ x: 3, y: 3 });
  });

  it('四方向移動下沒有「切角」這種走法：對角格必須繞兩步', () => {
    const s = unburden(testState(['#####', '#D.T#', '#.#.#', '#...#', '#####']));
    placePlayer(s, { x: 1, y: 2 });
    expect(checkLegal(s, { type: 'MOVE', dir: 'NE' }).ok).toBe(false);
    expect(checkLegal(s, { type: 'MOVE', dir: 'N' }).ok).toBe(true);
    // (1,2) -> (2,1) 走不了斜線，得經過 (1,1) 或 (2,2)，(2,2) 是牆 → 只剩 2 步繞路
    expect(movePath(s, { x: 2, y: 1 })!.length).toBe(2);
  });

  it('尋路成本 = 路徑長度 × 移動時間（四方向）', () => {
    const s = unburden(testState(['#####', '#D.T#', '#.#.#', '#...#', '#####']));
    // (1,1) -> (2,1) -> (3,1)='T' 可通行 -> (3,2)
    expect(movePath(s, { x: 3, y: 2 })!.length).toBe(3);
    // 曼哈頓距離就是無障礙時的步數
    const open = unburden(testState(OPEN));
    expect(movePath(open, { x: 4, y: 3 })!.length).toBe(5); // (1,1)->(4,3) = 3+2
  });

  it('單位不可重疊', () => {
    const s = unburden(testState(OPEN, [{ archetype: 'HULK', pos: { x: 2, y: 1 } }]));
    expect(checkLegal(s, { type: 'MOVE', dir: 'E' }).ok).toBe(false);
  });
});
