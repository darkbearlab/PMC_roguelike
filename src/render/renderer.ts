/**
 * Canvas 2D 繪製。唯讀 GameState —— 這一層絕不改寫狀態。
 */
import type { Corpse, GameState, Unit, Vec2 } from '../core/state';
import { activePlayerUnit, corpseAt } from '../core/state';
import { inBounds, tileAt } from '../core/map';
import { sightPath } from '../core/los';
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
  select: '#ffd24d',
  losOk: 'rgba(79,214,255,0.85)',
  losBad: 'rgba(255,91,74,0.85)',
  path: 'rgba(79,214,255,0.55)',
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

export interface Scene {
  state: GameState;
  vision: Vision;
  cam: Camera;
  ghosts: Ghost[];
  selection: Vec2 | null;
  fireTarget: Vec2 | null;
  previewPath: Vec2[] | null;
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
  drawPreviewPath(ctx, sc);
  drawFireLine(ctx, sc);
  drawSelection(ctx, sc);
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

function drawPreviewPath(ctx: CanvasRenderingContext2D, sc: Scene): void {
  if (!sc.previewPath || sc.previewPath.length === 0) return;
  const { cam } = sc;
  const t = cam.tile;
  ctx.fillStyle = C.path;
  for (const p of sc.previewPath) {
    const c = tileCenter(cam, p);
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(2.5, t * 0.11), 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 射擊前先把視線畫出來（§12.4：玩家要在確認前就知道自己在承擔什麼）。 */
function drawFireLine(ctx: CanvasRenderingContext2D, sc: Scene): void {
  const target = sc.fireTarget;
  if (!target) return;
  const me = activePlayerUnit(sc.state);
  if (!me) return;
  const { cam } = sc;
  const a = tileCenter(cam, me.pos);
  const b = tileCenter(cam, target);

  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = C.losOk;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // 經過的格子淡淡標一下，讓「這條線碰到哪些掩體」看得見
  ctx.fillStyle = 'rgba(79,214,255,0.10)';
  for (const p of sightPath(me.pos, target)) {
    const s = tileToScreen(cam, p);
    ctx.fillRect(s.x, s.y, cam.tile, cam.tile);
  }

  ctx.strokeStyle = C.losBad;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(b.x, b.y, cam.tile * 0.42, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawSelection(ctx: CanvasRenderingContext2D, sc: Scene): void {
  if (!sc.selection) return;
  const s = tileToScreen(sc.cam, sc.selection);
  const t = sc.cam.tile;
  ctx.strokeStyle = C.select;
  ctx.lineWidth = 2.5;
  ctx.strokeRect(s.x + 1.5, s.y + 1.5, t - 3, t - 3);
}

/** 供 UI 判斷點到的是不是屍體。 */
export function corpseAtTile(state: GameState, p: Vec2): Corpse | null {
  return corpseAt(state, p);
}
