/**
 * 格間移動演出（v0.17）。**純呈現層** ——
 * 單位的邏輯位置在動作結算的當下就已經改變，這裡只是把畫面追上去。
 *
 * `GameState` 裡沒有、也不得有任何動畫進度：把動畫時間設為 0，
 * 或在播放中途打斷，最終狀態都必須完全相同。
 *
 * **最重要的一條是可被打斷**（§1.3）：
 *
 * > 動畫播放中收到新的輸入 → 當前這一步立刻瞬移完成 → 立即開始處理下一步。
 *
 * 這是移動動畫毀掉 roguelike 手感最常見的方式：玩家連按方向鍵趕路時，
 * 若每一步都要等動畫跑完，操作會變得非常黏。
 * **慢慢走的時候有演出，趕路的時候不擋人。**
 */
import type { Vec2 } from '../core/state';

interface Slide {
  from: Vec2;
  to: Vec2;
  start: number;
  dur: number;
}

/** 平滑一點的補間。線性看起來像貼圖在滑，這個有一點起步與收尾。 */
function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

export class MotionLayer {
  private slides = new Map<string, Slide>();

  /** 開始一段位移。`dur <= 0` 直接不記 —— 那等同瞬間完成。 */
  begin(unitId: string, from: Vec2, to: Vec2, dur: number, now: number): void {
    if (dur <= 0) { this.slides.delete(unitId); return; }
    if (from.x === to.x && from.y === to.y) return;
    this.slides.set(unitId, { from: { ...from }, to: { ...to }, start: now, dur });
  }

  /** 這個單位現在**畫**在哪（浮點格座標）。沒有動畫就是邏輯位置。 */
  posOf(unitId: string, logical: Vec2, now: number): Vec2 {
    const s = this.slides.get(unitId);
    if (!s) return logical;
    // 邏輯位置在動畫途中被別的東西改掉了（傳送、重生、外部指派）——
    // 那這段動畫就過期了，畫面直接跳到現在的位置。**邏輯永遠是對的那一邊。**
    if (s.to.x !== logical.x || s.to.y !== logical.y) {
      this.slides.delete(unitId);
      return logical;
    }
    const k = (now - s.start) / s.dur;
    if (k >= 1) { this.slides.delete(unitId); return logical; }
    if (k <= 0) return s.from;
    const e = ease(k);
    return {
      x: s.from.x + (s.to.x - s.from.x) * e,
      y: s.from.y + (s.to.y - s.from.y) * e,
    };
  }

  active(now: number): boolean {
    for (const [, s] of this.slides) if (now - s.start < s.dur) return true;
    return false;
  }

  /** §1.3：全部立刻瞬移完成。任何新輸入之前都要先呼叫。 */
  finishAll(): void {
    this.slides.clear();
  }

  forget(unitId: string): void {
    this.slides.delete(unitId);
  }

  clear(): void {
    this.slides.clear();
  }
}

/**
 * 攝影機平移（v0.17 §2）。
 *
 * **只在必要時才平移**：目標已經舒服地待在畫面內時，不平移也不等待。
 * 加上「平移期間目標暫停行動」之後，若每一隻敵人都要平移過去再等，
 * 十隻敵人的一輪會非常久 —— 而大部分情況下目標本來就在畫面內。
 */
export class PanLayer {
  private from: Vec2 | null = null;
  private to: Vec2 | null = null;
  private start = 0;
  private dur = 0;

  begin(from: Vec2, to: Vec2, dur: number, now: number): void {
    if (dur <= 0) { this.from = null; return; }
    this.from = { ...from };
    this.to = { ...to };
    this.start = now;
    this.dur = dur;
  }

  /** 平移中嗎？**平移期間目標不得開始它的動作**（§3.1）。 */
  active(now: number): boolean {
    return this.from !== null && now - this.start < this.dur;
  }

  /** 現在鏡頭該看哪裡。沒有在平移就回傳 fallback。 */
  focus(fallback: Vec2, now: number): Vec2 {
    if (!this.from || !this.to) return fallback;
    const k = (now - this.start) / this.dur;
    if (k >= 1) { this.from = null; return this.to; }
    const e = ease(Math.max(0, k));
    return {
      x: this.from.x + (this.to.x - this.from.x) * e,
      y: this.from.y + (this.to.y - this.from.y) * e,
    };
  }

  /** 跳過演出時直接到位。 */
  finish(): void {
    this.from = null;
  }
}
