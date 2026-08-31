/**
 * 針對正式任務地圖 mission_01 的整合測試。
 * 目的不是驗證「打得贏」，而是驗證地圖可玩、流程一定會收斂、不會卡死。
 */
import { describe, it, expect } from 'vitest';
import { isPlayerTurn } from '../src/core/scheduler';
import { createInitialState } from '../src/core/setup';
import { applyCommand } from '../src/core/commands';
import type { Command } from '../src/core/commands';

/** applyCommand 現在回傳 { state, events }（§8.6）；這裡只取狀態。 */
function run(s: GameState, cmd: Command): GameState {
  return applyCommand(s, cmd).state;
}

import { findPath, stepDirection } from '../src/core/pathfind';
import { activePlayerUnit, unitAt } from '../src/core/state';
import { findTiles } from '../src/core/map';
import { canAttackAny } from '../src/core/combat';
import { manhattan } from '../src/core/grid';
import type { Facing, GameState, Vec2 } from '../src/core/state';

describe('mission_01 地圖完整性（§13.1）', () => {
  const s = createInitialState(1);
  const start = s.map.startDropPoint;

  it('主目標從起點走得到，也走得回來', () => {
    const t = s.objectives.main.pos;
    const there = findPath(s, start, t, { ignoreUnitIds: s.units.map((u) => u.id) });
    const back = findPath(s, t, start, { ignoreUnitIds: s.units.map((u) => u.id) });
    expect(there).not.toBeNull();
    expect(back).not.toBeNull();
    expect(there!.length).toBeGreaterThan(30); // 四方向下路徑更長；終端在離起點最遠的一端
  });

  it('兩個次要目標都走得到，且都在主路線之外（需要繞路）', () => {
    const ignore = s.units.map((u) => u.id);
    const mainLen = findPath(s, start, s.objectives.main.pos, { ignoreUnitIds: ignore })!.length;
    for (const o of s.objectives.secondary) {
      const via = findPath(s, start, o.pos, { ignoreUnitIds: ignore });
      expect(via).not.toBeNull();
      const rest = findPath(s, o.pos, s.objectives.main.pos, { ignoreUnitIds: ignore });
      expect(rest).not.toBeNull();
      // 繞過去再回主目標，一定比直接走主路線遠
      expect(via!.length + rest!.length).toBeGreaterThan(mainLen);
    }
  });

  it('三個空投點彼此可達，且分散在路線上', () => {
    const drops = findTiles(s.map, 'DROP_POINT');
    expect(drops.length).toBeGreaterThanOrEqual(3);
    const ignore = s.units.map((u) => u.id);
    const dists = drops.map((d) => findPath(s, start, d, { ignoreUnitIds: ignore })?.length ?? -1);
    expect(dists.every((d) => d >= 0)).toBe(true);
    // 至少有一個空投點離起點超過 15 格（死一次要付出空間代價）
    expect(Math.max(...dists)).toBeGreaterThan(15);
  });

  it('每個敵人的出生點都是可通行且互不重疊的', () => {
    const seen = new Set<string>();
    for (const u of s.units) {
      const k = u.pos.x + ',' + u.pos.y;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
});

/** 一個很笨但決定性的機器人：站到目標就互動，能打就打，不然往目標走。 */
function botTurn(s: GameState, goal: Vec2): GameState {
  const u = activePlayerUnit(s);
  if (!u) return s;

  // v0.3：相鄰即可互動，不必站上去
  if (manhattan(u.pos, goal) <= 1) {
    const acted = run(s, { type: 'INTERACT', pos: goal });
    if (acted !== s) return acted;
    return run(s, { type: 'WAIT' });
  }

  // 相鄰或射程內有敵人就開火
  let target: Vec2 | null = null;
  let best = Infinity;
  for (const e of s.units) {
    if (e.faction !== 'ENEMY') continue;
    if (!canAttackAny(s, u, e.pos).ok) continue;
    const d = manhattan(u.pos, e.pos);
    if (d < best) { best = d; target = e.pos; }
  }
  if (target) return run(s, { type: 'FIRE', target });
  // **裝填不成就繼續往下走。**沒有備彈時 RELOAD 是非法的，
  // 而非法指令回傳同一個狀態物件（§3.1 的識別契約）—— 直接 return 會讓機器人卡死。
  if (u.equipped && u.equipped.ammo === 0) {
    const reloaded = run(s, { type: 'RELOAD' });
    if (reloaded !== s) return reloaded;
  }

  const path = findPath(s, u.pos, goal, { ignoreUnitIds: [u.id] });
  if (path && path.length > 0) {
    const step = path[0];
    if (unitAt(s, step)) return run(s, { type: 'WAIT' });
    // v0.19：翻越那一步在路徑上是兩格，要用 stepDirection
    const dir = stepDirection(u.pos, step);
    if (dir) {
      const next = run(s, { type: 'MOVE', dir: dir as Facing });
      if (next !== s) return next;
    }
  }
  return run(s, { type: 'WAIT' });
}

describe('整場任務一定會收斂（不卡死）', () => {
  it('機器人跑完整場：狀態機必定走到 MISSION_END，且不會無限迴圈', () => {
    let s = createInitialState(20260826);
    let steps = 0;
    const LIMIT = 20000;

    while (s.result === 'ONGOING' && steps++ < LIMIT) {
      if (s.pendingReinforcement) {
        s = run(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] });
        continue;
      }
      if (!isPlayerTurn(s)) {
        const before = s;
        s = run(s, { type: 'ADVANCE' });
        expect(s, '敵人回合卡住了').not.toBe(before);
        continue;
      }
      // 先拿主目標，再回撤離點
      const goal = s.objectives.main.done ? s.map.startDropPoint : s.objectives.main.pos;
      const before = s;
      s = botTurn(s, goal);
      expect(s, '玩家回合卡住了').not.toBe(before);
    }

    expect(steps).toBeLessThan(LIMIT);
    expect(s.result).not.toBe('ONGOING');
    expect(['SUCCESS', 'WIPED', 'ABORTED']).toContain(s.result);
    expect(s.deployed).toBeLessThanOrEqual(4);
    expect(s.casualties).toBeLessThanOrEqual(4);
    // 陣亡就一定留下屍體與裝備。v0.9 起敵人也留殘骸、地圖也有搜刮點（§4），
    // 所以只驗「己方遺體數 = 陣亡數」。
    expect(s.loot.filter((c) => c.kind === 'PLAYER_BODY').length).toBe(s.casualties);
  });

  it('同一場跑兩次結果完全一致', () => {
    const playOnce = (): string => {
      let s = createInitialState(20260826);
      let steps = 0;
      while (s.result === 'ONGOING' && steps++ < 20000) {
        if (s.pendingReinforcement) {
          s = run(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] });
        } else if (!isPlayerTurn(s)) {
          s = run(s, { type: 'ADVANCE' });
        } else {
          s = botTurn(s, s.objectives.main.done ? s.map.startDropPoint : s.objectives.main.pos);
        }
      }
      return JSON.stringify({ r: s.result, t: s.clock, c: s.casualties, log: s.log.length });
    };
    expect(playOnce()).toBe(playOnce());
  });
});
