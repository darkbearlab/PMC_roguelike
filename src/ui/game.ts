/**
 * 遊戲控制器：把觸控輸入翻成 Command，把 GameState 交給渲染層。
 * 這一層唯讀 GameState —— 任何狀態改變都必須經過 applyCommand()。
 *
 * v0.3 的核心是統一的地圖點擊文法（§12）：
 *   第一下 = 選取，並顯示「如果執行會發生什麼」；第二下 = 執行。
 * 兩條不變式：選取永遠不消耗任何資源；選取狀態是持續且可見的。
 * 因此不需要「取消」鍵，也不需要遮蔽戰場的彈出面板。
 */
import type { Facing, GameState, Vec2 } from '../core/state';
import { activePlayerUnit, corpseAt, findUnit, unitAt } from '../core/state';
import type { Command, WeaponSlot } from '../core/commands';
import {
  applyCommand, checkLegal, interactKindAt, interactTarget, movePath, swapCost,
} from '../core/commands';
import { createInitialState } from '../core/setup';
import { toHitChance } from '../core/combat';
import { facingFromDelta, manhattan, sameTile } from '../core/grid';
import { inBounds } from '../core/map';
import type { Camera } from '../render/camera';
import { computeCamera, screenToTile } from '../render/camera';
import type { Ghost, InteractPreview, Lock, MovePreview } from '../render/renderer';
import { draw } from '../render/renderer';
import type { Vision } from '../render/vision';
import { computeVision, isVisible, visionKey } from '../render/vision';
import { $, $$, esc, show } from './dom';
import { renderHud } from './hud';
import { corpsePanelHtml, selfPanelHtml, wireMenu } from './menus';
import {
  hideModal, showAbortConfirm, showReinforcement, showSplashConfirm, showSummary,
} from './modals';
import { BUILD_ID } from './build';

const ENEMY_STEP_MS = 150;
const MOVE_STEP_MS = 110;
const TAP_SLOP = 12;
const TAP_MS = 700;

type ModalKind = 'NONE' | 'REINFORCE' | 'ABORT' | 'SUMMARY' | 'SPLASH';

/** 目前的選取。TARGET 就是「鎖定」，跨回合保留。 */
type Sel =
  | { kind: 'TARGET'; pos: Vec2; unitId: string }
  | { kind: 'MOVE'; pos: Vec2 }
  | { kind: 'CORPSE'; pos: Vec2; corpseId: string }
  | { kind: 'INTERACT'; pos: Vec2 }
  | { kind: 'SELF' }
  | null;

/** 自動移動的中斷條件需要記住出發時的狀況。 */
interface AutoMove {
  path: Vec2[];
  foes: Set<string>;
  hp: number;
}

const INTERACT_LABEL: Record<string, string> = {
  TERMINAL: '存取終端',
  SUPPLY: '回收補給箱',
  EXTRACT: '撤離',
};

export class Game {
  state: GameState;
  private canvas = $<HTMLCanvasElement>('#map');
  private ctx: CanvasRenderingContext2D;
  private cam: Camera = { tile: 24, ox: 0, oy: 0 };
  private vision: Vision;
  private ghosts = new Map<string, Ghost>();
  private pan: Vec2 = { x: 0, y: 0 };
  private focus: Vec2;
  private sel: Sel = null;
  private auto: AutoMove | null = null;
  private lastStep = 0;
  private modal: ModalKind = 'NONE';
  private logOpen = false;
  private skillOpen = false;
  private viewW = 1;
  private viewH = 1;

  /** 測試用入口。正式流程一律走 canvas 的 pointer 事件與 rAF 迴圈。 */
  readonly test = {
    tap: (p: Vec2): void => this.tapTile(p),
    selection: (): string | null => {
      const s = this.sel;
      if (!s) return null;
      if (s.kind === 'TARGET') return 'TARGET:' + s.unitId;
      if (s.kind === 'SELF') return 'SELF';
      return s.kind + ':' + s.pos.x + ',' + s.pos.y;
    },
    autoActive: (): boolean => this.auto !== null,
    autoStep: (): void => this.stepAuto(),
    refresh: (): void => this.refresh(),
  };

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
    this.pan = { x: 0, y: 0 };
    this.refresh();
    return true;
  }

  restart(): void {
    this.state = createInitialState(this.seed);
    this.ghosts.clear();
    this.auto = null;
    this.sel = null;
    this.pan = { x: 0, y: 0 };
    this.modal = 'NONE';
    this.skillOpen = false;
    hideModal();
    this.refresh();
  }

  // ---------------------------------------------------------------- 更新

  private refresh(): void {
    this.syncVision();
    this.updateGhosts();
    const me = activePlayerUnit(this.state);
    if (me) this.focus = { ...me.pos };
    this.validateSelection();

    renderHud(this.state);
    this.updateControls();
    this.updateCard();
    this.updateLog();
    this.updateModal();
  }

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

  /** 現在打得到的敵人（決定「靜態細框」畫在誰身上）。IDLE 與否不影響。 */
  private legalTargetIds(): string[] {
    if (this.state.phase !== 'PLAYER') return [];
    return this.state.units
      .filter((u) => u.faction === 'ENEMY')
      .filter((u) => isVisible(this.vision, this.state.map, u.pos))
      .filter((u) => checkLegal(this.state, { type: 'FIRE', target: u.pos }).ok)
      .map((u) => u.id);
  }

  /**
   * 選取狀態的有效性。鎖定跨回合保留，只有在目標死亡、
   * 脫離視線或脫離射程時才解除（§3.3）。
   */
  private validateSelection(): void {
    const s = this.sel;
    if (!s) return;
    const me = activePlayerUnit(this.state);
    if (!me) { this.sel = null; return; }

    if (s.kind === 'TARGET') {
      const foe = findUnit(this.state, s.unitId);
      if (!foe || !isVisible(this.vision, this.state.map, foe.pos)
        || !checkLegal(this.state, { type: 'FIRE', target: foe.pos }).ok) {
        // 只有在「本來就打不到」時才留著顯示原因；死亡或消失一律清掉
        if (!foe || !isVisible(this.vision, this.state.map, foe.pos)) { this.sel = null; return; }
      }
      s.pos = { ...foe.pos };
      return;
    }
    if (s.kind === 'MOVE') {
      const path = movePath(this.state, s.pos);
      if (!path || path.length === 0) this.sel = null;
      return;
    }
    if (s.kind === 'CORPSE') {
      if (!corpseAt(this.state, s.pos)) this.sel = null;
      return;
    }
    if (s.kind === 'INTERACT') {
      if (!interactTarget(this.state, me, s.pos)) this.sel = null;
    }
  }

  // ---------------------------------------------------------------- 地圖點擊

  /**
   * 統一文法：第一下選取＋預覽，第二下執行。
   * 選取永遠不消耗 AP、彈藥或回合，所以點錯永遠無害。
   */
  private tapTile(p: Vec2): void {
    if (this.modal !== 'NONE') return;
    this.auto = null;
    this.skillOpen = false;
    const me = activePlayerUnit(this.state);
    if (!me || !inBounds(this.state.map, p)) { this.clearSel(); return; }

    // 自己 → 詳細狀態，單次點擊即可
    if (sameTile(me.pos, p) && !corpseAt(this.state, p)) {
      this.sel = { kind: 'SELF' };
      this.afterSelect();
      return;
    }

    // 敵人 → 鎖定；再點同一個就開火，鎖定保留
    const foe = unitAt(this.state, p);
    if (foe && foe.faction === 'ENEMY' && isVisible(this.vision, this.state.map, p)) {
      const s = this.sel;
      if (s && s.kind === 'TARGET' && s.unitId === foe.id
        && checkLegal(this.state, { type: 'FIRE', target: p }).ok) {
        this.fireAt(p);
        return;
      }
      this.sel = { kind: 'TARGET', pos: { ...p }, unitId: foe.id };
      this.afterSelect();
      return;
    }

    // 屍體 → 物品清單；再點一次拾取第一件
    const corpse = corpseAt(this.state, p);
    if (corpse) {
      const s = this.sel;
      if (s && s.kind === 'CORPSE' && sameTile(s.pos, p)) {
        this.pickupFirst(corpse.id);
        return;
      }
      this.sel = { kind: 'CORPSE', pos: { ...p }, corpseId: corpse.id };
      this.afterSelect();
      return;
    }

    // 相鄰的終端／補給箱／撤離點 → 顯示互動內容；再點一次執行
    if (interactTarget(this.state, me, p)) {
      const s = this.sel;
      if (s && s.kind === 'INTERACT' && sameTile(s.pos, p)) {
        this.dispatch({ type: 'INTERACT', pos: p });
        return;
      }
      this.sel = { kind: 'INTERACT', pos: { ...p } };
      this.afterSelect();
      return;
    }

    // 其餘可通行格 → 顯示路徑與 AP；再點一次沿路徑移動
    const path = movePath(this.state, p);
    if (!path || path.length === 0) { this.clearSel(); return; }   // 非法目標 → 無反應
    const s = this.sel;
    if (s && s.kind === 'MOVE' && sameTile(s.pos, p)) {
      this.startAutoMove(path);
      return;
    }
    this.sel = { kind: 'MOVE', pos: { ...p } };
    this.afterSelect();
  }

  private clearSel(): void {
    this.sel = null;
    this.afterSelect();
  }

  /** 選取不改變 GameState，所以只需要刷新畫面相關的部分。 */
  private afterSelect(): void {
    this.updateCard();
    this.updateControls();
  }

  // ---------------------------------------------------------------- 射擊

  /** 濺射會不會波及自己 —— 全遊戲唯一保留的確認彈窗。 */
  private splashHitsSelf(target: Vec2): boolean {
    const u = activePlayerUnit(this.state);
    const w = u ? u.equipped : null;
    if (!u || !w || w.splash <= 0) return false;
    return manhattan(u.pos, target) <= w.splash;
  }

  private fireAt(target: Vec2): void {
    if (this.splashHitsSelf(target)) {
      this.modal = 'SPLASH';
      showSplashConfirm(
        this.state, target,
        () => { this.modal = 'NONE'; hideModal(); this.dispatch({ type: 'FIRE', target }); },
        () => { this.modal = 'NONE'; hideModal(); this.refresh(); },
      );
      return;
    }
    this.dispatch({ type: 'FIRE', target });
  }

  private pickupFirst(corpseId: string): void {
    const u = activePlayerUnit(this.state);
    if (!u) return;
    const slot: WeaponSlot = !u.equipped ? 'EQUIPPED' : !u.stowed ? 'STOWED' : 'STOWED';
    if (!this.dispatch({ type: 'PICKUP', corpseId, weaponIndex: 0, slot })) return;
    this.clearSel();
  }

  // ---------------------------------------------------------------- 自動移動

  private visibleFoeIds(): Set<string> {
    const out = new Set<string>();
    for (const u of this.state.units) {
      if (u.faction !== 'ENEMY') continue;
      if (isVisible(this.vision, this.state.map, u.pos)) out.add(u.id);
    }
    return out;
  }

  private startAutoMove(path: Vec2[]): void {
    const u = activePlayerUnit(this.state);
    if (!u) return;
    this.auto = { path: path.slice(), foes: this.visibleFoeIds(), hp: u.hp };
    this.clearSel();
  }

  /**
   * 自動移動的一步。下列任一情況立即停止，剩餘 AP 保留：
   * AP 耗盡、有新的敵人進入視線、玩家受到傷害、路徑被阻擋。
   */
  private stepAuto(): void {
    const a = this.auto;
    if (!a) return;
    const u = activePlayerUnit(this.state);
    if (!u || this.state.phase !== 'PLAYER' || a.path.length === 0) { this.auto = null; return; }
    if (u.ap <= 0 || u.hp < a.hp) { this.auto = null; return; }
    for (const id of this.visibleFoeIds()) {
      if (!a.foes.has(id)) { this.auto = null; this.updateControls(); return; }
    }

    const next = a.path[0];
    const dir = facingFromDelta(next.x - u.pos.x, next.y - u.pos.y);
    if (!dir || !this.dispatch({ type: 'MOVE', dir })) { this.auto = null; this.updateControls(); return; }
    a.path.shift();
    a.hp = activePlayerUnit(this.state)?.hp ?? a.hp;
    if (a.path.length === 0) { this.auto = null; this.updateControls(); }
  }

  // ---------------------------------------------------------------- 控制列

  private updateControls(): void {
    const s = this.state;
    const u = activePlayerUnit(s);
    const busy = this.modal !== 'NONE' || s.phase !== 'PLAYER' || !!s.pendingReinforcement;

    // 不可用的按鈕一律灰掉，不隱藏 —— 按鈕消失會造成位移與誤觸。
    for (const btn of $$<HTMLButtonElement>('#dpad button[data-dir]')) {
      const dir = btn.dataset.dir as Facing;
      btn.disabled = busy || !checkLegal(s, { type: 'MOVE', dir }).ok;
    }
    const en = (sel: string, ok: boolean): void => {
      $<HTMLButtonElement>(sel).disabled = busy || !ok;
    };
    en('button[data-act="WAIT"]', checkLegal(s, { type: 'WAIT' }).ok);
    en('button[data-act="STANCE"]', checkLegal(s, { type: 'TOGGLE_STANCE' }).ok);
    en('button[data-act="RELOAD"]', checkLegal(s, { type: 'RELOAD' }).ok);
    en('button[data-act="SWAP"]', checkLegal(s, { type: 'SWAP_WEAPON' }).ok);
    en('button[data-act="SKILL"]', true);

    $('#lbl-stance').textContent = u && u.stance === 'STAND' ? '蹲' : '站';
    $('#lbl-reload').textContent = u && u.equipped ? String(u.equipped.reloadCost) : '—';
    const sc = u ? swapCost(u) : Infinity;
    $('#lbl-swap').textContent = Number.isFinite(sc) ? String(sc) : '—';

    $<HTMLButtonElement>('button[data-act="SKILL"]').classList.toggle('on', this.skillOpen);
    $<HTMLButtonElement>('#btn-log').classList.toggle('on', this.logOpen);
    show($('#skill-menu'), this.skillOpen);
    if (this.skillOpen) {
      $('#skill-menu').innerHTML = '<p class="note">（尚無可用技能）</p>';
    }
    this.updateBanner();
  }

  private updateBanner(): void {
    const s = this.state;
    const banner = $('#turn-banner');
    // HUD 的高度會隨 chip 換行而變，橫幅位置跟著算，避免壓到戰況損益那一行
    banner.style.top = Math.round($('#hud').getBoundingClientRect().bottom + 8) + 'px';
    const busy = this.logOpen || this.modal !== 'NONE';
    if (s.result !== 'ONGOING') { show(banner, false); return; }
    if (s.phase === 'ENEMY') {
      banner.textContent = '敵人回合';
      show(banner, !busy);
      return;
    }
    banner.textContent = '第 ' + s.turn + ' 回合';
    show(banner, !busy && !this.auto);
  }

  // ---------------------------------------------------------------- 卡片與紀錄

  /** 只有「看自己」與「翻屍體」需要卡片；射擊、移動、互動的預覽都畫在戰場上。 */
  private updateCard(): void {
    const host = $('#tile-menu');
    const s = this.sel;
    const needsCard = !!s && (s.kind === 'SELF' || s.kind === 'CORPSE');
    if (!needsCard || this.modal !== 'NONE') {
      show(host, false);
      host.innerHTML = '';
      return;
    }
    const me = activePlayerUnit(this.state);
    if (!me) { show(host, false); return; }
    const at = s.kind === 'CORPSE' ? s.pos : me.pos;
    host.innerHTML = s.kind === 'SELF'
      ? selfPanelHtml(this.state)
      : corpsePanelHtml(this.state, at);
    this.placeSheet(host, at);
    show(host, true);
    wireMenu(host, at, {
      pickup: (corpseId, weaponIndex, slot) => {
        this.dispatch({ type: 'PICKUP', corpseId, weaponIndex, slot });
        this.clearSel();
      },
      interact: (pos) => { this.dispatch({ type: 'INTERACT', pos }); this.clearSel(); },
      close: () => this.clearSel(),
    });
  }

  private placeSheet(host: HTMLElement, at: Vec2 | null): void {
    const me = activePlayerUnit(this.state);
    const below = !!me && !!at && at.y > me.pos.y;
    host.classList.toggle('sheet--top', below);
    host.classList.toggle('sheet--bottom', !below);
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
    this.placeSheet(host, null);
    show(host, true);
    this.updateBanner();
    const btn = host.querySelector<HTMLButtonElement>('button[data-close]');
    if (btn) btn.addEventListener('click', () => { this.logOpen = false; this.updateLog(); this.updateControls(); });
  }

  private updateModal(): void {
    const s = this.state;
    if (this.modal === 'SPLASH') return;
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
          () => this.askAbort(),
        );
      }
      return;
    }
    if (this.modal === 'REINFORCE') { this.modal = 'NONE'; hideModal(); }
  }

  /** 止損只在當前士兵陣亡時提供（§11.3）。取消則退回增援選單。 */
  private askAbort(): void {
    this.modal = 'ABORT';
    hideModal();
    showAbortConfirm(
      this.state,
      () => { this.modal = 'NONE'; hideModal(); this.dispatch({ type: 'ABORT' }); },
      () => { this.modal = 'NONE'; hideModal(); this.refresh(); },
    );
  }

  // ---------------------------------------------------------------- 輸入

  private bindInput(): void {
    for (const btn of $$<HTMLButtonElement>('#dpad button[data-dir]')) {
      btn.addEventListener('click', () => {
        this.auto = null;
        this.dispatch({ type: 'MOVE', dir: btn.dataset.dir as Facing });
      });
    }
    const act: Record<string, () => void> = {
      WAIT: () => { this.auto = null; this.clearSel(); this.dispatch({ type: 'WAIT' }); },
      STANCE: () => this.dispatch({ type: 'TOGGLE_STANCE' }),
      RELOAD: () => this.dispatch({ type: 'RELOAD' }),
      SWAP: () => this.dispatch({ type: 'SWAP_WEAPON' }),
      SKILL: () => { this.skillOpen = !this.skillOpen; this.updateControls(); },
    };
    for (const btn of $$<HTMLButtonElement>('#controls button[data-act]')) {
      const fn = act[btn.dataset.act as string];
      if (fn) btn.addEventListener('click', fn);
    }
    $('#btn-log').addEventListener('click', () => {
      this.logOpen = !this.logOpen;
      this.updateLog();
      this.updateControls();
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
      if (!dragging && elapsed < TAP_MS) this.tapTile(screenToTile(this.cam, p.x, p.y));
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', () => { downAt = 0; });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** 桌面瀏覽器的可選鍵盤操作（不強制，方便測試）。 */
  private bindKeyboard(): void {
    const map: Record<string, Facing> = {
      ArrowUp: 'N', ArrowDown: 'S', ArrowLeft: 'W', ArrowRight: 'E',
      Numpad8: 'N', Numpad2: 'S', Numpad4: 'W', Numpad6: 'E',
    };
    window.addEventListener('keydown', (e) => {
      if (this.modal !== 'NONE') return;
      const dir = map[e.code];
      if (dir) { e.preventDefault(); this.auto = null; this.dispatch({ type: 'MOVE', dir }); return; }
      if (e.code === 'KeyC') this.dispatch({ type: 'TOGGLE_STANCE' });
      else if (e.code === 'KeyR') this.dispatch({ type: 'RELOAD' });
      else if (e.code === 'KeyQ') this.dispatch({ type: 'SWAP_WEAPON' });
      else if (e.code === 'Space') { e.preventDefault(); this.dispatch({ type: 'WAIT' }); }
    });
  }

  // ---------------------------------------------------------------- 畫面

  private observeResize(): void {
    const stage = $('#app');
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
    this.render(now);
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
    if (this.auto && now - this.lastStep >= MOVE_STEP_MS) {
      this.lastStep = now;
      this.stepAuto();
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

  private buildLock(): Lock | null {
    const s = this.sel;
    if (!s || s.kind !== 'TARGET') return null;
    const me = activePlayerUnit(this.state);
    const foe = findUnit(this.state, s.unitId);
    if (!me || !foe || !me.equipped) return null;
    const legal = checkLegal(this.state, { type: 'FIRE', target: foe.pos });
    return {
      unitId: foe.id,
      pos: { ...foe.pos },
      name: foe.name,
      chance: legal.ok ? toHitChance(me, foe, me.equipped, this.state) : null,
      reason: legal.reason,
    };
  }

  private buildMovePreview(): MovePreview | null {
    const s = this.sel;
    if (!s || s.kind !== 'MOVE') return null;
    const me = activePlayerUnit(this.state);
    const path = movePath(this.state, s.pos);
    if (!me || !path || path.length === 0) return null;
    return { path, ap: path.length, affordable: path.length <= me.ap };
  }

  private buildInteractPreview(): InteractPreview | null {
    const s = this.sel;
    if (!s || s.kind !== 'INTERACT') return null;
    const kind = interactKindAt(this.state, s.pos);
    if (!kind) return null;
    return { pos: { ...s.pos }, label: INTERACT_LABEL[kind] ?? '互動', ap: 1 };
  }

  private render(now: number): void {
    this.cam = computeCamera(this.state.map, this.viewW, this.viewH, this.focus, this.pan);
    draw(this.ctx, this.viewW, this.viewH, {
      state: this.state,
      vision: this.vision,
      cam: this.cam,
      ghosts: this.visibleGhosts(),
      legalTargets: this.legalTargetIds(),
      lock: this.buildLock(),
      movePreview: this.buildMovePreview(),
      interactPreview: this.buildInteractPreview(),
      time: now,
    });
  }
}
