/**
 * §3 敵人的彈藥管理與 §4 威脅的可讀性。
 *
 * 原則是**笨，但可預測**：玩家可以數敵人開了幾槍、知道換彈的窗口什麼時候到、
 * 在那個空檔衝上去。這與 v0.10 的固定巡視周期是同一條原則 ——
 * **可預測的行為是一道解得開的題，隨機的行為只是雜訊。**
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RULES, CALLOUTS } from '../src/core/content';
import { calloutText } from '../src/core/ai';
import { isIdentified, markIdentified, outOfAmmo } from '../src/core/combat';
import { weightsFor } from '../src/core/tactics';
import { makeWeapon } from '../src/core/weapon';
import {
  advanceOnce, armEnemy, freezeCombat, player, testState, thawCombat, unit,
} from './helpers';

const HALL = [
  '##########################',
  '#D.......................#',
  '#........................#',
  '#.......................T#',
  '##########################',
];

beforeAll(() => freezeCombat());
afterAll(() => thawCombat());

/** 讓敵人進入 ALERT 並開始行動。 */
const alerted = (arch = 'SHOOTER', at = { x: 6, y: 1 }) => {
  let s = testState(HALL, [{ archetype: arch, pos: at }]);
  player(s).maxHp = 9999;
  player(s).hp = 9999;
  s.units[0].nextActAt = 1e6;
  s = advanceOnce(s);
  s.units[0].nextActAt = 1e6;
  return s;
};

describe('§3.2 只在彈匣打空後才裝填，絕不提前', () => {
  it('剩一發也照打，不會先補彈', () => {
    let s = alerted();
    const e = unit(s, 'E01');
    e.equipped!.ammo = 1;
    e.reserveAmmo = 99;
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);
    expect(unit(s, 'E01').equipped!.ammo, '那一發打掉了，沒有先裝填').toBe(0);
  });

  it('打空之後才裝填，而且走與玩家相同的時間成本', () => {
    let s = alerted();
    const e = unit(s, 'E01');
    e.equipped!.ammo = 0;
    e.reserveAmmo = 99;
    e.declared = null;
    const at = e.nextActAt;
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);
    const after = unit(s, 'E01');
    expect(after.equipped!.ammo).toBeGreaterThan(0);
    expect(after.nextActAt - at).toBe(after.equipped!.reloadTime);
    expect(after.reserveAmmo).toBeLessThan(99);
  });

  it('增量裝填的槍一次只補一發 —— 泵動霰彈槍的敵人也是這個手感', () => {
    let s = alerted();
    armEnemy(s, 'E01', 'sg12p');
    const e = unit(s, 'E01');
    e.equipped!.ammo = 0;
    e.reserveAmmo = 99;
    e.declared = null;
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);
    expect(unit(s, 'E01').equipped!.ammo).toBe(1);
  });

  it('系列動作的槍要走完整套才補得到彈（RR-4 的兩步）', () => {
    let s = alerted();
    armEnemy(s, 'E01', 'rr4');
    const e = unit(s, 'E01');
    e.equipped!.ammo = 0;
    e.reserveAmmo = 99;
    e.declared = null;
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);
    expect(unit(s, 'E01').equipped!.ammo, '第一步只是開栓退殼').toBe(0);
    expect(unit(s, 'E01').equipped!.reloadProgress).toBe(1);
    unit(s, 'E01').declared = null;
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);
    expect(unit(s, 'E01').equipped!.ammo, '走完才有彈').toBeGreaterThan(0);
  });
});

describe('§3.4 彈盡的敵人要改變行為', () => {
  it('彈匣與備彈都空了才算「打光」', () => {
    const s = alerted();
    const e = unit(s, 'E01');
    e.equipped!.ammo = 0;
    e.reserveAmmo = 5;
    expect(outOfAmmo(e), '還有備彈就不算').toBe(false);
    e.reserveAmmo = 0;
    expect(outOfAmmo(e)).toBe(true);
  });

  it('**從來沒有槍的原型不算彈盡** —— 他們本來就是那樣打的', () => {
    const s = alerted('RUNNER', { x: 3, y: 1 });
    const e = unit(s, 'E01');
    expect(e.equipped).toBeNull();
    expect(outOfAmmo(e), '衝鋒型不是彈盡，他只是沒有槍').toBe(false);
    // 權重維持衝鋒型自己的，沒有被 desperate 蓋掉
    expect(weightsFor(e)).not.toBe(RULES.ai.desperate);
  });

  it('打光之後落點權重切成積極型 —— 不會躲在掩體後不動', () => {
    const s = alerted();
    const e = unit(s, 'E01');
    const normal = weightsFor(e);
    e.equipped!.ammo = 0;
    e.reserveAmmo = 0;
    const desperate = weightsFor(e);
    expect(desperate).toEqual(RULES.ai.desperate);
    expect(desperate.approach).toBeGreaterThan(normal.approach);
    expect(desperate.crouchInCover).toBe(false);
  });

  it('打光之後改用內建近戰，貼身還是打得到人', () => {
    let s = alerted('SHOOTER', { x: 2, y: 1 });
    const e = unit(s, 'E01');
    e.equipped!.ammo = 0;
    e.reserveAmmo = 0;
    e.declared = null;
    player(s).pos = { x: 1, y: 1 };
    const hp = player(s).hp;
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);
    expect(player(s).hp).toBeLessThan(hp);
  });

  it('§3.3 「沒子彈了」是一個真的戰術訊號，而且只喊一次', () => {
    expect(CALLOUTS.NO_AMMO).toBeTruthy();
    expect(CALLOUTS.RELOAD).toBeTruthy();
    let s = alerted('SHOOTER', { x: 3, y: 1 });
    const e = unit(s, 'E01');
    e.equipped!.ammo = 0;
    e.reserveAmmo = 0;
    e.declared = null;
    expect(e.announcedDry).toBe(false);
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);
    expect(unit(s, 'E01').announcedDry).toBe(true);
  });
});

describe('§4.2 武器識別的三個層級', () => {
  it('預設看不出來拿的是什麼', () => {
    const s = alerted('SHOOTER', { x: 12, y: 1 });
    expect(isIdentified(s, unit(s, 'E01').equipped)).toBe(false);
  });

  it('開過火就認得出來 —— 開槍是最誠實的自我介紹', () => {
    let s = alerted('SHOOTER', { x: 6, y: 1 });
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);
    expect(isIdentified(s, unit(s, 'E01').equipped)).toBe(true);
  });

  it('走得夠近也認得出來', () => {
    const s = alerted('SHOOTER', { x: 14, y: 1 });
    const me = player(s);
    expect(isIdentified(s, unit(s, 'E01').equipped)).toBe(false);
    me.pos = { x: 14 - RULES.ai.identifyRange, y: 1 };
    markIdentified(s, me);
    expect(isIdentified(s, unit(s, 'E01').equipped)).toBe(true);
  });

  it('conspicuous 的武器藏不住，從任何距離都看得到', () => {
    const s = alerted('SHOOTER', { x: 20, y: 1 });
    armEnemy(s, 'E01', 'rr4');
    expect(unit(s, 'E01').equipped!.conspicuous).toBe(true);
    expect(isIdentified(s, unit(s, 'E01').equipped)).toBe(true);
    const q = makeWeapon(s, 'ar9');
    expect(q.conspicuous).toBeFalsy();
    expect(isIdentified(s, q)).toBe(false);
  });

  it('§4.3 未識別的武器不得被口令洩漏', () => {
    expect(calloutText({ kind: 'FIRE' })).toBe(CALLOUTS.FIRE);
    expect(calloutText({ kind: 'SETUP' })).toBe(CALLOUTS.SETUP);
    expect(calloutText({ kind: 'FIRE' }, 'RR-4')).toContain('RR-4');
    expect(calloutText({ kind: 'SETUP' }, 'RR-4')).toContain('RR-4');
  });
});

describe('§4.4 重武器的架設預警', () => {
  const setUpScene = () => {
    const s = alerted('SHOOTER', { x: 8, y: 1 });
    armEnemy(s, 'E01', 'rr4');
    const e = unit(s, 'E01');
    e.declared = null;
    e.setUp = false;
    return s;
  };

  it('顯眼武器開火前要先架設，架設本身是一個完整動作', () => {
    let s = setUpScene();
    const at = unit(s, 'E01').nextActAt;
    const hp = player(s).hp;
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);
    expect(unit(s, 'E01').setUp, '這一下只是把砲架起來').toBe(true);
    expect(player(s).hp, '還沒有任何東西射出去').toBe(hp);
    expect(unit(s, 'E01').nextActAt - at).toBe(RULES.time.weaponSetup);
  });

  it('架好之後的下一個動作才是那一發，打完就要重架', () => {
    let s = setUpScene();
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);                    // 架設
    const hp = player(s).hp;
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);                    // 射擊
    expect(player(s).hp).toBeLessThan(hp);
    expect(unit(s, 'E01').setUp).toBe(false);
  });

  it('**斷掉射線之後那一砲整個作廢**', () => {
    let s = setUpScene();
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);                    // 架設
    expect(unit(s, 'E01').setUp).toBe(true);
    const hp = player(s).hp;
    player(s).pos = { x: 24, y: 3 };       // 拉開到射程外
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);
    expect(player(s).hp, '沒挨打').toBe(hp);
    expect(unit(s, 'E01').setUp, '架好的砲白架了').toBe(false);
  });

  it('換了位置也要重架', () => {
    const s = setUpScene();
    const e = unit(s, 'E01');
    e.setUp = true;
    e.declared = { kind: 'ADVANCE', to: { x: 7, y: 1 } };
    e.nextActAt = s.clock;
    const next = advanceOnce(s);
    expect(unit(next, 'E01').setUp).toBe(false);
  });

  it('玩家的 RR-4 不受影響 —— 一個動作開火（這個不對稱是刻意的）', () => {
    const s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 10, y: 1 } }]);
    const me = player(s);
    me.equipped = makeWeapon(s, 'rr4');
    expect(me.equipped.conspicuous).toBe(true);
    expect(me.setUp).toBe(false);
  });
});
