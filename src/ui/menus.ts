/**
 * 浮動小卡（§12）。
 *
 * v0.3 起，高頻動作（射擊、移動、互動）全部改用「點一下預覽、再點一下執行」
 * 的地圖文法，預覽直接畫在戰場上，不再有面板。
 * 只剩兩種情況需要卡片：看自己的詳細狀態，以及從屍體挑一件裝備 ——
 * 兩者都是低頻、而且本來就需要一份清單。
 */
import type { GameState, Vec2 } from '../core/state';
import { activePlayerUnit, corpseAt } from '../core/state';
import type { WeaponSlot } from '../core/commands';
import { checkLegal, interactTarget } from '../core/commands';
import { sameTile } from '../core/grid';
import { effectiveSightRange } from '../core/stance';
import { esc } from './dom';

export interface MenuHandlers {
  pickup(corpseId: string, weaponIndex: number, slot: WeaponSlot): void;
  interact(pos: Vec2): void;
  close(): void;
}

function head(title: string): string {
  return '<h3>' + esc(title) + '<button class="close" data-do="close">關閉</button></h3>';
}

function stat(label: string, value: string, accent = false): string {
  return '<div class="stat' + (accent ? ' accent' : '') + '"><span>'
    + esc(label) + '</span><b>' + esc(value) + '</b></div>';
}

/** 點自己 → 詳細狀態。單次點擊即可，不需第二下。 */
export function selfPanelHtml(state: GameState): string {
  const u = activePlayerUnit(state);
  if (!u) return '';
  const w = u.equipped;
  const st = u.stowed;
  const kind = interactTarget(state, u, u.pos);
  const label = kind === 'TERMINAL' ? '存取終端（主目標）'
    : kind === 'SUPPLY' ? '回收補給箱（次要目標）'
    : kind === 'EXTRACT' ? '撤離（任務成功）' : null;
  const legal = checkLegal(state, { type: 'INTERACT', pos: u.pos });

  return head(u.name + '　詳細狀態')
    + '<div class="stat-grid">'
    + stat('HP', Math.max(0, u.hp) + '/' + u.maxHp)
    + stat('AP', u.ap + '/' + u.maxAp, true)
    + stat('姿勢', u.stance === 'CROUCH' ? '蹲' : '站')
    + '</div>'
    + '<p class="note">手持：' + esc(w ? w.name + ' ' + w.ammo + '/' + w.magazine : '空手')
    + '　收納：' + esc(st ? st.name + ' ' + st.ammo + '/' + st.magazine : '無')
    + '<br>視野 ' + effectiveSightRange(u) + ' 格（曼哈頓，蹲姿縮短）・面向 ' + u.facing + '（面向不影響視野，僅美術用）</p>'
    + '<div class="menu-actions">'
    + (label
      ? '<button data-do="interact" ' + (legal.ok ? 'class="primary"' : 'disabled') + '>'
        + esc(label) + '<em>' + (legal.ok ? '1 AP' : esc(legal.reason)) + '</em></button>'
      : '')
    + '</div>';
}

/** 點屍體 → 可拾取的物品清單。再點屍體一次 = 拾取第一件。 */
export function corpsePanelHtml(state: GameState, pos: Vec2): string {
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
        + '" data-slot="' + slot + '"'
        + (legal.ok && free ? ' class="primary"' : legal.ok ? '' : ' disabled')
        + '>拾取 ' + label + suffix + '<em>' + hint + '</em></button>';
    }
  });
  html += '</div>';
  return html;
}

export function wireMenu(host: HTMLElement, at: Vec2, h: MenuHandlers): void {
  host.querySelectorAll<HTMLButtonElement>('button[data-do]').forEach((btn) => {
    btn.addEventListener('click', () => {
      switch (btn.dataset.do) {
        case 'interact': h.interact(at); break;
        case 'pickup':
          h.pickup(btn.dataset.corpse as string, Number(btn.dataset.idx), btn.dataset.slot as WeaponSlot);
          break;
        default: h.close();
      }
    });
  });
}
