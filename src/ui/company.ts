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
  assignWeapon, freeAmmo, freeConsumable,
  holderOf, moveAmmo, moveConsumable, resolveLoadout, resupplyAll,
  levelOf, resupplySoldier, resupplyTarget, supplyBatch, unassignSlot, xpToNext,
  buyAmmo, buyConsumable, buySoldier, buyWeapon, sellStock, sellWeapon, wasOurs,
} from '../core/meta';
import { allAmmoTypes, ammoLabel, checkKit, kitBreakdown, selectableConsumables } from '../core/loadout';
import { BOARD_MAIL, ECONOMY, ITEMS, RULES, WEAPONS } from '../core/content';
import {
  ammoPrice, consumablePrice, debtLabel, debtTier, isLegacy, itemPrice, localCatalogue,
  sellValue, soldierPrice, weaponPrice,
} from '../core/economy';
import { fmtWeight } from './hud';
import { $, esc, show } from './dom';

type View =
  | { kind: 'ROSTER' }
  | { kind: 'ARMOURY' }
  | { kind: 'SUPPLY' }
  | { kind: 'KIT'; soldierId: string }
  | { kind: 'MAIL' }
  | { kind: 'PICK' };

const CR = (n: number): string => (n < 0 ? '−' : '') + Math.abs(n) + ' ' + ECONOMY.currency.short;

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

/**
 * 補給鍵上的說明（v0.18 附錄）：告訴玩家「基準是多少、現在差多少」。
 * 按鈕不會憑空變出東西 —— 不夠就是不夠，那時候要去補給站。
 */
function resupplyNote(meta: MetaState, s: Soldier): string {
  const want = resupplyTarget(meta, s);
  const parts = Object.entries(want).map(([id, n]) => {
    const held = s.loadout.ammo[id] ?? 0;
    const gap = Math.max(0, n - held);
    const stock = freeAmmo(meta, id);
    return ammoLabel(id) + ' ' + held + '／' + n
      + (gap > 0 ? (stock >= gap ? '（可補 ' + gap + '）' : '（庫存只剩 ' + stock + '）') : '');
  });
  if (parts.length === 0) return '沒有配槍，沒有要補的東西';
  return parts.join('　');
}

/**
 * 等級與當前加成（§1.6）。
 *
 * 服役紀錄從此不再只是裝飾 —— **旁邊有實際生效的數值。**
 * 刻意不列生命值：經驗完全不影響它（§1.4）。
 */
export function levelLine(s: Soldier): string {
  const lv = levelOf(s.xp);
  const next = xpToNext(s.xp);
  const bonus = lv.level === 1
    ? '新兵，尚無加成'
    : '命中 +' + Math.round(lv.aim * 100) + '%'
      + '　迴避 +' + Math.round(lv.evasion * 100) + '%'
      + '　動作 ×' + lv.actionScale.toFixed(2);
  return 'Lv.' + lv.level + '　經驗 ' + s.xp
    + (next === null ? '（已滿級）' : '（再 ' + next + ' 升級）')
    + '　' + bonus;
}

/** 服務紀錄。**純數值士兵唯一的人格來源**（§4.4）。 */
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
      + '<p class="co-level">' + esc(levelLine(s)) + '</p>'
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

function supplyHtml(meta: MetaState): string {
  const row = (kind: string, key: string, label: string, price: number, note: string,
    disabled = false): string =>
    '<button class="l-pick" data-buy="' + kind + '" data-key="' + esc(key) + '"'
    + (disabled ? ' disabled' : '') + '>'
    + '<span class="l-pick-head"><b>' + esc(label) + '</b><i>' + CR(price) + '</i></span>'
    + '<em>' + esc(note) + '</em></button>';

  // ---- 遺產武器：**不是型錄，是現貨** ----
  // 架上擺的是**實例**，不是型號 —— 買走的就是那一把（§2.1）。
  const stock = meta.legacyStock.length
    ? meta.legacyStock.map((w, i) => row('weapon', w.instanceId, w.name, weaponPrice(w.typeId),
      '現貨 1 件　' + RULES.calibres[w.calibre].name + '　' + w.action
      + (wasOurs(w) ? '　⚑ 前次登記：本公司' : '')
      + (i === 0 ? '　—— 買走就沒了，池子不會自己長回來' : ''))).join('')
    : '<p class="note">補給站沒有遺產武器現貨。'
      + '槍不會被生產，只會流通 —— 池子空了就是真的空了，'
      + '要等戰場上的那幾把被拾荒者洗回來。</p>';

  const legacyOwned = meta.armoury.filter((w) => !holderOf(meta, w.instanceId));
  const sellRow = (kind: string, key: string, label: string, price: number, note: string): string =>
    '<button class="l-pick" data-sell="' + kind + '" data-key="' + esc(key) + '">'
    + '<span class="l-pick-head"><b>' + esc(label) + '</b><i>+' + CR(price) + '</i></span>'
    + '<em>' + esc(note) + '</em></button>';

  const sellStockRows = [
    ...Object.entries(meta.salvage),
    ...Object.entries(meta.consumableStock),
    ...Object.entries(meta.ammoStock),
  ].filter(([, n]) => n > 0).map(([id, n]) => sellRow('stock', id,
    (ITEMS[id]?.name ?? id) + ' ×' + n, sellValue(itemPrice(id, n)),
    id === 'DNA' ? '可以賣。**日後另有用途** —— 賣掉之前想清楚。' : '整批賣出'));

  return '<h3 class="l-h">遺產武器（現貨）</h3>'
    + '<p class="note">撤離前製造的東西**只有流通、沒有生產**。'
    + '這裡列的是本期調度得到的，不是型錄 —— 買走就沒了。</p>'
    + '<div class="l-list">' + stock + '</div>'

    + '<h3 class="l-h">土製武器</h3>'
    + '<p class="note">現在還做得出來的東西，隨時有貨。</p>'
    + '<div class="l-list">'
    + localCatalogue().map((id) => {
      const w = WEAPONS.find((x) => x.id === id)!;
      return row('weapon', id, w.name, weaponPrice(id),
        RULES.calibres[w.calibre].name + '　' + w.action + '　' + fmtWeight(w.weight));
    }).join('')
    + '</div>'

    + '<h3 class="l-h">複製人</h3>'
    + '<div class="l-list">'
    + row('soldier', '-', '徵召一名複製人（B 系）', soldierPrice(),
      '加入名冊，Gen.1，沒有配裝。這條血脈的樣本庫龐大，隨時有貨。')
    + '</div>'

    + '<h3 class="l-h">彈藥</h3>'
    + '<div class="l-list">'
    + RULES.meta.supply.ammo.map((id) => row('ammo', id,
      ammoLabel(id) + ' ×' + supplyBatch(id), ammoPrice(id, supplyBatch(id)),
      '進共用庫存')).join('')
    + '</div>'

    + '<h3 class="l-h">消耗品</h3>'
    + '<div class="l-list">'
    + selectableConsumables().map((id) => row('item', id, ITEMS[id].name,
      consumablePrice(id), '進共用庫存')).join('')
    + '</div>'

    + '<h3 class="l-h">出售</h3>'
    + '<p class="note">售價是買價的 ' + Math.round(ECONOMY.sellDiscount * 100) + '%。'
    + '有人拿著的槍不能賣 —— 先在配裝畫面收回來。</p>'
    + '<div class="l-list">'
    + (legacyOwned.length
      ? legacyOwned.map((w) => sellRow('weapon', w.instanceId,
        w.name + '（' + w.instanceId + '）', sellValue(weaponPrice(w.typeId)),
        isLegacy(w.typeId) ? '遺產武器 —— 賣掉之後未必買得回來' : '土製，隨時再買得到')).join('')
      : '<p class="note">沒有未指派的武器。</p>')
    + (sellStockRows.length ? sellStockRows.join('') : '<p class="note">沒有多餘的物資。</p>')
    + '</div>';
}

/**
 * 董事會信件（v0.20 §4.3）。**信件本身就是後果** —— 這一版不附帶任何實際懲罰。
 * 文體依世界觀 §12：用最無趣的公文語言，講最荒謬的事。
 */
function mailHtml(meta: MetaState): string {
  const id = meta.mail[0];
  const letter = id ? BOARD_MAIL[id] : null;
  if (!letter) {
    return '<header class="l-top"><h2>信箱</h2></header>'
      + '<p class="note">沒有待閱讀的信件。</p>'
      + '<div class="l-actions"><button class="primary" data-back="1">回名冊</button></div>';
  }
  return '<header class="l-top"><h2>' + esc(letter.subject) + '</h2>'
    + '<p class="co-service">' + esc(letter.from) + '</p></header>'
    + '<div class="c-brief">'
    + letter.body.map((line) => '<p class="c-field">' + esc(line) + '</p>').join('')
    + '</div>'
    + '<div class="l-actions">'
    + '<button class="primary" data-readmail="' + esc(id) + '">已閱<em>'
    + (meta.mail.length > 1 ? '還有 ' + (meta.mail.length - 1) + ' 封' : '歸檔') + '</em></button>'
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
    + '<p class="co-level">' + esc(levelLine(s)) + '</p>'
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
    + '<button data-resupply="' + esc(s.id) + '">補給至基準<em>'
    + esc(resupplyNote(meta, s)) + '</em></button>'
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
    else if (v.kind === 'SUPPLY') body = supplyHtml(meta);
    else if (v.kind === 'MAIL') body = mailHtml(meta);
    else body = rosterHtml(meta, false) + stockHtml(meta);

    const tabs = v.kind === 'KIT' || v.kind === 'PICK' || v.kind === 'MAIL' ? '' :
      '<nav class="co-tabs">' + TABS.map((t) =>
        '<button class="' + (t.kind === v.kind ? 'on' : '') + '" data-tab="' + t.kind + '">'
        + t.label + '</button>').join('') + '</nav>';

    const head = v.kind === 'KIT' || v.kind === 'PICK' || v.kind === 'MAIL' ? '' :
      '<header class="l-top"><h2>公司</h2>'
      + '<p class="co-credits' + (meta.credits < 0 ? ' bad' : '') + '">'
      + esc(ECONOMY.currency.name) + '　<b>' + CR(meta.credits) + '</b>'
      + (meta.credits < 0
        ? '　<span class="co-debt">' + esc(debtLabel(debtTier(meta.credits) ?? '')) + '</span>'
        : '')
      + (meta.mail.length
        ? '<button class="co-mailbtn" data-mail="1">董事會來信 ' + meta.mail.length + '</button>'
        : '')
      + '</p>'
      + '<p class="note">名冊 ' + meta.roster.length + ' 人　軍械庫 ' + meta.armoury.length + ' 把'
      + (meta.missionLog.length
        ? '　上一場：' + esc(meta.missionLog[0].mapName) + ' ' + esc(meta.missionLog[0].outcome)
          + '（陣亡 ' + meta.missionLog[0].casualties + '）'
        : '　尚未出過勤')
      + '</p></header>';

    const foot = v.kind === 'KIT' || v.kind === 'PICK' || v.kind === 'MAIL' ? '' :
      '<div class="l-actions">'
      + '<button class="primary" data-go="1"' + (meta.roster.length === 0 ? ' disabled' : '') + '>'
      + '接合約<em>' + (meta.roster.length === 0 ? '名冊已空' : '進入合約清單') + '</em></button>'
      + (v.kind === 'ROSTER'
        ? '<button data-resupply-all="1">全員補給<em>補到基準，不會讓誰變慢</em></button>'
        : '')
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
    on('button[data-mail]', () => { view = { kind: 'MAIL' }; draw(); });
    on('button[data-readmail]', (b) => {
      meta.mail = meta.mail.filter((x) => x !== b.dataset.readmail);
      view = { kind: 'ROSTER' };
      dirty();
    });
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
    on('button[data-resupply]', (b) => { resupplySoldier(meta, b.dataset.resupply!); dirty(); });
    on('button[data-resupply-all]', () => { resupplyAll(meta); dirty(); });
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
    // 補給站（v0.20：真的要錢了）
    on('button[data-buy]', (b) => {
      const key = b.dataset.key!;
      switch (b.dataset.buy) {
        case 'soldier': buySoldier(meta); break;
        case 'weapon': buyWeapon(meta, key); break;
        case 'ammo': buyAmmo(meta, key, supplyBatch(key)); break;
        default: buyConsumable(meta, key, 1); break;
      }
      dirty();
    });
    on('button[data-sell]', (b) => {
      const key = b.dataset.key!;
      if (b.dataset.sell === 'weapon') sellWeapon(meta, key);
      else {
        const n = (meta.salvage[key] ?? meta.consumableStock[key] ?? meta.ammoStock[key]) ?? 0;
        sellStock(meta, key, n);
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
