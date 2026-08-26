/**
 * §7.2b 掩蔽：與遮蔽分開的獨立檢查。
 */
import { describe, it, expect } from 'vitest';
import { COVER_LABEL, coverAgainst, playerDefence } from '../src/core/cover';
import { hasLineOfSight } from '../src/core/los';
import { RULES } from '../src/core/content';
import { testState, player } from './helpers';

//        0123456
//  y=0   #######
//  y=1   #.....#
//  y=2   #..#..#      (3,2) 是牆
//  y=3   #D...T#
//  y=4   #.....#
//  y=5   #######
const MAP = ['#######', '#.....#', '#..#..#', '#D...T#', '#.....#', '#######'];
const map = testState(MAP).map;

//        012345678
//  y=3   #...#...#   ← (4,3) 是唯一的內牆
const FLANK = ['#########', '#D......#', '#.......#', '#...#...#', '#.......#', '#......T#', '#########'];
const at = (x: number, y: number) => ({ x, y });

describe('掩蔽是鄰格掃描，不是射線', () => {
  it('目標朝射手側沒有阻擋物 → 無掩蔽', () => {
    // 目標 (1,1)、射手 (5,1)：朝射手側是 (2,1)，是地板
    expect(coverAgainst(map, at(1, 1), at(5, 1)).level).toBe('NONE');
  });

  it('朝射手側有一格阻擋物 → 部分掩蔽 −25%', () => {
    // 目標 (2,1)、射手 (2,4)：朝射手的垂直鄰格是 (2,2)？不是牆。改用 (4,2) 對 (2,2)
    // 目標 (4,1)、射手 (1,3)：dx<0 → (3,1) 地板；dy>0 → (4,2) 地板 → 無掩蔽
    // 用 (2,2) 當目標、(5,2) 當射手：dx>0 → (3,2) 是牆 → 一格
    const c = coverAgainst(map, at(2, 2), at(5, 2));
    expect(c.level).toBe('PARTIAL');
    expect(c.penalty).toBe(RULES.combat.cover.partial);
    expect(c.tiles).toEqual([at(3, 2)]);
  });

  it('朝射手側兩格都是阻擋物 → 良好掩蔽 −40%（牆角）', () => {
    // 目標 (1,1) 貼在左上角：射手在東南方 → 候選是 (2,1) 與 (1,2)，都是地板 → 無掩蔽
    // 改用射手在西北方：候選是 (0,1) 與 (1,0)，都是外牆 → 兩格
    const c = coverAgainst(map, at(1, 1), at(-3, -3));
    expect(c.level).toBe('GOOD');
    expect(c.penalty).toBe(RULES.combat.cover.good);
    expect(c.tiles).toHaveLength(2);
  });

  it('地圖界外視同 WALL，貼邊界站立可獲得掩蔽', () => {
    // 目標 (1,3) 貼左牆，射手在正西方 → 候選只有 (0,3)，是外牆
    expect(coverAgainst(map, at(1, 3), at(-5, 3)).level).toBe('PARTIAL');
  });

  it('WALL 與 HALF_COVER 提供相同的掩蔽', () => {
    const wallMap = testState(['#####', '#...#', '#.#.#', '#D.T#', '#####']).map;
    const coverMap = testState(['#####', '#...#', '#.+.#', '#D.T#', '#####']).map;
    const a = coverAgainst(wallMap, at(1, 2), at(3, 2));
    const b = coverAgainst(coverMap, at(1, 2), at(3, 2));
    expect(a.level).toBe(b.level);
    expect(a.penalty).toBe(b.penalty);
  });

  it('射手繞到另一側，掩蔽就消失 —— 側翼是掩蔽的解法', () => {
    // 目標 (2,2)，牆在 (3,2)。射手在東邊 → 部分掩蔽；繞到西邊 → 無掩蔽
    expect(coverAgainst(map, at(2, 2), at(5, 2)).level).toBe('PARTIAL');
    expect(coverAgainst(map, at(2, 2), at(1, 2)).level).toBe('NONE');
  });

  it('最多兩格：不會因為周圍都是牆就無限累加', () => {
    const boxed = testState(['#####', '#####', '##D##', '#####', '#T###']).map;
    const c = coverAgainst(boxed, at(2, 2), at(4, 4));
    expect(c.tiles.length).toBeLessThanOrEqual(2);
    expect(c.level).toBe('GOOD');
  });
});

describe('掩蔽與遮蔽是兩回事', () => {
  it('正交直線對射時，朝向射手的鄰格若是阻擋物，結果是遮蔽而非掩蔽', () => {
    // 目標 (2,2)、射手 (4,2)：中間的 (3,2) 是牆
    // → 射線被完全阻擋（遮蔽），根本打不到，而不是「有掩蔽但打得到」
    expect(hasLineOfSight(map, at(4, 2), 'STAND', at(2, 2), 'STAND')).toBe(false);
    // 掩蔽函式本身仍然回報那一格，但它在這個方向上沒有意義 —— 因為根本沒有視線
    expect(coverAgainst(map, at(2, 2), at(4, 2)).level).toBe('PARTIAL');
  });

  it('有掩蔽而視線仍然通暢：兩者確實是獨立的檢查', () => {
    //        012345678
    //  y=2   #.......#   ← 目標 (4,2)
    //  y=3   #...#...#   ← (4,3) 是牆，位於目標「朝射手（南方）」那一側
    //  y=4   #.......#   ← 射手 (2,4)：斜著看過去，射線繞過那面牆
    const m = testState(FLANK).map;
    expect(hasLineOfSight(m, at(2, 4), 'STAND', at(4, 2), 'STAND')).toBe(true);
    const c = coverAgainst(m, at(4, 2), at(2, 4));
    expect(c.level).toBe('PARTIAL');
    expect(c.tiles).toEqual([at(4, 3)]);
  });

  it('射手繞到目標同一列，掩蔽歸零而視線依舊 —— 側翼真的有用', () => {
    const m = testState(FLANK).map;
    // 射手移到正西方：dy = 0，垂直方向沒有候選格，那面牆就不再提供掩蔽
    expect(hasLineOfSight(m, at(1, 2), 'STAND', at(4, 2), 'STAND')).toBe(true);
    expect(coverAgainst(m, at(4, 2), at(1, 2)).level).toBe('NONE');
  });

});

describe('§12.11 玩家防禦狀態採「最差情況」', () => {
  it('沒有敵人看得到玩家時，威脅數為 0', () => {
    const s = testState(MAP);
    const d = playerDefence(s);
    expect(d.threats).toBe(0);
  });

  it('多個敵人時取掩蔽最低的那一個 —— HUD 不會騙玩家', () => {
    const s = testState(FLANK, [
      { archetype: 'RUNNER', pos: { x: 2, y: 4 } },   // 斜下方：有掩蔽
      { archetype: 'RUNNER', pos: { x: 1, y: 2 } },   // 正西方：沒有掩蔽
    ]);
    player(s).pos = { x: 4, y: 2 };
    const d = playerDefence(s);
    expect(d.threats).toBe(2);
    expect(d.level).toBe('NONE');          // 取最差
    expect(COVER_LABEL[d.level]).toBe('無掩蔽');
  });

  it('只剩有掩蔽的那個敵人看得到時，才回報掩蔽', () => {
    const s = testState(FLANK, [{ archetype: 'RUNNER', pos: { x: 2, y: 4 } }]);
    player(s).pos = { x: 4, y: 2 };
    const d = playerDefence(s);
    expect(d.threats).toBe(1);
    expect(d.level).toBe('PARTIAL');
  });

  it('回報是否蹲伏', () => {
    const s = testState(MAP);
    expect(playerDefence(s).crouched).toBe(false);
    player(s).stance = 'CROUCH';
    expect(playerDefence(s).crouched).toBe(true);
  });
});
