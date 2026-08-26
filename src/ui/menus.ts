/**
 * 點擊地圖格的情境選單（§12.4）。
 *
 * 手機沒有 hover：所有預覽資訊都靠「點擊 → 預覽 → 再點擊確認」兩段式取得。
 * 只列出當前合法的選項；不合法的一律灰化並附上原因，不讓玩家點下去才被拒絕。
 */
import type { GameState, Vec2 } from '../core/state';
import { activePlayerUnit, corpseAt, unitAt } from '../core/state';
import type { WeaponSlot } from '../core/commands';
import { checkLegal, interactTarget, movePath } from '../core/commands';
import { damageAfterArmor, toHitChance } from '../core/combat';
import { chebyshev, sameTile } from '../core/grid';
import { tileAt } from '../core/map';
import { esc } from './dom';

export interface MenuHandlers {
  fire(target: Vec2): void;
  moveTo(target: Vec2): void;
  pickup(corpseId: string, weaponIndex: number, slot: WeaponSlot): void;
  interact(): void;
  close(): void;
}

const TILE_LABEL: Record<string, string> = {
  FLOOR: '地板', WALL: '牆', HALF_COVER: '半身掩體',
  DROP_POINT: '空投點', TERMINAL: '終端', SUPPLY: '補給箱',
};

function head(title: string): string {
  return '<h3>' + esc(title) + '<button class="close" data-do="close">關閉</button></h3>';
}

function stat(label: string, value: string, accent = false): string {
  return '<div class="stat' + (accent ? ' accent' : '') + '"><span>'
    + esc(label) + '</span><b>' + esc(value) + '</b></div>';
}

function moveButton(state: GameState, pos: Vec2): string {
  const path = movePath(state, pos);
  const u = activePlayerUnit(state);
  if (!path || !u) return '<button disabled>移動至此<em>沒有路徑</em></button>';
  if (path.length === 0) return '';
  const enough = path.length <= u.ap;
  return '<button data-do="move" ' + (enough ? 'class="primary"' : 'disabled') + '>'
    + '移動至此<em>' + path.length + ' AP'
    + (enough ? '' : '（AP 不足，目前 ' + u.ap + '）') + '</em></button>';
}

/** 射擊預覽面板。命中率欄位現在就固定在版面上（MVP 顯示 100%）。 */
function firePanel(state: GameState, pos: Vec2): string {
  const u = activePlayerUnit(state);
  const foe = unitAt(state, pos);
  if (!u || !foe) return '';
  const w = u.equipped;
  const legal = checkLegal(state, { type: 'FIRE', target: pos });

  const chance = w ? toHitChance(u, foe, w, state) : 0;
  const dmg = w ? damageAfterArmor(w.damage, foe.armor) : 0;
  const apLeft = w ? u.ap - w.fireCost : u.ap;

  const notes = [
    '目標 HP ' + Math.max(0, foe.hp) + '/' + foe.maxHp,
    '護甲 ' + foe.armor,
    '距離 ' + chebyshev(u.pos, pos) + ' 格',
    w ? w.name + '（射程 ' + w.range + '・彈藥 ' + w.ammo + '/' + w.magazine
        + '・噪音 ' + w.noiseRadius + ' 格）' : '空手',
  ];
  if (w && w.splash > 0) notes.push('濺射半徑 ' + w.splash + '（會傷到自己人）');

  return head('射擊預覽 — ' + foe.name)
    + '<div class="stat-grid">'
    + stat('命中率', Math.round(chance * 100) + '%', true)
    + stat('傷害', String(dmg))
    + stat('剩餘 AP', String(Math.max(0, apLeft)))
    + '</div>'
    + '<p class="note">' + esc(notes.join(' ・ ')) + '</p>'
    + '<div class="menu-actions">'
    + (legal.ok
      ? '<button class="primary" data-do="fire">確認射擊<em>或再點一次目標</em></button>'
      : '<button disabled>無法射擊<em>' + esc(legal.reason) + '</em></button>' + moveButton(state, pos))
    + '</div>';
}

function corpsePanel(state: GameState, pos: Vec2): string {
  const u = activePlayerUnit(state);
  const corpse = corpseAt(state, pos);
  if (!u || !corpse) return '';
  const standing = sameTile(u.pos, pos);

  let html = head(corpse.unitId + ' 的遺體');
  if (corpse.weapons.length === 0) {
    html += '<p class="note">身上已經沒有可回收的裝備了。</p>';
  } else {
    html += '<p class="note">遺留裝備 ' + corpse.weapons.length + ' 件'
      + (standing ? '（拾取 1 AP，換下來的槍免費留在原地）' : '（必須先走到這一格）') + '</p>';
  }
  html += '<div class="menu-actions">';

  corpse.weapons.forEach((w, i) => {
    const label = esc(w.name) + ' ' + w.ammo + '/' + w.magazine;
    if (!standing) {
      html += '<button disabled>' + label + '<em>需站在該格</em></button>';
      return;
    }
    const free: WeaponSlot | null = !u.equipped ? 'EQUIPPED' : !u.stowed ? 'STOWED' : null;
    const slots: WeaponSlot[] = free ? [free] : ['EQUIPPED', 'STOWED'];
    for (const slot of slots) {
      const legal = checkLegal(state, {
        type: 'PICKUP', corpseId: corpse.id, weaponIndex: i, slot,
      });
      const cur = slot === 'EQUIPPED' ? u.equipped : u.stowed;
      const suffix = free ? '' : ' → ' + (slot === 'EQUIPPED' ? '手持' : '收納');
      const hint = legal.ok
        ? '1 AP' + (cur ? '・替換 ' + esc(cur.name) : '')
        : esc(legal.reason);
      html += '<button data-do="pickup" data-corpse="' + esc(corpse.id) + '" data-idx="' + i
        + '" data-slot="' + slot + '"' + (legal.ok && free ? ' class="primary"' : legal.ok ? '' : ' disabled')
        + '>拾取 ' + label + suffix + '<em>' + hint + '</em></button>';
    }
  });

  if (!standing) html += moveButton(state, pos);
  html += '</div>';
  return html;
}

function selfPanel(state: GameState): string {
  const u = activePlayerUnit(state);
  if (!u) return '';
  const w = u.equipped;
  const s = u.stowed;
  const kind = interactTarget(state, u);
  const interactLabel = kind === 'TERMINAL' ? '存取終端（主目標）'
    : kind === 'SUPPLY' ? '回收補給箱（次要目標）'
    : kind === 'EXTRACT' ? '撤離（任務成功）' : null;
  const legal = checkLegal(state, { type: 'INTERACT' });

  return head(u.name + '　詳細狀態')
    + '<div class="stat-grid">'
    + stat('HP', Math.max(0, u.hp) + '/' + u.maxHp)
    + stat('AP', u.ap + '/' + u.maxAp, true)
    + stat('姿勢', u.stance === 'CROUCH' ? '蹲' : '站')
    + '</div>'
    + '<p class="note">手持：' + esc(w ? w.name + ' ' + w.ammo + '/' + w.magazine : '空手')
    + '　收納：' + esc(s ? s.name + ' ' + s.ammo + '/' + s.magazine : '無')
    + '<br>視野 ' + u.sightRange + ' 格・面向 ' + u.facing + '（面向不影響視野，僅美術用）</p>'
    + '<div class="menu-actions">'
    + (interactLabel
      ? '<button data-do="interact" ' + (legal.ok ? 'class="primary"' : 'disabled') + '>'
        + esc(interactLabel) + '<em>' + (legal.ok ? '1 AP' : esc(legal.reason)) + '</em></button>'
      : '')
    + '</div>';
}

function tilePanel(state: GameState, pos: Vec2): string {
  const u = activePlayerUnit(state);
  const kind = tileAt(state.map, pos);
  const standing = !!u && sameTile(u.pos, pos);

  let html = head('(' + pos.x + ',' + pos.y + ')　' + (TILE_LABEL[kind] ?? kind));
  const notes: string[] = [];
  if (kind === 'HALF_COVER') {
    notes.push('緊鄰這一格並蹲下 → 越過它的視線雙向阻擋；站起來就能越過它射擊。');
  }
  if (kind === 'DROP_POINT') {
    notes.push(sameTile(pos, state.map.startDropPoint)
      ? '初始空投點：完成主目標後回到這裡互動即可撤離。'
      : '增援落點：陣亡後新士兵會從最近的空投點出現。');
  }
  if (kind === 'TERMINAL') notes.push('主目標：站上去花 1 AP 互動。');
  if (kind === 'SUPPLY') notes.push('次要目標：站上去花 1 AP 互動。');
  if (notes.length) html += '<p class="note">' + esc(notes.join(' ')) + '</p>';

  html += '<div class="menu-actions">';
  if (standing) {
    const legal = checkLegal(state, { type: 'INTERACT' });
    const now = u ? interactTarget(state, u) : null;
    if (now || legal.reason.includes('主目標') || legal.reason.includes('已經完成')) {
      html += '<button data-do="interact" ' + (legal.ok ? 'class="primary"' : 'disabled')
        + '>互動<em>' + (legal.ok ? '1 AP' : esc(legal.reason)) + '</em></button>';
    }
  } else {
    html += moveButton(state, pos);
  }
  html += '</div>';
  return html;
}

/** 依照點到的東西組出面板。回傳 null 表示不開選單。 */
export function tileMenuHtml(state: GameState, pos: Vec2): string | null {
  const u = activePlayerUnit(state);
  if (!u) return null;
  const target = unitAt(state, pos);
  if (target && target.faction === 'ENEMY') return firePanel(state, pos);
  if (corpseAt(state, pos)) return corpsePanel(state, pos);
  if (sameTile(u.pos, pos)) return selfPanel(state);
  return tilePanel(state, pos);
}

export function wireMenu(host: HTMLElement, pos: Vec2, h: MenuHandlers): void {
  host.querySelectorAll<HTMLButtonElement>('button[data-do]').forEach((btn) => {
    btn.addEventListener('click', () => {
      switch (btn.dataset.do) {
        case 'fire': h.fire(pos); break;
        case 'move': h.moveTo(pos); break;
        case 'interact': h.interact(); break;
        case 'pickup':
          h.pickup(btn.dataset.corpse as string, Number(btn.dataset.idx), btn.dataset.slot as WeaponSlot);
          break;
        default: h.close();
      }
    });
  });
}
