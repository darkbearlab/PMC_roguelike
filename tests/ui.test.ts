// @vitest-environment jsdom
/**
 * UI 層冒煙測試：確認 DOM 選擇器、按鈕接線與情境選單真的能跑，
 * 而不是只有型別過得去。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { resetToHitPolicy, setToHitPolicy } from '../src/core/combat';
import { readFileSync } from 'node:fs';

function stubCanvas(): void {
  const noop = (): void => {};
  const ctx = new Proxy(
    { canvas: null, setTransform: noop, measureText: () => ({ width: 10 }) },
    { get: (t, k) => (k in t ? (t as never)[k] : noop), set: () => true },
  );
  (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).getContext = () => ctx;
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
  vi.stubGlobal('requestAnimationFrame', () => 0);
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { x: 0, y: 0, width: 390, height: 480, top: 0, left: 0, right: 390, bottom: 480,
      toJSON: () => ({}) } as DOMRect;
  };
}

function mount(): void {
  const html = readFileSync('index.html', 'utf8');
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');
}

describe('UI 冒煙測試', () => {
  beforeEach(() => {
    stubCanvas();
    mount();
  });

  afterEach(() => resetToHitPolicy());

  it('可以建立 Game，HUD 立刻反映初始狀態', async () => {
    const { Game } = await import('../src/ui/game');
    const g = new Game(1);
    expect(document.querySelector('#hud-hp')!.textContent).toBe('HP 10/10');
    expect(document.querySelector('#hud-weapon')!.textContent).toContain('AR-9 6/6');
    expect(document.querySelector('#hud-roster')!.textContent).toBe('名冊 3');
    expect(document.querySelector('#hud-foes')!.textContent).toBe('敵 10');
    expect(document.querySelectorAll('#hud-ap i.full')).toHaveLength(2);
    expect(g.state.turn).toBe(1);
  });

  it('方向鍵會發出 MOVE 指令並更新 HUD 的 AP 圓點', async () => {
    const { Game } = await import('../src/ui/game');
    const g = new Game(1);
    const before = { ...g.state.units[0].pos };
    document.querySelector<HTMLButtonElement>('#dpad button[data-dir="S"]')!.click();
    expect(g.state.units[0].pos).not.toEqual(before);
    expect(document.querySelectorAll('#hud-ap i.full')).toHaveLength(1);
  });

  it('不合法的動作按鈕會被灰化，不是點下去才拒絕', async () => {
    const { Game } = await import('../src/ui/game');
    new Game(1);
    // 起始位置在左上角空投點：往北是牆
    expect(document.querySelector<HTMLButtonElement>('#dpad button[data-dir="N"]')!.disabled).toBe(true);
    // 滿彈時不能裝填
    expect(document.querySelector<HTMLButtonElement>('#actions button[data-act="RELOAD"]')!.disabled).toBe(true);
    // 開場沒有任何敵人在視線與射程內
    expect(document.querySelector<HTMLButtonElement>('#actions button[data-act="FIRE"]')!.disabled).toBe(true);
    // 換武器可用（收納著 RR-4）
    expect(document.querySelector<HTMLButtonElement>('#actions button[data-act="SWAP"]')!.disabled).toBe(false);
  });

  it('姿勢鍵免費切換，且按鈕文字跟著換', async () => {
    const { Game } = await import('../src/ui/game');
    const g = new Game(1);
    expect(document.querySelector('#lbl-stance')!.textContent).toBe('蹲');
    document.querySelector<HTMLButtonElement>('#actions button[data-act="STANCE"]')!.click();
    expect(g.state.units[0].stance).toBe('CROUCH');
    expect(g.state.units[0].ap).toBe(2);
    expect(document.querySelector('#lbl-stance')!.textContent).toBe('站');
  });

  it('HUD 上沒有止損按鈕，止損只在當前士兵陣亡時才出現', async () => {
    const { Game } = await import('../src/ui/game');
    const g = new Game(1);
    expect(document.querySelector('#btn-abort')).toBeNull();
    expect(document.querySelector('#modal-root')!.classList.contains('hidden')).toBe(true);

    // 製造一次陣亡 → 增援選單，止損選項在這裡才浮現
    const me = g.state.units.find((u) => u.faction === 'PLAYER')!;
    me.hp = 3;
    g.dispatch({ type: 'FIRE', target: { ...me.pos } });

    const modal = document.querySelector('#modal-root')!;
    expect(modal.classList.contains('hidden')).toBe(false);
    expect(modal.textContent).toContain('已陣亡');
    expect(modal.querySelector('button[data-abort]')).not.toBeNull();

    // 止損仍需二次確認（§11.3）
    modal.querySelector<HTMLButtonElement>('button[data-abort]')!.click();
    expect(document.querySelector('#modal-root')!.textContent).toContain('確認止損');
    expect(document.querySelector('#modal-root')!.textContent).toContain('投入 1 名');

    // 取消 → 退回增援選單，任務繼續
    document.querySelector<HTMLButtonElement>('#modal-root button[data-no]')!.click();
    expect(g.state.result).toBe('ONGOING');
    expect(document.querySelector('#modal-root')!.textContent).toContain('已陣亡');

    // 再按一次並確認 → 結算
    document.querySelector<HTMLButtonElement>('#modal-root button[data-abort]')!.click();
    document.querySelector<HTMLButtonElement>('#modal-root button[data-yes]')!.click();
    expect(g.state.result).toBe('ABORTED');
    expect(document.querySelector('#modal-root')!.textContent).toContain('任務中止');
    expect(document.querySelector('#modal-root')!.textContent).toContain('回合數');

    document.querySelector<HTMLButtonElement>('#modal-root button[data-restart]')!.click();
    expect(g.state.result).toBe('ONGOING');
    expect(g.state.turn).toBe(1);
  });

  it('浮動面板依目標位置決定靠上或靠下，不會蓋住正中央的士兵', async () => {
    const { Game } = await import('../src/ui/game');
    const g = new Game(1);
    const me = g.state.units.find((u) => u.faction === 'PLAYER')!;
    const panel = document.querySelector('#tile-menu')!;

    g.tapTileForTest({ x: me.pos.x, y: me.pos.y + 3 });   // 目標在下方
    expect(panel.classList.contains('sheet--top')).toBe(true);

    g.tapTileForTest({ x: me.pos.x + 2, y: me.pos.y });   // 目標在同高
    expect(panel.classList.contains('sheet--bottom')).toBe(true);
  });

  it('未命中路徑在 UI 上不會炸掉，戰鬥紀錄看得到「未命中」', async () => {
    setToHitPolicy(() => 0);
    const { Game } = await import('../src/ui/game');
    const g = new Game(1);
    // 把一個敵人搬到玩家旁邊（測試捷徑；下一次 dispatch 會複製整個狀態）
    const me = g.state.units.find((u) => u.faction === 'PLAYER')!;
    const foe = g.state.units.find((u) => u.faction === 'ENEMY')!;
    foe.pos = { x: me.pos.x + 1, y: me.pos.y };
    const hpBefore = foe.hp;
    const ammoBefore = me.equipped!.ammo;

    expect(g.dispatch({ type: 'FIRE', target: { x: me.pos.x + 1, y: me.pos.y } })).toBe(true);

    const foeAfter = g.state.units.find((u) => u.id === foe.id)!;
    const meAfter = g.state.units.find((u) => u.faction === 'PLAYER')!;
    expect(foeAfter.hp).toBe(hpBefore);                    // 不扣血
    expect(meAfter.equipped!.ammo).toBe(ammoBefore - 1);    // 照扣彈藥
    expect(meAfter.ap).toBe(1);                             // 照扣 AP

    document.querySelector<HTMLButtonElement>('#actions button[data-act="LOG"]')!.click();
    expect(document.querySelector('#log-panel')!.textContent).toContain('未命中');
    expect(document.querySelector('#hud-weapon')!.textContent).toContain('5/6');
  });

  it('紀錄面板可以開關', async () => {
    const { Game } = await import('../src/ui/game');
    new Game(1);
    const panel = document.querySelector('#log-panel')!;
    expect(panel.classList.contains('hidden')).toBe(true);
    document.querySelector<HTMLButtonElement>('#actions button[data-act="LOG"]')!.click();
    expect(panel.classList.contains('hidden')).toBe(false);
    expect(panel.textContent).toContain('任務開始');
  });
});
