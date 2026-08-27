/**
 * 單位紀律與決定論。
 *
 * v0.4 曾經用一份「放大前錄下的事件序列」來證明 ×10 是純資料改動，
 * v0.5 也還能靠關掉擲骰與浮動把它重現。到 v0.6 那份基準檔正式退役 ——
 * 這一版改了基礎命中、生命值、彈匣，還加了兩段式察覺（規則改動），
 * 沒有任何開關能把行為退回 v0.4，硬留著只會變成每一版都要重錄的變更偵測器。
 *
 * 取而代之的是**不會隨版本失效的性質**：
 *  1. 哪些量與生命值同單位、哪些不是（§1.2）—— 這條永遠成立
 *  2. 把浮動關掉之後，同一場任務必須逐事件完全重現（決定論）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runMission } from './bot';
import { RULES, WEAPONS, ACTORS } from '../src/core/content';
import { freezeCombat, thawCombat } from './helpers';

describe('關掉浮動之後，整場任務逐事件完全重現', () => {
  beforeAll(() => freezeCombat());
  afterAll(() => thawCombat());

  it('同一個種子跑兩次，事件序列與結局完全相同', () => {
    const a = runMission(20260826);
    const b = runMission(20260826);
    expect(a.events).toEqual(b.events);
    expect([a.result, a.elapsed, a.casualties, a.deployed])
      .toEqual([b.result, b.elapsed, b.casualties, b.deployed]);
    expect(a.events.length).toBeGreaterThan(50);   // 確認真的有跑起來
  });

  it('這一場真的有打到護甲，護甲路徑沒有被跳過', () => {
    const a = runMission(20260826);
    expect(a.events.filter((e) => e.kind === 'IMPACT' && e.blocked > 0).length)
      .toBeGreaterThan(0);
  });
});

describe('§1.2 不該放大的東西一律沒動', () => {
  it('射程、最佳射程、彈匣、AP 成本、噪音半徑、濺射半徑維持原值', () => {
    const ar9 = WEAPONS.find((w) => w.id === 'ar9')!;
    const rr4 = WEAPONS.find((w) => w.id === 'rr4')!;
    // 距離與次數不隨生命值縮放。開火／裝填在 v0.7 改為時間值（1 AP → 10）。
    expect([ar9.range, ar9.optimalRange, ar9.magazine, ar9.noiseRadius, ar9.splash])
      .toEqual([8, 5, 4, 6, 0]);
    expect([rr4.range, rr4.optimalRange, rr4.magazine, rr4.noiseRadius, rr4.splash])
      .toEqual([12, 8, 1, 14, 1]);
    // 時間成本維持原本 AP 的相對關係：重武器是輕武器的兩倍
    expect(rr4.fireTime).toBe(ar9.fireTime * 2);
    expect(rr4.reloadTime).toBe(ar9.reloadTime * 2);
  });

  it('視野維持原值（v0.7 把 AP 換成時間，視野不受影響）', () => {
    expect(ACTORS.SOLDIER.sightRange).toBe(12);
    expect(ACTORS.RUNNER.sightRange).toBe(10);
    expect(ACTORS.HULK.sightRange).toBe(8);
    expect(ACTORS.SHOOTER.sightRange).toBe(12);
    expect(ACTORS.RUNNER.attack!.range).toBe(1);
    expect(ACTORS.SHOOTER.attack!.range).toBe(7);
  });

  it('速度分級由時間成本表達，取代原本的 AP 分級', () => {
    // RUNNER 原本 3 AP（比玩家快 1.5 倍）、HULK 原本 1 AP（比玩家慢一半）
    expect(ACTORS.RUNNER.time.move).toBeLessThan(ACTORS.SOLDIER.time.move);
    expect(ACTORS.HULK.time.move).toBeGreaterThan(ACTORS.SOLDIER.time.move);
    expect(ACTORS.SHOOTER.time.move).toBe(ACTORS.SOLDIER.time.move);
  });

  it('搜索持續時間、名冊人數、時間成本表', () => {
    expect(RULES.ai.searchTime).toBe(30);          // v0.6 的 3 回合換算
    expect(RULES.roster.size).toBe(4);
    expect(RULES.time.move).toBe(10);              // 基準
    expect(RULES.time.interact).toBe(RULES.time.move);
    expect(RULES.time.swap).toEqual({ LIGHT: 10, HEAVY: 20 });
  });
});

describe('§1.3 保底傷害來自資料檔', () => {
  it('目前值為 10', () => {
    expect(RULES.combat.minDamage).toBe(10);
  });

  it('AR-9 打裝甲型的平均值剛好落在保底上：30 - 20 = 10', () => {
    const ar9 = WEAPONS.find((w) => w.id === 'ar9')!;
    expect(Math.max(RULES.combat.minDamage, ar9.damage - ACTORS.HULK.armor)).toBe(10);
  });

  it('保底相對於士兵血量仍然是「有感但不致命」的量級', () => {
    expect(RULES.combat.minDamage).toBeGreaterThan(1);
    const share = RULES.combat.minDamage / ACTORS.SOLDIER.hp;
    expect(share).toBeGreaterThan(0.05);   // 太小等於實質取消保底
    expect(share).toBeLessThan(0.25);      // 太大會讓輕武器打重甲也很有效
  });
});
