/**
 * §3 背包與負重、§4 搜刮、§5 撤離。
 *
 * 三者是同一個決策：搜刮若沒有容量上限就不是決策（把地圖清空即可）；
 * 戰利品若沒有撤離管道就沒有意義。
 */
import { describe, it, expect } from 'vitest';
import { checkLegal } from '../src/core/commands';
import {
  carriedWeight, countAmmo, effectiveMoveTime, maxWeight, moveCostForWeight, nextTierAt, totalWeight,
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
  it('分級表來自資料檔，上限 100（v0.15 的換算尺）', () => {
    expect(maxWeight()).toBe(100);
    expect(RULES.backpack.weightTiers.map((t) => [t.maxWeight, t.moveCost]))
      .toEqual([[55, 10], [78, 12], [100, 14]]);
  });

  it('v0.15：手持與收納的武器也計入負重', () => {
    const s = testState(ROOM);
    const p = player(s);
    // 背包裡只有彈藥與封合劑
    expect(totalWeight(p.backpack)).toBeCloseTo(24 * 0.024 + 2 * 6 + 2, 3);
    // 身上的兩把槍（AR-9 7 + RR-4 20）以前是免費的，現在不是
    expect(carriedWeight(p)).toBeCloseTo(totalWeight(p.backpack) + 27, 3);
  });

  it('預設配裝落在基準速度內，且留有餘裕（§4.3）', () => {
    const s = testState(ROOM);
    const w = carriedWeight(player(s));
    expect(w).toBeCloseTo(41.576, 3);         // AR-9 7 + RR-4 20 + 5.56×24 + 84mm×2 + 封合劑 2
    expect(moveCostForWeight(w)).toBe(10);
    expect(effectiveMoveTime(player(s))).toBe(10);
    // 餘裕約 13：撿兩個動力核心（各 6）就會掉級
    expect(nextTierAt(w)).toBe(55);
    expect(moveCostForWeight(56)).toBe(12);
  });

  it('跨過門檻移動時間就變慢', () => {
    const s = testState(ROOM);
    expect(moveCostForWeight(55)).toBe(10);
    expect(moveCostForWeight(56)).toBe(12);
    expect(moveCostForWeight(78)).toBe(12);
    expect(moveCostForWeight(79)).toBe(14);
    const p = player(s);
    p.backpack!.items.push({
      id: 'X', kind: 'VALUABLE', defId: 'CORE', name: '動力核心', weight: 6, qty: 3,
    });
    expect(carriedWeight(p)).toBeCloseTo(59.576, 3);
    expect(effectiveMoveTime(p)).toBe(12);
  });

  it('負重真的讓移動變慢，不只是顯示', () => {
    let s = testState(ROOM);
    player(s).backpack!.items.push({
      id: 'X', kind: 'VALUABLE', defId: 'CORE', name: '動力核心', weight: 6, qty: 3,
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
    expect(pile.items.some((it) => it.defId === 'standard_5.56')).toBe(true);
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
    expect(pile.items.some((it) => it.defId === 'standard_5.56')).toBe(true);
    expect(pile.items.some((it) => it.defId === 'heat_84mm')).toBe(true);
    expect(pile.items.filter((it) => it.kind === 'DNA')).toHaveLength(1);
  });
});

describe('§4.3 搜刮操作', () => {
  const withCache = () => {
    const s = testState(ROOM);
    s.loot.push({
      id: 'LX', kind: 'CACHE', pos: { x: 2, y: 1 }, label: '測試箱',
      items: [
        { id: 'A', kind: 'AMMO', defId: 'standard_5.56', name: '5.56 步槍彈', weight: 0.024, qty: 8, ammoTypeId: 'standard_5.56' },
        { id: 'B', kind: 'VALUABLE', defId: 'CORE', name: '動力核心', weight: 6, qty: 1, value: 5 },
      ],
    });
    return s;
  };

  it('拿一項花 10 時間，東西進背包、離開那一堆', () => {
    let s = withCache();
    const before = countAmmo(bagOf(s), 'standard_5.56');
    s = run(s, { type: 'PICKUP', lootId: 'LX', itemIndex: 0 });
    expect(countAmmo(bagOf(s), 'standard_5.56')).toBe(before + 8);
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
    // 先把身上塞到接近上限（v0.15：上限算的是**身上全部**，含兩把槍的 27）
    player(s).backpack!.items.push({
      id: 'Z', kind: 'VALUABLE', defId: 'CORE', name: '動力核心', weight: 6, qty: 10,
    });
    expect(carriedWeight(player(s))).toBeCloseTo(101.576, 3);
    const legal = checkLegal(s, { type: 'PICKUP', lootId: 'LX', itemIndex: 1 });   // 6 重
    expect(legal.ok).toBe(false);
    expect(legal.reason).toContain('背包裝不下');
  });

  it('全部拿走在超重時盡可能拿（可堆疊的拿得下的部分）', () => {
    let s = withCache();
    const p = player(s);
    p.backpack!.items = p.backpack!.items.filter((i) => i.defId !== 'SEALANT');
    // 湊到只剩 2 的餘裕
    const room = maxWeight() - carriedWeight(p) - 2;
    p.backpack!.items.push({
      id: 'Z', kind: 'VALUABLE', defId: 'BALLAST', name: '壓艙物', weight: room, qty: 1,
    });
    expect(maxWeight() - carriedWeight(p)).toBeCloseTo(2, 3);
    s = run(s, { type: 'TAKE_ALL', lootId: 'LX' });
    // 動力核心（6）拿不動，5.56（每發 0.024）八發只有 0.192，全部拿得走
    const left = lootAt(s, { x: 2, y: 1 })!;
    expect(left.items.some((it) => it.defId === 'CORE')).toBe(true);
    expect(left.items.some((it) => it.defId === 'standard_5.56')).toBe(false);
  });
});

describe('§4.3 全部拿走的邊界', () => {
  it('一件都拿不動時，「全部拿走」是非法的', () => {
    const s = testState(ROOM);
    s.loot.push({
      id: 'LY', kind: 'CACHE', pos: { x: 2, y: 1 }, label: '重物箱',
      items: [{ id: 'H', kind: 'VALUABLE', defId: 'CORE', name: '動力核心', weight: 6, qty: 1 }],
    });
    const p = player(s);
    p.backpack!.items = p.backpack!.items.filter((i) => i.defId !== 'SEALANT');
    const room = maxWeight() - carriedWeight(p) - 2;
    p.backpack!.items.push({
      id: 'Z', kind: 'VALUABLE', defId: 'BALLAST', name: '壓艙物', weight: room, qty: 1,
    });
    expect(maxWeight() - carriedWeight(p)).toBeCloseTo(2, 3);
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
