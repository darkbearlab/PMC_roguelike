/** HUD 列（§12.3）。永遠可見。 */
import type { GameState } from '../core/state';
import { abandonedWeapons, activePlayerUnit, enemies } from '../core/state';
import { COVER_LABEL, playerDefence } from '../core/cover';
import { $, esc } from './dom';

/** 武器型號：取名稱的第一個空白之前。 */
export function shortName(name: string): string {
  return name.split(' ')[0];
}

export function renderHud(state: GameState): void {
  const u = activePlayerUnit(state);

  // v0.7：沒有 AP 了。這一格改成顯示世界時刻，讓玩家對「花了多少時間」有概念。
  $('#hud-clock').textContent = 'T ' + state.clock;

  $('#hud-hp').textContent = u ? `HP ${Math.max(0, u.hp)}/${u.maxHp}` : 'HP —';

  const w = u ? u.equipped : null;
  // HUD 空間有限，只取型號（"AR-9 制式步槍" → "AR-9"）；完整名稱在詳細面板裡。
  $('#hud-weapon').textContent = w ? `${shortName(w.name)} ${w.ammo}/${w.magazine}` : '空手';

  // 防禦狀態：玩家要在按下結束回合前，知道自己會以什麼狀態承受攻擊（§12.11）
  const def = playerDefence(state);
  $('#hud-stance').textContent = u
    ? (u.stance === 'CROUCH' ? '蹲' : '站') + '・' + COVER_LABEL[def.level]
      + (def.threats > 0 ? '（' + def.threats + ' 人瞄得到）' : '（無人瞄準）')
    : '姿勢 —';
  $('#hud-stance').classList.toggle('warn', def.threats > 0 && def.level === 'NONE');
  $('#hud-roster').textContent = `名冊 ${state.roster.length}`;
  $('#hud-foes').textContent = `敵 ${enemies(state).length}`;

  $('#hud-ledger').innerHTML = ledgerHtml(state);
}

/** §12.3 戰況損益。止損二次確認也用同一份文字。 */
export function ledgerHtml(state: GameState): string {
  const sec = state.objectives.secondary;
  const done = sec.filter((o) => o.done).length;
  const lost = abandonedWeapons(state).length;
  return [
    `投入 <b>${state.deployed}</b> 名`,
    `陣亡 <b>${state.casualties}</b> 名`,
    `主目標 <b>${state.objectives.main.done ? '已完成' : '未完成'}</b>`,
    `次要 <b>${done}/${sec.length}</b>`,
    `戰場遺留 <b>${lost}</b> 件裝備`,
  ].join(' ／ ');
}

export function ledgerText(state: GameState): string {
  return ledgerHtml(state).replace(/<\/?b>/g, '');
}

export function abandonedList(state: GameState): string {
  const ws = abandonedWeapons(state);
  if (ws.length === 0) return '<li>無 —— 全部裝備都帶回來了</li>';
  const byCorpse = state.corpses
    .filter((c) => c.weapons.length > 0)
    .map((c) => `<li>${esc(c.unitId)} 於 (${c.pos.x},${c.pos.y})：`
      + esc(c.weapons.map((w) => w.name).join('、')) + '</li>');
  return byCorpse.join('');
}
