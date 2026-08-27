/**
 * 回饋層的繪製路徑（§2.3 / §2.4）。
 * 用一個假的 2D context 記錄實際畫出來的文字與顏色，
 * 確認三種結果真的長得不一樣、未命中真的會播、數字真的會錯開。
 */
import { describe, it, expect } from 'vitest';
import { EffectLayer } from '../src/render/effects';
import type { CombatEvent } from '../src/core/events';
import type { Camera } from '../src/render/camera';

const CAM: Camera = { tile: 32, ox: 0, oy: 0 };

interface Drawn { text: string; x: number; y: number; colour: string; size: number }

function fakeCtx(): { ctx: CanvasRenderingContext2D; drawn: Drawn[]; strokes: number } {
  const drawn: Drawn[] = [];
  const box = { fillStyle: '', font: '', strokes: 0 };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_t, k) => {
      if (k === 'fillStyle') return box.fillStyle;
      if (k === 'font') return box.font;
      if (k === 'canvas') return { width: 400, height: 800 };
      if (k === 'getTransform') return () => ({ a: 1 });
      if (k === 'fillText') {
        return (text: string, x: number, y: number) => {
          const m = /(\d+(?:\.\d+)?)px/.exec(box.font);
          drawn.push({ text, x, y, colour: box.fillStyle, size: m ? Number(m[1]) : 0 });
        };
      }
      if (k === 'stroke' || k === 'strokeText') return () => { box.strokes++; };
      return () => undefined;
    },
    set: (_t, k, v) => {
      if (k === 'fillStyle') box.fillStyle = String(v);
      if (k === 'font') box.font = String(v);
      return true;
    },
  };
  const ctx = new Proxy({}, handler) as unknown as CanvasRenderingContext2D;
  return { ctx, drawn, get strokes() { return box.strokes; } } as never;
}

function render(events: CombatEvent[], atMs = 0, drawAtMs = 20): Drawn[] {
  const layer = new EffectLayer();
  const { ctx, drawn } = fakeCtx();
  layer.push(events, atMs);
  layer.draw(ctx, CAM, drawAtMs);
  return drawn;
}

const impact = (amount: number, blocked: number, lethal = false): CombatEvent =>
  ({ kind: 'IMPACT', unitId: 'E01', pos: { x: 2, y: 2 }, amount, blocked, lethal });

describe('§2.3 三種結果在畫面上長得不一樣', () => {
  const effective = render([impact(30, 0)]);
  const blocked = render([impact(10, 20)]);
  const missed = render([
    { kind: 'MISS', pos: { x: 2, y: 2 }, impactPos: { x: 2, y: 2 } },
  ]);

  it('有效命中：只畫一個亮色傷害數字，沒有「擋下」', () => {
    expect(effective.map((d) => d.text)).toEqual(['30']);
  });

  it('被擋下：主數字之外多一行「擋下 N」', () => {
    expect(blocked.map((d) => d.text)).toEqual(['10', '擋下 20']);
  });

  it('未命中：畫的是文字而不是數字', () => {
    expect(missed.map((d) => d.text)).toEqual(['未命中']);
  });

  it('三者的顏色互不相同 —— 這是「該換武器了」能不能被讀懂的關鍵', () => {
    const colours = [effective[0].colour, blocked[0].colour, missed[0].colour];
    expect(new Set(colours).size).toBe(3);
  });

  it('被擋下的主數字比有效命中小，視覺份量就分得出來', () => {
    expect(blocked[0].size).toBeLessThan(effective[0].size);
  });

  it('擊殺比一般命中更大、顏色也不同', () => {
    const kill = render([impact(40, 0, true)]);
    expect(kill[0].size).toBeGreaterThan(effective[0].size);
    expect(kill[0].colour).not.toBe(effective[0].colour);
  });
});

describe('§2.4 表現要求', () => {
  it('同一目標連續受擊時，數字錯開不重疊', () => {
    const layer = new EffectLayer();
    const { ctx, drawn } = fakeCtx();
    layer.push([impact(30, 0)], 0);
    layer.push([impact(30, 0)], 100);
    layer.push([impact(30, 0)], 200);
    layer.draw(ctx, CAM, 210);
    const ys = drawn.filter((d) => d.text === '30').map((d) => d.y);
    expect(ys).toHaveLength(3);
    // 兩兩間距都要大於一個字的高度，否則會咬在一起
    const sorted = [...ys].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThan(20);
    }
  });

  it('浮動數字約 0.75 秒後消失，不會殘留', () => {
    const layer = new EffectLayer();
    layer.push([impact(30, 0)], 0);
    const a = fakeCtx();
    layer.draw(a.ctx, CAM, 700);
    expect(a.drawn.length).toBeGreaterThan(0);
    const b = fakeCtx();
    layer.draw(b.ctx, CAM, 800);
    expect(b.drawn).toHaveLength(0);
  });

  it('每個浮動文字都有描邊，淺色地形上也讀得到', () => {
    const layer = new EffectLayer();
    const f = fakeCtx();
    layer.push([impact(10, 20)], 0);
    layer.draw(f.ctx, CAM, 10);
    expect(f.strokes).toBeGreaterThanOrEqual(2);   // 主數字與副標各一次
  });

  it('其餘事件都有畫面表現', () => {
    expect(render([{ kind: 'AMMO_OUT', unitId: 'P', pos: { x: 1, y: 1 } }])
      .map((d) => d.text)).toEqual(['空倉']);
    // IDLE -> ALERT 是「剛發現、這回合不開火」，SEARCH -> ALERT 是重新鎖定，
    // 兩者的文字與顏色都要分得出來（§9.2 的反應窗口靠這個被看見）
    const spotted = render([
      { kind: 'AI_STATE', unitId: 'E', pos: { x: 1, y: 1 }, from: 'IDLE', to: 'ALERT' }]);
    const relock = render([
      { kind: 'AI_STATE', unitId: 'E', pos: { x: 1, y: 1 }, from: 'SEARCH', to: 'ALERT' }]);
    expect(spotted.map((d) => d.text)).toEqual(['！剛發現你']);
    expect(relock.map((d) => d.text)).toEqual(['！重新鎖定']);
    expect(spotted[0].colour).not.toBe(relock[0].colour);
    expect(render([{ kind: 'KILL', unitId: 'E', pos: { x: 1, y: 1 }, faction: 'ENEMY', name: 'x' }])
      .map((d) => d.text)).toEqual(['擊殺']);
    // 彈道與噪音是線條不是文字，確認它們有被 stroke 出來
    const f = fakeCtx();
    const layer = new EffectLayer();
    layer.push([
      { kind: 'SHOT', from: { x: 0, y: 0 }, to: { x: 3, y: 0 }, hit: true, weaponId: 'ar9', splash: 0 },
      { kind: 'NOISE', pos: { x: 1, y: 1 }, radius: 6 },
    ], 0);
    layer.draw(f.ctx, CAM, 10);
    expect(f.strokes).toBeGreaterThanOrEqual(2);
  });
});
