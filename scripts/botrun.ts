/** 跑幾場笨機器人，看看難度落點大概在哪（僅供調參參考，不是測試）。 */
import { createInitialState } from '../src/core/setup';
import { applyCommand } from '../src/core/commands';
import { findPath } from '../src/core/pathfind';
import { activePlayerUnit, unitAt } from '../src/core/state';
import { canAttack } from '../src/core/combat';
import { chebyshev, facingFromDelta, sameTile } from '../src/core/grid';
import type { Facing, GameState, Vec2 } from '../src/core/state';

function botTurn(s: GameState, goal: Vec2): GameState {
  const u = activePlayerUnit(s);
  if (!u) return s;
  if (sameTile(u.pos, goal)) {
    const acted = applyCommand(s, { type: 'INTERACT' });
    if (acted !== s) return acted;
    return applyCommand(s, { type: 'WAIT' });
  }
  let target: Vec2 | null = null;
  let best = Infinity;
  for (const e of s.units) {
    if (e.faction !== 'ENEMY') continue;
    if (!canAttack(s, u, e.pos, u.equipped).ok) continue;
    const d = chebyshev(u.pos, e.pos);
    if (d < best) { best = d; target = e.pos; }
  }
  if (target) return applyCommand(s, { type: 'FIRE', target });
  if (u.equipped && u.equipped.ammo === 0) return applyCommand(s, { type: 'RELOAD' });
  const path = findPath(s, u.pos, goal, { ignoreUnitIds: [u.id] });
  if (path && path.length > 0 && !unitAt(s, path[0])) {
    const dir = facingFromDelta(path[0].x - u.pos.x, path[0].y - u.pos.y);
    if (dir) {
      const next = applyCommand(s, { type: 'MOVE', dir: dir as Facing });
      if (next !== s) return next;
    }
  }
  return applyCommand(s, { type: 'WAIT' });
}

for (const seed of [1, 42, 999, 20260826, 7777]) {
  let s = createInitialState(seed);
  let guard = 0;
  while (s.result === 'ONGOING' && guard++ < 20000) {
    if (s.pendingReinforcement) { s = applyCommand(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] }); continue; }
    if (s.phase === 'ENEMY') { s = applyCommand(s, { type: 'ENEMY_STEP' }); continue; }
    s = botTurn(s, s.objectives.main.done ? s.map.startDropPoint : s.objectives.main.pos);
  }
  const foes = s.units.filter((u) => u.faction === 'ENEMY').length;
  console.log(
    `seed ${String(seed).padStart(9)} → ${s.result.padEnd(8)}`,
    `回合 ${String(s.turn).padStart(3)}`,
    `投入 ${s.deployed}`, `陣亡 ${s.casualties}`,
    `主目標 ${s.objectives.main.done ? '✓' : '✗'}`,
    `殘敵 ${foes}/10`,
    `遺留裝備 ${s.corpses.reduce((n, c) => n + c.weapons.length, 0)}`,
  );
}
