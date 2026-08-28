/** 增援選單、止損二次確認、任務結算（§10.1 / §11.3 / §11.4）。 */
import type { GameState, Vec2 } from '../core/state';
import { activePlayerUnit, unitAt } from '../core/state';
import { activatedDropOptions } from '../core/commands';
import { isExplored } from '../core/fog';
import { sameTile } from '../core/grid';
import { damageAfterArmor } from '../core/combat';
import { $, esc, show } from './dom';
import { abandonedList, extractedList, ledgerText } from './hud';
import type { MissionLedger } from '../core/meta';
import { ECONOMY } from '../core/content';

function root(): HTMLElement {
  return $('#modal-root');
}

export function hideModal(): void {
  const r = root();
  r.innerHTML = '';
  show(r, false);
}

function open(html: string): HTMLElement {
  const r = root();
  r.innerHTML = '<div class="modal">' + html + '</div>';
  show(r, true);
  return r;
}

/**
 * §10.1 第 4 點：陣亡後從名冊選一位。
 *
 * v0.16 起**替補帶著他自己的配裝降落**，不再是配發一把 AR-9 ——
 * 所以這裡要看得到每個人身上有什麼。沒有配裝的人可以派，他會赤手空拳落地，
 * 那是玩家在公司畫面上的決定的後果。
 */
export function showReinforcement(
  state: GameState,
  onPick: (id: string, at?: Vec2) => void,
  onAbort: () => void,
): void {
  const p = state.pendingReinforcement;
  if (!p) return;
  const kitOf = (id: string): string => {
    const d = state.deployment.find((x) => x.id === id);
    if (!d) return '（不在派遣名單上）';
    const guns = [d.equipped, d.stowed].filter(Boolean).map((w) => w!.name);
    return guns.length === 0 ? '赤手空拳' : guns.join(' ＋ ');
  };
  const nameOf = (id: string): string =>
    state.deployment.find((x) => x.id === id)?.designation ?? id;

  // 插隊版 §2：**只有已啟用的空投點可以降落。**
  // 死亡懲罰因此從「地圖作者決定的間距」變成「玩家事先買不買保險」。
  const drops = activatedDropOptions(state);
  // 預設選離陣亡地點最近的那一個 —— 不挑也能直接按，維持原本的節奏（§12.26）。
  let chosen = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  drops.forEach((d, i) => {
    const dist = Math.abs(d.x - p.deathPos.x) + Math.abs(d.y - p.deathPos.y);
    if (dist < bestDist) { bestDist = dist; chosen = i; }
  });
  const dropLine = (d: Vec2, i: number): string => {
    const dist = Math.abs(d.x - p.deathPos.x) + Math.abs(d.y - p.deathPos.y);
    // 只反映**玩家已知的情況** —— 有迷霧之後這一點特別重要
    const near = state.units.filter((u) => u.faction === 'ENEMY'
      && isExplored(state, u.pos)
      && Math.abs(u.pos.x - d.x) + Math.abs(u.pos.y - d.y) <= 6);
    const home = sameTile(d, state.map.startDropPoint);
    return '<button class="' + (i === chosen ? 'primary' : '') + '" data-drop="' + i + '">'
      + (home ? '起始空投點' : '空投點') + ' (' + d.x + ',' + d.y + ')'
      + '<em>離陣亡地點 ' + dist
      + (near.length ? '　⚠ 附近有 ' + near.length + ' 名已知敵人' : '　附近無已知敵人')
      + '</em></button>';
  };

  const html = (): string =>
    '<h2 class="lose">' + esc(nameOf(p.deadUnitId)) + ' 已陣亡</h2>'
    + '<p>屍體與其攜帶的所有裝備留在 (' + p.deathPos.x + ',' + p.deathPos.y + ')。'
    + '接替者<b>帶著自己的配裝</b>，從<b>你選的已啟用空投點</b>落地，該回合無法行動。</p>'
    + '<p>' + esc(ledgerText(state)) + '</p>'
    + (drops.length > 1
      ? '<h3 class="sub">降落位置</h3><div class="menu-actions">'
        + drops.map(dropLine).join('') + '</div>'
      : drops.length === 1
        ? '<p class="note">只有一個已啟用的空投點：('
          + drops[0].x + ',' + drops[0].y + ')。'
          + '往前推進時順手啟用空投點，等於買了一份保險。</p>'
        : '<p class="note"><b>沒有可用的空投點。</b></p>')
    + '<h3 class="sub">投入誰（名冊剩餘 ' + state.roster.length + ' 人）</h3>'
    + '<div class="menu-actions">'
    + state.roster.map((id) =>
      '<button class="primary" data-pick="' + esc(id) + '">投入 ' + esc(nameOf(id))
      + '<em>' + esc(kitOf(id)) + '</em></button>').join('')
    + '<button class="danger" data-abort="1">改為止損撤出<em>身上的一切留在戰場</em></button>'
    + '</div>';

  const r = open(html());
  const wire = (): void => {
    r.querySelectorAll<HTMLButtonElement>('button[data-drop]').forEach((b) => {
      b.addEventListener('click', () => {
        chosen = Number(b.dataset.drop);
        r.innerHTML = '<div class="modal">' + html() + '</div>';
        wire();
      });
    });
    r.querySelectorAll<HTMLButtonElement>('button[data-pick]').forEach((b) => {
      b.addEventListener('click', () => onPick(b.dataset.pick as string, drops[chosen]));
    });
    const ab = r.querySelector<HTMLButtonElement>('button[data-abort]');
    if (ab) ab.addEventListener('click', onAbort);
  };
  wire();
}


/** §11.3：止損按鈕任何時候都可以按，按下後顯示戰況損益並二次確認。 */
export function showAbortConfirm(state: GameState, onConfirm: () => void, onCancel: () => void): void {
  const r = open(
    '<h2 class="abort">確認止損？</h2>'
    + '<p>任務將立即中止。已完成的目標會計入結算，留在戰場上的裝備視為損失。</p>'
    + '<p>' + esc(ledgerText(state)) + '</p>'
    + '<ul>' + abandonedList(state) + '</ul>'
    + '<div class="menu-actions">'
    + '<button class="danger" data-yes="1">確認止損<em>結束任務</em></button>'
    + '<button data-no="1">繼續作戰</button>'
    + '</div>',
  );
  (r.querySelector('button[data-yes]') as HTMLButtonElement).addEventListener('click', onConfirm);
  (r.querySelector('button[data-no]') as HTMLButtonElement).addEventListener('click', onCancel);
}

/**
 * 全遊戲唯一保留的確認彈窗：濺射範圍會涵蓋玩家自己時（§3.4）。
 * 重武器開火要花掉整個回合也不另外確認 —— 兩段式點擊本身已經夠了。
 */
export function showSplashConfirm(
  state: GameState,
  target: Vec2,
  onConfirm: () => void,
  onCancel: () => void,
): void {
  const me = activePlayerUnit(state);
  const w = me ? me.equipped : null;
  const foe = unitAt(state, target);
  if (!me || !w) return;
  const selfDmg = damageAfterArmor(Math.floor(w.damage / 2), me.armor);
  const r = open(
    '<h2 class="abort">你會被自己的濺射打到</h2>'
    + '<p>' + esc(w.name) + ' 的濺射半徑為 ' + w.splash + ' 格，'
    + '而你距離彈著點只有 ' + (Math.abs(me.pos.x - target.x) + Math.abs(me.pos.y - target.y)) + ' 格。'
    + '本作刻意不做友軍傷害豁免。</p>'
    + '<div class="stat-grid">'
    + '<div class="stat"><span>目標</span><b>' + esc(foe ? foe.name : '地面') + '</b></div>'
    + '<div class="stat accent"><span>你會受到</span><b>' + selfDmg + '</b></div>'
    + '<div class="stat"><span>你的 HP</span><b>' + Math.max(0, me.hp) + '/' + me.maxHp + '</b></div>'
    + '</div>'
    + '<div class="menu-actions">'
    + '<button class="danger" data-yes="1">照樣開火<em>' + (me.hp - selfDmg <= 0 ? '這一發會打死自己' : '扣 ' + selfDmg + ' HP') + '</em></button>'
    + '<button data-no="1">取消</button>'
    + '</div>',
  );
  (r.querySelector('button[data-yes]') as HTMLButtonElement).addEventListener('click', onConfirm);
  (r.querySelector('button[data-no]') as HTMLButtonElement).addEventListener('click', onCancel);
}

const RESULT_TITLE: Record<string, [string, string]> = {
  SUCCESS: ['任務成功', 'win'],
  ABORTED: ['任務中止（止損）', 'abort'],
  WIPED: ['名冊耗盡 — 任務失敗', 'lose'],
  ONGOING: ['任務進行中', ''],
};

/**
 * 結算標題（§5.2 / §5.3）。
 *
 * ABORTED 有兩種來路，玩家必須分得出來：
 *   **撤離**（走出去，東西帶回來了）與 **止損**（不要了，全部損失）。
 * 兩者的 result 相同，差別在有沒有東西被帶出去。
 */
function resultTitle(state: GameState): [string, string] {
  if (state.result === 'ABORTED' && state.extracted.length > 0) {
    return ['撤離完成 — 合約失敗', 'abort'];
  }
  return RESULT_TITLE[state.result] ?? RESULT_TITLE.ONGOING;
}

/**
 * §11.4 結算畫面。
 *
 * @param onReturnToList v0.14：回到**重新產生**的合約清單。
 *   與「重新開始」是兩件事 —— 後者重打同一份合約、同一個種子，
 *   前者換一批合約。`?map=` 的除錯流程沒有清單可回，所以可以是 null。
 */
/**
 * 損益表（v0.20 §5.4）。**這張表就是那一版的重點** ——
 * 玩家必須看得出自己這一趟是賺是賠，以及**賠在哪裡**。
 *
 * 用會計語言講死人：陣亡的士兵在這裡是一列重置成本，
 * 遺留的槍是一列永久性減損。不加註解，不解釋。
 */
function ledgerHtml2(l: MissionLedger): string {
  const cur = ECONOMY.currency.short;
  const row = (label: string, n: number, sign: 1 | -1): string =>
    '<li><span>' + esc(label) + '</span><b class="' + (sign > 0 ? 'plus' : 'minus') + '">'
    + (n === 0 ? '—' : (sign > 0 ? '+' : '−') + n) + '</b></li>';
  return '<h3 class="sub">本次合約損益（' + esc(cur) + '）</h3>'
    + '<ul class="ledger">'
    + row('合約報酬', l.reward, 1)
    + row('次要目標獎金', l.secondary, 1)
    + row('帶出的戰利品（估值）', l.salvage, 1)
    + '<li class="rule"></li>'
    + row('陣亡士兵（重置成本）', l.soldiersLost, -1)
    + row('遺留的武器（永久性減損）', l.weaponsLost, -1)
    + row('消耗的彈藥與物資', l.suppliesLost, -1)
    + '<li class="rule"></li>'
    + '<li class="total"><span>本次合約損益</span><b class="'
    + (l.net >= 0 ? 'plus' : 'minus') + '">' + (l.net >= 0 ? '+' : '−') + Math.abs(l.net)
    + '</b></li>'
    + '</ul>'
    + '<p class="note">實際入帳 <b>' + l.creditsEarned + '</b> —— '
    + '戰利品要在補給站賣掉才變成錢，遺留與陣亡是已經發生的支出。</p>';
}

export function showSummary(
  state: GameState,
  onRestart: () => void,
  onReturnToList: (() => void) | null = null,
  ledger: MissionLedger | null = null,
): void {
  const [title, cls] = resultTitle(state);
  const sec = state.objectives.secondary;
  const r = open(
    '<h2 class="' + cls + '">' + esc(title) + '</h2>'
    // 損益表擺在最上面：**這張表就是玩家最想知道的事** ——
    // 這一趟是賺是賠，以及賠在哪裡。搜刮清單擺它後面。
    + (ledger ? ledgerHtml2(ledger) : '')
    + '<div class="stat-grid">'
    + '<div class="stat"><span>總耗時</span><b>' + state.clock + '</b></div>'
    + '<div class="stat"><span>地圖</span><b>' + esc(state.map.name) + '</b></div>'
    + '<div class="stat"><span>投入士兵</span><b>' + state.deployed + '</b></div>'
    + '<div class="stat"><span>陣亡</span><b>' + state.casualties + '</b></div>'
    + '</div>'
    + (state.result === 'ABORTED' && state.extracted.length > 0
      ? '<p class="note">主目標未完成，合約失敗 —— 但背包裡的東西都帶回來了。</p>'
      : '')
    + '<p>主目標：<b>' + (state.objectives.main.done ? '已完成' : '未完成') + '</b>'
    + '　次要目標：<b>' + sec.filter((o) => o.done).length + '/' + sec.length + '</b></p>'
    + '<p><b>帶出去的東西</b>（要在補給站賣掉才變成錢）：</p>'
    + '<ul>' + extractedList(state) + '</ul>'
    + '<p><b>遺留在戰場上</b>（未回收的損失）：</p>'
    + '<ul>' + abandonedList(state) + '</ul>'
    + '<div class="menu-actions">'
    + (onReturnToList
      ? '<button class="primary" data-list="1">返回合約清單<em>重新開出一批合約</em></button>'
      : '')
    + '<button' + (onReturnToList ? '' : ' class="primary"')
    + ' data-restart="1">重新開始<em>同一份合約，同一個種子</em></button>'
    + '</div>',
  );
  (r.querySelector('button[data-restart]') as HTMLButtonElement).addEventListener('click', onRestart);
  const back = r.querySelector<HTMLButtonElement>('button[data-list]');
  if (back && onReturnToList) back.addEventListener('click', onReturnToList);
}

/**
 * 存檔版本不符（§7.2）。**不要嘗試遷移，也不要崩潰。**
 * 專案迭代很快，存檔格式會被之後每一版打破；遷移程式碼的維護成本遠高於重置。
 */
export function showVersionMismatch(
  v: { found: number; expected: number },
  onReset: () => void,
): void {
  const r = open(
    '<h2 class="abort">存檔版本不符</h2>'
    + '<p>找到的存檔是第 <b>' + v.found + '</b> 版，這個版本要的是第 <b>' + v.expected + '</b> 版。</p>'
    + '<p>本作<b>刻意不做存檔遷移</b> —— 專案迭代很快，格式會被之後每一版打破，'
    + '而遷移程式碼的維護成本遠高於重來一次。</p>'
    + '<div class="menu-actions">'
    + '<button class="primary" data-reset="1">重置並開始新公司<em>舊的存檔會被清除</em></button>'
    + '</div>',
  );
  (r.querySelector('button[data-reset]') as HTMLButtonElement).addEventListener('click', () => {
    hideModal();
    onReset();
  });
}
