/** HUD 列（§12.3）。永遠可見。 */
import type { GameState, Item } from '../core/state';
import { abandonedItems, activePlayerUnit, enemies } from '../core/state';
import { COVER_LABEL, playerDefence } from '../core/cover';
import {
  carriedWeight, countAmmoFor, maxWeight, moveCostForWeight, weightTierIndex,
} from '../core/inventory';
import { $, esc } from './dom';

/** 重量顯示：0.5 這種半數不要印成 "0.5000000001"，整數也不要印成 "18.0"。 */
export function fmtWeight(w: number): string {
  return Number.isInteger(w) ? String(w) : w.toFixed(1);
}

/** 物品的顯示標籤（帶數量）。 */
export function itemText(it: Item): string {
  return it.qty > 1 ? it.name + ' ×' + it.qty : it.name;
}

/** 武器型號：取名稱的第一個空白之前。 */
export function shortName(name: string): string {
  return name.split(' ')[0];
}

/**
 * HUD 只留「這個動作要不要做」的輸入（§12.6）：
 * 還能挨幾發、還能開幾槍、讓出行動權後會被怎麼打、走一格要多久。
 *
 * 任務帳目（世界時刻、名冊、敵數、戰況損益）全部搬進日誌面板 ——
 * 它們回答的是「這一場打得怎麼樣」，不是「這一下要做什麼」，
 * 而在直向手機上它們曾經吃掉將近三成的畫面高度。
 */
export function renderHud(state: GameState): void {
  const u = activePlayerUnit(state);

  $('#hud-hp').textContent = u ? `HP ${Math.max(0, u.hp)}/${u.maxHp}` : 'HP —';

  const w = u ? u.equipped : null;
  // HUD 空間有限，只取型號（"AR-9 制式步槍" → "AR-9"）；完整名稱在詳細面板裡。
  // 斜線後面是**背包裡的備彈**（§1.1）—— 槍內剩幾發只是一半的資訊。
  $('#hud-weapon').textContent = w
    ? `${shortName(w.name)} ${w.ammo}/${w.magazine}`
      + (!w.intrinsic ? `｜備 ${countAmmoFor(u!.backpack, w)}` : '')
    : '空手';

  // 負重（§3.2）：玩家要看得出「再撿就會變慢」
  const load = carriedWeight(u);
  const tier = weightTierIndex(load);
  // 移動時間只有在「不是基準值」時才值得佔位 —— 沒被拖慢就不用一直報。
  $('#hud-load').textContent = !u ? '負重 —'
    : tier === 0 ? `負重 ${fmtWeight(load)}/${maxWeight()}`
    : `負重 ${fmtWeight(load)}/${maxWeight()}・移動 ${moveCostForWeight(load)}`;
  $('#hud-load').classList.toggle('warn', tier > 0);

  // 準備欄（§12.19）：HUD 上要一眼看得到現在身上準備好的是什麼
  const prep = u && u.preparedId
    ? (u.backpack ? u.backpack.items.find((it) => it.id === u.preparedId) : null)
    : null;
  $('#hud-prepared').textContent = prep ? '備 ' + shortName(prep.name) : '備 —';
  $('#hud-prepared').classList.toggle('accent', !!prep);

  // 防禦狀態：玩家要在按下結束回合前，知道自己會以什麼狀態承受攻擊（§12.11）
  // 沒人瞄得到你的時候，掩蔽等級不是可用的資訊 —— 那時候只要知道姿勢就好。
  // 有人瞄得到才把等級與人數攤開，那正是這一格要被讀到的時候。
  const def = playerDefence(state);
  const posture = u ? (u.stance === 'CROUCH' ? '蹲' : '站') : '—';
  $('#hud-stance').textContent = !u ? '姿勢 —'
    : def.threats === 0 ? posture + '・無人瞄準'
    : posture + '・' + COVER_LABEL[def.level] + '・' + def.threats + ' 人瞄得到';
  $('#hud-stance').classList.toggle('warn', def.threats > 0 && def.level === 'NONE');
}

/**
 * 任務帳目（§12.6）。日誌面板頂端與止損二次確認共用。
 *
 * 這些數字全部是「這一場打得怎麼樣」，不是「這一下要做什麼」——
 * 所以它們不常駐 HUD，而是在玩家真的要問這個問題時（開日誌、考慮止損）才出現。
 */
export function missionPanelHtml(state: GameState): string {
  return '<div class="hud-row">'
    + '<div class="chip">時刻 ' + state.clock + '</div>'
    + '<div class="chip">名冊 ' + state.roster.length + '</div>'
    + '<div class="chip">敵 ' + enemies(state).length + '</div>'
    + '</div>'
    + '<p class="hud-ledger">' + ledgerHtml(state) + '</p>';
}

/** §12.3 戰況損益。止損二次確認也用同一份文字。 */
export function ledgerHtml(state: GameState): string {
  const sec = state.objectives.secondary;
  const done = sec.filter((o) => o.done).length;
  // 只算**己方遺體**上的東西：沒開過的補給箱不是「損失」，
  // 那只是還沒去拿。這一欄要回答的是「這一場我賠了多少」。
  const lost = state.loot
    .filter((c) => c.kind === 'PLAYER_BODY')
    .reduce((a, c) => a + c.items.length, 0);
  return [
    `投入 <b>${state.deployed}</b> 名`,
    `陣亡 <b>${state.casualties}</b> 名`,
    `主目標 <b>${state.objectives.main.done ? '已完成' : '未完成'}</b>`,
    `次要 <b>${done}/${sec.length}</b>`,
    `我方遺留 <b>${lost}</b> 項物資`,
  ].join(' ／ ');
}

export function ledgerText(state: GameState): string {
  return ledgerHtml(state).replace(/<\/?b>/g, '');
}

/** 遺留在戰場上的東西（§6 結算畫面）。 */
export function abandonedList(state: GameState): string {
  if (abandonedItems(state).length === 0) return '<li>無 —— 什麼都沒留下</li>';
  return state.loot
    .filter((c) => c.items.length > 0)
    .map((c) => `<li>${esc(c.label)} 於 (${c.pos.x},${c.pos.y})：`
      + esc(c.items.map(itemText).join('、')) + '</li>')
    .join('');
}

/** 帶出去的東西（§6 結算畫面），依種類分組。 */
export function extractedList(state: GameState): string {
  if (state.extracted.length === 0) {
    return '<li>無 —— 這一趟什麼都沒帶出來</li>';
  }
  const groups: { key: Item['kind']; label: string }[] = [
    { key: 'WEAPON', label: '武器' },
    { key: 'AMMO', label: '彈藥' },
    { key: 'VALUABLE', label: '值錢物品' },
    { key: 'DNA', label: 'DNA' },
  ];
  const out: string[] = [];
  for (const g of groups) {
    const items = state.extracted.filter((it) => it.kind === g.key);
    if (items.length === 0) continue;
    const value = items.reduce((a, it) => a + (it.value ?? 0) * it.qty, 0);
    out.push(`<li><b>${g.label}</b>：` + esc(items.map(itemText).join('、'))
      + (value > 0 ? `（價值 ${value}）` : '') + '</li>');
  }
  return out.join('');
}
