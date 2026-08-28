/**
 * 浮動小卡（§12）。
 *
 * v0.3 起，高頻動作（射擊、移動、互動）全部改用「點一下預覽、再點一下執行」
 * 的地圖文法，預覽直接畫在戰場上，不再有面板。
 * 只剩兩種情況需要卡片：看自己的詳細狀態，以及從一堆東西裡挑要拿什麼 ——
 * 兩者都是低頻、而且都需要一份清單。
 */
import type { GameState, Item, LootPile, Vec2 } from '../core/state';
import { activePlayerUnit, lootAt } from '../core/state';
import type { WeaponSlot } from '../core/commands';
import { checkLegal, commandTime, interactTarget } from '../core/commands';
import { manhattan } from '../core/grid';
import { describe as describeSequence } from '../core/sequence';
import { RULES } from '../core/content';
import {
  carriedWeight, countAmmoFor, maxWeight, moveCostForWeight, nextTierAt, stackWeight, weightTierIndex,
} from '../core/inventory';
import { esc } from './dom';
import { fmtWeight, itemText } from './hud';

const FACING_ZH: Record<string, string> = {
  N: '北', NE: '東北', E: '東', SE: '東南', S: '南', SW: '西南', W: '西', NW: '西北',
};

export interface MenuHandlers {
  pickup(lootId: string, itemIndex: number, slot?: WeaponSlot): void;
  takeAll(lootId: string): void;
  prepare(itemId: string): void;
  drop(itemId: string): void;
  /** v0.18：在主手、收納欄與背包之間搬一把槍。 */
  moveGear(from: WeaponSlot, to: WeaponSlot, itemId?: string): void;
  swapWeapon(): void;
  interact(pos: Vec2): void;
  abortSequence(): void;
  close(): void;
}

function head(title: string): string {
  return '<h3>' + esc(title) + '<button class="close" data-do="close">關閉</button></h3>';
}

function stat(label: string, value: string, accent = false): string {
  return '<div class="stat' + (accent ? ' accent' : '') + '"><span>'
    + esc(label) + '</span><b>' + esc(value) + '</b></div>';
}

type PlayerUnit = NonNullable<ReturnType<typeof activePlayerUnit>>;

function weaponLine(state: GameState, w: PlayerUnit['equipped']): string {
  if (!w) return '無';
  const u = activePlayerUnit(state);
  const spare = w.magazine < 99 ? '　備彈 ' + countAmmoFor(u ? u.backpack : null, w) : '';
  const mode = w.modes.length > 1 ? '　' + RULES.fireModes[w.mode].full : '';
  return w.name + ' ' + w.ammo + '/' + w.magazine + spare + mode;
}

function bagSummaryLine(bag: PlayerUnit['backpack']): string {
  if (!bag) return '';
  if (bag.items.length === 0) return '<p class="note">背包：空的</p>';
  return '<p class="note">背包：'
    + esc(bag.items.map((it) => itemText(it) + '（' + fmtWeight(stackWeight(it)) + '）').join('、'))
    + '</p>';
}

/** 點自己 → 詳細狀態。單次點擊即可，不需第二下。 */
export function selfPanelHtml(state: GameState): string {
  const u = activePlayerUnit(state);
  if (!u) return '';
  const kind = interactTarget(state, u, u.pos);
  const label = kind === 'TERMINAL' ? '存取終端（主目標）'
    : kind === 'SUPPLY' ? '回收補給箱（次要目標）'
    : kind === 'EXTRACT' ? '撤離（帶著背包走人）' : null;
  const legal = checkLegal(state, { type: 'INTERACT', pos: u.pos });
  const load = carriedWeight(u);

  return head(u.name + '　詳細狀態')
    + '<div class="stat-grid">'
    + stat('HP', Math.max(0, u.hp) + '/' + u.maxHp)
    + stat('時刻', String(state.clock), true)
    + stat('負重', fmtWeight(load) + '/' + maxWeight())
    + '</div>'
    + (u.pendingSequence
      ? '<p class="note">進行中：' + esc(describeSequence(u.pendingSequence))
        + '　（可中止，已花費的時間不退還）</p>'
      : '')
    + '<p class="note">手持：' + esc(weaponLine(state, u.equipped))
    + '<br>收納：' + esc(weaponLine(state, u.stowed))
    + '<br>視野 ' + u.sightRange + ' 格（曼哈頓）・面向 ' + FACING_ZH[u.facing]
    + (u.stance === 'CROUCH'
      ? '<br><b>蹲姿：只看得見面向的前方半平面</b>，後方三格是盲區。方向鍵可轉向（不花時間）。'
      : '<br>站姿為全方位視野，面向不影響看得見什麼。')
    + '</p>'
    + bagSummaryLine(u.backpack)
    + '<div class="menu-actions">'
    + (u.pendingSequence
      ? '<button class="danger" data-do="abort-seq">中止 ' + esc(describeSequence(u.pendingSequence))
        + '<em>已花費的時間不退還</em></button>'
      : '')
    + (label
      ? '<button data-do="interact" ' + (legal.ok ? 'class="primary"' : 'disabled') + '>'
        + esc(label) + '<em>'
        + (legal.ok ? '費時 ' + commandTime(state, { type: 'INTERACT', pos: u.pos }) : esc(legal.reason))
        + '</em></button>'
      : '')
    + '</div>';
}

function itemButtons(
  state: GameState, pile: LootPile, it: Item, i: number, u: PlayerUnit, inReach: boolean,
): string {
  const label = esc(itemText(it)) + '（' + fmtWeight(stackWeight(it)) + '）';
  if (!inReach) return '<button disabled>' + label + '<em>需走到附近</em></button>';

  // 武器可以直接換到手持／收納欄（不佔背包），也可以塞進背包（佔重量、不能用）
  if (it.kind === 'WEAPON') {
    const slots: WeaponSlot[] = ['EQUIPPED', 'STOWED', 'BACKPACK'];
    const names: Record<WeaponSlot, string> = {
      EQUIPPED: '換為手持', STOWED: '換為收納', BACKPACK: '塞進背包',
    };
    return slots.map((slot) => {
      const legal = checkLegal(state, { type: 'PICKUP', lootId: pile.id, itemIndex: i, slot });
      const cur = slot === 'EQUIPPED' ? u.equipped : slot === 'STOWED' ? u.stowed : null;
      const hint = !legal.ok ? esc(legal.reason)
        : slot === 'BACKPACK' ? '佔 ' + fmtWeight(it.weight) + ' 重量，放著不能用'
        : cur ? '換下 ' + esc(cur.name) + '，留在原地' : '空欄位';
      return '<button data-do="pickup" data-loot="' + esc(pile.id) + '" data-idx="' + i
        + '" data-slot="' + slot + '"' + (legal.ok ? '' : ' disabled')
        + '>' + names[slot] + ' ' + label + '<em>' + hint + '</em></button>';
    }).join('');
  }

  const legal = checkLegal(state, { type: 'PICKUP', lootId: pile.id, itemIndex: i });
  return '<button data-do="pickup" data-loot="' + esc(pile.id) + '" data-idx="' + i + '"'
    + (legal.ok ? '' : ' disabled')
    + '>拿走 ' + label + '<em>' + (legal.ok ? '費時 ' + RULES.loot.takeTime : esc(legal.reason))
    + '</em></button>';
}

/**
 * 目標點的互動鍵（v0.19 附錄）。
 *
 * **屍體會落在目標點上。**在此之前介面查搜刮堆優先於查目標點，
 * 於是「敵人剛好死在終端機上」= 那個終端機永遠按不到 ——
 * 規則層一直是合法的，到不了的是介面。
 *
 * 修法是把互動鍵放進掠奪面板，而不是改變點擊的優先順序：
 * 屍體上的東西與目標點都在同一格，兩件事都要做得到。
 */
function interactButtonHtml(state: GameState, u: PlayerUnit, pos: Vec2): string {
  const kind = interactTarget(state, u, pos);
  if (!kind) return '';
  const label = kind === 'TERMINAL' ? '存取終端（主目標）'
    : kind === 'SUPPLY' ? '回收補給箱（次要目標）'
    : '撤離（帶著背包走人）';
  const legal = checkLegal(state, { type: 'INTERACT', pos });
  return '<button data-do="interact" ' + (legal.ok ? 'class="primary"' : 'disabled') + '>'
    + esc(label) + '<em>'
    + (legal.ok ? '費時 ' + commandTime(state, { type: 'INTERACT', pos }) : esc(legal.reason))
    + '</em></button>';
}

/** 點一堆東西 → 可拿的清單。§4.3 的兩段式文法：第一下顯示，第二下拿。 */
export function lootPanelHtml(state: GameState, pos: Vec2): string {
  const u = activePlayerUnit(state);
  const pile = lootAt(state, pos);
  if (!u || !pile) return '';
  const inReach = manhattan(u.pos, pos) <= 1;
  const room = maxWeight() - carriedWeight(u);
  // 同一格既是屍體又是目標點的情況（v0.19 附錄）——兩件事都要做得到
  const interact = interactButtonHtml(state, u, pos);

  let html = head(pile.label);
  if (pile.items.length === 0) {
    return html + '<p class="note">這裡已經空了。</p>'
      + '<div class="menu-actions">' + interact + '</div>';
  }
  html += '<p class="note">'
    + (inReach
      ? '每次搜刮費時 ' + RULES.loot.takeTime + '　背包還剩 ' + fmtWeight(room) + ' 重量'
      : '必須走到這一格或相鄰格')
    + '</p><div class="menu-actions">'
    + interact;

  if (inReach) {
    const allLegal = checkLegal(state, { type: 'TAKE_ALL', lootId: pile.id });
    html += '<button data-do="take-all" data-loot="' + esc(pile.id) + '"'
      + (allLegal.ok ? ' class="primary"' : ' disabled')
      + '>全部拿走<em>費時 ' + RULES.loot.takeTime + '，超重的留在原地</em></button>';
  }
  pile.items.forEach((it, i) => { html += itemButtons(state, pile, it, i, u, inReach); });
  return html + '</div>';
}

/**
 * 準備與丟棄要二次確認（§12.20）。
 *
 * 用「同一顆鍵按兩次」而不是另開一個對話框：手機上單手可達，
 * 而且不會把已經滿版的背包再蓋一層。第一下把該鍵換成確認樣式，
 * 按別的鍵就取消 —— 誤觸的代價只是多看一眼。
 */
function needsConfirm(kind: string | undefined): boolean {
  // v0.18：搬裝備會花時間，而背包是滿版介面 —— 誤觸的代價是整場的時間。
  return kind === 'prepare' || kind === 'drop' || kind === 'gear' || kind === 'swap';
}

export function wireMenu(host: HTMLElement, at: Vec2, h: MenuHandlers): void {
  let armed: HTMLButtonElement | null = null;
  const disarm = (): void => {
    if (!armed) return;
    armed.classList.remove('confirm');
    if (armed.dataset.label) armed.innerHTML = armed.dataset.label;
    armed = null;
  };

  host.querySelectorAll<HTMLButtonElement>('button[data-do]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (needsConfirm(btn.dataset.do) && armed !== btn) {
        disarm();
        armed = btn;
        btn.dataset.label = btn.innerHTML;
        btn.innerHTML = '再按一次確認<em>' + esc(btn.textContent?.trim().slice(0, 14) ?? '') + '</em>';
        btn.classList.add('confirm');
        return;
      }
      disarm();
      switch (btn.dataset.do) {
        case 'interact': h.interact(at); break;
        case 'abort-seq': h.abortSequence(); break;
        case 'take-all': h.takeAll(btn.dataset.loot as string); break;
        case 'prepare': h.prepare(btn.dataset.item as string); break;
        case 'drop': h.drop(btn.dataset.item as string); break;
        case 'swap': h.swapWeapon(); break;
        case 'gear':
          h.moveGear(
            btn.dataset.from as WeaponSlot,
            btn.dataset.to as WeaponSlot,
            btn.dataset.item || undefined,
          );
          break;
        case 'pickup':
          h.pickup(
            btn.dataset.loot as string,
            Number(btn.dataset.idx),
            btn.dataset.slot as WeaponSlot | undefined,
          );
          break;
        default: h.close();
      }
    });
  });
}

/**
 * 一顆搬裝備的按鈕（v0.18 §3.2）。
 * **顯示時間花費**，而且會走 needsConfirm 的二次確認 ——
 * 背包是滿版介面，誤觸的代價是整場的時間。
 */
function gearButton(
  state: GameState, from: WeaponSlot, to: WeaponSlot, label: string, itemId?: string,
): string {
  const cmd = { type: 'MOVE_GEAR' as const, from, to, itemId };
  const legal = checkLegal(state, cmd);
  const cost = commandTime(state, cmd);
  return '<button data-do="gear" data-from="' + from + '" data-to="' + to + '"'
    + (itemId ? ' data-item="' + esc(itemId) + '"' : '')
    + (legal.ok ? '' : ' disabled') + '>' + label
    + '<em>' + (legal.ok ? '費時 ' + cost : esc(legal.reason)) + '</em></button>';
}

/**
 * 裝備欄（v0.18 §3.1）。**沒有新增介面** —— 就長在既有的滿版背包畫面裡。
 *
 * 這一段存在的理由：空投下來的替補走到屍體旁邊，屍體上躺著一把無後座力砲，
 * 但他自己的主手與收納欄都滿了，而在此之前**遊戲裡沒有任何動作可以騰出位置**。
 */
function gearSectionHtml(state: GameState, u: PlayerUnit): string {
  const row = (slot: WeaponSlot, name: string, w: PlayerUnit['equipped']): string => {
    if (!w) return '<button disabled>' + name + '：空<em>沒有東西可以搬</em></button>';
    const label = name + '：' + esc(w.name) + '（' + fmtWeight(w.weight) + '）';
    return gearButton(state, slot, 'BACKPACK', label + ' → 背包');
  };
  const swap = checkLegal(state, { type: 'SWAP_WEAPON' });
  return '<h3 class="sub">裝備</h3>'
    + '<p class="note">三個位置的東西<b>全部計入負重</b>，所以搬動不改變總重 ——'
    + '改變的是拿不拿得到。也因此它要花時間：在敵火下騰位置是件蠢事。</p>'
    + '<div class="menu-actions">'
    + row('EQUIPPED', '手持', u.equipped)
    + row('STOWED', '收納', u.stowed)
    + '<button data-do="swap"' + (swap.ok ? '' : ' disabled') + '>手持 ↔ 收納'
    + '<em>' + (swap.ok ? '費時 ' + commandTime(state, { type: 'SWAP_WEAPON' }) : esc(swap.reason))
    + '</em></button>'
    + '</div>';
}

/**
 * 背包（§12.20）。**檢視不花時間** —— 那是玩家自己的東西，屬於資訊而非行動。
 *
 * 這裡沒有「使用」，只有「準備」。使用一律回到戰鬥主畫面按「用」（§12.19）：
 * 準備要花 10，所以「你身上現在準備好的是什麼」變成一個要提前做的決定，
 * 與「現在手上拿的是哪把槍」完全對稱。
 */
export function backpackHtml(state: GameState): string {
  const u = activePlayerUnit(state);
  if (!u || !u.backpack) return '';
  // v0.15：手持與收納的武器也計重，所以背包畫面顯示的是**身上全部**的重量
  const load = carriedWeight(u);
  const tier = weightTierIndex(load);
  const next = nextTierAt(load);
  const prepared = u.preparedId
    ? u.backpack.items.find((it) => it.id === u.preparedId) ?? null
    : null;

  let html = head('背包')
    + '<div class="stat-grid">'
    + stat('負重', fmtWeight(load) + '/' + maxWeight(), tier > 0)
    + stat('移動一格', String(moveCostForWeight(load)), tier > 0)
    + stat('準備欄', prepared ? prepared.name : '空', !!prepared)
    + '</div>';

  // 負重級距在 v0.9 是隱形的，玩家只能從移動變慢間接感覺到。這一版要說出來。
  html += '<p class="note">'
    + (tier === 0
      ? '目前是最輕的級距（移動 ' + moveCostForWeight(0) + '）。'
      : '<b>已經被拖慢了。</b>')
    + (next !== null
      ? '　再撿 ' + fmtWeight(next - load + 0.5) + ' 就會掉到下一級（移動 '
        + moveCostForWeight(next + 1) + '）。'
      : '　已經是最重的級距。')
    + '</p>';

  html += gearSectionHtml(state, u);

  html += '<h3 class="sub">背包</h3>';
  if (u.backpack.items.length === 0) {
    return html + '<p class="note">背包是空的。</p><div class="menu-actions"></div>';
  }

  html += '<div class="menu-actions">';
  for (const it of u.backpack.items) {
    const label = esc(itemText(it)) + '（' + fmtWeight(stackWeight(it)) + '）';
    const isPrepared = prepared !== null && prepared.id === it.id;
    if (it.kind === 'CONSUMABLE') {
      const legal = checkLegal(state, { type: 'PREPARE', itemId: it.id });
      html += '<button data-do="prepare" data-item="' + esc(it.id) + '"'
        + (legal.ok ? ' class="primary"' : ' disabled')
        + '>' + (isPrepared ? '已準備：' : '準備 ') + label
        + '<em>' + (legal.ok ? '費時 ' + RULES.time.prepare : esc(legal.reason)) + '</em></button>';
    } else {
      if (it.kind === 'WEAPON') {
        // v0.18：這一顆就是 v0.9 規格預期、但一直沒實作的那個動作。
        html += gearButton(state, 'BACKPACK', 'STOWED', '移到收納欄 ' + label, it.id);
      } else {
        html += '<button disabled>' + label + '<em>'
          + (it.kind === 'AMMO' ? '裝填時自動使用' : '帶出去才有價值')
          + '</em></button>';
      }
    }
    html += '<button class="danger" data-do="drop" data-item="' + esc(it.id) + '">丟下 '
      + label + '<em>不花時間，落在腳下</em></button>';
  }
  return html + '</div>';
}
