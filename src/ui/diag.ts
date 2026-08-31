/**
 * 難度診斷 §3：人類遊玩的儀器化。
 *
 * 機器人量不到的那一半，只能靠實際遊玩收集 —— **它對資訊系統免疫**：
 * 迷霧、武器識別、口令，它讀的是規則狀態而不是畫面。
 * 因此可能出現「機器人數據沒有偏移，但人類難度大幅上升」。
 *
 * 三個數字：
 *
 *  1. 玩家承受的傷害中，來自「開火當下**尚未識別武器**」的敵人的比例
 *     → 高的話代表難度來自**不確定性**，不是殺傷力
 *  2. 玩家承受的傷害中，來自「開火前玩家**從未見過**」的敵人的比例
 *     → 高的話代表難度來自**迷霧與開場暴露**
 *  3. 玩家每次挨打的當下，對他有視線的敵人數量的平均值與最大值
 *     → 常態 ≥ 3 代表難度來自**地圖與敵人初始配置**，不是數值
 *
 * 硬性界線：
 *  - **純統計輸出，不影響任何規則。**
 *  - **不進 `GameState`** —— 它活在這裡，與渲染層同一層。
 *  - 可用資料檔開關關閉（`rules.diagnostics.playerMetrics`）。
 */
import type { CombatEvent } from '../core/events';
import type { GameState, Unit, Vec2 } from '../core/state';
import { isIdentified } from '../core/combat';
import { unitSees } from '../core/sight';
import { hasLineOfSight } from '../core/los';
import { manhattan, sameTile } from '../core/grid';
import { RULES } from '../core/content';

export interface PlayerMetrics {
  /** 玩家總共挨了多少傷害。 */
  totalDamage: number;
  /** 其中來自「開火當下武器尚未識別」的敵人的量。 */
  fromUnidentified: number;
  /** 其中來自「開火前從未見過」的敵人的量。 */
  fromUnseen: number;
  /** 每次挨打當下，對玩家有視線的敵人數量。 */
  threatCounts: number[];
  hits: number;
}

const blank = (): PlayerMetrics => ({
  totalDamage: 0, fromUnidentified: 0, fromUnseen: 0, threatCounts: [], hits: 0,
});

export function metricsEnabled(): boolean {
  return !!(RULES as unknown as { diagnostics?: { playerMetrics?: boolean } })
    .diagnostics?.playerMetrics;
}

/**
 * 一場任務的統計收集器。
 *
 * `observe()` 要在**每次 dispatch 之後**呼叫，帶著那一次的事件與**新的**狀態。
 * 「見過沒有」則靠 `seen()` 在每一幀（或每次刷新）累積 —— 那是視野的歷史，
 * 規則層沒有這個東西，也不該有。
 */
export class MetricsCollector {
  private m: PlayerMetrics = blank();

  /** 玩家曾經真的看見過的敵人 id。 */
  private everSeen = new Set<string>();

  reset(): void {
    this.m = blank();
    this.everSeen.clear();
  }

  /** 記下玩家現在看得見誰。每次刷新畫面時呼叫即可。 */
  markSeen(state: GameState, me: Unit | null): void {
    if (!me) return;
    for (const e of state.units) {
      if (e.faction !== 'ENEMY') continue;
      if (unitSees(state.map, me, e)) this.everSeen.add(e.id);
    }
  }

  /**
   * 消化一次指令的事件。
   *
   * `SHOT` 帶著射手的位置，緊接在它後面的 `IMPACT` 就是它造成的 ——
   * 事件是決定性且有序的（§8.6），所以這個關聯是可靠的。
   */
  observe(before: GameState, after: GameState, events: CombatEvent[]): void {
    let shooter: Unit | null = null;
    let shooterUnidentified = false;
    let shooterUnseen = false;
    for (const ev of events) {
      if (ev.kind === 'SHOT') {
        shooter = enemyAt(before, ev.from) ?? enemyAt(after, ev.from);
        // **開火當下**的識別狀態 —— 用開火前的狀態，開槍本身會讓它變成已識別
        shooterUnidentified = !!shooter && !isIdentified(before, shooter.equipped);
        shooterUnseen = !!shooter && !this.everSeen.has(shooter.id);
        continue;
      }
      if (ev.kind !== 'IMPACT') continue;
      const victim = after.units.find((u) => u.id === ev.unitId)
        ?? before.units.find((u) => u.id === ev.unitId);
      if (!victim || victim.faction !== 'PLAYER') continue;
      if (!shooter) continue;                    // 濺射到自己之類的，不算敵人打的
      this.m.totalDamage += ev.amount;
      this.m.hits += 1;
      if (shooterUnidentified) this.m.fromUnidentified += ev.amount;
      if (shooterUnseen) this.m.fromUnseen += ev.amount;
      this.m.threatCounts.push(threatsOn(before, victim.pos));
    }
  }

  snapshot(): PlayerMetrics {
    return { ...this.m, threatCounts: [...this.m.threatCounts] };
  }

  /** 給結算畫面與戰鬥紀錄的一行摘要。不需要美觀。 */
  report(): string {
    const m = this.m;
    if (m.totalDamage === 0) return '診斷：這一趟沒有挨過打';
    const p = (n: number): string => ((n / m.totalDamage) * 100).toFixed(0) + '%';
    const counts = m.threatCounts;
    const avg = counts.length
      ? (counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2) : '0';
    const max = counts.length ? Math.max(...counts) : 0;
    return '診斷｜挨打 ' + m.hits + ' 次共 ' + m.totalDamage + ' 點'
      + '　① 未識別武器 ' + p(m.fromUnidentified)
      + '　② 從未見過 ' + p(m.fromUnseen)
      + '　③ 同時瞄著我的敵人 平均 ' + avg + '／最多 ' + max;
  }
}

/** 這一格上的敵人。 */
function enemyAt(s: GameState, p: Vec2): Unit | null {
  return s.units.find((u) => u.faction === 'ENEMY' && sameTile(u.pos, p)) ?? null;
}

/**
 * 這一刻有幾個敵人對這一格有視線。
 *
 * 用的是「他看得到你」而不是「你看得到他」—— 這一項要量的是被瞄準的程度，
 * 不是玩家的資訊量。
 */
function threatsOn(s: GameState, p: Vec2): number {
  let n = 0;
  for (const e of s.units) {
    if (e.faction !== 'ENEMY') continue;
    if (manhattan(e.pos, p) > e.sightRange) continue;
    if (!hasLineOfSight(s.map, e.pos, e.stance, p, 'STAND')) continue;
    n++;
  }
  return n;
}
