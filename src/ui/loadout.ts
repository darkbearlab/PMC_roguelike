/**
 * 出擊前配裝畫面（v0.15 §5）。
 *
 * 這個畫面存在的理由只有一個：v0.14 的合約清單會告訴玩家
 * 「開闊地形、敵方以遠程為主、存在重裝目標」——**然後玩家什麼都不能改變**。
 * 有標籤而沒有配裝，比沒有標籤更糟。
 *
 * 所以合約的標籤要留在畫面上端，就在重量列旁邊：
 * 玩家調整配裝的時候，必須同時看得見他是為了什麼在調。
 */
import type { Contract } from '../core/contracts';
import type { Loadout } from '../core/loadout';
import {
  allAmmoTypes, ammoLabel, checkLoadout, cloneLoadout, defaultLoadout,
  loadoutBreakdown, selectableConsumables,
} from '../core/loadout';
import { AMMO_TYPES, ITEMS, RULES, WEAPONS, ammoTypesForCalibre } from '../core/content';
import { fmtWeight } from './hud';
import { $, esc, show } from './dom';

function root(): HTMLElement {
  return $('#loadout-root');
}

function weaponSummary(id: string): string {
  const w = WEAPONS.find((x) => x.id === id);
  if (!w) return '';
  const modes = w.modes.map((m) => RULES.fireModes[m].full).join('／');
  const reload = w.reloadMode === 'INCREMENTAL'
    ? '裝填 ' + w.reloadTime + '／發'
    : '裝填 ' + w.reloadTime;
  return '傷害 ' + w.damage + '　射程 ' + w.range + '　彈倉 ' + w.magazine
    + '　' + reload + '　' + modes;
}

function weaponRow(slot: 'primary' | 'stowed', id: string | null, cur: string | null): string {
  const w = id ? WEAPONS.find((x) => x.id === id) : null;
  const on = cur === id;
  const label = w ? w.name : '不帶';
  const meta = w ? RULES.calibres[w.calibre].name + '　' + fmtWeight(w.weight) : '空欄位';
  // 名稱與口徑／重量同一列（右對齊），數值另起一整列 ——
  // 兩欄並排在 320px 會互相擠成一團。
  return '<button class="l-pick' + (on ? ' on' : '') + '" data-slot="' + slot
    + '" data-id="' + esc(id ?? '') + '">'
    + '<span class="l-pick-head"><b>' + esc(label) + '</b>'
    + '<i>' + esc(meta) + '</i></span>'
    + (w ? '<em>' + esc(weaponSummary(w.id)) + '</em>' : '')
    + '</button>';
}

function stepper(kind: 'ammo' | 'item', key: string, label: string, qty: number, note: string): string {
  return '<div class="l-step">'
    + '<button data-step="' + kind + '" data-key="' + esc(key) + '" data-d="-1">−</button>'
    + '<span class="l-step-body"><b>' + esc(label) + '</b><em>' + esc(note) + '</em></span>'
    + '<span class="l-step-qty">' + qty + '</span>'
    + '<button data-step="' + kind + '" data-key="' + esc(key) + '" data-d="1">＋</button>'
    + '</div>';
}

/** 玩家目前帶的兩把槍餵得到哪些彈藥型別 —— 那幾種排在前面，而且標出來。 */
function neededAmmo(l: Loadout): Set<string> {
  const out = new Set<string>();
  for (const id of [l.primary, l.stowed]) {
    const w = id ? WEAPONS.find((x) => x.id === id) : null;
    if (!w) continue;
    for (const t of ammoTypesForCalibre(w.calibre)) out.add(t.id);
  }
  return out;
}

export function showLoadout(
  contract: Contract | null,
  initial: Loadout,
  onLaunch: (l: Loadout) => void,
  onBack: (() => void) | null,
): void {
  const r = root();
  let l = cloneLoadout(initial);

  const header = (): string => {
    if (!contract) return '';
    return '<p class="l-where">' + esc(contract.brief.code) + '　' + esc(contract.mapName)
      + '<span class="c-rating r' + esc(contract.difficulty.rating) + '">'
      + esc(contract.difficulty.rating) + '　' + esc(contract.difficulty.label) + '</span></p>'
      + '<div class="c-tags">'
      + contract.tags.map((t) => '<span class="c-tag">' + esc(t.label) + '</span>').join('')
      + '</div>';
  };

  const weightBlock = (chk: ReturnType<typeof checkLoadout>): string => {
    const tiers = RULES.backpack.weightTiers;
    return '<div class="l-weight' + (chk.overweight ? ' bad' : chk.tier > 0 ? ' warn' : '') + '">'
      + '<div class="stat-grid">'
      + '<div class="stat"><span>總重</span><b>' + fmtWeight(chk.weight) + '／' + chk.maxWeight + '</b></div>'
      + '<div class="stat' + (chk.tier > 0 ? ' accent' : '') + '"><span>移動一格</span><b>'
      + chk.moveCost + '</b></div>'
      + '<div class="stat"><span>負重級距</span><b>' + (chk.tier + 1) + '／' + tiers.length + '</b></div>'
      + '</div>'
      + '<p class="note">'
      + (chk.overweight
        ? '<b>超過攜行上限，無法出擊。</b>'
        : chk.headroom !== null
          ? (chk.tier === 0 ? '不受影響。' : '<b>已經被拖慢了。</b>')
            + '再加 ' + fmtWeight(chk.headroom) + ' 就會掉到下一級（移動 '
            + tiers[chk.tier + 1].moveCost + '）。　戰場上撿到的東西算在同一個數字裡。'
          : '已經是最重的級距。')
      + '</p></div>';
  };

  const draw = (): void => {
    const chk = checkLoadout(l);
    const need = neededAmmo(l);
    const ammo = allAmmoTypes()
      .map((id, i) => ({ id, k: (need.has(id) ? 0 : 1000) + i }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.id);
    const ids: (string | null)[] = [null, ...WEAPONS.map((w) => w.id)];

    r.innerHTML = '<div class="loadout-screen">'
      + '<header class="l-top"><h2>出擊前配裝</h2>' + header() + '</header>'
      + weightBlock(chk)
      + (chk.warnings.length
        ? '<ul class="l-warn">' + chk.warnings.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>'
        : '')
      + '<h3 class="l-h">主手</h3><div class="l-list">'
      + ids.filter((id) => id === null || id !== l.stowed)
        .map((id) => weaponRow('primary', id, l.primary)).join('')
      + '</div>'
      + '<h3 class="l-h">收納</h3><div class="l-list">'
      + ids.filter((id) => id === null || id !== l.primary)
        .map((id) => weaponRow('stowed', id, l.stowed)).join('')
      + '</div>'
      + '<h3 class="l-h">攜行彈藥</h3><div class="l-list">'
      + ammo.map((id) => {
        const def = AMMO_TYPES[id];
        const n = l.ammo[id] ?? 0;
        const note = (need.has(id) ? '● 你的槍吃這個　' : '')
          + '每發 ' + def.weightPerRound
          + '　小計 ' + fmtWeight(Math.round(def.weightPerRound * n * 1000) / 1000);
        return stepper('ammo', id, ammoLabel(id) + ' ×' + RULES.loadout.ammoStep[id], n, note);
      }).join('')
      + '</div>'
      + '<h3 class="l-h">消耗品</h3><div class="l-list">'
      + selectableConsumables().map((id) => {
        const def = ITEMS[id];
        return stepper('item', id, def.name, l.consumables[id] ?? 0,
          '每個 ' + fmtWeight(def.weight) + '　' + (def.use ? def.use.label : ''));
      }).join('')
      + '</div>'
      + '<h3 class="l-h">重量明細</h3><ul class="l-bd">'
      + (loadoutBreakdown(l).map((x) =>
        '<li><span>' + esc(x.label) + '</span><b>' + fmtWeight(x.weight) + '</b></li>').join('')
        || '<li><span>什麼都沒帶</span><b>0</b></li>')
      + '</ul>'
      + '<div class="l-actions">'
      + '<button class="primary" data-go="1"' + (chk.overweight ? ' disabled' : '') + '>出擊'
      + '<em>' + (chk.overweight ? '超重' : fmtWeight(chk.weight) + '　移動 ' + chk.moveCost)
      + '</em></button>'
      + '<button data-reset="1">回到預設配裝<em>AR-9 + RR-4</em></button>'
      + (onBack ? '<button data-back="1">回合約清單</button>' : '')
      + '</div></div>';

    r.querySelectorAll<HTMLButtonElement>('button[data-slot]').forEach((b) => {
      b.addEventListener('click', () => {
        const slot = b.dataset.slot as 'primary' | 'stowed';
        l[slot] = b.dataset.id ? b.dataset.id : null;
        draw();
      });
    });
    r.querySelectorAll<HTMLButtonElement>('button[data-step]').forEach((b) => {
      b.addEventListener('click', () => {
        const d = Number(b.dataset.d);
        const key = b.dataset.key as string;
        if (b.dataset.step === 'ammo') {
          const step = RULES.loadout.ammoStep[key];
          l.ammo[key] = Math.max(0,
            Math.min(RULES.loadout.ammoMax, (l.ammo[key] ?? 0) + d * step));
        } else {
          l.consumables[key] = Math.max(0,
            Math.min(RULES.loadout.consumableMax, (l.consumables[key] ?? 0) + d));
        }
        draw();
      });
    });
    const go = r.querySelector<HTMLButtonElement>('button[data-go]');
    if (go) go.addEventListener('click', () => onLaunch(cloneLoadout(l)));
    const reset = r.querySelector<HTMLButtonElement>('button[data-reset]');
    if (reset) reset.addEventListener('click', () => { l = defaultLoadout(); draw(); });
    const back = r.querySelector<HTMLButtonElement>('button[data-back]');
    if (back && onBack) back.addEventListener('click', onBack);
  };

  draw();
  show(r, true);
  r.scrollTop = 0;
}

export function hideLoadout(): void {
  const r = root();
  r.innerHTML = '';
  show(r, false);
}
