import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { isPlayerTurn } from '../src/core/scheduler';
import { checkLegal } from '../src/core/commands';
import { damageAfterArmor, resetToHitPolicy } from '../src/core/combat';
import { commandTime } from '../src/core/commands';
import { weaponById } from '../src/core/content';
import { run, testState, player, unit, freezeCombat, thawCombat } from './helpers';

afterEach(() => resetToHitPolicy());

// 這一檔測的是機制不是浮動：把傷害／護甲的 spread 歸零、命中改必中，
// 斷言才寫得出確切數字。浮動本身另有專門的測試。
beforeAll(() => freezeCombat());
afterAll(() => thawCombat());

const ROOM = [
  '################',
  '#D.............#',
  '#..............#',
  '#..............#',
  '#.............T#',
  '################',
];

describe('§8.2 傷害與護甲', () => {
  it('實際傷害 = max(保底, damage - armor)，保底由資料檔決定', () => {
    expect(damageAfterArmor(30, 0)).toBe(30);
    expect(damageAfterArmor(30, 20)).toBe(10);   // AR-9 對 HULK：剛好落在保底上
    expect(damageAfterArmor(120, 20)).toBe(100); // RR-4 對 HULK
    expect(damageAfterArmor(10, 990)).toBe(10);  // 保底
  });

  it('輕武器對裝甲型每發只造成 10 點（保底），90 血要打 9 發', () => {
    let s = testState(ROOM, [{ archetype: 'HULK', pos: { x: 5, y: 1 } }]);
    expect(unit(s, 'E01').hp).toBe(90);
    s = run(s, { type: 'FIRE', target: { x: 5, y: 1 } });
    expect(unit(s, 'E01').hp).toBe(80);
  });

  it('重武器對裝甲型一發就打掉 100 點，90 血直接死', () => {
    let s = testState(ROOM, [{ archetype: 'HULK', pos: { x: 5, y: 1 } }]);
    s = run(s, { type: 'SWAP_WEAPON' });          // 換重武器 2 AP
    expect(player(s).equipped!.id).toBe('rr4');
    // 換重武器花 20 —— 等於走兩格的時間，敵人會先動
    expect(player(s).nextActAt).toBe(20);
    expect(isPlayerTurn(s)).toBe(false);                          // 換完就沒 AP 開火了
    let guard = 0;
    while (!isPlayerTurn(s) && guard++ < 200) s = run(s, { type: 'ADVANCE' });
    s = run(s, { type: 'FIRE', target: unit(s, 'E01').pos });
    expect(s.units.filter((u) => u.faction === 'ENEMY')).toHaveLength(0);
  });

  it('濺射對半徑內其他單位造成 floor(damage/2)，且會傷到自己人', () => {
    let s = testState(ROOM, [
      { archetype: 'RUNNER', pos: { x: 8, y: 1 } },
      { archetype: 'RUNNER', pos: { x: 9, y: 1 } },
    ]);
    const p = player(s);
    p.equipped = weaponById('rr4');
    p.stowed = null;
    p.pos = { x: 7, y: 1 };   // 與主目標相鄰 → 自己也在濺射半徑內
    p.hp = 100;
    s = run(s, { type: 'FIRE', target: { x: 8, y: 1 } });
    // 主目標 120 傷害 → 死；相鄰的 RUNNER 受 floor(120/2)=60 → 死；玩家自己也吃 60
    expect(s.units.filter((u) => u.faction === 'ENEMY')).toHaveLength(0);
    expect(player(s).hp).toBe(40);
  });
});

describe('§8.1 合法性檢查先於解算', () => {
  it('超出射程 → 非法', () => {
    const s = testState(ROOM, [{ archetype: 'RUNNER', pos: { x: 12, y: 1 } }]);
    const r = checkLegal(s, { type: 'FIRE', target: { x: 12, y: 1 } });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('射程');
  });

  it('沒有視線 → 非法', () => {
    const s = testState(
      ['########', '#D.#..T#', '#..#...#', '########'],
      [{ archetype: 'RUNNER', pos: { x: 5, y: 1 } }],
    );
    expect(checkLegal(s, { type: 'FIRE', target: { x: 5, y: 1 } }).ok).toBe(false);
  });

  it('彈藥耗盡 → 非法，且裝填後恢復', () => {
    let s = testState(ROOM, [{ archetype: 'HULK', pos: { x: 5, y: 1 } }]);
    player(s).equipped!.ammo = 0;
    expect(checkLegal(s, { type: 'FIRE', target: { x: 5, y: 1 } }).ok).toBe(false);
    s = run(s, { type: 'RELOAD' });
    expect(player(s).equipped!.ammo).toBe(4);
    expect(player(s).nextActAt).toBe(10);
  });
});

describe('§5 武器節奏（時間表達）', () => {
  it('輕武器開一槍花 10，等同走一格', () => {
    let s = testState(ROOM, [{ archetype: 'HULK', pos: { x: 5, y: 1 } }]);
    s = run(s, { type: 'FIRE', target: { x: 5, y: 1 } });
    expect(player(s).nextActAt).toBe(10);
    expect(player(s).equipped!.ammo).toBe(3);
  });

  it('重武器開一槍花 20 —— 是輕武器的兩倍，這就是它的代價', () => {
    const s = testState(ROOM, [{ archetype: 'HULK', pos: { x: 5, y: 1 } }]);
    const p = player(s);
    p.equipped = weaponById('rr4');
    const after = run(s, { type: 'FIRE', target: { x: 5, y: 1 } });
    expect(after.units[0].nextActAt).toBe(20);
  });

  it('開火的時間花費來自武器資料，不寫死', () => {
    const s = testState(ROOM, [{ archetype: 'HULK', pos: { x: 5, y: 1 } }]);
    expect(commandTime(s, { type: 'FIRE', target: { x: 5, y: 1 } }))
      .toBe(player(s).equipped!.fireTime);
  });
});

describe('§8.3 噪音', () => {
  it('開火讓噪音半徑內的 IDLE 敵人轉為 SEARCH 並記下開火點', () => {
    let s = testState(
      [
        '####################',
        '#D.................#',
        '#..................#',
        '#..................#',
        '#.................T#',
        '####################',
      ],
      [
        { archetype: 'HULK', pos: { x: 3, y: 1 } },   // 目標
        { archetype: 'RUNNER', pos: { x: 5, y: 3 } }, // 曼哈頓 6，剛好在噪音半徑內
        { archetype: 'RUNNER', pos: { x: 18, y: 3 } },// 曼哈頓 19，半徑外
      ],
    );
    s = run(s, { type: 'FIRE', target: { x: 3, y: 1 } });
    expect(unit(s, 'E02').aiState).toBe('SEARCH');
    expect(unit(s, 'E02').lastKnownTarget).toEqual({ x: 1, y: 1 });
    expect(unit(s, 'E03').aiState).toBe('IDLE');
  });
});
