/** 增援選單、止損二次確認、任務結算（§10.1 / §11.3 / §11.4）。 */
import type { GameState, Vec2 } from '../core/state';
import { activePlayerUnit, unitAt } from '../core/state';
import { damageAfterArmor } from '../core/combat';
import { $, esc, show } from './dom';
import { abandonedList, extractedList, ledgerText } from './hud';

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

/** §10.1 第 4 點：陣亡後從名冊選一位。MVP 名冊 4 人數值完全相同。 */
export function showReinforcement(state: GameState, onPick: (id: string) => void, onAbort: () => void): void {
  const p = state.pendingReinforcement;
  if (!p) return;
  const r = open(
    '<h2 class="lose">' + esc(p.deadUnitId) + ' 已陣亡</h2>'
    + '<p>屍體與其攜帶的所有裝備留在 (' + p.deathPos.x + ',' + p.deathPos.y + ')。'
    + '接替者只會配發一把 AR-9，並從<b>最近的空投點</b>落地，該回合無法行動。</p>'
    + '<p>' + esc(ledgerText(state)) + '</p>'
    + '<p>名冊剩餘 <b>' + state.roster.length + '</b> 人。MVP 階段四人數值完全相同。</p>'
    + '<div class="menu-actions">'
    + state.roster.map((id) =>
      '<button class="primary" data-pick="' + esc(id) + '">投入 ' + esc(id)
      + '<em>配發 AR-9（滿彈）</em></button>').join('')
    + '<button class="danger" data-abort="1">改為止損撤出<em>任務結束</em></button>'
    + '</div>',
  );
  r.querySelectorAll<HTMLButtonElement>('button[data-pick]').forEach((b) => {
    b.addEventListener('click', () => onPick(b.dataset.pick as string));
  });
  const ab = r.querySelector<HTMLButtonElement>('button[data-abort]');
  if (ab) ab.addEventListener('click', onAbort);
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
export function showSummary(
  state: GameState,
  onRestart: () => void,
  onReturnToList: (() => void) | null = null,
): void {
  const [title, cls] = resultTitle(state);
  const sec = state.objectives.secondary;
  const r = open(
    '<h2 class="' + cls + '">' + esc(title) + '</h2>'
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
    + '<p><b>帶出去的東西</b>（§6，將來是局外層的輸入）：</p>'
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
