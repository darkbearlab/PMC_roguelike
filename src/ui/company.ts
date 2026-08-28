/**
 * 公司畫面（v0.16 §4）：名冊、軍械庫、補給站、逐人配裝、派遣。
 *
 * 這一版之後，配裝從「選裝備」變成**「分配資源」**：
 * 武器是實例，同一把槍只能給一個人；彈藥與消耗品是共用庫存，逐人分配。
 * 玩家面對的不再是「哪把槍比較強」，而是**「我要把有限的東西分給誰」**。
 *
 * 由此自然長出兩種配裝原型，兩種都不需要額外設計：
 *  - **主攻**：重裝、彈藥充足、載重量吃緊
 *  - **回收**：只帶手槍與封合劑，刻意把載重量留空，去把前一個人的東西撿回來
 */
import type { MetaState, Soldier } from '../core/meta';
import {
  assignWeapon, freeAmmo, freeConsumable, grantAmmo, grantConsumable, grantSoldier,
  grantWeapon, holderOf, moveAmmo, moveConsumable, resolveLoadout, supplyBatch,
  supplyCatalogue, unassignSlot,
} from '../core/meta';
import { allAmmoTypes, ammoLabel, checkKit, kitBreakdown, selectableConsumables } from '../core/loadout';
import { ITEMS, RULES, WEAPONS } from '../core/content';
import { fmtWeight } from './hud';
import { $, esc, show } from './dom';

type View =
  | { kind: 'ROSTER' }
  | { kind: 'ARMOURY' }
  | { kind: 'SUPPLY' }
  | { kind: 'KIT'; soldierId: string }
  | { kind: 'PICK' };

export interface CompanyHandlers {
  /** 存檔。每次動到 MetaState 就呼叫（§7.1：只在公司畫面存）。 */
  save(): void;
  /** 「接合約」→ 合約清單。 */
  toContracts(): void;
  /** 派遣首發士兵 → 開始任務。只有 PICK 模式會用到。 */
  deploy(soldierId: string): void;
  /** 重置公司（需二次確認，§7.3）。 */
  reset(): void;
}

function root(): HTMLElement {
  return $('#company-root');
}

const weaponName = (meta: MetaState, id: string | null): string => {
  if (!id) return '空';
  const w = meta.armoury.find((x) => x.instanceId === id);
  return w ? w.name : '（遺失）';
};

/** 服役紀錄。**純數值士兵唯一的人格來源**（§4.4）。 */
function serviceLine(s: Soldier): string {
  const r = s.serviceRecord;
  if (r.missions === 0) return '尚未出勤';
  return '出勤 ' + r.missions + '　擊殺 ' + r.kills + '　承受 ' + r.damageTaken
    + (r.contracts.length ? '　最近：' + r.contracts[r.contracts.length - 1] : '');
}

function kitSummary(meta: MetaState, s: Soldier): string {
  const kit = resolveLoadout(meta, s.loadout);
  const chk = checkKit(kit);
  const ammo = Object.entries(s.loadout.ammo)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => ammoLabel(id) + '×' + n);
  const cons = Object.entries(s.loadout.consumables)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => (ITEMS[id]?.name ?? id) + '×' + n);
  return '手持 ' + esc(weaponName(meta, s.loadout.equippedWeaponId))
    + '　收納 ' + esc(weaponName(meta, s.loadout.stowedWeaponId))
    + '<br>' + (ammo.length || cons.length ? esc([...ammo, ...cons].join('、')) : '沒有攜行物資')
    + '<br>負重 ' + fmtWeight(chk.weight) + '／' + chk.maxWeight
    + '　移動 ' + chk.moveCost
    + (chk.overweight ? '　<b class="bad">超重</b>' : chk.tier > 0 ? '　<b class="warn">已被拖慢</b>' : '');
}

// ---------------------------------------------------------------- 各分頁

function rosterHtml(meta: MetaState, pick: boolean): string {
  if (meta.roster.length === 0) {
    return '<p class="note"><b>名冊已空。</b>到補給站取得新的複製人。</p>';
  }
  return '<div class="l-list">' + meta.roster.map((s) => {
    const chk = checkKit(resolveLoadout(meta, s.loadout));
    return '<article class="co-card">'
      + '<div class="co-head"><b>' + esc(s.designation) + '</b>'
      + '<span class="co-hp">HP ' + s.hp + '／' + s.maxHp + '</span></div>'
      + '<p class="co-service">' + esc(serviceLine(s)) + '</p>'
      + '<p class="co-kit">' + kitSummary(meta, s) + '</p>'
      + '<div class="c-actions">'
      + (pick
        ? '<button class="primary" data-deploy="' + esc(s.id) + '"'
          + (chk.overweight ? ' disabled' : '') + '>派他出去'
          + '<em>' + (chk.overweight ? '超重，無法出擊' : fmtWeight(chk.weight) + '　移動 ' + chk.moveCost)
          + '</em></button>'
        : '<button data-kit="' + esc(s.id) + '">配裝<em>'
          + (chk.warnings.length ? esc(chk.warnings[0]) : '沒有問題') + '</em></button>')
      + '</div></article>';
  }).join('') + '</div>';
}

function armouryHtml(meta: MetaState): string {
  if (meta.armoury.length === 0) {
    return '<p class="note"><b>軍械庫是空的。</b>到補給站領槍。</p>';
  }
  return '<div class="l-list">' + meta.armoury.map((w) => {
    const holder = holderOf(meta, w.instanceId);
    return '<article class="co-card">'
      + '<div class="co-head"><b>' + esc(w.name) + '</b>'
      + '<span class="co-hp">' + fmtWeight(w.weight) + '</span></div>'
      + '<p class="co-service">' + esc(w.instanceId) + '　'
      + RULES.calibres[w.calibre].name + '　' + esc(w.action)
      + '　彈倉 ' + w.ammo + '／' + w.magazine + '</p>'
      + '<p class="co-kit">' + (holder ? '由 <b>' + esc(holder.designation) + '</b> 持有' : '未指派')
      + '</p></article>';
  }).join('') + '</div>'
    + '<p class="c-foot">同一把槍只能給一個人。三把槍四個人，就有一個人沒槍。</p>';
}

function stockHtml(meta: MetaState): string {
  const ammo = allAmmoTypes().filter((id) => freeAmmo(meta, id) > 0)
    .map((id) => ammoLabel(id) + ' ×' + freeAmmo(meta, id));
  const cons = selectableConsumables().filter((id) => freeConsumable(meta, id) > 0)
    .map((id) => ITEMS[id].name + ' ×' + freeConsumable(meta, id));
  const salv = Object.entries(meta.salvage).filter(([, n]) => n > 0)
    .map(([id, n]) => (ITEMS[id]?.name ?? id) + ' ×' + n);
  return '<h3 class="l-h">未分配的庫存</h3>'
    + '<p class="note">' + (ammo.length || cons.length ? esc([...ammo, ...cons].join('　')) : '空的')
    + '</p>'
    + (salv.length
      ? '<h3 class="l-h">帶回來的雜物</h3><p class="note">' + esc(salv.join('　'))
        + '<br>本階段沒有用途 —— 等經濟層。</p>'
      : '');
}

function supplyHtml(): string {
  const cat = supplyCatalogue();
  const row = (kind: string, key: string, label: string, note: string): string =>
    '<button class="l-pick" data-buy="' + kind + '" data-key="' + esc(key) + '">'
    + '<span class="l-pick-head"><b>' + esc(label) + '</b><i>0</i></span>'
    + '<em>' + esc(note) + '</em></button>';
  return '<div class="l-warn"><b>暫時性的測試機能。</b>'
    + '所有價格為 0，因為經濟層還不存在。'
    + '這個畫面之後會被「合成（長士兵、做土製槍）＋交易（取得遺產武器）」整段取代。</div>'
    + '<h3 class="l-h">複製人</h3><div class="l-list">'
    + row('soldier', '-', '徵召一名複製人', '加入名冊，Gen.1，沒有配裝')
    + '</div>'
    + '<h3 class="l-h">武器</h3><div class="l-list">'
    + cat.weapons.map((id) => {
      const w = WEAPONS.find((x) => x.id === id)!;
      return row('weapon', id, w.name,
        RULES.calibres[w.calibre].name + '　' + w.action + '　' + fmtWeight(w.weight)
        + '　每次領取都是一把新的實例');
    }).join('')
    + '</div><h3 class="l-h">彈藥</h3><div class="l-list">'
    + cat.ammo.map((id) => row('ammo', id, ammoLabel(id) + ' ×' + supplyBatch(id),
      '進共用庫存')).join('')
    + '</div><h3 class="l-h">消耗品</h3><div class="l-list">'
    + cat.consumables.map((id) => row('item', id, ITEMS[id].name, '進共用庫存')).join('')
    + '</div>';
}

// ---------------------------------------------------------------- 逐人配裝

function weaponPickRow(
  meta: MetaState, s: Soldier, slot: 'equipped' | 'stowed', instanceId: string | null,
): string {
  const cur = slot === 'equipped' ? s.loadout.equippedWeaponId : s.loadout.stowedWeaponId;
  const other = slot === 'equipped' ? s.loadout.stowedWeaponId : s.loadout.equippedWeaponId;
  if (!instanceId) {
    return '<button class="l-pick' + (cur === null ? ' on' : '') + '" data-slot="' + slot
      + '" data-id="">'
      + '<span class="l-pick-head"><b>不帶</b><i>空欄位</i></span></button>';
  }
  const w = meta.armoury.find((x) => x.instanceId === instanceId);
  if (!w || instanceId === other) return '';
  const holder = holderOf(meta, instanceId);
  const taken = holder !== null && holder.id !== s.id;
  return '<button class="l-pick' + (cur === instanceId ? ' on' : '') + '" data-slot="' + slot
    + '" data-id="' + esc(instanceId) + '">'
    + '<span class="l-pick-head"><b>' + esc(w.name) + '</b>'
    + '<i>' + RULES.calibres[w.calibre].name + '　' + fmtWeight(w.weight) + '</i></span>'
    + '<em>' + esc(w.instanceId) + '　彈倉 ' + w.ammo + '／' + w.magazine
    + (taken ? '　<b>目前在 ' + esc(holder!.designation) + ' 身上，選了就搶過來</b>' : '')
    + '</em></button>';
}

function stepper(kind: string, key: string, label: string, held: number, note: string): string {
  return '<div class="l-step">'
    + '<button data-move="' + kind + '" data-key="' + esc(key) + '" data-d="-1">−</button>'
    + '<span class="l-step-body"><b>' + esc(label) + '</b><em>' + esc(note) + '</em></span>'
    + '<span class="l-step-qty">' + held + '</span>'
    + '<button data-move="' + kind + '" data-key="' + esc(key) + '" data-d="1">＋</button>'
    + '</div>';
}

function kitHtml(meta: MetaState, s: Soldier): string {
  const kit = resolveLoadout(meta, s.loadout);
  const chk = checkKit(kit);
  const tiers = RULES.backpack.weightTiers;
  const ids: (string | null)[] = [null, ...meta.armoury.map((w) => w.instanceId)];

  return '<header class="l-top"><h2>' + esc(s.designation) + '　配裝</h2>'
    + '<p class="co-service">' + esc(serviceLine(s)) + '</p></header>'

    + '<div class="l-weight' + (chk.overweight ? ' bad' : chk.tier > 0 ? ' warn' : '') + '">'
    + '<div class="stat-grid">'
    + '<div class="stat"><span>總重</span><b>' + fmtWeight(chk.weight) + '／' + chk.maxWeight + '</b></div>'
    + '<div class="stat' + (chk.tier > 0 ? ' accent' : '') + '"><span>移動一格</span><b>'
    + chk.moveCost + '</b></div>'
    + '<div class="stat"><span>負重級距</span><b>' + (chk.tier + 1) + '／' + tiers.length + '</b></div>'
    + '</div><p class="note">'
    + (chk.overweight
      ? '<b>超過攜行上限，無法出擊。</b>'
      : chk.headroom !== null
        ? (chk.tier === 0 ? '不受影響。' : '<b>已經被拖慢了。</b>')
          + '再加 ' + fmtWeight(chk.headroom) + ' 就會掉到下一級（移動 '
          + tiers[chk.tier + 1].moveCost + '）。　戰場上撿到的東西算在同一個數字裡。'
        : '已經是最重的級距。')
    + '</p></div>'

    + (chk.warnings.length
      ? '<ul class="l-warn">' + chk.warnings.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>'
      : '')

    + '<h3 class="l-h">主手</h3><div class="l-list">'
    + ids.map((id) => weaponPickRow(meta, s, 'equipped', id)).join('')
    + '</div><h3 class="l-h">收納</h3><div class="l-list">'
    + ids.map((id) => weaponPickRow(meta, s, 'stowed', id)).join('')
    + '</div>'

    + '<h3 class="l-h">攜行彈藥<span class="co-sub">　＋／− 是從共用庫存拿與還</span></h3>'
    + '<div class="l-list">'
    + allAmmoTypes().map((id) => stepper('ammo', id, ammoLabel(id),
      s.loadout.ammo[id] ?? 0,
      '庫存還有 ' + freeAmmo(meta, id) + '　每發 ' + ITEMS[id].weight)).join('')
    + '</div>'

    + '<h3 class="l-h">消耗品</h3><div class="l-list">'
    + selectableConsumables().map((id) => stepper('item', id, ITEMS[id].name,
      s.loadout.consumables[id] ?? 0,
      '庫存還有 ' + freeConsumable(meta, id) + '　每個 ' + fmtWeight(ITEMS[id].weight))).join('')
    + '</div>'

    + '<h3 class="l-h">重量明細</h3><ul class="l-bd">'
    + (kitBreakdown(kit).map((x) =>
      '<li><span>' + esc(x.label) + '</span><b>' + fmtWeight(x.weight) + '</b></li>').join('')
      || '<li><span>什麼都沒帶</span><b>0</b></li>')
    + '</ul>'

    + '<div class="l-actions">'
    + '<button class="primary" data-back="1">回名冊</button>'
    + '<button data-strip="1">全部卸下<em>武器與物資都還回公司</em></button>'
    + '</div>';
}

// ---------------------------------------------------------------- 主畫面

const TABS: { kind: View['kind']; label: string }[] = [
  { kind: 'ROSTER', label: '名冊' },
  { kind: 'ARMOURY', label: '軍械庫' },
  { kind: 'SUPPLY', label: '補給站' },
];

export function showCompany(meta: MetaState, h: CompanyHandlers, pick = false): void {
  const r = root();
  let view: View = pick ? { kind: 'PICK' } : { kind: 'ROSTER' };
  let armedReset = false;

  const draw = (): void => {
    const v = view;
    const s = v.kind === 'KIT' ? meta.roster.find((x) => x.id === v.soldierId) ?? null : null;
    if (v.kind === 'KIT' && !s) view = { kind: 'ROSTER' };

    let body: string;
    if (v.kind === 'KIT' && s) body = kitHtml(meta, s);
    else if (v.kind === 'PICK') {
      body = '<header class="l-top"><h2>派遣</h2>'
        + '<p class="note">挑一名首發。陣亡之後可以再挑替補，'
        + '<b>替補會帶著他自己的配裝降落</b> —— 沒有配裝的人就赤手空拳。</p></header>'
        + rosterHtml(meta, true)
        + '<div class="l-actions"><button data-cancel="1">回合約清單</button></div>';
    } else if (v.kind === 'ARMOURY') body = armouryHtml(meta) + stockHtml(meta);
    else if (v.kind === 'SUPPLY') body = supplyHtml();
    else body = rosterHtml(meta, false) + stockHtml(meta);

    const tabs = v.kind === 'KIT' || v.kind === 'PICK' ? '' :
      '<nav class="co-tabs">' + TABS.map((t) =>
        '<button class="' + (t.kind === v.kind ? 'on' : '') + '" data-tab="' + t.kind + '">'
        + t.label + '</button>').join('') + '</nav>';

    const head = v.kind === 'KIT' || v.kind === 'PICK' ? '' :
      '<header class="l-top"><h2>公司</h2>'
      + '<p class="note">名冊 ' + meta.roster.length + ' 人　軍械庫 ' + meta.armoury.length + ' 把'
      + (meta.missionLog.length
        ? '　上一場：' + esc(meta.missionLog[0].mapName) + ' ' + esc(meta.missionLog[0].outcome)
          + '（陣亡 ' + meta.missionLog[0].casualties + '）'
        : '　尚未出過勤')
      + '</p></header>';

    const foot = v.kind === 'KIT' || v.kind === 'PICK' ? '' :
      '<div class="l-actions">'
      + '<button class="primary" data-go="1"' + (meta.roster.length === 0 ? ' disabled' : '') + '>'
      + '接合約<em>' + (meta.roster.length === 0 ? '名冊已空' : '進入合約清單') + '</em></button>'
      + '<button class="danger" data-reset="1">'
      + (armedReset ? '再按一次確認重置<em>這間公司會消失</em>' : '重置公司<em>清除存檔，重新開始</em>')
      + '</button></div>';

    r.innerHTML = '<div class="company-screen">' + head + tabs + body + foot + '</div>';
    wire();
  };

  const dirty = (): void => { h.save(); draw(); };

  const wire = (): void => {
    const on = (sel: string, fn: (b: HTMLButtonElement) => void): void => {
      r.querySelectorAll<HTMLButtonElement>(sel).forEach((b) => {
        b.addEventListener('click', () => {
          if (b.dataset.reset === undefined) armedReset = false;
          fn(b);
        });
      });
    };
    on('button[data-tab]', (b) => {
      view = { kind: b.dataset.tab as 'ROSTER' | 'ARMOURY' | 'SUPPLY' };
      draw();
    });
    on('button[data-kit]', (b) => { view = { kind: 'KIT', soldierId: b.dataset.kit! }; draw(); });
    on('button[data-back]', () => { view = { kind: 'ROSTER' }; draw(); });
    on('button[data-go]', () => h.toContracts());
    on('button[data-cancel]', () => h.toContracts());
    on('button[data-deploy]', (b) => h.deploy(b.dataset.deploy!));
    on('button[data-reset]', () => {
      if (!armedReset) { armedReset = true; draw(); return; }
      armedReset = false;
      h.reset();
    });

    // 配裝：指派武器
    on('button[data-slot]', (b) => {
      const v = view;
      if (v.kind !== 'KIT') return;
      const slot = b.dataset.slot as 'equipped' | 'stowed';
      const id = b.dataset.id;
      if (!id) unassignSlot(meta, v.soldierId, slot);
      else assignWeapon(meta, id, v.soldierId, slot);
      dirty();
    });
    // 配裝：從共用庫存拿與還
    on('button[data-move]', (b) => {
      const v = view;
      if (v.kind !== 'KIT') return;
      const d = Number(b.dataset.d);
      const key = b.dataset.key!;
      if (b.dataset.move === 'ammo') {
        const step = RULES.loadout.ammoStep[key] ?? 1;
        moveAmmo(meta, v.soldierId, key, d * step);
      } else {
        moveConsumable(meta, v.soldierId, key, d);
      }
      dirty();
    });
    on('button[data-strip]', () => {
      const v = view;
      if (v.kind !== 'KIT') return;
      const sol = meta.roster.find((x) => x.id === v.soldierId);
      if (!sol) return;
      unassignSlot(meta, sol.id, 'equipped');
      unassignSlot(meta, sol.id, 'stowed');
      for (const id of Object.keys(sol.loadout.ammo)) moveAmmo(meta, sol.id, id, -99999);
      for (const id of Object.keys(sol.loadout.consumables)) moveConsumable(meta, sol.id, id, -99999);
      dirty();
    });
    // 補給站（全部 0 元）
    on('button[data-buy]', (b) => {
      const key = b.dataset.key!;
      switch (b.dataset.buy) {
        case 'soldier': grantSoldier(meta); break;
        case 'weapon': grantWeapon(meta, key); break;
        case 'ammo': grantAmmo(meta, key, supplyBatch(key)); break;
        default: grantConsumable(meta, key, 1); break;
      }
      dirty();
    });
  };

  draw();
  show(r, true);
  r.scrollTop = 0;
}

export function hideCompany(): void {
  const r = root();
  r.innerHTML = '';
  show(r, false);
}
