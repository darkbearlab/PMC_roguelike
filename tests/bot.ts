/**
 * 決定性的機器人跑完整場任務，回傳完整事件序列與狀態摘要。
 *
 * 用途：驗證 v0.4 的「數值 ×10」是純資料改動（§1.4）——
 * 同一段劇本在放大前後必須產生**完全等價**的事件序列，只有生命值單位的數字大十倍。
 */
import type { Command, CommandResult } from '../src/core/commands';
import { applyCommand } from '../src/core/commands';
import { createInitialState } from '../src/core/setup';
import { findPath } from '../src/core/pathfind';
import { activePlayerUnit, unitAt } from '../src/core/state';
import { canAttackAny } from '../src/core/combat';
import { isPlayerTurn } from '../src/core/scheduler';
import { facingFromDelta, manhattan } from '../src/core/grid';
import type { CombatEvent } from '../src/core/events';
import type { Facing, GameState, Vec2 } from '../src/core/state';

export interface MissionTrace {
  events: CombatEvent[];
  result: string;
  /** 總耗時（世界時刻）。v0.7 之後沒有回合數。 */
  elapsed: number;
  casualties: number;
  deployed: number;
  /** 收場時每個存活單位的血量，用來確認數值規模 */
  hp: { id: string; hp: number; maxHp: number; armor: number }[];
}

function botTurn(s: GameState, goal: Vec2): CommandResult {
  const u = activePlayerUnit(s);
  if (!u) return { state: s, events: [] };

  if (manhattan(u.pos, goal) <= 1) {
    const acted = applyCommand(s, { type: 'INTERACT', pos: goal });
    if (acted.state !== s) return acted;
    return applyCommand(s, { type: 'WAIT' });
  }

  let target: Vec2 | null = null;
  let best = Infinity;
  for (const e of s.units) {
    if (e.faction !== 'ENEMY') continue;
    if (!canAttackAny(s, u, e.pos).ok) continue;
    const d = manhattan(u.pos, e.pos);
    if (d < best) { best = d; target = e.pos; }
  }
  if (target) return applyCommand(s, { type: 'FIRE', target });
  // 裝填不成就繼續往下走 —— 非法指令回傳同一個狀態物件，直接 return 會卡死
  if (u.equipped && u.equipped.ammo === 0) {
    const reloaded = applyCommand(s, { type: 'RELOAD' });
    if (reloaded.state !== s) return reloaded;
  }

  const path = findPath(s, u.pos, goal, { ignoreUnitIds: [u.id] });
  if (path && path.length > 0 && !unitAt(s, path[0])) {
    const dir = facingFromDelta(path[0].x - u.pos.x, path[0].y - u.pos.y);
    if (dir) {
      const next = applyCommand(s, { type: 'MOVE', dir: dir as Facing });
      if (next.state !== s) return next;
    }
  }
  return applyCommand(s, { type: 'WAIT' });
}

export function runMission(seed: number, limit = 20000): MissionTrace {
  let s = createInitialState(seed);
  const events: CombatEvent[] = [];
  const take = (r: CommandResult): void => { s = r.state; events.push(...r.events); };
  let steps = 0;

  while (s.result === 'ONGOING' && steps++ < limit) {
    if (s.pendingReinforcement) {
      take(applyCommand(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] } as Command));
      continue;
    }
    if (!isPlayerTurn(s)) {
      take(applyCommand(s, { type: 'ADVANCE' }));
      continue;
    }
    take(botTurn(s, s.objectives.main.done ? s.map.startDropPoint : s.objectives.main.pos));
  }

  return {
    events,
    result: s.result,
    elapsed: s.clock,
    casualties: s.casualties,
    deployed: s.deployed,
    hp: s.units.map((u) => ({ id: u.id, hp: u.hp, maxHp: u.maxHp, armor: u.armor })),
  };
}
