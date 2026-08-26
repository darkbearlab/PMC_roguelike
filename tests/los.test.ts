import { describe, it, expect } from 'vitest';
import { bresenham, hasLineOfSight } from '../src/core/los';
import { parseMap } from '../src/core/map';
import type { MapData, Stance, Vec2 } from '../src/core/state';
import { LEGEND } from './helpers';

function mapOf(rows: string[]): MapData {
  return parseMap({
    id: 't', name: 't', width: rows[0].length, height: rows.length,
    legend: LEGEND, tiles: rows, startDropPoint: { x: 0, y: 0 }, enemies: [],
  });
}

const at = (x: number, y: number): Vec2 => ({ x, y });

describe('§7.1 視線對稱性', () => {
  const rows = [
    '#########',
    '#.......#',
    '#..#.+..#',
    '#.......#',
    '#.+###..#',
    '#.......#',
    '#..+.+..#',
    '#.......#',
    '#########',
  ];
  const map = mapOf(rows);

  it('任意兩格、任意姿勢組合下，A→B 與 B→A 的結果永遠一致', () => {
    const open: Vec2[] = [];
    for (let y = 1; y < rows.length - 1; y++) {
      for (let x = 1; x < rows[0].length - 1; x++) {
        if (rows[y][x] === '.') open.push(at(x, y));
      }
    }
    const stances: Stance[] = ['STAND', 'CROUCH'];
    let checked = 0;
    for (const a of open) {
      for (const b of open) {
        for (const sa of stances) {
          for (const sb of stances) {
            const ab = hasLineOfSight(map, a, sa, b, sb);
            const ba = hasLineOfSight(map, b, sb, a, sa);
            expect(
              ab,
              `(${a.x},${a.y})/${sa} vs (${b.x},${b.y})/${sb}`,
            ).toBe(ba);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('bresenham 含頭尾兩端', () => {
    const line = bresenham(at(1, 1), at(4, 1));
    expect(line[0]).toEqual(at(1, 1));
    expect(line[line.length - 1]).toEqual(at(4, 1));
    expect(line).toHaveLength(4);
  });
});

describe('§7.2 半身掩體規則', () => {
  //  y=0 #####
  //  y=1 #...#   ← 敵人 (3,1)
  //  y=2 #+++#   ← 半身掩體整排
  //  y=3 #...#   ← 玩家 (3,3)
  //  y=4 #####
  const map = mapOf(['#####', '#...#', '#+++#', '#...#', '#####']);
  const me = at(3, 3);
  const foe = at(3, 1);

  it('雙方都站著時，視線可以越過半身掩體', () => {
    expect(hasLineOfSight(map, me, 'STAND', foe, 'STAND')).toBe(true);
  });

  it('我緊鄰掩體並蹲下 → 雙向阻擋（我看不見他，他也看不見我）', () => {
    expect(hasLineOfSight(map, me, 'CROUCH', foe, 'STAND')).toBe(false);
    expect(hasLineOfSight(map, foe, 'STAND', me, 'CROUCH')).toBe(false);
  });

  it('對方緊鄰掩體並蹲下 → 同樣雙向阻擋', () => {
    expect(hasLineOfSight(map, me, 'STAND', foe, 'CROUCH')).toBe(false);
  });

  it('站起來後可以越過同一個掩體射擊同一個敵人', () => {
    expect(hasLineOfSight(map, me, 'CROUCH', foe, 'STAND')).toBe(false);
    expect(hasLineOfSight(map, me, 'STAND', foe, 'STAND')).toBe(true);
  });

  it('沒有緊鄰掩體時，蹲下不會擋住遠方的視線', () => {
    const wide = mapOf([
      '#######',
      '#.....#',
      '#..+..#',
      '#.....#',
      '#.....#',
      '#.....#',
      '#######',
    ]);
    // (3,5) 距離掩體 (3,2) 有 3 格，不算緊鄰
    expect(hasLineOfSight(wide, at(3, 5), 'CROUCH', at(3, 1), 'STAND')).toBe(true);
  });
});

describe('§7.2 WALL', () => {
  const map = mapOf(['#####', '#...#', '#.#.#', '#...#', '#####']);
  it('牆永遠阻擋視線，與姿勢無關', () => {
    expect(hasLineOfSight(map, at(2, 1), 'STAND', at(2, 3), 'STAND')).toBe(false);
    expect(hasLineOfSight(map, at(2, 1), 'CROUCH', at(2, 3), 'CROUCH')).toBe(false);
  });
  it('繞過牆的斜向視線成立', () => {
    expect(hasLineOfSight(map, at(1, 1), 'STAND', at(1, 3), 'STAND')).toBe(true);
  });
});
