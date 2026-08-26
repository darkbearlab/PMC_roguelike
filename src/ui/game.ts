/**
 * 遊戲控制器：把觸控輸入翻成 Command，把 GameState 交給渲染層。
 * 這一層唯讀 GameState —— 任何狀態改變都必須經過 applyCommand()。
 */
import type { Facing, GameState, Vec2 } from '../core/state';
import { activePlayerUnit, findUnit, unitAt } from '../core/state';
import type { Command, WeaponSlot } from '../core/commands';
import { applyCommand, checkLegal, movePath, swapCost } from '../core/commands';
import { createInitialState } from '../core/setup';
import { chebyshev, facingFromDelta, sameTile } from '../core/grid';
import { inBounds } from '../core/map';
import type { Camera } from '../render/camera';
import { computeCamera, screenToTile } from '../render/camera';
import type { Ghost } from '../render/renderer';
import { draw } from '../render/renderer';
import type { Vision } from '../render/vision';
import { computeVision, isVisible, visionKey } from '../render/vision';
import { BUILD_ID } from './build';
import { $, $$, esc, show } from './dom';
import { renderHud } from './hud';
import { tileMenuHtml, wireMenu } from './menus';
import { hideModal, showAbortConfirm, showReinforcement, showSummary } from './modals';

const ENEMY_STEP_MS = 150;
const MOVE_STEP_MS = 110;
const TAP_SLOP = 12;
const TAP_MS = 700;

type ModalKind = 'NONE' | 'REINFORCE' | 'ABORT' | 'SUMMARY';

export class Game {
  state: GameState;
  private canvas = $<HTMLCanvasElement>('#map');
  private ctx: CanvasRenderingContext2D;
  private cam: Camera = { tile: 24, ox: 0, oy: 0 };
  private vision: Vision;
  private ghosts = new Map<string, Ghost>();
  private pan: Vec2 = { x: 0, y: 0 };
  private focus: Vec2;
  private selection: Vec2 | null = null;
  private fireTarget: Vec2 | null = null;
  private previewPath: Vec2[] | null = null;
  private moveQueue: Facing[] = [];
  private lastStep = 0;
  private modal: ModalKind = 'NONE';
  private logOpen = false;
  private viewW = 1;
  private viewH = 1;

  constructor(private seed: number) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('取不到 Canvas 2D context');
    this.ctx = ctx;
    this.state = createInitialState(seed);
    this.vision = computeVision(this.state);
    this.focus = { ...this.state.map.startDropPoint };
    this.bindInput();
    this.observeResize();
    this.refresh();
    requestAnimationFrame(this.loop);
  }

  // ---------------------------------------------------------------- 指令

  dispatch(cmd: Command): boolean {
    const next = applyCommand(this.state, cmd);
    if (next === this.state) return false;
    this.state = next;
    this.refresh();
    return true;
  }

  restart(): void {
    this.state = createInitialState(this.seed);
    this.ghosts.clear();
    this.moveQueue = [];
    this.selection = null;
    this.fireTarget = null;
    this.previewPath = null;
    this.pan = { x: 0, y: 0 };
    this.modal = 'NONE';
    hideModal();
    this.refresh();
  }

  // ---------------------------------------------------------------- 更新

  private refresh(): void {
    this.syncVision();
    this.updateGhosts();

    const me = activePlayerUnit(this.state);
    if (me) this.focus = { ...me.pos };

    // 目標死掉或狀態變了就把預覽收掉
    if (this.fireTarget && !unitAt(this.state, this.fireTarget)) this.fireTarget = null;

    renderHud(this.state);
    this.updateControls();
    this.updateMenu();
    this.updateLog();
    this.updateModal();
  }

  /** 可見性只跟玩家的位置／姿勢有關，敵人回合大多不需要重算。 */
  private syncVision(): void {
    if (this.vision.key !== visionKey(this.state)) this.vision = computeVision(this.state);
  }

  private updateGhosts(): void {
    const alive = new Set(this.state.units.map((u) => u.id));
    for (const id of [...this.ghosts.keys()]) if (!alive.has(id)) this.ghosts.delete(id);
    for (const u of this.state.units) {
      if (u.faction !== 'ENEMY') continue;
      if (isVisible(this.vision, this.state.map, u.pos)) {
        this.ghosts.set(u.id, { archetype: u.archetype, pos: { ...u.pos } });
      }
    }
  }

  /** 目前渲染要畫的「最後已知位置」幽靈（只畫看不見的那些）。 */
  private visibleGhosts(): Ghost[] {
    const out: Ghost[] = [];
    for (const [id, g] of this.ghosts) {
      const u = findUnit(this.state, id);
      if (!u) continue;
      if (isVisible(this.vision, this.state.map, u.pos)) continue;
      out.push(g);
    }
    return out;
  }

  // ---------------------------------------------------------------- 控制列

  private updateControls(): void {
    const s = this.state;
    const u = activePlayerUnit(s);
    const busy = this.modal !== 'NONE' || s.phase !== 'PLAYER' || !!s.pendingReinforcement;

    for (const btn of $$<HTMLButtonElement>('#dpad button[data-dir]')) {
      const dir = btn.dataset.dir as Facing;
      btn.disabled = busy || !checkLegal(s, { type: 'MOVE', dir }).ok;
    }
    const en = (sel: string, ok: boolean): void => {
      $<HTMLButtonElement>(sel).disabled = busy || !ok;
    };
    en('#dpad button[data-act="WAIT"]', checkLegal(s, { type: 'WAIT' }).ok);
    en('#actions button[data-act="STANCE"]', checkLegal(s, { type: 'TOGGLE_STANCE' }).ok);
    en('#actions button[data-act="FIRE"]', this.bestTarget() !== null);
    en('#actions button[data-act="RELOAD"]', checkLegal(s, { type: 'RELOAD' }).ok);
    en('#actions button[data-act="SWAP"]', checkLegal(s, { type: 'SWAP_WEAPON' }).ok);
    en('#actions button[data-act="INTERACT"]', checkLegal(s, { type: 'INTERACT' }).ok);
    $<HTMLButtonElement>('#actions button[data-act="LOG"]').disabled = false;

    $('#lbl-stance').textContent = u && u.stance === 'STAND' ? '蹲' : '站';
    $('#lbl-fire').textContent = u && u.equipped ? u.equipped.fireCost + ' AP' : '— AP';
    $('#lbl-reload').textContent = u && u.equipped ? u.equipped.reloadCost + ' AP' : '— AP';
    const sc = u ? swapCost(u) : Infinity;
    $('#lbl-swap').textContent = Number.isFinite(sc) ? sc + ' AP' : '— AP';

    this.updateBanner();
  }

  private updateBanner(): void {
    const s = this.state;
    const banner = $('#turn-banner');
    const busy = !!this.selection || this.logOpen || this.modal !== 'NONE';
    if (s.result !== 'ONGOING') { show(banner, false); return; }
    if (s.phase === 'ENEMY') {
      banner.textContent = '敵人回合';
      show(banner, !busy);
      return;
    }
    banner.textContent = '第 ' + s.turn + ' 回合';
    show(banner, !busy && this.moveQueue.length === 0);
  }

  /** 目前最近的一個合法射擊目標（開火鍵用）。 */
  private bestTarget(): Vec2 | null {
    const u = activePlayerUnit(this.state);
    if (!u || this.state.phase !== 'PLAYER') return null;
    let best: Vec2 | null = null;
    let bestD = Infinity;
    for (const e of this.state.units) {
      if (e.faction !== 'ENEMY') continue;
      if (!checkLegal(this.state, { type: 'FIRE', target: e.pos }).ok) continue;
      const d = chebyshev(u.pos, e.pos);
      if (d < bestD) { bestD = d; best = { ...e.pos }; }
    }
    return best;
  }

  // ---------------------------------------------------------------- 面板

  private updateMenu(): void {
    const host = $('#tile-menu');
    if (!this.selection || this.modal !== 'NONE') {
      show(host, false);
      host.innerHTML = '';
      this.updateBanner();
      return;
    }
    const html = tileMenuHtml(this.state, this.selection);
    if (!html) {
      show(host, false);
      return;
    }
    host.innerHTML = html;
    show(host, true);
    this.updateBanner();
    wireMenu(host, this.selection, {
      fire: (t) => this.confirmFire(t),
      moveTo: (t) => this.queueMoveTo(t),
      pickup: (corpseId, weaponIndex, slot: WeaponSlot) => {
        this.dispatch({ type: 'PICKUP', corpseId, weaponIndex, slot });
        this.closeMenu();
      },
      interact: () => { this.dispatch({ type: 'INTERACT' }); this.closeMenu(); },
      close: () => this.closeMenu(),
    });
  }

  private updateLog(): void {
    const host = $('#log-panel');
    if (!this.logOpen) { show(host, false); this.updateBanner(); return; }
    const items = this.state.log.slice(-40).reverse()
      .map((l) => '<li class="kind-' + l.kind + '">[T' + l.turn + '] ' + esc(l.text) + '</li>')
      .join('');
    host.innerHTML = '<h3>戰鬥紀錄<button class="close" data-close="1">關閉</button></h3>'
      + '<p class="note">build ' + esc(BUILD_ID) + '　seed ' + this.state.rngSeed + '</p>'
      + '<ol>' + items + '</ol>';
    show(host, true);
    this.updateBanner();
    const btn = host.querySelector<HTMLButtonElement>('button[data-close]');
    if (btn) btn.addEventListener('click', () => { this.logOpen = false; this.updateLog(); });
  }

  private updateModal(): void {
    const s = this.state;
    if (s.result !== 'ONGOING' && this.modal !== 'SUMMARY') {
      this.modal = 'SUMMARY';
      showSummary(s, () => this.restart());
      return;
    }
    if (this.modal === 'SUMMARY' || this.modal === 'ABORT') return;
    if (s.pendingReinforcement) {
      if (this.modal !== 'REINFORCE') {
        this.modal = 'REINFORCE';
        showReinforcement(
          s,
          (id) => {
            this.modal = 'NONE';
            hideModal();
            this.dispatch({ type: 'DEPLOY_REINFORCEMENT', soldierId: id });
          },
          () => { this.modal = 'NONE'; hideModal(); this.dispatch({ type: 'ABORT' }); },
        );
      }
      return;
    }
    if (this.modal === 'REINFORCE') { this.modal = 'NONE'; hideModal(); }
  }

  private closeMenu(): void {
    this.selection = null;
    this.fireTarget = null;
    this.previewPath = null;
    this.updateMenu();
  }

  // ---------------------------------------------------------------- 動作

  private confirmFire(target: Vec2): void {
    if (this.dispatch({ type: 'FIRE', target })) this.closeMenu();
  }

  private queueMoveTo(target: Vec2): void {
    const u = activePlayerUnit(this.state);
    const path = movePath(this.state, target);
    if (!u || !path || path.length === 0) return;
    const steps = path.slice(0, u.ap);
    const dirs: Facing[] = [];
    let from = u.pos;
    for (const p of steps) {
      const d = facingFromDelta(p.x - from.x, p.y - from.y);
      if (!d) break;
      dirs.push(d);
      from = p;
    }
    this.moveQueue = dirs;
    this.closeMenu();
  }

  private tapTile(p: Vec2): void {
    if (this.modal !== 'NONE') return;
    if (!inBounds(this.state.map, p)) { this.closeMenu(); return; }
    this.moveQueue = [];

    const foe = unitAt(this.state, p);
    const canSee = isVisible(this.vision, this.state.map, p);

    // 敵人：第一次點 → 預覽 + 畫視線；再點一次同一格 → 確認射擊（§12.4）
    if (foe && foe.faction === 'ENEMY' && canSee) {
      if (this.fireTarget && sameTile(this.fireTarget, p)
        && checkLegal(this.state, { type: 'FIRE', target: p }).ok) {
        this.confirmFire(p);
        return;
      }
      this.selection = { ...p };
      this.fireTarget = { ...p };
      this.previewPath = null;
      this.updateMenu();
      return;
    }

    this.fireTarget = null;
    this.selection = { ...p };
    const path = movePath(this.state, p);
    const u = activePlayerUnit(this.state);
    this.previewPath = path && u ? path.slice(0, Math.max(u.ap, 0)) : null;
    this.updateMenu();
  }

  // ---------------------------------------------------------------- 輸入

  private bindInput(): void {
    for (const btn of $$<HTMLButtonElement>('#dpad button[data-dir]')) {
      btn.addEventListener('click', () => {
        this.moveQueue = [];
        this.closeMenu();
        this.dispatch({ type: 'MOVE', dir: btn.dataset.dir as Facing });
      });
    }
    $('#dpad button[data-act="WAIT"]').addEventListener('click', () => {
      this.moveQueue = [];
      this.closeMenu();
      this.dispatch({ type: 'WAIT' });
    });

    const act: Record<string, () => void> = {
      STANCE: () => this.dispatch({ type: 'TOGGLE_STANCE' }),
      RELOAD: () => this.dispatch({ type: 'RELOAD' }),
      SWAP: () => this.dispatch({ type: 'SWAP_WEAPON' }),
      INTERACT: () => this.dispatch({ type: 'INTERACT' }),
      FIRE: () => {
        const t = this.bestTarget();
        if (!t) return;
        this.selection = t;
        this.fireTarget = t;
        this.updateMenu();
      },
      LOG: () => { this.logOpen = !this.logOpen; this.updateLog(); },
    };
    for (const btn of $$<HTMLButtonElement>('#actions button[data-act]')) {
      const fn = act[btn.dataset.act as string];
      if (fn) btn.addEventListener('click', fn);
    }

    $('#btn-abort').addEventListener('click', () => {
      if (this.state.result !== 'ONGOING') return;
      const prev = this.modal;
      this.modal = 'ABORT';
      hideModal();
      showAbortConfirm(
        this.state,
        () => { this.modal = 'NONE'; hideModal(); this.dispatch({ type: 'ABORT' }); },
        () => { this.modal = prev === 'ABORT' ? 'NONE' : prev; hideModal(); this.refresh(); },
      );
    });

    this.bindCanvas();
    this.bindKeyboard();
  }

  private bindCanvas(): void {
    let downAt = 0;
    let start: Vec2 = { x: 0, y: 0 };
    let panStart: Vec2 = { x: 0, y: 0 };
    let dragging = false;

    const local = (e: PointerEvent): Vec2 => {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      downAt = performance.now();
      start = local(e);
      panStart = { ...this.pan };
      dragging = false;
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!downAt) return;
      const p = local(e);
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      if (!dragging && Math.hypot(dx, dy) > TAP_SLOP) dragging = true;
      if (dragging) this.pan = { x: panStart.x + dx, y: panStart.y + dy };
    });
    const end = (e: PointerEvent): void => {
      if (!downAt) return;
      const elapsed = performance.now() - downAt;
      const p = local(e);
      downAt = 0;
      if (!dragging && elapsed < TAP_MS) {
        this.pan = { x: 0, y: 0 };
        this.tapTile(screenToTile(this.cam, p.x, p.y));
      }
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', () => { downAt = 0; });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** 桌面瀏覽器的可選鍵盤操作（§3：不強制，方便測試）。 */
  private bindKeyboard(): void {
    const map: Record<string, Facing> = {
      ArrowUp: 'N', ArrowDown: 'S', ArrowLeft: 'W', ArrowRight: 'E',
      Numpad8: 'N', Numpad2: 'S', Numpad4: 'W', Numpad6: 'E',
      Numpad7: 'NW', Numpad9: 'NE', Numpad1: 'SW', Numpad3: 'SE',
    };
    window.addEventListener('keydown', (e) => {
      if (this.modal !== 'NONE') return;
      const dir = map[e.code];
      if (dir) { e.preventDefault(); this.moveQueue = []; this.dispatch({ type: 'MOVE', dir }); return; }
      if (e.code === 'KeyC') this.dispatch({ type: 'TOGGLE_STANCE' });
      else if (e.code === 'KeyR') this.dispatch({ type: 'RELOAD' });
      else if (e.code === 'KeyQ') this.dispatch({ type: 'SWAP_WEAPON' });
      else if (e.code === 'KeyE') this.dispatch({ type: 'INTERACT' });
      else if (e.code === 'Space') { e.preventDefault(); this.dispatch({ type: 'WAIT' }); }
      else if (e.code === 'KeyF') {
        const t = this.bestTarget();
        if (t) { this.selection = t; this.fireTarget = t; this.updateMenu(); }
      }
    });
  }

  // ---------------------------------------------------------------- 畫面

  private observeResize(): void {
    const stage = $('#stage');
    const fit = (): void => {
      const r = stage.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      this.viewW = Math.max(1, Math.floor(r.width));
      this.viewH = Math.max(1, Math.floor(r.height));
      this.canvas.width = Math.floor(this.viewW * dpr);
      this.canvas.height = Math.floor(this.viewH * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    new ResizeObserver(fit).observe(stage);
    window.addEventListener('orientationchange', () => setTimeout(fit, 120));
  }

  private loop = (now: number): void => {
    this.step(now);
    this.render();
    requestAnimationFrame(this.loop);
  };

  private step(now: number): void {
    const s = this.state;
    if (s.result !== 'ONGOING' || s.pendingReinforcement) return;

    if (s.phase === 'ENEMY') {
      if (now - this.lastStep >= ENEMY_STEP_MS) {
        this.lastStep = now;
        this.runEnemySteps();
      }
      return;
    }
    if (this.moveQueue.length > 0 && now - this.lastStep >= MOVE_STEP_MS) {
      this.lastStep = now;
      const dir = this.moveQueue.shift() as Facing;
      if (!this.dispatch({ type: 'MOVE', dir })) this.moveQueue = [];
      if (this.moveQueue.length === 0) this.updateControls();
    }
  }

  /**
   * 敵人回合：玩家看得見的動作逐步播放，看不見的直接快轉。
   * 十個敵人各自 IDLE 時不該讓玩家乾等一秒半。
   */
  private runEnemySteps(): void {
    let budget = 40;
    while (budget-- > 0) {
      const id = this.state.enemyQueue[0];
      const actor = id ? findUnit(this.state, id) : null;
      const wasVisible = !!actor && isVisible(this.vision, this.state.map, actor.pos);
      const hpBefore = activePlayerUnit(this.state)?.hp ?? 0;
      const phaseBefore = this.state.phase;

      const next = applyCommand(this.state, { type: 'ENEMY_STEP' });
      if (next === this.state) break;
      this.state = next;
      this.syncVision();

      const after = id ? findUnit(this.state, id) : null;
      const nowVisible = !!after && isVisible(this.vision, this.state.map, after.pos);
      const hpAfter = activePlayerUnit(this.state)?.hp ?? 0;

      if (
        wasVisible || nowVisible ||
        hpAfter !== hpBefore ||
        this.state.phase !== phaseBefore ||
        this.state.pendingReinforcement ||
        this.state.result !== 'ONGOING'
      ) break;
    }
    this.refresh();
  }

  /** 面板打開時擋住的高度，讓攝影機把焦點推到看得見的區域。 */
  private sheetInset(): number {
    let inset = 0;
    for (const sel of ['#tile-menu', '#log-panel']) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && !el.classList.contains('hidden')) inset = Math.max(inset, el.offsetHeight);
    }
    return inset;
  }

  /** 射擊預覽時把攝影機對準「射手與目標的中點」，讓整條視線都看得到。 */
  private cameraFocus(): Vec2 {
    if (!this.fireTarget) return this.focus;
    return {
      x: (this.focus.x + this.fireTarget.x) / 2,
      y: (this.focus.y + this.fireTarget.y) / 2,
    };
  }

  private render(): void {
    this.cam = computeCamera(
      this.state.map, this.viewW, this.viewH,
      this.cameraFocus(), this.pan, this.sheetInset(),
    );
    draw(this.ctx, this.viewW, this.viewH, {
      state: this.state,
      vision: this.vision,
      cam: this.cam,
      ghosts: this.visibleGhosts(),
      selection: this.selection,
      fireTarget: this.fireTarget,
      previewPath: this.previewPath,
    });
  }
}
