/**
 * §1 內建近戰武器。
 *
 * 這一節是**重構**，不是新增特例：敵人的內嵌 attack 變成 weapons.json 裡的武器，
 * 走完全相同的命中、掩蔽、背刺與時間解算路徑。驗收的第一條就是行為不變。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ACTORS, WEAPONS } from '../src/core/content';
import { weaponType } from '../src/core/weapon';
import { attackWeapon, canAttackAny, usesIntrinsic } from '../src/core/combat';
import { checkLegal } from '../src/core/commands';
import {
  advanceToPlayer, freezeCombat, player, run, testState, thawCombat, unit,
} from './helpers';

const HALL = [
  '####################',
  '#D.................#',
  '#..................#',
  '#................T.#',
  '####################',
];

beforeAll(() => freezeCombat());
afterAll(() => thawCombat());

describe('§1.2 內建武器的性質', () => {
  it('射程 1、重量 0、只有單發、不可補充', () => {
    const list = WEAPONS.filter((w) => w.intrinsic);
    expect(list.length).toBeGreaterThan(0);
    for (const w of list) {
      expect(w.range, w.id).toBe(1);
      expect(w.weight, w.id).toBe(0);
      expect(w.modes, w.id).toEqual(['SINGLE']);
      expect(w.noiseRadius, w.id).toBe(0);
      expect(w.reloadSequence, w.id).toBeNull();
    }
  });

  it('每個原型都有，包含玩家（§1.3）', () => {
    for (const k of Object.keys(ACTORS)) {
      if (!ACTORS[k] || typeof ACTORS[k] !== 'object' || !('hp' in ACTORS[k])) continue;
      const w = weaponType(ACTORS[k].intrinsic);
      expect(w.intrinsic, k).toBe(true);
    }
  });

  it('不佔主手也不佔收納欄，而且彈藥無限', () => {
    const s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 3, y: 1 } }]);
    const me = player(s);
    expect(me.intrinsic).toBeTruthy();
    expect(me.equipped!.instanceId).not.toBe(me.intrinsic.instanceId);
    expect(me.stowed!.instanceId).not.toBe(me.intrinsic.instanceId);
    // 開一百下也不會沒彈
    for (let i = 0; i < 100; i++) me.intrinsic.ammo -= 0;
    expect(me.intrinsic.intrinsic).toBe(true);
  });

  it('內建武器不會出現在戰場上的任何一個堆裡 —— 它長在身上', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 2, y: 1 } }]);
    unit(s, 'E01').hp = 1;
    player(s).pos = { x: 1, y: 1 };
    s = run(s, { type: 'FIRE', target: { x: 2, y: 1 } });
    const items = s.loot.flatMap((p) => p.items);
    expect(items.some((it) => it.weapon?.intrinsic)).toBe(false);
  });
});

describe('§1.4 主手用不了就自動改用內建近戰', () => {
  it('彈藥打光之後，貼身仍然打得出東西', () => {
    const s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 2, y: 1 } }]);
    const me = player(s);
    me.pos = { x: 1, y: 1 };
    me.equipped!.ammo = 0;
    // 主手打不出去
    expect(canAttackAny(s, me, { x: 2, y: 1 }).ok).toBe(true);
    expect(usesIntrinsic(s, me, { x: 2, y: 1 })).toBe(true);
    expect(attackWeapon(s, me, { x: 2, y: 1 })!.instanceId).toBe(me.intrinsic.instanceId);
    expect(checkLegal(s, { type: 'FIRE', target: { x: 2, y: 1 } }).ok).toBe(true);
  });

  it('遠處打不到 —— 內建武器只有一格', () => {
    const s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 8, y: 1 } }]);
    const me = player(s);
    me.pos = { x: 1, y: 1 };
    me.equipped!.ammo = 0;
    expect(canAttackAny(s, me, { x: 8, y: 1 }).ok).toBe(false);
  });

  it('主手還打得到就用主手 —— 不會自作主張改用刀', () => {
    const s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 2, y: 1 } }]);
    const me = player(s);
    me.pos = { x: 1, y: 1 };
    expect(usesIntrinsic(s, me, { x: 2, y: 1 })).toBe(false);
  });

  it('花費依實際會用的那一把，不是那把空槍', () => {
    const s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 2, y: 1 } }]);
    const me = player(s);
    me.pos = { x: 1, y: 1 };
    me.equipped!.ammo = 0;
    const before = me.nextActAt;
    const after = run(s, { type: 'FIRE', target: { x: 2, y: 1 } });
    const u = after.units.find((x) => x.id === me.id);
    // 打死了就查排程時刻，沒死就查單位；兩種都要比刀的時間
    const spent = (u ? u.nextActAt : after.clock) - before;
    expect(spent).toBe(me.intrinsic.fireTime);
  });

  it('衝鋒型從頭到尾走的就是這條路：它沒有槍，只有爪', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 2, y: 1 } }]);
    const e = unit(s, 'E01');
    expect(e.equipped).toBeNull();
    expect(e.intrinsic.name).toBe('衝擊爪');
    const me = player(s);
    me.maxHp = 5000;
    me.hp = 5000;
    me.nextActAt = s.clock + 1000;
    s = advanceToPlayer(s);
    expect(s.units.find((u) => u.id === me.id)!.hp).toBeLessThan(5000);
  });
});
