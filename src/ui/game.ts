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
import { activePlayerUnit, lootAt, findUnit, unitAt } from '../core/state';
import type { Command } from '../core/commands';
import {
  applyCommand, checkLegal, commandTime, interactKindAt, interactTarget, movePath, movePhase,
  swapTime,
} from '../core/commands';
import { activeUnit, isMissionOver, isPlayerTurn } from '../core/scheduler';
import { describe as describeSequence } from '../core/sequence';
import { createInitialState } from '../core/setup';
import { RULES } from '../core/content';
import { armorRange, damageRange, effectiveMode, hitBreakdown } from '../core/combat';
import { COVER_LABEL } from '../core/cover';
import { facingFromDelta, manhattan, sameTile } from '../core/grid';
import { inBounds } from '../core/map';
import type { Camera } from '../render/camera';
import { computeCamera, screenToTile } from '../render/camera';
import type { Ghost, InteractPreview, Lock, MovePreview } from '../render/renderer';
import { draw } from '../render/renderer';
import { EffectLayer } from '../render/effects';
import type { Vision } from '../render/vision';
import { computeVision, isVisible, visionKey } from '../render/vision';
import { $, $$, esc, show } from './dom';
import { missionPanelHtml, renderHud } from './hud';
import { lootPanelHtml, selfPanelHtml, wireMenu } from './menus';
import {
  hideModal, showAbortConfirm, showReinforcement, showSplashConfirm, showSummary,
} from './modals';
import { BUILD_ID } from './build';

const TAP_SLOP = 10;   // §12.15：超過這個位移就是拖曳，不是點擊
const TAP_MS = 700;

type ModalKind = 'NONE' | 'REINFORCE' | 'ABORT' | 'SUMMARY' | 'SPLASH';

/** 目前的選取。TARGET 就是「鎖定」，跨回合保留。 */
type Sel =
  | { kind: 'TARGET'; pos: Vec2; unitId: string }
  | { kind: 'MOVE'; pos: Vec2 }
  | { kind: 'LOOT'; pos: Vec2; lootId: string }
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
  /** 點地圖尋路移動的開關（§12.16）。預設開啟。 */
  private tapMove = true;
  /**
   * 演出期間的鏡頭強制目標（§12.15）。
   *
   * 玩家拖到別處看的時候，若不把鏡頭帶回正在行動的敵人，v0.6 花一整版
   * 建立的逐一演出等於沒有播 —— 自由鏡頭不可以悄悄把回饋可讀性吃掉。
   * 輪回玩家時清空。
   */
  private spotlight: Vec2 | null = null;
  private focus: Vec2;
  private sel: Sel = null;
  private auto: AutoMove | null = null;
  private lastStep = 0;
  private modal: ModalKind = 'NONE';
  private logOpen = false;
  private skillOpen = false;
  /** 玩家按了跳過：敵人回合直接結算到底，不再逐一演出（§12.12）。 */
  private skipEnemyTurn = false;
  private viewW = 1;
  private viewH = 1;
  /** 沒有被 HUD 與控制列蓋住的那一段畫面。攝影機夾制用（見 render/camera.ts）。 */
  private safe = { top: 0, bottom: 1 };
  /** 戰場回饋層。動畫狀態只活在這裡，不進 GameState（§12.9）。 */
  private effects = new EffectLayer();

  /** 測試用入口。正式流程一律走 canvas 的 pointer 事件與 rAF 迴圈。 */
  readonly test = {
    tap: (p: Vec2): void => this.tapTile(p),
    isPlayerTurn: (): boolean => isPlayerTurn(this.state),
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
    enemySteps: (): void => this.runEnemySteps(),
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
    const { state, events } = applyCommand(this.state, cmd);
    if (state === this.state) return false;
    this.state = state;
    this.effects.push(events, performance.now());
    if (isPlayerTurn(this.state)) this.skipEnemyTurn = false;
    this.recenter();               // 玩家做了事 → 鏡頭回到士兵（§12.15）
    this.refresh();
    return true;
  }

  restart(): void {
    this.state = createInitialState(this.seed);
    this.ghosts.clear();
    this.auto = null;
    this.sel = null;
    this.recenter();
    this.modal = 'NONE';
    this.skillOpen = false;
    this.skipEnemyTurn = false;
    this.effects.clear();
    hideModal();
    this.refresh();
  }

  // ---------------------------------------------------------------- 更新

  private refresh(): void {
    this.syncVision();
    this.updateGhosts();
    const me = activePlayerUnit(this.state);
    if (this.spotlight) this.focus = { ...this.spotlight };
    else if (me) this.focus = { ...me.pos };
    this.validateSelection();

    renderHud(this.state);
    // HUD 的 chip 會換行，高度是畫完才知道的 —— 量在 renderHud 之後，
    // 橫幅與相機才不會壓到目標列（v0.7 的序列橫幅在兩行 HUD 下踩過這個雷）
    this.measureSafeArea();
    this.updateControls();
    this.updateCard();
    this.updateLog();
    this.updateModal();
  }

  /**
   * 量出可觸區域：HUD 底部到控制列頂部。
   * HUD 會因為 chip 換行而變高，所以每次 refresh 與每次 resize 都重量一次。
   */
  private measureSafeArea(): void {
    const pad = 4;
    const hud = $('#hud').getBoundingClientRect();
    const controls = $('#controls').getBoundingClientRect();
    this.safe = {
      top: Math.max(0, hud.bottom + pad),
      bottom: Math.min(this.viewH, controls.top - pad),
    };
  }

  /** 鏡頭有沒有被玩家拖離士兵。 */
  private panned(): boolean {
    return this.pan.x !== 0 || this.pan.y !== 0;
  }

  /** 鏡頭回到士兵。任何玩家動作之後也會自動呼叫（§12.15）。 */
  private recenter(): void {
    this.pan = { x: 0, y: 0 };
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
    if (!isPlayerTurn(this.state)) return [];
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
    if (s.kind === 'LOOT') {
      if (!lootAt(this.state, s.pos)) this.sel = null;
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
    // 敵人回合中點畫面任意處 = 跳過演出，直接結算到底。
    // 結果與完整播放完全相同 —— 規則解算本來就與演出無關。
    if (!isPlayerTurn(this.state) && !this.state.pendingReinforcement && !isMissionOver(this.state)) {
      // 敵方行動演出中，點畫面任意處 = 跳過，直接結算到再次輪到玩家
      this.skipEnemyTurn = true;
      this.updateControls();
      return;
    }
    this.auto = null;
    this.skillOpen = false;
    const me = activePlayerUnit(this.state);
    if (!me || !inBounds(this.state.map, p)) { this.clearSel(); return; }

    // 自己 → 詳細狀態，單次點擊即可
    if (sameTile(me.pos, p) && !lootAt(this.state, p)) {
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
    const pile = lootAt(this.state, p);
    if (pile) {
      const s = this.sel;
      if (s && s.kind === 'LOOT' && sameTile(s.pos, p)) {
        // 第二下 = 全部拿走（§4.3）。要挑就用面板上的個別按鈕。
        this.dispatch({ type: 'TAKE_ALL', lootId: pile.id });
        this.clearSel();
        return;
      }
      this.sel = { kind: 'LOOT', pos: { ...p }, lootId: pile.id };
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

    // 其餘可通行格 → 顯示路徑與總時間；再點一次沿路徑移動。
    // 這一段（也只有這一段）受「點地圖移動」開關控制 —— 鎖定、屍體、
    // 互動、看自己都不受影響（§12.16）。
    if (!this.tapMove) { this.clearSel(); return; }
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
    if (!u || !isPlayerTurn(this.state) || a.path.length === 0) { this.auto = null; return; }
    if (u.hp < a.hp) { this.auto = null; return; }
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
    const busy = this.modal !== 'NONE' || !isPlayerTurn(s);

    // 不可用的按鈕一律灰掉，不隱藏 —— 按鈕消失會造成位移與誤觸。
    for (const btn of $$<HTMLButtonElement>('#dpad button[data-dir]')) {
      const dir = btn.dataset.dir as Facing;
      btn.disabled = busy || !checkLegal(s, { type: 'MOVE', dir }).ok;
      // 蹲姿時同一顆鍵有兩種意思，玩家必須在按下去之前就分得出來（§12.14）
      const phase = u && u.stance === 'CROUCH' ? movePhase(u, dir) : null;
      btn.classList.toggle('will-turn', phase === 'TURN');
      btn.classList.toggle('will-step', phase === 'STEP');
    }
    const en = (sel: string, ok: boolean): void => {
      $<HTMLButtonElement>(sel).disabled = busy || !ok;
    };
    en('button[data-act="WAIT"]', checkLegal(s, { type: 'WAIT' }).ok);
    en('button[data-act="STANCE"]', checkLegal(s, { type: 'TOGGLE_STANCE' }).ok);
    const inSeq = !!u && !!u.pendingSequence;
    en('button[data-act="RELOAD"]',
      inSeq ? checkLegal(s, { type: 'SEQUENCE_STEP' }).ok : checkLegal(s, { type: 'RELOAD' }).ok);
    en('button[data-act="SWAP"]', checkLegal(s, { type: 'SWAP_WEAPON' }).ok);
    en('button[data-act="MODE"]', checkLegal(s, { type: 'CYCLE_FIRE_MODE' }).ok);

    // 射擊模式（§2.5）：按鈕上顯示**實際會用的**模式與耗彈量。
    // 彈藥不足時自動降級，但絕不無聲降級 —— 降級的模式要看得出來（§2.6）。
    const w = u ? u.equipped : null;
    const shown = w ? effectiveMode(w) : 'SINGLE';
    const down = !!w && shown !== w.mode;
    $('#lbl-mode').textContent = w ? RULES.fireModes[shown].label : '—';
    $('#lbl-mode-ammo').textContent = w ? String(RULES.fireModes[shown].shots) : '—';
    $<HTMLButtonElement>('button[data-act="MODE"]').classList.toggle('downgraded', down);
    $<HTMLButtonElement>('button[data-act="MODE"]').title = w && down
      ? '彈藥不足，實際會用' + RULES.fireModes[shown].label + '發'
      : '射擊模式（不花時間）';
    en('button[data-act="SKILL"]', true);

    $('#lbl-stance').textContent = u && u.stance === 'STAND' ? '蹲' : '站';
    // 按鈕上顯示的是**時間花費**，不再是 AP（§7.2）
    $('#lbl-reload').textContent = inSeq
      ? String(commandTime(s, { type: 'SEQUENCE_STEP' }) ?? 0)
      : (u && u.equipped ? String(u.equipped.reloadTime) : '—');
    $<HTMLButtonElement>('button[data-act="RELOAD"]').querySelector('b')!.textContent =
      inSeq ? '續' : '彈';
    const sw = u ? swapTime(u) : Infinity;
    $('#lbl-swap').textContent = Number.isFinite(sw) ? String(sw) : '—';

    $<HTMLButtonElement>('button[data-act="SKILL"]').classList.toggle('on', this.skillOpen);
    $<HTMLButtonElement>('#btn-log').classList.toggle('on', this.logOpen);
    $<HTMLButtonElement>('#btn-tapmove').classList.toggle('off', !this.tapMove);
    show($('#btn-recenter'), this.panned());
    show($('#skill-menu'), this.skillOpen);
    if (this.skillOpen) {
      $('#skill-menu').innerHTML = '<p class="note">（尚無可用技能）</p>';
    }
    this.updateBanner();
  }

  private updateBanner(): void {
    const s = this.state;
    const banner = $('#turn-banner');
    banner.style.top = Math.round(this.safe.top) + 'px';
    const busy = this.logOpen || this.modal !== 'NONE';
    if (isMissionOver(s)) { show(banner, false); return; }

    // 承諾中：讓玩家看得出自己正在蓄勢，以及還剩幾步（§5.5）
    const me = activePlayerUnit(s);
    if (me && me.pendingSequence) {
      banner.textContent = describeSequence(me.pendingSequence);
      show(banner, !busy);
      return;
    }
    if (!isPlayerTurn(s) && !s.pendingReinforcement) {
      banner.textContent = this.skipEnemyTurn ? '敵方行動中（結算）' : '敵方行動中　點畫面跳過';
      show(banner, !busy);
      return;
    }
    // 玩家可以行動時不顯示橫幅 —— 沒有「回合」這個東西可以報
    show(banner, false);
  }

  // ---------------------------------------------------------------- 卡片與紀錄

  /** 只有「看自己」與「翻屍體」需要卡片；射擊、移動、互動的預覽都畫在戰場上。 */
  private updateCard(): void {
    const host = $('#tile-menu');
    const s = this.sel;
    const needsCard = !!s && (s.kind === 'SELF' || s.kind === 'LOOT');
    if (!needsCard || this.modal !== 'NONE') {
      show(host, false);
      host.innerHTML = '';
      return;
    }
    const me = activePlayerUnit(this.state);
    if (!me) { show(host, false); return; }
    const at = s.kind === 'LOOT' ? s.pos : me.pos;
    host.innerHTML = s.kind === 'SELF'
      ? selfPanelHtml(this.state)
      : lootPanelHtml(this.state, at);
    this.placeSheet(host, at);
    show(host, true);
    wireMenu(host, at, {
      pickup: (lootId, itemIndex, slot) => {
        this.dispatch({ type: 'PICKUP', lootId, itemIndex, slot });
        // 面板留著：搜刮通常要連拿好幾樣，關掉會很煩
        this.updateCard();
      },
      takeAll: (lootId) => { this.dispatch({ type: 'TAKE_ALL', lootId }); this.updateCard(); },
      interact: (pos) => { this.dispatch({ type: 'INTERACT', pos }); this.clearSel(); },
      abortSequence: () => { this.dispatch({ type: 'ABORT_SEQUENCE' }); this.clearSel(); },
      close: () => this.clearSel(),
    });
  }

  /**
   * 小卡的位置與高度。
   *
   * 高度**必須量出來**，不能用 `50dvh` 那種比例：直向手機扣掉網址列之後
   * 可視高度只剩約 550px，50dvh 減掉方向盤與留白之後只剩二十幾像素，
   * 卡片會整個塌掉 —— 比例值撐不住真實的手機高度。
   *
   * 卡片可以蓋住地圖，用滿整個可觸區域。§12.8 的「士兵與四個鄰格不能被蓋住」
   * 管的是**常駐 UI**（HUD 與控制列），不是這種讀完就關掉的清單卡片：
   * 打開它的當下你在讀清單、按按鈕，不是在點地圖。
   * 原本為了不越過畫面中線而砍高度，結果是搜刮面板只剩 96px、一次看兩件東西。
   */
  private placeSheet(host: HTMLElement, at: Vec2 | null): void {
    const me = activePlayerUnit(this.state);
    const below = !!me && !!at && at.y > me.pos.y;
    host.classList.toggle('sheet--top', below);
    host.classList.toggle('sheet--bottom', !below);
    host.style.maxHeight = Math.round(Math.max(120, this.safe.bottom - this.safe.top)) + 'px';
  }

  private updateLog(): void {
    const host = $('#log-panel');
    if (!this.logOpen) { show(host, false); this.updateBanner(); return; }
    const items = this.state.log.slice(-40).reverse()
      .map((l) => '<li class="kind-' + l.kind + '">[' + l.at + '] ' + esc(l.text) + '</li>')
      .join('');
    // 任務帳目擺在紀錄上方：HUD 讓出來的那幾行搬到這裡（§12.6）
    host.innerHTML = '<h3>戰況<button class="close" data-close="1">關閉</button></h3>'
      + missionPanelHtml(this.state)
      + '<h3 class="sub">戰鬥紀錄</h3>'
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
      // 承諾中時，「彈」鍵變成「繼續下一步」；長按以外的中止入口在自己的狀態卡片上
      RELOAD: () => {
        const me = activePlayerUnit(this.state);
        if (me && me.pendingSequence) this.dispatch({ type: 'SEQUENCE_STEP' });
        else this.dispatch({ type: 'RELOAD' });
      },
      SWAP: () => this.dispatch({ type: 'SWAP_WEAPON' }),
      MODE: () => this.dispatch({ type: 'CYCLE_FIRE_MODE' }),
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
    $('#btn-tapmove').addEventListener('click', () => {
      this.tapMove = !this.tapMove;
      // 關掉時把還掛著的移動預覽收掉，免得留一條走不了的路徑在畫面上
      if (!this.tapMove && this.sel && this.sel.kind === 'MOVE') this.clearSel();
      this.updateControls();
    });
    $('#btn-recenter').addEventListener('click', () => {
      this.recenter();
      this.refresh();
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
      // 拖曳只在玩家自己決策的期間有效：演出時鏡頭歸演出管（§12.15）
      if (dragging && isPlayerTurn(this.state) && this.modal === 'NONE') {
        this.pan = { x: panStart.x + dx, y: panStart.y + dy };
      }
    });
    const end = (e: PointerEvent): void => {
      if (!downAt) return;
      const elapsed = performance.now() - downAt;
      const p = local(e);
      downAt = 0;
      if (dragging) { this.updateControls(); return; }   // 讓置中鍵出現
      if (elapsed < TAP_MS) this.tapTile(screenToTile(this.cam, p.x, p.y));
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
      this.measureSafeArea();
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
    if (isMissionOver(s) || s.pendingReinforcement) return;

    if (!isPlayerTurn(s)) {
      if (this.skipEnemyTurn || now - this.lastStep >= RULES.presentation.enemyStepMs) {
        this.lastStep = now;
        this.runEnemySteps();
      }
      return;
    }
    if (this.auto && now - this.lastStep >= RULES.presentation.playerMoveStepMs) {
      this.lastStep = now;
      this.stepAuto();
    }
  }

  /**
   * 敵人回合：玩家看得見的動作逐步播放，看不見的直接快轉。
   * 十個敵人各自 IDLE 時不該讓玩家乾等一秒半。
   */
  private runEnemySteps(): void {
    // 看不見的動作全部瞬間結算，所以額度要夠大 ——
    // 「整個敵人回合都沒有可見動作」時必須完全沒有停頓（§12.12）。
    let budget = 600;
    while (budget-- > 0) {
      const actor = activeUnit(this.state);
      const id = actor ? actor.id : null;
      const wasVisible = !!actor && isVisible(this.vision, this.state.map, actor.pos);
      const hpBefore = activePlayerUnit(this.state)?.hp ?? 0;

      const { state, events } = applyCommand(this.state, { type: 'ADVANCE' });
      if (state === this.state) break;
      this.state = state;
      this.effects.push(events, performance.now());
      if (isPlayerTurn(this.state)) this.skipEnemyTurn = false;
      this.syncVision();

      const after = id ? findUnit(this.state, id) : null;
      const nowVisible = !!after && isVisible(this.vision, this.state.map, after.pos);
      const hpAfter = activePlayerUnit(this.state)?.hp ?? 0;

      if (isPlayerTurn(this.state) || this.state.pendingReinforcement || isMissionOver(this.state)) break;
      if (this.skipEnemyTurn) continue;   // 跳過：只結算，不停下來演
      if (wasVisible || nowVisible || hpAfter !== hpBefore) {
        // 鏡頭強制帶到正在行動的那個單位，並取消玩家的手動平移（§12.15）
        this.spotlight = { ...(after ? after.pos : (actor as { pos: Vec2 }).pos) };
        this.recenter();
        break;
      }
    }
    if (isPlayerTurn(this.state) || this.state.pendingReinforcement || isMissionOver(this.state)) {
      this.spotlight = null;
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
    const bd = hitBreakdown(me, foe, me.equipped, this.state);
    return {
      unitId: foe.id,
      pos: { ...foe.pos },
      name: foe.name,
      chance: legal.ok ? bd.chance : null,
      reason: legal.reason,
      damage: damageRange(me.equipped, foe),
      armor: armorRange(foe),
      time: me.equipped.fireTime,
      // 預覽只顯示**當前模式**的數值，不列出其他模式（§2.6）。
      // 降級時要寫出來，玩家才知道自己按的跟實際發生的不一樣。
      modeNote: bd.shots > 1 || me.equipped.modes.length > 1
        ? RULES.fireModes[bd.mode].label + '發 ' + bd.shots + ' 發'
          + (bd.downgraded ? '（彈藥不足，已降級）' : '')
        : '',
      shots: bd.shots,
      // 只給一個變小的數字沒有用：要說出等級與幅度，玩家才知道該繞側翼（§12.10）
      // 背刺會把掩蔽歸零，此時要寫「掩蔽已失效」而不是把掩蔽藏起來 ——
      // 玩家要看得出「本來有掩蔽，是我繞到背後才沒用的」（§12.10）
      coverNote: bd.coverLevel === 'NONE'
        ? ''
        : bd.backstab
          ? COVER_LABEL[bd.coverLevel] + ' 已失效'
          : COVER_LABEL[bd.coverLevel] + ' −' + Math.round(bd.cover * 100) + '%',
      coverTiles: bd.coverTiles,
      backstabNote: bd.backstab
        ? '背刺 +' + Math.round(bd.backstabBonus * 100) + '%'
          + (RULES.combat.backstab.ignoreCover ? '・無視掩蔽' : '')
        : '',
    };
  }

  private buildMovePreview(): MovePreview | null {
    const s = this.sel;
    if (!s || s.kind !== 'MOVE') return null;
    const me = activePlayerUnit(this.state);
    const path = movePath(this.state, s.pos);
    if (!me || !path || path.length === 0) return null;
    // 尋路預覽顯示的是**總時間花費**，不是 AP（§7.2）
    return { path, time: path.length * me.moveTime, affordable: true };
  }

  private buildInteractPreview(): InteractPreview | null {
    const s = this.sel;
    if (!s || s.kind !== 'INTERACT') return null;
    const kind = interactKindAt(this.state, s.pos);
    if (!kind) return null;
    return {
      pos: { ...s.pos },
      label: INTERACT_LABEL[kind] ?? '互動',
      time: commandTime(this.state, { type: 'INTERACT', pos: s.pos }) ?? RULES.time.interact,
    };
  }

  private render(now: number): void {
    this.cam = computeCamera(this.state.map, this.viewW, this.viewH, this.focus, this.pan, this.safe);
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
    // 回饋層畫在最上層。它只是被畫出來，不會擋住輸入也不會延後回合推進。
    // 口令要知道「這個敵人看不看得見」與「玩家在哪」：
    // 看得見畫在頭上，只聽得到就只報方位（§12.18）。
    this.effects.draw(this.ctx, this.cam, now, {
      seesUnit: (id) => {
        const u = findUnit(this.state, id);
        return !!u && isVisible(this.vision, this.state.map, u.pos);
      },
      anchor: activePlayerUnit(this.state)?.pos ?? null,
    });
  }
}
