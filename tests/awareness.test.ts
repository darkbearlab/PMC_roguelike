/**
 * §9.2 兩段式察覺，以及 v0.6 的致命度設定。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyCommand } from '../src/core/commands';
import { damageAfterArmor } from '../src/core/combat';
import { ACTORS, RULES, WEAPONS } from '../src/core/content';
import { advanceOnce, run, testState, player, unit, freezeCombat, thawCombat } from './helpers';

const HALL = [
  '########################',
  '#D.....................#',
  '#......................#',
  '#.....................T#',
  '########################',
];

describe('§9.2 階段轉換耗時（取代兩段式察覺）', () => {
  beforeAll(() => freezeCombat());
  afterAll(() => thawCombat());

  it('IDLE 敵人取得視線時，那一次行動是狀態轉換而非攻擊', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 2, y: 1 } }]);   // 一開始就相鄰
    player(s).hp = 500;
    player(s).maxHp = 500;
    s = run(s, { type: 'WAIT' });          // 玩家先動，推到 10
    expect(unit(s, 'E01').aiState).toBe('IDLE');

    s = advanceOnce(s);                    // 敵人的第一次行動：轉換
    expect(unit(s, 'E01').aiState).toBe('ALERT');
    expect(unit(s, 'E01').transitioning).toBe(true);
    expect(player(s).hp).toBe(500);        // 轉換那一下不做別的事
    // 轉換花掉了該原型的轉換時間
    expect(unit(s, 'E01').nextActAt).toBe(ACTORS.RUNNER.time.transition);
  });

  it('轉換完成後的下一次行動才會攻擊', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 2, y: 1 } }]);
    player(s).hp = 500;
    player(s).maxHp = 500;
    s = run(s, { type: 'WAIT' });
    s = advanceOnce(s);                    // 轉換
    expect(player(s).hp).toBe(500);
    s = advanceOnce(s);                    // 下一次輪到它 → 開打
    expect(player(s).hp).toBeLessThan(500);
    expect(unit(s, 'E01').transitioning).toBe(false);
  });

  it('轉換時間越長，玩家的反應窗口越大 —— HULK 給的窗口比 RUNNER 大', () => {
    const window = (arch: string): number => {
      let s = testState(HALL, [{ archetype: arch, pos: { x: 2, y: 1 } }]);
      player(s).hp = 500;
      player(s).maxHp = 500;
      s = run(s, { type: 'WAIT' });
      s = advanceOnce(s);                  // 轉換
      return unit(s, 'E01').nextActAt;     // 它下次能動的時刻
    };
    expect(window('HULK')).toBeGreaterThan(window('RUNNER'));
    expect(window('SHOOTER')).toBeGreaterThan(window('RUNNER'));
  });

  it('SEARCH 敵人重新取得視線：轉換花 0，同一次行動就能開火', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 2, y: 1 } }]);
    player(s).maxHp = 500;
    player(s).hp = 500;
    const e = unit(s, 'E01');
    e.aiState = 'SEARCH';
    e.searchTimer = RULES.ai.searchTime;
    e.lastKnownTarget = { x: 1, y: 1 };
    s = run(s, { type: 'WAIT' });
    s = advanceOnce(s);                    // 只推一格
    expect(unit(s, 'E01').aiState).toBe('ALERT');
    expect(unit(s, 'E01').transitioning).toBe(false);   // 沒有反應窗口
    expect(player(s).hp).toBeLessThan(500);             // 當場就開打
  });

  it('反覆進出視線無法製造無限安全的騷擾迴圈', () => {
    // 漏洞的形狀是：開槍 → 警戒 → 退出視線 → 轉入搜索 → 再進入視線
    // → 敵人又「剛發現」而無法攻擊。關鍵在於**搜索中**重新取得視線的轉換要花 0。
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 2, y: 1 } }]);
    player(s).maxHp = 2000;
    player(s).hp = 2000;

    // 走完整個搜索期，每一次重新取得視線都不給窗口
    for (let t = RULES.ai.searchTime; t > 0; t -= 10) {
      const e = unit(s, 'E01');
      e.aiState = 'SEARCH';
      e.searchTimer = t;
      e.lastKnownTarget = { x: 20, y: 3 };
      e.pos = { x: 2, y: 1 };
      e.nextActAt = s.clock;
      player(s).nextActAt = s.clock + 1000;   // 讓排程器一定選到敵人
      const before = player(s).hp;
      s = advanceOnce(s);
      expect(unit(s, 'E01').transitioning, '搜索剩餘 ' + t).toBe(false);
      expect(player(s).hp, '搜索剩餘 ' + t).toBeLessThan(before);
    }
  });

  it('只有等敵人完全放棄（回到 IDLE）才會再有反應窗口，而那要等滿搜索時間', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 20, y: 3 } }]);
    const e = unit(s, 'E01');
    e.aiState = 'SEARCH';
    e.searchTimer = 1;
    e.lastKnownTarget = { x: 20, y: 3 };     // 已經站在最後已知位置 → 這一次就放棄
    player(s).nextActAt = s.clock + 1000;    // 讓排程器一定選到敵人
    s = advanceOnce(s);
    expect(unit(s, 'E01').aiState).toBe('IDLE');

    // 回到 IDLE 之後再被發現，才又有窗口 —— 代價是玩家得先躲滿整個搜索期
    const e2 = unit(s, 'E01');
    e2.pos = { x: 3, y: 1 };
    e2.nextActAt = s.clock;
    player(s).nextActAt = s.clock + 1000;
    s = advanceOnce(s);
    expect(unit(s, 'E01').aiState).toBe('ALERT');
    expect(unit(s, 'E01').transitioning).toBe(true);
  });

});

describe('§2 v0.6 的致命度', () => {
  const ar9 = WEAPONS.find((w) => w.id === 'ar9')!;
  const rr4 = WEAPONS.find((w) => w.id === 'rr4')!;

  it('衝鋒型 25 血：步槍命中一發必死（最小傷害也夠）', () => {
    const minDmg = damageAfterArmor(ar9.damage - ar9.damageSpread, ACTORS.RUNNER.armor, ar9.penetration);
    expect(minDmg).toBeGreaterThanOrEqual(ACTORS.RUNNER.hp);
  });

  it('射手型 30 血：步槍命中一發通常即死', () => {
    const minDmg = damageAfterArmor(ar9.damage - ar9.damageSpread, ACTORS.SHOOTER.armor, ar9.penetration);
    expect(minDmg).toBeGreaterThanOrEqual(ACTORS.SHOOTER.hp - 5);
  });

  it('裝甲型 90 血 vs 步槍：每發 10–23，要打上約 5～9 發', () => {
    const lo = damageAfterArmor(ar9.damage - ar9.damageSpread, ACTORS.HULK.armor + ACTORS.HULK.armorSpread, 0);
    const hi = damageAfterArmor(ar9.damage + ar9.damageSpread, ACTORS.HULK.armor - ACTORS.HULK.armorSpread, 0);
    expect(lo).toBe(RULES.combat.minDamage);
    expect(Math.ceil(ACTORS.HULK.hp / hi)).toBeGreaterThanOrEqual(4);
    expect(Math.ceil(ACTORS.HULK.hp / lo)).toBeGreaterThanOrEqual(9);
  });

  it('裝甲型 90 血 vs 重武器：一發命中「通常」即死，但不保證', () => {
    let kills = 0;
    let total = 0;
    for (let d = rr4.damage - rr4.damageSpread; d <= rr4.damage + rr4.damageSpread; d++) {
      for (let a = ACTORS.HULK.armor - ACTORS.HULK.armorSpread;
        a <= ACTORS.HULK.armor + ACTORS.HULK.armorSpread; a++) {
        total++;
        if (damageAfterArmor(d, a, rr4.penetration) >= ACTORS.HULK.hp) kills++;
      }
    }
    const p = kills / total;
    expect(p).toBeGreaterThan(0.5);     // 「通常」
    expect(p).toBeLessThan(1);          // 但賭得有風險
  });

  it('士兵 60 血 vs 步槍：兩發「多半」會死，但最低值的兩發活得下來', () => {
    const lo = damageAfterArmor(ar9.damage - ar9.damageSpread, 0, 0);
    const hi = damageAfterArmor(ar9.damage + ar9.damageSpread, 0, 0);
    expect(lo * 2).toBeLessThan(ACTORS.SOLDIER.hp);        // 50 < 60，兩發不保證
    expect(hi * 2).toBeGreaterThanOrEqual(ACTORS.SOLDIER.hp);
    expect(lo * 3).toBeGreaterThanOrEqual(ACTORS.SOLDIER.hp);  // 三發必死
  });
});

describe('§3 彈匣節奏', () => {
  it('AR-9 彈匣 8 發（v0.9 被射擊模式逼出來的調整），開一槍仍等同走一格', () => {
    const ar9 = WEAPONS.find((w) => w.id === 'ar9')!;
    expect(ar9.magazine).toBe(8);
    expect(ar9.fireTime).toBe(ACTORS.SOLDIER.time.move);   // 開一槍 = 走一格
    // 連發一次吃 3 發：彈匣仍為 4 的話會有一半的行動花在裝填上
    expect(ar9.magazine).toBeGreaterThanOrEqual(RULES.fireModes.AUTO.shots * 2);
  });

  it('裝填的相對成本未改變：AR-9 一個單位、RR-4 兩個單位', () => {
    const move = ACTORS.SOLDIER.time.move;
    expect(WEAPONS.find((w) => w.id === 'ar9')!.reloadTime).toBe(move);
    expect(WEAPONS.find((w) => w.id === 'rr4')!.reloadTime).toBe(move * 2);
  });

  it('打空後開火非法，裝填後恢復', () => {
    let s = testState(HALL, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
    player(s).equipped!.ammo = 0;
    expect(applyCommand(s, { type: 'FIRE', target: { x: 4, y: 1 } }).state).toBe(s);
    s = run(s, { type: 'RELOAD' });
    expect(player(s).equipped!.ammo).toBe(8);
  });
});

describe('§1 命中率：位置成為交火的主題', () => {
  it('基礎命中下修後，良好掩蔽把命中率壓到下限', () => {
    const ar9 = WEAPONS.find((w) => w.id === 'ar9')!;
    expect(ar9.accuracy).toBe(0.55);
    // 0.55 − 0.40（良好掩蔽）= 0.15，剛好是下限
    expect(ar9.accuracy - RULES.combat.cover.good).toBeCloseTo(RULES.combat.hitFloor, 5);
  });

  it('敵人有自己的基礎命中，近戰明顯高於遠程', () => {
    expect(ACTORS.RUNNER.attack!.accuracy).toBe(0.7);
    expect(ACTORS.HULK.attack!.accuracy).toBe(0.7);
    expect(ACTORS.SHOOTER.attack!.accuracy).toBe(0.5);
    expect(ACTORS.RUNNER.attack!.accuracy).toBeGreaterThan(ACTORS.SHOOTER.attack!.accuracy);
  });
});
