/**
 * Canvas 2D 繪製。唯讀 GameState —— 這一層絕不改寫狀態。
 */
import type { Corpse, GameState, Unit, Vec2 } from '../core/state';
import { activePlayerUnit, corpseAt } from '../core/state';
import { inBounds, tileAt } from '../core/map';
import { sameTile } from '../core/grid';
import type { Camera } from './camera';
import { screenToTile, tileCenter, tileToScreen } from './camera';
import type { Vision } from './vision';
import { isVisible } from './vision';

const C = {
  bg: '#0b0e12',
  floor: '#232b33',
  floorGrid: '#2e3740',
  wallFace: '#4a5765',
  wallTop: '#69798b',
  coverBase: '#3a5c45',
  coverTop: '#84d69b',
  drop: '#1c4570',
  dropInk: '#6fc0ff',
  terminal: '#4d4114',
  terminalInk: '#ffd35c',
  supply: '#14493f',
  supplyInk: '#5cf0cd',
  fog: 'rgba(5,8,12,0.62)',
  voidFill: '#0a0d11',
  voidHatch: 'rgba(105,121,139,0.085)',
  edge: 'rgba(105,121,139,0.55)',
  lit: 'rgba(255,238,205,0.055)',
  player: '#4fd6ff',
  corpse: '#6d5a52',
  frameLegal: 'rgba(210, 230, 245, 0.75)',
  frameAlert: '#ff5b4a',
  frameSpotting: '#ffb648',
  laser: '#ff4d3d',
  laserDead: '#7d8a97',
  path: '#4fd6ff',
  pathBad: '#ffb648',
  interact: '#ffd35c',
  coverCause: '#7fd0e8',
  inkDim: '#b7c3ce',
};

const FOE: Record<string, string> = {
  RUNNER: '#ff5b4a',
  HULK: '#e0913a',
  SHOOTER: '#b06be0',
};

export interface Ghost {
  archetype: string;
  pos: Vec2;
}

/** 鎖定中的目標。持續顯示在戰場上，不是對話框。 */
export interface Lock {
  unitId: string;
  pos: Vec2;
  name: string;
  /** 命中率 0..1；null 代表目前打不到（顯示原因）。 */
  chance: number | null;
  reason: string;
  /** 預期傷害區間（已扣過護甲與穿甲）。 */
  damage: { min: number; max: number };
  /** 目標護甲區間。和傷害擺在一起，玩家一眼看得出「為什麼只有這麼點」。 */
  armor: { min: number; max: number };
  /** 掩蔽說明，例如「良好掩蔽 −40%」；無掩蔽時為空字串。 */
  coverNote: string;
  /** 造成掩蔽的格子。標出來玩家才知道該繞哪邊（§12.10）。 */
  coverTiles: Vec2[];
}

export interface MovePreview {
  path: Vec2[];
  ap: number;
  affordable: boolean;
}

export interface InteractPreview {
  pos: Vec2;
  label: string;
  ap: number;
}

export interface Scene {
  state: GameState;
  vision: Vision;
  cam: Camera;
  ghosts: Ghost[];
  /** 現在打得到的敵人 id —— 決定「靜態細框」畫在誰身上。 */
  legalTargets: string[];
  lock: Lock | null;
  movePreview: MovePreview | null;
  interactPreview: InteractPreview | null;
  /** 毫秒時間戳，用於點滅動畫。 */
  time: number;
}

export function draw(ctx: CanvasRenderingContext2D, w: number, h: number, sc: Scene): void {
  const { cam } = sc;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);

  // 士兵永遠置中 ⇒ 攝影機不夾邊界 ⇒ 畫面會露出地圖之外。
  // 界外照 §6「地圖邊界視同 WALL」畫成整片岩層，再描一圈可作戰範圍的邊。
  const tl = screenToTile(cam, 0, 0);
  const br = screenToTile(cam, w, h);
  const x0 = tl.x - 1;
  const y0 = tl.y - 1;
  const x1 = br.x + 1;
  const y1 = br.y + 1;

  drawTiles(ctx, sc, x0, y0, x1, y1);
  drawMapEdge(ctx, sc);
  drawCorpses(ctx, sc, Math.max(0, x0), Math.max(0, y0), x1, y1);
  drawGhosts(ctx, sc);
  drawUnits(ctx, sc);
  drawMovePreview(ctx, sc);
  drawInteractPreview(ctx, sc);
  drawTargetFrames(ctx, sc);
  drawLock(ctx, sc);
  drawVignette(ctx, w, h);
}

/**
 * 邊角壓暗。士兵鎖在正中央，在地圖角落時畫面會露出大片界外岩層 ——
 * 暈影讓那片區域自然退到背景，視線集中回中央的士兵。
 */
function drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const cx = w / 2;
  const cy = h / 2;
  const g = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.32, cx, cy, Math.max(w, h) * 0.72);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function drawTiles(ctx: CanvasRenderingContext2D, sc: Scene, x0: number, y0: number, x1: number, y1: number): void {
  const { state, cam, vision } = sc;
  const t = cam.tile;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = { x, y };
      const s = tileToScreen(cam, p);

      if (!inBounds(state.map, p)) {
        drawVoid(ctx, s, t, x, y);
        continue;
      }
      const kind = tileAt(state.map, p);

      ctx.fillStyle = C.floor;
      ctx.fillRect(s.x, s.y, t, t);
      ctx.strokeStyle = C.floorGrid;
      ctx.lineWidth = 1;
      ctx.strokeRect(s.x + 0.5, s.y + 0.5, t - 1, t - 1);

      if (kind === 'WALL') {
        ctx.fillStyle = C.wallFace;
        ctx.fillRect(s.x, s.y, t, t);
        ctx.fillStyle = C.wallTop;
        ctx.fillRect(s.x, s.y, t, Math.max(2, t * 0.22));
      } else if (kind === 'HALF_COVER') {
        // 半身高：只畫下半，並在頂端加亮邊，讓「可以越過去射」看得出來
        const hh = t * 0.58;
        ctx.fillStyle = C.coverBase;
        ctx.fillRect(s.x + 1, s.y + (t - hh), t - 2, hh);
        ctx.fillStyle = C.coverTop;
        ctx.fillRect(s.x + 1, s.y + (t - hh), t - 2, Math.max(2, t * 0.11));
      } else if (kind === 'DROP_POINT') {
        marker(ctx, s, t, C.drop, C.dropInk, sameTile(p, state.map.startDropPoint) ? '⌂' : 'D');
      } else if (kind === 'TERMINAL') {
        marker(ctx, s, t, C.terminal, C.terminalInk, state.objectives.main.done ? '✓' : 'T');
      } else if (kind === 'SUPPLY') {
        const o = state.objectives.secondary.find((q) => sameTile(q.pos, p));
        marker(ctx, s, t, C.supply, C.supplyInk, o && o.done ? '✓' : 'S');
      }

      // 有視線的格子加一層暖光、其餘壓暗 —— 讓「我現在看得到哪裡」一眼可辨
      ctx.fillStyle = isVisible(vision, state.map, p) ? C.lit : C.fog;
      ctx.fillRect(s.x, s.y, t, t);
    }
  }
}

/** 界外岩層：實心底色 + 斜線紋理，一眼看得出「這裡永遠去不了」。 */
function drawVoid(ctx: CanvasRenderingContext2D, s: Vec2, t: number, tx: number, ty: number): void {
  ctx.fillStyle = C.voidFill;
  ctx.fillRect(s.x, s.y, t, t);
  ctx.strokeStyle = C.voidHatch;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // 用格座標決定相位，鏡頭移動時紋理不會跟著游移
  const step = t / 3;
  const phase = ((((tx + ty) % 3) + 3) % 3) * (step / 3);
  for (let i = phase; i < t * 2; i += step) {
    ctx.moveTo(s.x + i, s.y);
    ctx.lineTo(s.x + i - t, s.y + t);
  }
  ctx.stroke();
}

/** 可作戰範圍的外框。 */
function drawMapEdge(ctx: CanvasRenderingContext2D, sc: Scene): void {
  const { cam, state } = sc;
  const a = tileToScreen(cam, { x: 0, y: 0 });
  ctx.save();
  ctx.strokeStyle = C.edge;
  ctx.lineWidth = 2;
  ctx.setLineDash([9, 5]);
  ctx.strokeRect(a.x - 1, a.y - 1, state.map.width * cam.tile + 2, state.map.height * cam.tile + 2);
  ctx.restore();
}

function marker(
  ctx: CanvasRenderingContext2D, s: Vec2, t: number,
  bg: string, ink: string, glyph: string,
): void {
  ctx.fillStyle = bg;
  ctx.fillRect(s.x + 1, s.y + 1, t - 2, t - 2);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(s.x + 2.5, s.y + 2.5, t - 5, t - 5);
  ctx.fillStyle = ink;
  ctx.font = `600 ${Math.round(t * 0.5)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, s.x + t / 2, s.y + t / 2 + 1);
}

function drawCorpses(ctx: CanvasRenderingContext2D, sc: Scene, x0: number, y0: number, x1: number, y1: number): void {
  const { state, cam } = sc;
  const seen = new Set<string>();
  for (const c of state.corpses) {
    if (c.pos.x < x0 || c.pos.x > x1 || c.pos.y < y0 || c.pos.y > y1) continue;
    const k = c.pos.x + ',' + c.pos.y;
    if (seen.has(k)) continue;
    seen.add(k);
    drawCorpse(ctx, cam, c);
  }
}

function drawCorpse(ctx: CanvasRenderingContext2D, cam: Camera, c: Corpse): void {
  const t = cam.tile;
  const p = tileCenter(cam, c.pos);
  ctx.strokeStyle = C.corpse;
  ctx.lineWidth = Math.max(2, t * 0.09);
  ctx.lineCap = 'round';
  const r = t * 0.26;
  ctx.beginPath();
  ctx.moveTo(p.x - r, p.y - r * 0.6);
  ctx.lineTo(p.x + r, p.y + r * 0.6);
  ctx.moveTo(p.x + r, p.y - r * 0.6);
  ctx.lineTo(p.x - r, p.y + r * 0.6);
  ctx.stroke();
  if (c.weapons.length > 0) {
    ctx.fillStyle = C.terminalInk;
    ctx.beginPath();
    ctx.arc(p.x + t * 0.28, p.y - t * 0.28, Math.max(2.5, t * 0.09), 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawUnits(ctx: CanvasRenderingContext2D, sc: Scene): void {
  const { state, cam, vision } = sc;
  const me = activePlayerUnit(state);
  for (const u of state.units) {
    if (u.faction === 'ENEMY' && !isVisible(vision, state.map, u.pos)) continue;
    drawUnit(ctx, cam, u, me ? u.id === me.id : false);
  }
}

function drawUnit(ctx: CanvasRenderingContext2D, cam: Camera, u: Unit, isActive: boolean): void {
  const t = cam.tile;
  const c = tileCenter(cam, u.pos);
  const color = u.faction === 'PLAYER' ? C.player : (FOE[u.archetype] ?? '#ff5b4a');
  const crouched = u.stance === 'CROUCH';
  const r = t * (crouched ? 0.26 : 0.34);

  if (isActive) {
    ctx.strokeStyle = 'rgba(79,214,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c.x, c.y, t * 0.46, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = color;
  ctx.beginPath();
  if (u.archetype === 'HULK') {
    ctx.rect(c.x - r, c.y - r, r * 2, r * 2);
  } else if (u.archetype === 'SHOOTER') {
    ctx.moveTo(c.x, c.y - r); ctx.lineTo(c.x + r, c.y);
    ctx.lineTo(c.x, c.y + r); ctx.lineTo(c.x - r, c.y);
    ctx.closePath();
  } else if (u.archetype === 'RUNNER') {
    ctx.moveTo(c.x, c.y - r); ctx.lineTo(c.x + r, c.y + r * 0.8);
    ctx.lineTo(c.x - r, c.y + r * 0.8);
    ctx.closePath();
  } else {
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  }
  ctx.fill();

  // 蹲下：底部加一條短橫線，一眼看得出姿勢
  if (crouched) {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, t * 0.08);
    ctx.beginPath();
    ctx.moveTo(c.x - r, c.y + r * 1.35);
    ctx.lineTo(c.x + r, c.y + r * 1.35);
    ctx.stroke();
  }

  // HP 條
  const bw = t * 0.72;
  const bh = Math.max(3, t * 0.1);
  const bx = c.x - bw / 2;
  const by = c.y - t * 0.48;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = u.faction === 'PLAYER' ? C.player : '#ff8b7f';
  ctx.fillRect(bx, by, (bw * Math.max(0, u.hp)) / u.maxHp, bh);

  // 敵人 AI 狀態
  if (u.faction === 'ENEMY') {
    if (u.justSpotted) {
      // 文字而不是符號：這個狀態的意思（本回合不會開火）值得講清楚
      ctx.font = '700 11px ui-sans-serif, system-ui, "Noto Sans TC", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(4,6,9,0.92)';
      ctx.lineWidth = 3;
      ctx.strokeText('剛發現', c.x, by - 2);
      ctx.fillStyle = C.frameSpotting;
      ctx.fillText('剛發現', c.x, by - 2);
    } else {
      const glyph = u.aiState === 'ALERT' ? '!' : u.aiState === 'SEARCH' ? '?' : '';
      if (glyph) {
        ctx.fillStyle = u.aiState === 'ALERT' ? '#ff5b4a' : '#ffb648';
        ctx.font = `700 ${Math.round(t * 0.42)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(glyph, c.x + t * 0.32, by - 1);
      }
    }
  }
}

function drawGhosts(ctx: CanvasRenderingContext2D, sc: Scene): void {
  const { cam } = sc;
  const t = cam.tile;
  for (const g of sc.ghosts) {
    const c = tileCenter(cam, g.pos);
    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.strokeStyle = FOE[g.archetype] ?? '#ff5b4a';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(c.x, c.y, t * 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = FOE[g.archetype] ?? '#ff5b4a';
    ctx.font = `700 ${Math.round(t * 0.36)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', c.x, c.y + 1);
    ctx.restore();
  }
}

/**
 * 目標框：兩種訊息，兩種表現，可以同時出現在同一個敵人身上。
 *   靜態細框 = 這個目標我現在打得到（視線、射程、彈藥、AP 皆成立）
 *   點滅紅框 = 這個敵人不是 IDLE（ALERT 或 SEARCH）
 * 框只表達狀態，不決定可否點擊 —— IDLE 的敵人一樣選得到、打得到。
 */
function drawTargetFrames(ctx: CanvasRenderingContext2D, sc: Scene): void {
  const { state, cam, vision } = sc;
  const t = cam.tile;
  const legal = new Set(sc.legalTargets);
  const blink = 0.5 + 0.5 * Math.sin(sc.time / 260);

  for (const u of state.units) {
    if (u.faction !== 'ENEMY') continue;
    if (!isVisible(vision, state.map, u.pos)) continue;
    const s = tileToScreen(cam, u.pos);

    if (legal.has(u.id)) {
      ctx.strokeStyle = C.frameLegal;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(s.x + 2.5, s.y + 2.5, t - 5, t - 5);
    }
    if (u.aiState !== 'IDLE') {
      // 「剛從 IDLE 發現、這一回合不會開火」必須與一般警戒截然不同 ——
      // 這一回合正是玩家用來蹲下、退回掩體或先開槍的反應窗口（§9.2）。
      // 用琥珀色虛線框而不是紅色實線閃爍，並在頭上標「剛發現」。
      const spotting = u.justSpotted;
      ctx.save();
      ctx.globalAlpha = spotting ? 0.9 : 0.35 + 0.65 * blink;
      ctx.strokeStyle = spotting ? C.frameSpotting : C.frameAlert;
      ctx.lineWidth = 2.5;
      if (spotting) ctx.setLineDash([5, 4]);
      ctx.strokeRect(s.x - 1.5, s.y - 1.5, t + 3, t + 3);
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
}

/** 雷射瞄準線 + 紅點準星 + 行內的名稱與命中率。持續顯示，不是對話框。 */
function drawLock(ctx: CanvasRenderingContext2D, sc: Scene): void {
  const lock = sc.lock;
  if (!lock) return;
  const me = activePlayerUnit(sc.state);
  if (!me) return;
  const { cam } = sc;
  const a = tileCenter(cam, me.pos);
  const b = tileCenter(cam, lock.pos);
  const live = lock.chance !== null;
  const beam = live ? C.laser : C.laserDead;

  ctx.save();
  // 雷射：外層柔光 + 內層細線
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = beam;
  ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.globalAlpha = live ? 0.95 : 0.5;
  ctx.lineWidth = 1.4;
  if (!live) ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.setLineDash([]);

  // 造成掩蔽的格子：標出來玩家才知道該繞哪邊（§12.10）
  if (lock.coverTiles.length > 0) {
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = C.coverCause;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 4]);
    for (const t of lock.coverTiles) {
      const s2 = tileToScreen(cam, t);
      ctx.strokeRect(s2.x + 2, s2.y + 2, cam.tile - 4, cam.tile - 4);
    }
    ctx.setLineDash([]);
  }

  // 紅點準星
  const r = cam.tile * 0.13;
  ctx.globalAlpha = 1;
  ctx.fillStyle = beam;
  ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = beam;
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(b.x, b.y, r * 2.6, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  const head = live
    ? lock.name + '　命中 ' + Math.round((lock.chance as number) * 100) + '%'
    : lock.name + '　' + lock.reason;
  // 傷害與護甲並排：AR-9 打裝甲型會顯示「傷害 10–10　裝甲 20」，
  // 開槍之前就看得出這把槍對它沒用（§12.9 的教學要在開火前就成立）
  const sub = live
    ? '傷害 ' + lock.damage.min + '–' + lock.damage.max
      + '　裝甲 ' + lock.armor.min + '–' + lock.armor.max
      + (lock.coverNote ? '　' + lock.coverNote : '')
    : '';
  // 標籤放在目標「下方」：浮動傷害數字一律往上飄，兩者才不會疊在一起。
  drawLabel(ctx, b.x, b.y + cam.tile * 0.62 + (sub ? 16 : 9), head, live ? C.laser : C.inkDim, sub);
}

function drawMovePreview(ctx: CanvasRenderingContext2D, sc: Scene): void {
  const mp = sc.movePreview;
  if (!mp || mp.path.length === 0) return;
  const { cam } = sc;
  const t = cam.tile;
  const colour = mp.affordable ? C.path : C.pathBad;

  ctx.save();
  ctx.fillStyle = colour;
  for (let i = 0; i < mp.path.length; i++) {
    const c = tileCenter(cam, mp.path[i]);
    const last = i === mp.path.length - 1;
    ctx.beginPath();
    ctx.arc(c.x, c.y, last ? t * 0.2 : Math.max(2, t * 0.09), 0, Math.PI * 2);
    ctx.fill();
  }
  const end = tileCenter(cam, mp.path[mp.path.length - 1]);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 2;
  ctx.strokeRect(end.x - t / 2 + 2, end.y - t / 2 + 2, t - 4, t - 4);
  ctx.restore();

  drawLabel(ctx, end.x, end.y - t * 0.62,
    mp.ap + ' AP' + (mp.affordable ? '' : '（不足）'),
    mp.affordable ? C.path : C.pathBad);
}

function drawInteractPreview(ctx: CanvasRenderingContext2D, sc: Scene): void {
  const ip = sc.interactPreview;
  if (!ip) return;
  const { cam } = sc;
  const t = cam.tile;
  const c = tileCenter(cam, ip.pos);
  ctx.save();
  ctx.strokeStyle = C.interact;
  ctx.lineWidth = 2;
  ctx.strokeRect(c.x - t / 2 + 2, c.y - t / 2 + 2, t - 4, t - 4);
  ctx.restore();
  drawLabel(ctx, c.x, c.y - t * 0.62, ip.label + '　' + ip.ap + ' AP', C.interact);
}

/** 戰場上的行內小標籤：深底 + 彩色文字，確保任何地形上都讀得到。 */
function drawLabel(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, text: string, ink: string, sub = '',
): void {
  ctx.save();
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const subW = sub ? ctx.measureText(sub).width : 0;
  const w = Math.max(ctx.measureText(text).width, subW) + 12;
  const h = sub ? 32 : 18;
  // 夾在畫面內，免得目標靠邊時標籤被切掉
  const cxc = Math.min(Math.max(cx, w / 2 + 4), ctx.canvas.width / (ctx.getTransform().a || 1) - w / 2 - 4);
  ctx.fillStyle = 'rgba(8, 11, 15, 0.82)';
  ctx.beginPath();
  const x = cxc - w / 2;
  const y = cy - h / 2;
  const r = 5;
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(150,180,210,0.22)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.fillText(text, cxc, sub ? cy - 7 : cy + 0.5);
  if (sub) {
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#cfe0ee';
    ctx.fillText(sub, cxc, cy + 8);
  }
  ctx.restore();
}

/** 供 UI 判斷點到的是不是屍體。 */
export function corpseAtTile(state: GameState, p: Vec2): Corpse | null {
  return corpseAt(state, p);
}
