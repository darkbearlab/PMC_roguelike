/**
 * §1.4：數值 ×10 必須是純資料改動。
 *
 * 基準檔 tests/fixtures/scale-baseline.json 是在放大**之前**，
 * 用同一支決定性機器人跑完整場任務錄下來的完整事件序列。
 * 放大之後重跑同一場，必須產生**完全等價**的事件序列 ——
 * 事件種類、順序、座標、單位全部一模一樣，只有生命值單位的數字剛好大十倍。
 *
 * 這條測試會抓到「有戰鬥數值寫死在程式碼裡而沒被抽出來」的情況：
 * 只要有一個沒跟著放大，事件序列就會分岔。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runMission, type MissionTrace } from './bot';
import { RULES, WEAPONS, ACTORS } from '../src/core/content';

const SCALE = 10;
const baseline = JSON.parse(
  readFileSync('tests/fixtures/scale-baseline.json', 'utf8'),
) as MissionTrace;

/** 生命值單位的欄位要 ×10，其餘一律原封不動。 */
function scaleEvent(e: Record<string, unknown>): Record<string, unknown> {
  if (e.kind !== 'IMPACT') return e;
  return { ...e, amount: (e.amount as number) * SCALE, blocked: (e.blocked as number) * SCALE };
}

describe('數值規模 ×10 是純資料改動', () => {
  const now = runMission(20260826);

  it('事件序列與放大前完全等價（只有生命值單位的數字大十倍）', () => {
    expect(now.events).toHaveLength(baseline.events.length);
    const expected = baseline.events.map((e) => scaleEvent(e as unknown as Record<string, unknown>));
    expect(now.events).toEqual(expected);
  });

  it('勝負、回合數、投入與陣亡人數完全相同', () => {
    expect(now.result).toBe(baseline.result);
    expect(now.turn).toBe(baseline.turn);
    expect(now.casualties).toBe(baseline.casualties);
    expect(now.deployed).toBe(baseline.deployed);
  });

  it('收場時所有單位的血量／護甲剛好是十倍', () => {
    expect(now.hp.map((u) => u.id)).toEqual(baseline.hp.map((u) => u.id));
    now.hp.forEach((u, i) => {
      const b = baseline.hp[i];
      expect(u.hp, u.id + ' hp').toBe(b.hp * SCALE);
      expect(u.maxHp, u.id + ' maxHp').toBe(b.maxHp * SCALE);
      expect(u.armor, u.id + ' armor').toBe(b.armor * SCALE);
    });
  });

  it('這一場真的有打到護甲（否則上面的等價測試會漏掉護甲路徑）', () => {
    const blocked = now.events.filter((e) => e.kind === 'IMPACT' && e.blocked > 0);
    expect(blocked.length).toBeGreaterThan(0);
  });
});

describe('§1.2 不該放大的東西一律沒動', () => {
  it('射程、最佳射程、彈匣、AP 成本、噪音半徑、濺射半徑維持原值', () => {
    const ar9 = WEAPONS.find((w) => w.id === 'ar9')!;
    const rr4 = WEAPONS.find((w) => w.id === 'rr4')!;
    expect([ar9.range, ar9.optimalRange, ar9.magazine, ar9.fireCost, ar9.reloadCost,
      ar9.noiseRadius, ar9.splash]).toEqual([8, 5, 6, 1, 1, 6, 0]);
    expect([rr4.range, rr4.optimalRange, rr4.magazine, rr4.fireCost, rr4.reloadCost,
      rr4.noiseRadius, rr4.splash]).toEqual([12, 8, 1, 2, 2, 14, 1]);
  });

  it('視野、AP 上限、每回合攻擊次數維持原值', () => {
    expect([ACTORS.SOLDIER.sightRange, ACTORS.SOLDIER.maxAp]).toEqual([12, 2]);
    expect([ACTORS.RUNNER.sightRange, ACTORS.RUNNER.maxAp]).toEqual([10, 3]);
    expect([ACTORS.HULK.sightRange, ACTORS.HULK.maxAp]).toEqual([8, 1]);
    expect([ACTORS.SHOOTER.sightRange, ACTORS.SHOOTER.maxAp, ACTORS.SHOOTER.attacksPerTurn])
      .toEqual([12, 2, 1]);
    expect(ACTORS.RUNNER.attack!.range).toBe(1);
    expect(ACTORS.SHOOTER.attack!.range).toBe(7);
  });

  it('searchTimer、名冊人數、AP 成本表維持原值', () => {
    expect(RULES.ai.searchTimer).toBe(3);
    expect(RULES.roster.size).toBe(4);
    expect(RULES.ap.moveCost).toBe(1);
    expect(RULES.ap.interactCost).toBe(1);
    expect(RULES.ap.swapCost).toEqual({ LIGHT: 1, HEAVY: 2 });
  });
});

describe('§1.3 保底傷害來自資料檔', () => {
  it('目前值為 10', () => {
    expect(RULES.combat.minDamage).toBe(10);
  });

  it('AR-9 打裝甲型剛好落在保底上：30 - 20 = 10', () => {
    const ar9 = WEAPONS.find((w) => w.id === 'ar9')!;
    expect(Math.max(RULES.combat.minDamage, ar9.damage - ACTORS.HULK.armor)).toBe(10);
  });

  it('放大後保底仍然有意義（若保底還是 1，等於實質取消）', () => {
    expect(RULES.combat.minDamage).toBeGreaterThan(1);
    expect(RULES.combat.minDamage / ACTORS.SOLDIER.hp).toBeCloseTo(0.1, 5);
  });
});
