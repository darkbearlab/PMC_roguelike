/**
 * §9.2 兩段式察覺，以及 v0.6 的致命度設定。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyCommand } from '../src/core/commands';
import { damageAfterArmor } from '../src/core/combat';
import { ACTORS, RULES, WEAPONS } from '../src/core/content';
import { run, testState, player, unit, freezeCombat, thawCombat } from './helpers';

const HALL = [
  '########################',
  '#D.....................#',
  '#......................#',
  '#.....................T#',
  '########################',
];

function runEnemyTurn(s0: ReturnType<typeof testState>) {
  let s = s0;
  let guard = 0;
  while (s.phase === 'ENEMY' && !s.pendingReinforcement && guard++ < 500) {
    s = run(s, { type: 'ENEMY_STEP' });
  }
  return s;
}

describe('§9.2 兩段式察覺', () => {
  beforeAll(() => freezeCombat());
  afterAll(() => thawCombat());

  it('從 IDLE 發現玩家的那一回合不得攻擊，但可以移動', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 10, y: 1 } }]);
    const from = { ...unit(s, 'E01').pos };
    s = run(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(unit(s, 'E01').justSpotted).toBe(true);
    expect(unit(s, 'E01').pos).not.toEqual(from);      // 有移動
    expect(player(s).hp).toBe(ACTORS.SOLDIER.hp);      // 沒有掉血
  });

  it('反應窗口只有一回合，下一回合就會開火', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 2, y: 1 } }]);
    player(s).maxHp = 500;
    player(s).hp = 500;
    s = runEnemyTurn(run(s, { type: 'WAIT' }));
    expect(player(s).hp).toBe(500);
    s = runEnemyTurn(run(s, { type: 'WAIT' }));
    expect(player(s).hp).toBeLessThan(500);
  });

  it('已在 SEARCH 的敵人重新取得視線可立即攻擊', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 2, y: 1 } }]);
    player(s).maxHp = 500;
    player(s).hp = 500;
    const e = unit(s, 'E01');
    e.aiState = 'SEARCH';
    e.searchTimer = 3;
    e.lastKnownTarget = { x: 1, y: 1 };
    s = runEnemyTurn(run(s, { type: 'WAIT' }));
    expect(unit(s, 'E01').justSpotted).toBe(false);
    expect(player(s).hp).toBeLessThan(500);
  });

  it('反覆進出視線無法製造無限安全的騷擾迴圈', () => {
    // §4.2 描述的漏洞是：開槍 → 警戒 → 退出視線 → 轉入搜索 → 再進入視線
    // → 又「剛發現」而無法攻擊。關鍵在於**搜索中**重新取得視線不得給窗口。
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 6, y: 1 } }]);
    player(s).maxHp = 500;
    player(s).hp = 500;

    // 走完整個搜索計時（3 回合）都不給窗口
    for (let t = RULES.ai.searchTimer; t > 0; t--) {
      const e = unit(s, 'E01');
      e.aiState = 'SEARCH';
      e.searchTimer = t;
      e.lastKnownTarget = { x: 20, y: 3 };     // 擺遠一點，免得這回合就走到而放棄
      e.pos = { x: 2, y: 1 };
      const before = player(s).hp;
      s = runEnemyTurn(run(s, { type: 'WAIT' }));
      expect(unit(s, 'E01').justSpotted, '搜索計時 ' + t).toBe(false);
      expect(player(s).hp, '搜索計時 ' + t).toBeLessThan(before);
    }
  });

  it('只有等敵人完全放棄（回到 IDLE）才會再有反應窗口，而那要等滿搜索計時', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 20, y: 3 } }]);
    const e = unit(s, 'E01');
    e.aiState = 'SEARCH';
    e.searchTimer = 1;
    e.lastKnownTarget = { x: 20, y: 3 };       // 已經站在最後已知位置 → 這回合放棄
    s = runEnemyTurn(run(s, { type: 'WAIT' }));
    expect(unit(s, 'E01').aiState).toBe('IDLE');

    // 回到 IDLE 之後再被發現，才又有一回合窗口 —— 代價是玩家得先躲滿整個搜索期
    unit(s, 'E01').pos = { x: 5, y: 1 };
    s = runEnemyTurn(run(s, { type: 'WAIT' }));
    expect(unit(s, 'E01').justSpotted).toBe(true);
  });

  it('justSpotted 是可序列化的規則狀態，不是動畫狀態', () => {
    const s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 3, y: 1 } }]);
    expect(JSON.parse(JSON.stringify(s)).units[1].justSpotted).toBe(false);
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
  it('AR-9 彈匣 4 發，兩回合打空', () => {
    const ar9 = WEAPONS.find((w) => w.id === 'ar9')!;
    expect(ar9.magazine).toBe(4);
    expect(ar9.magazine / (ACTORS.SOLDIER.maxAp / ar9.fireCost)).toBe(2);
  });

  it('裝填成本未改變', () => {
    expect(WEAPONS.find((w) => w.id === 'ar9')!.reloadCost).toBe(1);
    expect(WEAPONS.find((w) => w.id === 'rr4')!.reloadCost).toBe(2);
  });

  it('打空後開火非法，裝填後恢復', () => {
    let s = testState(HALL, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
    player(s).equipped!.ammo = 0;
    expect(applyCommand(s, { type: 'FIRE', target: { x: 4, y: 1 } }).state).toBe(s);
    s = run(s, { type: 'RELOAD' });
    expect(player(s).equipped!.ammo).toBe(4);
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
