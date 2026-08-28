/**
 * 合約清單畫面（§18）。任務開始前的第一個畫面。
 *
 * 為什麼要有它：v0.11 起隨機選圖，玩家會**毫無預警**被丟進性格差異
 * 極大的地圖。「接哪張合約」應該是一個決策，而決策需要資訊 ——
 * 這個畫面提供的資訊全部由地圖統計值推導（§18.2），所以它不會說謊。
 *
 * 這裡也是本作的敘事載體：主線與所有角色感都由合約簡報、公文與服役紀錄
 * 承擔，不做過場動畫。這個畫面就是那些文字第一次有地方放。
 *
 * 兩段式與地圖操作同一套文法：點卡片＝展開簡報，再點＝確認出擊。
 */
import type { Contract } from '../core/contracts';
import { $, esc, show } from './dom';
import { ECONOMY } from '../core/content';
import { contractReward, secondaryReward } from '../core/economy';

function root(): HTMLElement {
  return $('#contract-root');
}

function tagChips(c: Contract): string {
  return '<div class="c-tags">'
    + c.tags.map((t) => '<span class="c-tag">' + esc(t.label) + '</span>').join('')
    + '</div>';
}

function objectiveLine(c: Contract): string {
  return '主目標 ' + c.objectives.main
    + '　次要目標 ' + c.objectives.secondary
    + '　已知物資點 ' + c.objectives.caches;
}

/**
 * 報酬（v0.20 §5.3）。**與難度評級並列，讓「風險 vs 報酬」一眼可讀。**
 *
 * v0.14 刻意不顯示金額（沒有貨幣系統，顯示金額等於說謊）；現在有了。
 */
function rewardLine(c: Contract): string {
  const main = contractReward(c.difficulty.rating);
  const each = secondaryReward(c.difficulty.rating, 1);
  return '<p class="c-reward">報酬 <b>' + main + ' ' + esc(ECONOMY.currency.short) + '</b>'
    + '<span>次要目標每項 +' + each + '　主目標未完成即撤離只拿得到次要獎金</span></p>';
}

function briefHtml(c: Contract): string {
  const b = c.brief;
  const ol = (xs: string[]): string =>
    '<ol>' + xs.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ol>';
  return '<div class="c-brief">'
    + '<p class="c-field"><b>受文者</b>　' + esc(b.client) + '</p>'
    + '<p class="c-field"><b>旨</b>　' + esc(b.purpose) + '</p>'
    + '<p class="c-field"><b>說明</b></p>' + ol(b.notes)
    + '<p class="c-field"><b>辦法</b></p>' + ol(b.methods)
    + '<p class="c-field"><b>附件</b>　' + esc(b.attachment) + '</p>'
    + '<p class="c-note">' + esc(b.flavour) + '</p>'
    + '</div>';
}

/**
 * 難度評級（§18.3）與地形標籤都不是手寫的 —— 玩家可以相信它們，
 * 因為它們跟著地圖一起重算。簡報文字才是手寫的，而簡報是委託方寫的，
 * 委託方沒有義務說實話。
 */
function cardHtml(c: Contract, i: number, openIdx: number): string {
  const open = i === openIdx;
  const d = c.difficulty;
  return '<article class="c-card' + (open ? ' open' : '') + '" data-i="' + i + '">'
    + '<div class="c-head">'
    + '<span class="c-code">' + esc(c.brief.code) + '</span>'
    + '<span class="c-rating r' + esc(d.rating) + '">' + esc(d.rating) + '　'
    + esc(d.label) + '</span>'
    + '</div>'
    + '<h3>' + esc(c.brief.title) + '</h3>'
    + '<p class="c-where">作業地點　' + esc(c.mapName) + '</p>'
    + tagChips(c)
    + '<p class="c-obj">' + esc(objectiveLine(c)) + '</p>'
    + rewardLine(c)
    + (open ? briefHtml(c) : '')
    + '<div class="c-actions">'
    + (open
      ? '<button class="primary" data-go="' + i + '">確認出擊<em>'
        + esc(c.mapName) + '　承接後不得撤回</em></button>'
        + '<button data-toggle="' + i + '">收合簡報</button>'
      : '<button data-toggle="' + i + '">檢視簡報<em>'
        + esc(c.brief.client) + '</em></button>')
    + '</div>'
    + '</article>';
}

/**
 * @param onAccept 玩家確認出擊。呼叫端負責關掉這個畫面並開始任務。
 */
export function showContracts(list: Contract[], onAccept: (c: Contract) => void): void {
  const r = root();
  let openIdx = -1;

  const draw = (): void => {
    r.innerHTML = '<div class="contract-screen">'
      + '<header class="c-top">'
      + '<h2>可承接合約</h2>'
      + '<p class="c-note">本期可承接案件 ' + list.length + ' 件。'
      + '對價如各案所載，作業完成並經驗收後撥付。'
      + '承接後之人員與裝備損耗，均由承接方自行認列。</p>'
      + '</header>'
      + list.map((c, i) => cardHtml(c, i, openIdx)).join('')
      + '<p class="c-foot">評級與地形標籤係就地形資料計算所得，'
      + '非委託方之陳述，不構成任何形式之擔保。</p>'
      + '</div>';

    r.querySelectorAll<HTMLButtonElement>('button[data-toggle]').forEach((b) => {
      b.addEventListener('click', () => {
        const i = Number(b.dataset.toggle);
        openIdx = openIdx === i ? -1 : i;
        draw();
        if (openIdx >= 0) {
          const card = r.querySelector<HTMLElement>('.c-card.open');
          if (card) card.scrollIntoView({ block: 'start' });
        }
      });
    });
    r.querySelectorAll<HTMLButtonElement>('button[data-go]').forEach((b) => {
      b.addEventListener('click', () => onAccept(list[Number(b.dataset.go)]));
    });
  };

  draw();
  show(r, true);
  r.scrollTop = 0;
}

export function hideContracts(): void {
  const r = root();
  r.innerHTML = '';
  show(r, false);
}
