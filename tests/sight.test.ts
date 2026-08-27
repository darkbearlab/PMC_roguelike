/**
 * §7.5 面向視野與 §8.8 背刺。
 *
 * 這一組刻意驗**不對稱**：遮蔽（los.ts）永遠對稱，面向永遠可能不對稱，
 * 兩者混在一起的話兩邊都會壞掉。
 */
import { describe, it, expect } from 'vitest';
import { canSee, usesFieldOfView, withinFieldOfView } from '../src/core/sight';
import { hasLineOfSight } from '../src/core/los';
import { computeVision } from '../src/render/vision';
import { testState, player, unit } from './helpers';

const OPEN = [
  '###############',
  '#.............#',
  '#.............#',
  '#......D......#',
  '#.............#',
  '#.............#',
  '#............T#',
  '###############',
];

/** 正方形房間，D 在正中央 —— 用來驗四個面向的對稱性。 */
const SQUARE = [
  '#########',
  '#.......#',
  '#.......#',
  '#.......#',
  '#...D...#',
  '#.......#',
  '#.......#',
  '#......T#',
  '#########',
];

const at = (x: number, y: number) => ({ x, y });

describe('§7.5 面向半平面', () => {
  it('站立的玩家是全方位，面向不影響任何格子', () => {
    const s = testState(OPEN);
    const u = player(s);
    expect(usesFieldOfView(u)).toBe(false);
    u.facing = 'N';
    for (const p of [at(7, 1), at(7, 5), at(1, 3), at(13, 3)]) {
      expect(withinFieldOfView(u, p), JSON.stringify(p)).toBe(true);
    }
  });

  it('蹲下就只剩前方半平面', () => {
    const s = testState(OPEN);
    const u = player(s);
    u.stance = 'CROUCH';
    expect(usesFieldOfView(u)).toBe(true);
  });

  it('面向北時，正東與正西的相鄰格看得見（含垂直線）', () => {
    const s = testState(OPEN);
    const u = player(s);
    u.stance = 'CROUCH';
    u.facing = 'N';
    expect(withinFieldOfView(u, at(8, 3))).toBe(true);   // 正東
    expect(withinFieldOfView(u, at(6, 3))).toBe(true);   // 正西
    expect(withinFieldOfView(u, at(7, 2))).toBe(true);   // 正前
  });

  it('面向北時，後方三格全是盲區', () => {
    const s = testState(OPEN);
    const u = player(s);
    u.stance = 'CROUCH';
    u.facing = 'N';
    expect(withinFieldOfView(u, at(7, 4))).toBe(false);  // 後
    expect(withinFieldOfView(u, at(8, 4))).toBe(false);  // 後右
    expect(withinFieldOfView(u, at(6, 4))).toBe(false);  // 後左
  });

  it('整個後方半平面都看不見，不只後面三格', () => {
    const s = testState(OPEN);
    const u = player(s);
    u.stance = 'CROUCH';
    u.facing = 'N';
    for (let y = 4; y <= 6; y++) {
      for (let x = 1; x <= 13; x++) {
        expect(withinFieldOfView(u, at(x, y)), `${x},${y}`).toBe(false);
      }
    }
  });

  it('四個面向在對稱的房間裡看到一樣多 —— 半平面只是轉向，沒有偏心', () => {
    // 正方形房間，士兵站正中央：四個方向的半平面必須等大
    const s = testState(SQUARE);
    const u = player(s);
    u.stance = 'CROUCH';
    const counts = (['N', 'E', 'S', 'W'] as const).map((f) => {
      u.facing = f;
      return computeVision(s).tiles.reduce((a: number, b: number) => a + b, 0);
    });
    expect(new Set(counts).size).toBe(1);
    // 半平面（含垂直線）＝ 全圖的一半再加上那條線，所以會超過一半
    u.stance = 'STAND';
    const all = computeVision(s).tiles.reduce((a: number, b: number) => a + b, 0);
    expect(counts[0]).toBeGreaterThan(all / 2);
    expect(counts[0]).toBeLessThan(all);
  });

  it('敵人一律有盲區，不管姿勢', () => {
    const s = testState(OPEN, [{ archetype: 'SHOOTER', pos: at(7, 5), facing: 'S' }]);
    const e = unit(s, 'E01');
    expect(e.stance).toBe('STAND');
    expect(usesFieldOfView(e)).toBe(true);
    // 玩家在它北邊（(7,3)），它面向南 → 看不見
    expect(canSee(s.map, e, player(s).pos)).toBe(false);
    e.facing = 'N';
    expect(canSee(s.map, e, player(s).pos)).toBe(true);
  });
});

describe('§7.5 面向不動遮蔽，遮蔽仍然對稱', () => {
  it('遮蔽函式本身沒有面向參數，兩個方向永遠一致', () => {
    const s = testState(OPEN);
    expect(hasLineOfSight(s.map, at(1, 1), 'STAND', at(13, 6), 'STAND'))
      .toBe(hasLineOfSight(s.map, at(13, 6), 'STAND', at(1, 1), 'STAND'));
  });

  it('canSee 則可以單向成立 —— 那正是背刺的定義', () => {
    const s = testState(OPEN, [{ archetype: 'SHOOTER', pos: at(7, 5), facing: 'S' }]);
    const me = player(s);        // (7,3)，站立 → 全方位
    const e = unit(s, 'E01');    // (7,5)，面向南 → 背對玩家
    expect(canSee(s.map, me, e.pos)).toBe(true);
    expect(canSee(s.map, e, me.pos)).toBe(false);
  });
});

describe('§12.13 地形不受視野限制，只有單位受限制', () => {
  it('蹲下時看得見的格子變少 —— 但那只影響單位，地形照畫', () => {
    const s = testState(OPEN);
    const standCount = computeVision(s).tiles.reduce((a: number, b: number) => a + b, 0);
    player(s).stance = 'CROUCH';
    player(s).facing = 'N';
    const crouchCount = computeVision(s).tiles.reduce((a: number, b: number) => a + b, 0);
    expect(crouchCount).toBeLessThan(standCount);
  });

  it('可見性只跟「誰在看、站哪、什麼姿勢、面向哪」有關，敵人怎麼動都不影響', () => {
    const a = testState(OPEN, [{ archetype: 'RUNNER', pos: at(11, 1) }]);
    const b = testState(OPEN, [{ archetype: 'RUNNER', pos: at(2, 5) }]);
    expect(computeVision(a).key).toBe(computeVision(b).key);
  });

  it('面向改變會讓可見性快取失效（不然轉了頭畫面不會更新）', () => {
    const s = testState(OPEN);
    player(s).stance = 'CROUCH';
    player(s).facing = 'N';
    const north = computeVision(s).key;
    player(s).facing = 'S';
    expect(computeVision(s).key).not.toBe(north);
  });
});
