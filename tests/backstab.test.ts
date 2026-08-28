/**
 * §8.8 背刺：攻擊一個對自己沒有視線的目標。
 * 規則對雙方生效，玩家只有在蹲下時才可能被背刺。
 */
import { describe, it, expect } from 'vitest';
import { hitBreakdown, toHitChance } from '../src/core/combat';
import { isBackstab } from '../src/core/sight';
import { RULES } from '../src/core/content';
import { advanceOnce, player, testState, testWeapon, unit } from './helpers';

const OPEN = [
  '################',
  '#..............#',
  '#..............#',
  '#....D.........#',
  '#..............#',
  '#.............T#',
  '################',
];

/** 目標 (10,3) 的北鄰 (10,2) 是牆 → 朝射手那一側有阻擋物 = 部分掩蔽。 */
const WITH_COVER = [
  '################',
  '#..............#',
  '#....D....#....#',
  '#..............#',
  '#..............#',
  '#.............T#',
  '################',
];

const at = (x: number, y: number) => ({ x, y });

const chance = (s: ReturnType<typeof testState>) =>
  toHitChance(player(s), unit(s, 'E01'), player(s).equipped!, s);

describe('§8.8 背刺成立的條件', () => {
  it('目標背對你 → 成立；轉過來面對你 → 不成立', () => {
    const s = testState(OPEN, [{ archetype: 'SHOOTER', pos: at(9, 3), facing: 'E' }]);
    expect(isBackstab(s.map, player(s), unit(s, 'E01'))).toBe(true);
    unit(s, 'E01').facing = 'W';
    expect(isBackstab(s.map, player(s), unit(s, 'E01'))).toBe(false);
  });

  it('命中率剛好加 0.30', () => {
    const s = testState(OPEN, [{ archetype: 'SHOOTER', pos: at(9, 3), facing: 'W' }]);
    const facing = chance(s);
    unit(s, 'E01').facing = 'E';
    const behind = chance(s);
    expect(behind - facing).toBeCloseTo(RULES.combat.backstab.bonus, 5);
    expect(RULES.combat.backstab.bonus).toBe(0.30);
  });

  it('掩蔽被無視：同一格目標，背對時掩蔽減免歸零', () => {
    const s = testState(WITH_COVER, [{ archetype: 'SHOOTER', pos: at(10, 3), facing: 'W' }]);
    const me = player(s);
    const foe = unit(s, 'E01');
    const facing = hitBreakdown(me, foe, me.equipped!, s);
    expect(facing.coverLevel).not.toBe('NONE');
    expect(facing.cover).toBeGreaterThan(0);

    foe.facing = 'E';
    const behind = hitBreakdown(me, foe, me.equipped!, s);
    expect(behind.backstab).toBe(true);
    expect(behind.cover).toBe(0);
    // 掩蔽格照樣回報：玩家要看得出「本來有掩蔽，是繞背才失效的」
    expect(behind.coverLevel).toBe(facing.coverLevel);
    expect(behind.coverTiles.length).toBe(facing.coverTiles.length);
  });

  it('看不見你的理由不只面向：被牆擋住、或根本在視野外也算', () => {
    // HULK 視野 8。放在 10 格外，即使面向你也「沒發現你」
    const s = testState(OPEN, [{ archetype: 'HULK', pos: at(14, 3), facing: 'W' }]);
    const foe = unit(s, 'E01');
    expect(foe.sightRange).toBe(8);
    expect(isBackstab(s.map, player(s), foe)).toBe(true);
  });
});

describe('§8.8 雙向生效', () => {
  it('玩家站立時不會被背刺 —— 站姿是全方位視野', () => {
    const s = testState(OPEN, [{ archetype: 'SHOOTER', pos: at(9, 3), facing: 'W' }]);
    const me = player(s);
    expect(me.stance).toBe('STAND');
    for (const f of ['N', 'E', 'S', 'W'] as const) {
      me.facing = f;
      expect(isBackstab(s.map, unit(s, 'E01'), me), f).toBe(false);
    }
  });

  it('玩家蹲下背對敵人時，敵人對玩家的命中率會多 0.30', () => {
    const s = testState(OPEN, [{ archetype: 'SHOOTER', pos: at(9, 3), facing: 'W' }]);
    const me = player(s);
    const foe = unit(s, 'E01');
    me.stance = 'CROUCH';

    me.facing = 'E';                       // 面對敵人
    const facing = toHitChance(foe, me, foe.equipped!, s);
    expect(isBackstab(s.map, foe, me)).toBe(false);

    me.facing = 'W';                       // 背對敵人
    expect(isBackstab(s.map, foe, me)).toBe(true);
    const behind = toHitChance(foe, me, foe.equipped!, s);
    expect(behind - facing).toBeCloseTo(RULES.combat.backstab.bonus, 5);
  });
});

describe('§8.8 與 AI 的互動', () => {
  /** 敵人先看到玩家、轉入警戒。回傳已經 ALERT 的狀態。 */
  const alerted = () => {
    let s = testState(OPEN, [{ archetype: 'SHOOTER', pos: at(9, 3), facing: 'W' }]);
    player(s).equipped = testWeapon('ar9');
    s.units[0].nextActAt = 1000;          // 把行動權讓給敵人
    s = advanceOnce(s);
    expect(unit(s, 'E01').aiState).toBe('ALERT');
    return s;
  };

  it('警戒中的敵人每次行動都盯著你，所以打不出背刺', () => {
    let s = alerted();
    expect(isBackstab(s.map, player(s), unit(s, 'E01'))).toBe(false);
    // 小幅移動（仍在它的半平面內）：它會跟著轉，背刺仍然不成立
    s.units[0].pos = at(5, 2);
    s.units[0].nextActAt = 2000;
    s = advanceOnce(s);
    expect(unit(s, 'E01').aiState).toBe('ALERT');
    expect(isBackstab(s.map, player(s), unit(s, 'E01'))).toBe(false);
  });

  it('繞到它背後它就跟丟了 —— 這是面向真正的產出', () => {
    let s = alerted();
    // 瞬移到它的另一側：它這一次行動用的還是舊面向，於是失去目標
    s.units[0].pos = at(13, 3);
    s.units[0].nextActAt = 2000;
    s = advanceOnce(s);
    expect(unit(s, 'E01').aiState).toBe('SEARCH');
  });

  it('v0.10：IDLE 敵人會警戒巡視，背刺不再是白拿的（§9.3）', () => {
    let s = testState(OPEN, [{ archetype: 'SHOOTER', pos: at(9, 3), facing: 'E' }]);
    // 一開始它背對玩家，背刺成立
    expect(isBackstab(s.map, player(s), unit(s, 'E01'))).toBe(true);

    s.units[0].nextActAt = 1000;
    const facings = new Set<string>([unit(s, 'E01').facing]);
    let spotted = false;
    for (let i = 0; i < 8 && !spotted; i++) {
      s = advanceOnce(s);
      s.units[0].nextActAt += 1000;
      facings.add(unit(s, 'E01').facing);
      spotted = unit(s, 'E01').aiState !== 'IDLE';
    }
    expect(facings.size).toBeGreaterThan(1);   // 盲區會轉
    expect(spotted).toBe(true);                // 轉到某一刻就看到你了
  });

  it('關掉 tacticalBehaviour 就回到 v0.9：IDLE 完全不轉向', () => {
    const before = RULES.ai.tacticalBehaviour;
    try {
      RULES.ai.tacticalBehaviour = false;
      let s = testState(OPEN, [{ archetype: 'SHOOTER', pos: at(9, 3), facing: 'E' }]);
      s.units[0].nextActAt = 1000;
      for (let i = 0; i < 5; i++) { s = advanceOnce(s); s.units[0].nextActAt += 1000; }
      expect(unit(s, 'E01').aiState).toBe('IDLE');
      expect(unit(s, 'E01').facing).toBe('E');
      expect(isBackstab(s.map, player(s), unit(s, 'E01'))).toBe(true);
    } finally {
      RULES.ai.tacticalBehaviour = before;
    }
  });
});
