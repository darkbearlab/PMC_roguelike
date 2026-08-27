/**
 * §3 背包與負重、§4 搜刮、§5 撤離。
 *
 * 三者是同一個決策：搜刮若沒有容量上限就不是決策（把地圖清空即可）；
 * 戰利品若沒有撤離管道就沒有意義。
 */
import { describe, it, expect } from 'vitest';
import { checkLegal } from '../src/core/commands';
import {
  countAmmo, effectiveMoveTime, maxWeight, moveCostForWeight, totalWeight,
} from '../src/core/inventory';
import { RULES } from '../src/core/content';
import { lootAt } from '../src/core/state';
import { advanceToPlayer, run, testState, player, unit, weaponIds } from './helpers';

const ROOM = [
  '##############',
  '#D...........#',
  '#............#',
  '#...........T#',
  '##############',
];

const bagOf = (s: ReturnType<typeof testState>) => player(s).backpack!;

describe('§3.2 負重分級', () => {
  it('分級表來自資料檔，上限 50', () => {
    expect(maxWeight()).toBe(50);
    expect(RULES.backpack.weightTiers.map((t) => [t.maxWeight, t.moveCost]))
      .toEqual([[20, 10], [35, 12], [50, 14]]);
  });

  it('初始負重落在第一級：一開始就站在門檻上，撿東西才會是決定', () => {
    const s = testState(ROOM);
    const w = totalWeight(bagOf(s));
    expect(w).toBe(18);                       // 24×0.5 + 2×3
    expect(moveCostForWeight(w)).toBe(10);
    expect(effectiveMoveTime(player(s))).toBe(10);
  });

  it('跨過門檻移動時間就變慢', () => {
    const s = testState(ROOM);
    expect(moveCostForWeight(20)).toBe(10);
    expect(moveCostForWeight(21)).toBe(12);
    expect(moveCostForWeight(35)).toBe(12);
    expect(moveCostForWeight(36)).toBe(14);
    const p = player(s);
    p.backpack!.items.push({
      id: 'X', kind: 'VALUABLE', defId: 'CORE', name: '動力核心', weight: 6, qty: 1,
    });
    expect(totalWeight(p.backpack)).toBe(24);
    expect(effectiveMoveTime(p)).toBe(12);
  });

  it('負重真的讓移動變慢，不只是顯示', () => {
    let s = testState(ROOM);
    player(s).backpack!.items.push({
      id: 'X', kind: 'VALUABLE', defId: 'CORE', name: '動力核心', weight: 6, qty: 1,
    });
    s = run(s, { type: 'MOVE', dir: 'E' });
    expect(player(s).nextActAt).toBe(12);
  });

  it('敵人沒有背包，移動時間仍是原型的值', () => {
    const s = testState(ROOM, [{ archetype: 'RUNNER', pos: { x: 5, y: 1 } }]);
    const e = unit(s, 'E01');
    expect(e.backpack).toBeNull();
    expect(effectiveMoveTime(e)).toBe(7);
  });
});

describe('§4.2 敵人死亡留下可搜刮的屍體', () => {
  const killRunner = () => {
    let s = testState(ROOM, [{ archetype: 'RUNNER', pos: { x: 5, y: 1 } }]);
    unit(s, 'E01').hp = 1;
    s = run(s, { type: 'FIRE', target: { x: 5, y: 1 } });
    return s;
  };

  it('敵人陣亡後原地出現殘骸', () => {
    const s = killRunner();
    const pile = lootAt(s, { x: 5, y: 1 });
    expect(pile).not.toBeNull();
    expect(pile!.kind).toBe('ENEMY_BODY');
  });

  it('殘骸不阻擋移動', () => {
    let s = killRunner();
    player(s).pos = { x: 4, y: 1 };
    s = advanceToPlayer(s);
    player(s).nextActAt = s.clock;
    expect(checkLegal(s, { type: 'MOVE', dir: 'E' }).ok).toBe(true);
  });

  it('掉落表照序抽值，必掉的一定在', () => {
    const s = killRunner();
    const pile = lootAt(s, { x: 5, y: 1 })!;
    expect(pile.items.some((it) => it.defId === 'AMMO_RIFLE')).toBe(true);
  });
});

describe('§3.3 / §4.4 己方屍體帶著全部家當與一份 DNA', () => {
  const die = () => {
    let s = testState(ROOM);
    player(s).hp = 3;
    return run(s, { type: 'FIRE', target: player(s).pos });
  };

  it('兩把槍、背包全部內容、一份 DNA 都留在原地', () => {
    const s = die();
    const pile = s.loot.find((c) => c.kind === 'PLAYER_BODY')!;
    expect(weaponIds(pile).sort()).toEqual(['ar9', 'rr4']);
    expect(pile.items.some((it) => it.defId === 'AMMO_RIFLE')).toBe(true);
    expect(pile.items.some((it) => it.defId === 'AMMO_ROCKET')).toBe(true);
    expect(pile.items.filter((it) => it.kind === 'DNA')).toHaveLength(1);
  });
});

describe('§4.3 搜刮操作', () => {
  const withCache = () => {
    const s = testState(ROOM);
    s.loot.push({
      id: 'LX', kind: 'CACHE', pos: { x: 2, y: 1 }, label: '測試箱',
      items: [
        { id: 'A', kind: 'AMMO', defId: 'AMMO_RIFLE', name: '步槍彈', weight: 0.5, qty: 8, ammoType: 'RIFLE' },
        { id: 'B', kind: 'VALUABLE', defId: 'CORE', name: '動力核心', weight: 6, qty: 1, value: 5 },
      ],
    });
    return s;
  };

  it('拿一項花 10 時間，東西進背包、離開那一堆', () => {
    let s = withCache();
    const before = countAmmo(bagOf(s), 'RIFLE');
    s = run(s, { type: 'PICKUP', lootId: 'LX', itemIndex: 0 });
    expect(countAmmo(bagOf(s), 'RIFLE')).toBe(before + 8);
    expect(lootAt(s, { x: 2, y: 1 })!.items).toHaveLength(1);
    expect(player(s).nextActAt).toBe(RULES.loot.takeTime);
  });

  it('相鄰格就可以搜刮，不必站上去', () => {
    const s = withCache();
    expect(player(s).pos).toEqual({ x: 1, y: 1 });
    expect(checkLegal(s, { type: 'PICKUP', lootId: 'LX', itemIndex: 0 }).ok).toBe(true);
  });

  it('太遠就不行', () => {
    const s = withCache();
    player(s).pos = { x: 9, y: 3 };
    expect(checkLegal(s, { type: 'PICKUP', lootId: 'LX', itemIndex: 0 }).ok).toBe(false);
  });

  it('全部拿走：拿得完就清空', () => {
    let s = withCache();
    s = run(s, { type: 'TAKE_ALL', lootId: 'LX' });
    expect(lootAt(s, { x: 2, y: 1 })!.items).toHaveLength(0);
    expect(player(s).nextActAt).toBe(RULES.loot.takeTime);
  });

  it('超重就撿不起來 —— 沒有負重代價的話，最優解就是把地圖搬空', () => {
    const s = withCache();
    // 先把背包塞到接近上限
    player(s).backpack!.items.push({
      id: 'Z', kind: 'VALUABLE', defId: 'CORE', name: '動力核心', weight: 6, qty: 5,
    });
    expect(totalWeight(bagOf(s))).toBe(48);
    const legal = checkLegal(s, { type: 'PICKUP', lootId: 'LX', itemIndex: 1 });   // 6 重
    expect(legal.ok).toBe(false);
    expect(legal.reason).toContain('背包裝不下');
  });

  it('全部拿走在超重時盡可能拿（可堆疊的拿得下的部分）', () => {
    let s = withCache();
    player(s).backpack!.items.push({
      id: 'Z', kind: 'VALUABLE', defId: 'CORE', name: '動力核心', weight: 6, qty: 5,
    });
    expect(maxWeight() - totalWeight(bagOf(s))).toBe(2);   // 只剩 2 重量
    s = run(s, { type: 'TAKE_ALL', lootId: 'LX' });
    // 動力核心（6）拿不動，步槍彈（每發 0.5）拿了 4 發
    const left = lootAt(s, { x: 2, y: 1 })!;
    expect(left.items.some((it) => it.defId === 'CORE')).toBe(true);
    expect(totalWeight(bagOf(s))).toBe(maxWeight());
  });
});

describe('§4.3 全部拿走的邊界', () => {
  it('一件都拿不動時，「全部拿走」是非法的', () => {
    const s = testState(ROOM);
    s.loot.push({
      id: 'LY', kind: 'CACHE', pos: { x: 2, y: 1 }, label: '重物箱',
      items: [{ id: 'H', kind: 'VALUABLE', defId: 'CORE', name: '動力核心', weight: 6, qty: 1 }],
    });
    player(s).backpack!.items.push({
      id: 'Z', kind: 'VALUABLE', defId: 'CORE', name: '動力核心', weight: 6, qty: 5,
    });
    expect(maxWeight() - totalWeight(bagOf(s))).toBe(2);
    const legal = checkLegal(s, { type: 'TAKE_ALL', lootId: 'LY' });
    expect(legal.ok).toBe(false);
    expect(legal.reason).toContain('一件都裝不下');
    // 這條是笨機器人抓到的：不擋的話「一直按」會變成無限迴圈，
    // 每按一次白花 10 時間卻什麼都沒拿到。
  });

  it('空了的那一堆也不能再拿', () => {
    const s = testState(ROOM);
    s.loot.push({ id: 'LZ', kind: 'CACHE', pos: { x: 2, y: 1 }, label: '空箱', items: [] });
    expect(checkLegal(s, { type: 'TAKE_ALL', lootId: 'LZ' }).ok).toBe(false);
  });
});
