/**
 * 戰場回饋層（§12.9）。
 *
 * 消費規則層吐出的 CombatEvent，把「剛剛發生了什麼」畫在戰場上，
 * 讓玩家不必打開日誌就能完整理解戰況。
 *
 * 界線：
 *  - 動畫的時間軸與播放狀態全部活在這裡，**不進 GameState**。
 *  - 純 Canvas，不新增任何 DOM。
 *  - **不阻塞輸入**：這一層只是每幀被畫出來，不會延後回合推進，
 *    玩家在動畫播放中照樣可以操作。
 */
import type { CombatEvent } from '../core/events';
import type { Vec2 } from '../core/state';
import type { Camera } from './camera';
import { tileCenter } from './camera';

const FLOAT_MS = 750;    // §2.4 要求 0.6～0.8 秒
const TRACER_MS = 190;
const RING_MS = 520;
const PIP_MS = 700;
/** 同一目標在這段時間內再受擊，數字往上錯開一階，避免疊成一團。 */
const STACK_WINDOW_MS = 700;
/** 每一階錯開的高度，必須大於「主數字 + 副標」的總高。 */
const LANE_STEP_Y = 32;
const LANE_STEP_X = 12;
const LANE_WRAP = 4;

const C = {
  hit: '#ffe6a3',
  blocked: '#9db4c8',
  blockedNote: '#7fd0e8',
  miss: '#c3ccd5',
  kill: '#ff6a58',
  ammo: '#ffb648',
  alert: '#ff5b4a',
  search: '#ffb648',
  idle: '#9db4c8',
  objective: '#5cf0cd',
  tracerHit: '#ffd08a',
  tracerMiss: '#8e9aa6',
  ring: '#b48ce0',
};

interface FloatText {
  pos: Vec2; text: string; sub: string; colour: string; subColour: string;
  size: number; born: number; lane: number;
}
interface Tracer { from: Vec2; to: Vec2; hit: boolean; born: number }
interface Ring { pos: Vec2; radius: number; born: number }
interface Pip { pos: Vec2; text: string; colour: string; born: number }

/** 決定性的小偏移（未命中的彈著點用）。不能用 Math.random —— 全專案禁止。 */
function jitter(p: Vec2, seed: number): Vec2 {
  const h = Math.abs(Math.imul((p.x * 73856093) ^ (p.y * 19349663) ^ seed, 0x45d9f3b)) % 360;
  const a = (h / 360) * Math.PI * 2;
  return { x: Math.cos(a) * 0.42, y: Math.sin(a) * 0.42 };
}

export class EffectLayer {
  private floats: FloatText[] = [];
  private tracers: Tracer[] = [];
  private rings: Ring[] = [];
  private pips: Pip[] = [];
  /** unitId → 最近一次浮動數字的時間與階數，用來錯開連續受擊。 */
  private stack = new Map<string, { at: number; lane: number }>();

  clear(): void {
    this.floats = [];
    this.tracers = [];
    this.rings = [];
    this.pips = [];
    this.stack.clear();
  }

  /**
   * 同一目標連續受擊時的錯開階數。
   * 每階要拉開「一整個浮動字（含副標）的高度」，否則兩行字會咬在一起。
   * 超過 LANE_WRAP 階就繞回來，免得飛出畫面。
   */
  private lane(id: string, now: number): number {
    const prev = this.stack.get(id);
    const next = prev && now - prev.at < STACK_WINDOW_MS ? prev.lane + 1 : 0;
    this.stack.set(id, { at: now, lane: next });
    return next % LANE_WRAP;
  }

  private float(
    pos: Vec2, text: string, colour: string, now: number,
    opts: { sub?: string; subColour?: string; size?: number; id?: string } = {},
  ): void {
    this.floats.push({
      pos: { ...pos },
      text,
      sub: opts.sub ?? '',
      colour,
      subColour: opts.subColour ?? C.blockedNote,
      size: opts.size ?? 17,
      born: now,
      lane: opts.id ? this.lane(opts.id, now) : 0,
    });
  }

  push(events: readonly CombatEvent[], now: number): void {
    for (const e of events) {
      switch (e.kind) {
        case 'SHOT': {
          const j = jitter(e.to, 1);
          const to = e.hit ? e.to : { x: e.to.x + j.x, y: e.to.y + j.y };
          this.tracers.push({ from: { ...e.from }, to, hit: e.hit, born: now });
          break;
        }
        case 'IMPACT': {
          // 「打中但被擋下大半」必須和「沒打中」、和「有效命中」三者可分辨（§2.3）
          const heavy = e.blocked >= e.amount;
          this.float(e.pos, String(e.amount),
            e.lethal ? C.kill : heavy ? C.blocked : C.hit, now, {
              sub: e.blocked > 0 ? '擋下 ' + e.blocked : '',
              subColour: heavy ? C.blockedNote : C.blocked,
              size: e.lethal ? 22 : heavy ? 15 : 19,
              id: e.unitId,
            });
          break;
        }
        case 'MISS':
          this.float(e.impactPos, '未命中', C.miss, now, { size: 14 });
          break;
        case 'KILL':
          this.float(e.pos, e.faction === 'ENEMY' ? '擊殺' : '陣亡', C.kill, now,
            { size: 16, id: e.unitId });
          break;
        case 'NOISE':
          this.rings.push({ pos: { ...e.pos }, radius: e.radius, born: now });
          break;
        case 'AI_STATE':
          this.pips.push({
            pos: { ...e.pos },
            text: e.to === 'ALERT' ? '！發現' : e.to === 'SEARCH' ? '？搜索' : '…失去目標',
            colour: e.to === 'ALERT' ? C.alert : e.to === 'SEARCH' ? C.search : C.idle,
            born: now,
          });
          break;
        case 'AMMO_OUT':
          this.float(e.pos, '空倉', C.ammo, now, { size: 15, id: e.unitId });
          break;
        case 'RELOAD':
          this.float(e.pos, '裝填', C.ammo, now, { size: 14, id: e.unitId });
          break;
        case 'OBJECTIVE':
          this.float(e.pos, e.text, C.objective, now, { size: 16 });
          break;
        case 'DEPLOY':
          this.float(e.pos, '空投落地', C.objective, now, { size: 15 });
          break;
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, now: number): void {
    this.rings = this.rings.filter((r) => now - r.born < RING_MS);
    this.tracers = this.tracers.filter((t) => now - t.born < TRACER_MS);
    this.pips = this.pips.filter((p) => now - p.born < PIP_MS);
    this.floats = this.floats.filter((f) => now - f.born < FLOAT_MS);

    for (const r of this.rings) this.drawRing(ctx, cam, r, now);
    for (const t of this.tracers) this.drawTracer(ctx, cam, t, now);
    for (const p of this.pips) this.drawPip(ctx, cam, p, now);
    for (const f of this.floats) this.drawFloat(ctx, cam, f, now);
  }

  /** 噪音半徑是曼哈頓距離，所以畫成菱形而不是圓 —— 順便讓玩家看懂距離規則。 */
  private drawRing(ctx: CanvasRenderingContext2D, cam: Camera, r: Ring, now: number): void {
    const t = (now - r.born) / RING_MS;
    const c = tileCenter(cam, r.pos);
    const reach = r.radius * cam.tile * (0.25 + 0.75 * t);
    ctx.save();
    ctx.globalAlpha = 0.5 * (1 - t);
    ctx.strokeStyle = C.ring;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y - reach);
    ctx.lineTo(c.x + reach, c.y);
    ctx.lineTo(c.x, c.y + reach);
    ctx.lineTo(c.x - reach, c.y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  private drawTracer(ctx: CanvasRenderingContext2D, cam: Camera, tr: Tracer, now: number): void {
    const t = (now - tr.born) / TRACER_MS;
    const a = tileCenter(cam, tr.from);
    const b = tileCenter(cam, tr.to);
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = tr.hit ? C.tracerHit : C.tracerMiss;
    ctx.lineWidth = tr.hit ? 3 : 2;
    ctx.lineCap = 'round';
    if (!tr.hit) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  private drawPip(ctx: CanvasRenderingContext2D, cam: Camera, p: Pip, now: number): void {
    const t = (now - p.born) / PIP_MS;
    const c = tileCenter(cam, p.pos);
    ctx.save();
    ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    outlinedText(ctx, p.text, c.x, c.y - cam.tile * 0.72 - t * 6, 13, p.colour);
    ctx.restore();
  }

  private drawFloat(ctx: CanvasRenderingContext2D, cam: Camera, f: FloatText, now: number): void {
    const t = (now - f.born) / FLOAT_MS;
    const c = tileCenter(cam, f.pos);
    const rise = 10 + t * 24 + f.lane * LANE_STEP_Y;
    const x = c.x + f.lane * LANE_STEP_X;
    const y = c.y - cam.tile * 0.4 - rise;
    ctx.save();
    ctx.globalAlpha = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
    outlinedText(ctx, f.text, x, y, f.size, f.colour);
    if (f.sub) outlinedText(ctx, f.sub, x, y + f.size * 0.92, Math.max(11, f.size * 0.66), f.subColour);
    ctx.restore();
  }
}

/** 深色描邊 + 亮色字，確保在淺色地形上也讀得清（§2.4）。 */
function outlinedText(
  ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, colour: string,
): void {
  ctx.font = '700 ' + size + 'px ui-sans-serif, system-ui, "Noto Sans TC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(4, 6, 9, 0.92)';
  ctx.lineWidth = Math.max(3, size * 0.28);
  ctx.strokeText(text, x, y);
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
}
