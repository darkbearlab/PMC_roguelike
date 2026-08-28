// @vitest-environment jsdom
/**
 * UI 層測試：統一的地圖點擊文法（§2）、射擊（§3）、尋路移動（§4）、
 * 目標框（§5）與按鈕配置（§6）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { isPlayerTurn } from '../src/core/scheduler';
import { readFileSync } from 'node:fs';
import { resetToHitPolicy, setToHitPolicy } from '../src/core/combat';
import { freezeCombat, testWeapon, thawCombat } from './helpers';
import type { Game as GameType } from '../src/ui/game';

function stubCanvas(): void {
  const noop = (): void => {};
  const ctx = new Proxy(
    {
      canvas: null, setTransform: noop, measureText: () => ({ width: 10 }),
      createRadialGradient: () => ({ addColorStop: noop }),
    },
    { get: (t, k) => (k in t ? (t as never)[k] : noop), set: () => true },
  );
  (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).getContext = () => ctx;
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
  vi.stubGlobal('requestAnimationFrame', () => 0);
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { x: 0, y: 0, width: 390, height: 844, top: 0, left: 0, right: 390, bottom: 844,
      toJSON: () => ({}) } as DOMRect;
  };
}

function mount(): void {
  const html = readFileSync('index.html', 'utf8');
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');
}

const q = <T extends HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const btn = (sel: string): HTMLButtonElement => {
  const b = q<HTMLButtonElement>(sel);
  if (!b) throw new Error('找不到按鈕 ' + sel);
  return b;
};

/**
 * 開一場，把士兵搬到中央大廳第 9 列（x=1..20 全是地板、視線通透），
 * 清掉原有敵人，改放測試需要的。
 */
async function scene(foes: { at: [number, number]; archetype?: string; hp?: number }[] = []) {
  const { Game } = await import('../src/ui/game');
  const { makeEnemy } = await import('../src/core/setup');
  const g: GameType = new Game(1);
  // 這一組測的是點擊文法與按鈕，不是戰爭迷霧 —— 全部視為已探索。
  g.state.explored = '1'.repeat(g.state.map.width * g.state.map.height);
  g.state.units = g.state.units.filter((u) => u.faction === 'PLAYER');
  g.state.units[0].pos = { x: 5, y: 9 };
  foes.forEach((f, i) => {
    const e = makeEnemy(g.state, f.archetype ?? 'RUNNER', i, { x: f.at[0], y: f.at[1] });
    if (f.hp !== undefined) { e.hp = f.hp; e.maxHp = f.hp; }   // 墊高血量，避免一發就死掩蓋掉要測的東西
    g.state.units.push(e);
  });
  g.test.refresh();
  return g;
}

// UI 測的是互動文法，不是浮動：凍結浮動，斷言才寫得出確切血量。
beforeAll(() => freezeCombat());
afterAll(() => thawCombat());

describe('§6 按鈕配置', () => {
  beforeEach(() => { stubCanvas(); mount(); });
  afterEach(() => resetToHitPolicy());

  it('沒有開火鍵、沒有右側蹲鍵、沒有右下日誌鍵', async () => {
    const { Game } = await import('../src/ui/game');
    new Game(1);
    expect(q('button[data-act="FIRE"]')).toBeNull();
    expect(q('#actions button[data-act="STANCE"]')).toBeNull();
    expect(q('#actions button[data-act="LOG"]')).toBeNull();
  });

  it('左下是兩列六格，左上角留空，蹲立在右上角', async () => {
    const { Game } = await import('../src/ui/game');
    new Game(1);
    const cells = Array.from(document.querySelectorAll('#dpad > *'));
    expect(cells).toHaveLength(6);
    expect(cells[0].className).toContain('pad-blank');           // 左上留空
    expect((cells[1] as HTMLElement).dataset.dir).toBe('N');
    expect((cells[2] as HTMLElement).dataset.act).toBe('STANCE'); // 右上角
    expect((cells[3] as HTMLElement).dataset.dir).toBe('W');
    expect((cells[4] as HTMLElement).dataset.dir).toBe('S');
    expect((cells[5] as HTMLElement).dataset.dir).toBe('E');
    // 只有四方向
    expect(document.querySelectorAll('#dpad button[data-dir]')).toHaveLength(4);
    for (const d of ['NE', 'SE', 'SW', 'NW']) {
      expect(q(`#dpad button[data-dir="${d}"]`)).toBeNull();
    }
  });

  it('待機獨立於方向盤之外，右下只有技能／彈／換', async () => {
    const { Game } = await import('../src/ui/game');
    new Game(1);
    const wait = btn('button[data-act="WAIT"]');
    expect(wait.closest('#dpad')).toBeNull();
    expect(wait.parentElement!.id).toBe('move-cluster');
    const acts = Array.from(document.querySelectorAll('#actions button')).map(
      (b) => (b as HTMLElement).dataset.act);
    // v0.12：技能與背包合併成一顆「包」，並空出位置給「用」（§12.20）
    expect(acts).toEqual(['MODE', 'BAG', 'USE', 'RELOAD', 'SWAP']);
  });

  it('背包鍵可開合，開啟不花時間（§12.20）', async () => {
    const { Game } = await import('../src/ui/game');
    const g = new Game(1);
    const sheet = q('#tile-menu')!;
    expect(sheet.classList.contains('hidden')).toBe(true);
    const before = g.state.clock;

    btn('button[data-act="BAG"]').click();
    expect(sheet.classList.contains('hidden')).toBe(false);
    expect(sheet.textContent).toContain('背包');
    expect(sheet.textContent).toContain('負重');
    expect(g.state.clock).toBe(before);          // 檢視是資訊，不是行動

    btn('button[data-act="BAG"]').click();
    expect(sheet.classList.contains('hidden')).toBe(true);
  });

  it('「用」鍵在準備欄為空時是灰的', async () => {
    const { Game } = await import('../src/ui/game');
    new Game(1);
    expect(btn('button[data-act="USE"]').disabled).toBe(true);
  });

  it('日誌開合在右上，且不可用按鈕是灰掉而非隱藏', async () => {
    const { Game } = await import('../src/ui/game');
    new Game(1);
    const log = btn('#btn-log');
    expect(log.closest('#controls')).toBeNull();
    const before = document.querySelectorAll('#controls button').length;
    log.click();
    expect(q('#log-panel')!.classList.contains('hidden')).toBe(false);
    // 開場滿彈 → 裝填不可用，但按鈕仍在原位
    expect(btn('button[data-act="RELOAD"]').disabled).toBe(true);
    expect(document.querySelectorAll('#controls button').length).toBe(before);
  });
});

describe('§2/§3 統一點擊文法與射擊', () => {
  beforeEach(() => { stubCanvas(); mount(); });
  afterEach(() => resetToHitPolicy());

  it('點敵人一次只是鎖定：不消耗 AP、彈藥或回合', async () => {
    const g = await scene([{ at: [8, 9] }]);
    const before = JSON.stringify(g.state);
    g.test.tap({ x: 8, y: 9 });
    expect(g.test.selection()).toBe('TARGET:E01');
    expect(JSON.stringify(g.state)).toBe(before);
  });

  it('再點同一個敵人即開火，且鎖定保留', async () => {
    const g = await scene([{ at: [8, 9], hp: 100 }]);
    g.test.tap({ x: 8, y: 9 });
    const hp = g.state.units.find((u) => u.id === 'E01')!.hp;
    const ammo = g.state.units[0].equipped!.ammo;
    g.test.tap({ x: 8, y: 9 });
    expect(g.state.units.find((u) => u.id === 'E01')!.hp).toBe(hp - 30);
    expect(g.state.units[0].equipped!.ammo).toBe(ammo - 1);
    expect(g.test.selection()).toBe('TARGET:E01');    // 鎖定保留
  });

  it('鎖定跨回合保留：換回合後一下就開火', async () => {
    // 用裝甲型：AR-9 每發只造成 10 點（保底），兩槍打不死，鎖定才活得過這一回合
    const g = await scene([{ at: [8, 9], archetype: 'HULK' }]);
    g.test.tap({ x: 8, y: 9 });
    g.test.tap({ x: 8, y: 9 });          // 第一槍，AP 2 -> 1
    g.test.tap({ x: 8, y: 9 });          // 第二槍，AP 歸零 -> 敵人回合
    expect(g.state.units.find((u) => u.id === 'E01')!.hp).toBe(70);

    let guard = 0;
    while (!isPlayerTurn(g.state) && guard++ < 200) g.dispatch({ type: 'ADVANCE' });
    expect(isPlayerTurn(g.state)).toBe(true);
    expect(g.test.selection()).toBe('TARGET:E01');   // 鎖定活過回合

    const foe = g.state.units.find((u) => u.id === 'E01')!;
    g.test.tap({ ...foe.pos });           // 新回合的第一下就是開火
    expect(g.state.units.find((u) => u.id === 'E01')!.hp).toBe(60);
  });

  it('點另一個敵人只改變鎖定，不開火', async () => {
    const g = await scene([{ at: [8, 9] }, { at: [5, 7] }]);
    g.test.tap({ x: 8, y: 9 });
    const before = JSON.stringify(g.state);
    g.test.tap({ x: 5, y: 7 });
    expect(g.test.selection()).toBe('TARGET:E02');
    expect(JSON.stringify(g.state)).toBe(before);
  });

  it('IDLE 的敵人可以被選取並攻擊（偷襲是核心玩法）', async () => {
    const g = await scene([{ at: [8, 9] }]);
    expect(g.state.units.find((u) => u.id === 'E01')!.aiState).toBe('IDLE');
    g.test.tap({ x: 8, y: 9 });
    expect(g.test.selection()).toBe('TARGET:E01');
    g.test.tap({ x: 8, y: 9 });
    // v0.6：衝鋒型 25 血，步槍命中一發必死
    expect(g.state.units.find((u) => u.id === 'E01')).toBeUndefined();
  });

  it('看得見但超出曼哈頓射程時不算合法目標，但仍然看得見', async () => {
    const g = await scene([{ at: [14, 9] }]);   // 曼哈頓 9 > 射程 8
    g.test.tap({ x: 14, y: 9 });
    const before = JSON.stringify(g.state);
    g.test.tap({ x: 14, y: 9 });                 // 第二下不會開火
    expect(JSON.stringify(g.state)).toBe(before);
  });

  it('濺射會波及自己時跳出確認；取消則什麼都沒發生', async () => {
    const g = await scene([{ at: [6, 9] }]);
    g.state.units[0].equipped = testWeapon('rr4');   // 濺射半徑 1
    g.test.tap({ x: 6, y: 9 });
    const before = JSON.stringify(g.state);
    g.test.tap({ x: 6, y: 9 });
    const modal = q('#modal-root')!;
    expect(modal.classList.contains('hidden')).toBe(false);
    expect(modal.textContent).toContain('濺射');
    btn('#modal-root button[data-no]').click();
    expect(JSON.stringify(g.state)).toBe(before);

    g.test.tap({ x: 6, y: 9 });
    btn('#modal-root button[data-yes]').click();
    expect(g.state.units.find((u) => u.id === 'E01')).toBeUndefined();
    // v0.6：士兵 60 血、RR-4 濺射對自己是 60 —— 貼臉開砲會把自己一起帶走，
    // 這正是那個確認彈窗存在的理由
    expect(g.state.pendingReinforcement).not.toBeNull();
    expect(g.state.casualties).toBe(1);
  });

  it('動畫播放中仍可輸入，回合推進不被延後', async () => {
    const g = await scene([{ at: [8, 9], archetype: 'HULK' }]);
    g.test.tap({ x: 8, y: 9 });
    g.test.tap({ x: 8, y: 9 });                 // 開第一槍，回饋動畫開始播
    expect(g.state.units[0].nextActAt).toBe(10);

    // 動畫還在播的當下立刻再開一槍 —— 不應該被擋、也不應該被延後
    g.test.tap({ x: 8, y: 9 });
    expect(g.state.units[0].nextActAt).toBe(20);
    expect(g.state.units.find((u) => u.id === 'E01')!.hp).toBe(70);
    // AP 歸零就該立刻進敵人回合，不會等動畫播完
    expect(isPlayerTurn(g.state)).toBe(false);
  });

  it('一般射擊不跳任何對話框', async () => {
    const g = await scene([{ at: [8, 9] }]);
    g.test.tap({ x: 8, y: 9 });
    g.test.tap({ x: 8, y: 9 });
    expect(q('#modal-root')!.classList.contains('hidden')).toBe(true);
    expect(q('#tile-menu')!.classList.contains('hidden')).toBe(true);
  });

  it('未命中路徑在 UI 上不會炸掉，戰鬥紀錄看得到「未命中」', async () => {
    setToHitPolicy(() => 0);
    const g = await scene([{ at: [8, 9] }]);
    const hp = g.state.units.find((u) => u.id === 'E01')!.hp;
    g.test.tap({ x: 8, y: 9 });
    g.test.tap({ x: 8, y: 9 });
    expect(g.state.units.find((u) => u.id === 'E01')!.hp).toBe(hp);
    expect(g.state.units[0].equipped!.ammo).toBe(7);   // 彈匣 8，單發吃 1
    btn('#btn-log').click();
    expect(q('#log-panel')!.textContent).toContain('未命中');
  });
});

describe('§12.12 敵人回合演出', () => {
  beforeEach(() => { stubCanvas(); mount(); });

  it('點畫面可跳過，且跳過後的狀態與完整播放完全相同', async () => {
    const { Game } = await import('../src/ui/game');
    const play = async (skip: boolean) => {
      mount();
      const g: GameType = new Game(4242);
      g.dispatch({ type: 'WAIT' });                 // 進入敵人回合
      expect(isPlayerTurn(g.state)).toBe(false);
      if (skip) g.test.tap({ x: 5, y: 9 });         // 敵人回合中點畫面 = 跳過
      let guard = 0;
      while (!isPlayerTurn(g.state) && guard++ < 2000) g.test.enemySteps();
      return JSON.stringify(g.state);
    };
    expect(await play(true)).toBe(await play(false));
  });

  it('敵人回合中點畫面不會被當成選取或指令', async () => {
    const { Game } = await import('../src/ui/game');
    const g: GameType = new Game(1);
    g.dispatch({ type: 'WAIT' });
    const before = JSON.stringify(g.state);
    g.test.tap({ x: 5, y: 9 });
    expect(g.test.selection()).toBeNull();
    expect(JSON.stringify(g.state)).toBe(before);
  });

  it('演出間隔來自資料檔', async () => {
    const { RULES } = await import('../src/core/content');
    expect(RULES.presentation.enemyStepMs).toBe(200);
  });
});

describe('§4 尋路移動與 §2 其他目標', () => {
  beforeEach(() => { stubCanvas(); mount(); });
  afterEach(() => resetToHitPolicy());

  it('點遠處空格顯示選取，再點一次開始沿路徑移動', async () => {
    const g = await scene();
    g.test.tap({ x: 7, y: 9 });
    expect(g.test.selection()).toBe('MOVE:7,9');
    expect(g.test.autoActive()).toBe(false);
    g.test.tap({ x: 7, y: 9 });
    expect(g.test.autoActive()).toBe(true);

    const from = { ...g.state.units[0].pos };
    g.test.autoStep();
    expect(g.state.units[0].pos).not.toEqual(from);
  });

  it('自動移動在新敵人進入視線時立即停止，剩餘 AP 保留', async () => {
    const g = await scene([{ at: [25, 20] }]);   // 終端室內，中央大廳完全看不到
    g.test.tap({ x: 7, y: 9 });
    g.test.tap({ x: 7, y: 9 });
    expect(g.test.autoActive()).toBe(true);

    g.state.units.find((u) => u.id === 'E01')!.pos = { x: 8, y: 9 };  // 突然出現在視線內
    g.test.autoStep();
    expect(g.test.autoActive()).toBe(false);
    expect(g.state.units[0].nextActAt).toBeLessThan(30);   // 沒把整條路走完
  });

  it('點不可通行或走不到的格子沒有反應', async () => {
    const g = await scene();
    const before = g.test.selection();
    g.test.tap({ x: 0, y: 9 });      // 邊界牆
    expect(g.test.selection()).toBe(before);
  });

  it('點自己一次就顯示詳細狀態卡片', async () => {
    const g = await scene();
    g.test.tap({ x: 5, y: 9 });
    expect(g.test.selection()).toBe('SELF');
    expect(q('#tile-menu')!.classList.contains('hidden')).toBe(false);
    expect(q('#tile-menu')!.textContent).toContain('詳細狀態');
  });

  it('相鄰的終端：點一下選取，再點一下完成主目標', async () => {
    const g = await scene();
    const t = g.state.objectives.main.pos;
    g.state.units[0].pos = { x: t.x - 1, y: t.y };
    g.test.refresh();
    g.test.tap(t);
    expect(g.test.selection()).toBe('INTERACT:' + t.x + ',' + t.y);
    expect(g.state.objectives.main.done).toBe(false);   // 第一下不執行
    g.test.tap(t);
    expect(g.state.objectives.main.done).toBe(true);
  });
});
