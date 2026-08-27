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
/** 口令要讀得完，所以比傷害數字久一點。太久則會擠成一片。 */
const CALLOUT_MS = 1300;
/** 口令牌的高度，用來做同框避讓。 */
const CALLOUT_H = 21;
/**
 * 同時最多顯示幾張口令牌。
 *
 * 看不見的敵人是瞬間結算的（§12.12 不給延遲），所以一整批口令會在同一幀落地。
 * 不設上限的話它們會沿著方位排成一道字牆，等於什麼都讀不到。
 * 超過就丟最舊的 —— 最新的那幾句才是玩家現在需要反應的。
 */
const CALLOUT_MAX = 5;
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
  callout: '#ffd08a',
  calloutHeard: '#c8a4ff',
};

/** 方位的中文。口令聽得到但看不見時只報方向，不報座標（§12.18）。 */
const BEARING: Record<string, string> = {
  N: '北方', NE: '東北方', E: '東方', SE: '東南方',
  S: '南方', SW: '西南方', W: '西方', NW: '西北方',
};

interface FloatText {
  pos: Vec2; text: string; sub: string; colour: string; subColour: string;
  size: number; born: number; lane: number;
}
interface Tracer { from: Vec2; to: Vec2; hit: boolean; born: number }
interface Ring { pos: Vec2; radius: number; born: number }
interface Pip { pos: Vec2; text: string; colour: string; born: number }
/**
 * 敵人口令（§12.18）。事件只在玩家聽得到時才會發出（可聽範圍的判定在規則層），
 * 這裡只決定「看得見就畫在頭上、看不見就換算成方向」。
 */
interface Callout { unitId: string; pos: Vec2; text: string; born: number; lane: number }

/**
 * 量文字寬度。測試用的假 context 不見得實作 measureText，
 * 量不到就用「中文一字約等於字級」估 —— 避讓抓個大概就夠了。
 */
function textWidth(ctx: CanvasRenderingContext2D, text: string, size = 13): number {
  const m = ctx.measureText ? ctx.measureText(text) : undefined;
  return m && typeof m.width === 'number' ? m.width : text.length * size * 0.9;
}

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
  private callouts: Callout[] = [];
  /** unitId → 最近一次浮動數字的時間與階數，用來錯開連續受擊。 */
  private stack = new Map<string, { at: number; lane: number }>();

  clear(): void {
    this.floats = [];
    this.tracers = [];
    this.rings = [];
    this.pips = [];
    this.callouts = [];
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
            // IDLE -> ALERT 是「剛發現、這次不開火」，與重新鎖定要分得出來
            text: e.to === 'ALERT'
              ? (e.from === 'IDLE' ? '！剛發現你' : '！重新鎖定')
              : e.to === 'SEARCH' ? '？搜索' : '…失去目標',
            colour: e.to === 'ALERT'
              ? (e.from === 'IDLE' ? C.ammo : C.alert)
              : e.to === 'SEARCH' ? C.search : C.idle,
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
        case 'CALLOUT': {
          // 一個單位同時只留最新的一句：它喊第二句的時候，第一句已經過去了
          this.callouts = this.callouts.filter((c) => c.unitId !== e.unitId);
          this.callouts.push({
            unitId: e.unitId, pos: { ...e.pos }, text: e.text, born: now, lane: 0,
          });
          // 多個敵人同時喊話時要錯開，不可以疊成一團（§12.18）
          if (this.callouts.length > CALLOUT_MAX) {
            this.callouts.splice(0, this.callouts.length - CALLOUT_MAX);
          }
          break;
        }
      }
    }
  }

  /**
   * @param world 口令要知道兩件事：這個敵人現在看不看得見、以及玩家在哪。
   *              看得見 → 畫在它頭上；只聽得到 → 只報方位，不報座標（§12.18）。
   */
  draw(
    ctx: CanvasRenderingContext2D, cam: Camera, now: number,
    world?: { seesUnit(id: string): boolean; anchor: Vec2 | null },
  ): void {
    this.rings = this.rings.filter((r) => now - r.born < RING_MS);
    this.tracers = this.tracers.filter((t) => now - t.born < TRACER_MS);
    this.pips = this.pips.filter((p) => now - p.born < PIP_MS);
    this.floats = this.floats.filter((f) => now - f.born < FLOAT_MS);
    this.callouts = this.callouts.filter((c) => now - c.born < CALLOUT_MS);

    for (const r of this.rings) this.drawRing(ctx, cam, r, now);
    for (const t of this.tracers) this.drawTracer(ctx, cam, t, now);
    // 口令要**跨單位**避讓，而且要連 AI 狀態的小字一起讓（§12.18）。
    // 位置在畫的時候才知道（鏡頭會動），所以避讓也只能在這裡做。
    const taken: { x: number; y: number; w: number }[] = [];
    for (const p of this.pips) this.drawPip(ctx, cam, p, now, taken);
    for (const f of this.floats) this.drawFloat(ctx, cam, f, now);
    for (const c of this.callouts) this.drawCallout(ctx, cam, c, now, world, taken);
  }

  /**
   * 口令。看得見的敵人畫在頭上；只聽得到的畫在玩家周圍、指出方位。
   *
   * 第二種刻意不畫在敵人的實際位置上 —— 聽覺不該洩漏精確座標，
   * 否則 v0.8 的面向視野系統會被架空。
   */
  private drawCallout(
    ctx: CanvasRenderingContext2D, cam: Camera, c: Callout, now: number,
    world: { seesUnit(id: string): boolean; anchor: Vec2 | null } | undefined,
    taken: { x: number; y: number; w: number }[],
  ): void {
    const t = (now - c.born) / CALLOUT_MS;
    const seen = !world || world.seesUnit(c.unitId);
    let x: number;
    let y: number;
    let text = c.text;
    let ink = C.callout;

    if (seen) {
      const p = tileCenter(cam, c.pos);
      x = p.x;
      // 血條與狀態字在單位上方一點，口令再往上一層，避免咬在一起
      y = p.y - cam.tile * 1.05 - c.lane * CALLOUT_H - t * 6;
    } else {
      const a = world && world.anchor ? world.anchor : c.pos;
      const dx = c.pos.x - a.x;
      const dy = c.pos.y - a.y;
      const dir = bearing(dx, dy);
      text = BEARING[dir] + '：' + c.text;
      ink = C.calloutHeard;
      const p = tileCenter(cam, a);
      const r = cam.tile * (2.0 + c.lane * 0.7);
      const len = Math.hypot(dx, dy) || 1;
      x = p.x + (dx / len) * r;
      y = p.y + (dy / len) * r;
    }

    ctx.save();
    ctx.globalAlpha = t < 0.75 ? 1 : (1 - t) / 0.25;
    ctx.font = '700 13px ui-sans-serif, system-ui, "Noto Sans TC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 底襯 + 描邊：依資產調查的結論，無描邊的資訊元素在地形變亮時會直接消失
    const w = textWidth(ctx, text) + 12;

    // 跨單位避讓：跟已經畫好的牌重疊就往上疊一層，最多讓五層
    for (let i = 0; i < 5; i++) {
      const hit = taken.some((o) => Math.abs(o.y - y) < CALLOUT_H
        && Math.abs(o.x - x) < (o.w + w) / 2);
      if (!hit) break;
      y -= CALLOUT_H;
    }
    taken.push({ x, y, w });
    ctx.fillStyle = 'rgba(4,6,9,0.82)';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 10, w, 20, 6);
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(4,6,9,0.92)';
    ctx.lineWidth = 3;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = ink;
    ctx.fillText(text, x, y);
    ctx.restore();
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

  private drawPip(
    ctx: CanvasRenderingContext2D, cam: Camera, p: Pip, now: number,
    taken: { x: number; y: number; w: number }[],
  ): void {
    const t = (now - p.born) / PIP_MS;
    const c = tileCenter(cam, p.pos);
    const y = c.y - cam.tile * 0.72 - t * 6;
    ctx.save();
    ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    outlinedText(ctx, p.text, c.x, y, 13, p.colour);
    ctx.restore();
    ctx.save();
    ctx.font = '700 13px ui-sans-serif, system-ui, "Noto Sans TC", sans-serif';
    taken.push({ x: c.x, y, w: textWidth(ctx, p.text) + 8 });
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

/** 八方位。只用於口令的方向指示 —— 這不是距離比較，不受曼哈頓規則影響。 */
function bearing(dx: number, dy: number): string {
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  // 明顯偏一軸時就報正方位，免得一格之差就變成「東北」
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax > ay * 2) return sx > 0 ? 'E' : 'W';
  if (ay > ax * 2) return sy > 0 ? 'S' : 'N';
  if (sx === 0 && sy === 0) return 'N';
  if (sx === 0) return sy > 0 ? 'S' : 'N';
  if (sy === 0) return sx > 0 ? 'E' : 'W';
  return (sy > 0 ? 'S' : 'N') + (sx > 0 ? 'E' : 'W');
}
