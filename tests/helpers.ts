import type { GameState, Unit, Vec2 } from '../src/core/state';
import { activePlayerUnit, findUnit } from '../src/core/state';
import type { RawMap } from '../src/core/map';
import { createInitialState } from '../src/core/setup';
import type { Command } from '../src/core/commands';
import { applyCommand } from '../src/core/commands';
import type { CombatEvent } from '../src/core/events';

/**
 * 套用指令並只取新狀態。
 * applyCommand 現在回傳 { state, events }（§8.6），非法指令的 state 仍是原物件，
 * 所以 `expect(run(s, cmd)).toBe(s)` 這種 identity 比對照樣成立。
 */
export function run(s: GameState, cmd: Command): GameState {
  return applyCommand(s, cmd).state;
}

/** 套用指令並只取事件清單。 */
export function events(s: GameState, cmd: Command): CombatEvent[] {
  return applyCommand(s, cmd).events;
}


export const LEGEND = {
  '.': 'FLOOR',
  '#': 'WALL',
  '+': 'HALF_COVER',
  D: 'DROP_POINT',
  T: 'TERMINAL',
  S: 'SUPPLY',
};

/** 由 ASCII 列建立測試用狀態。地圖必須含至少一個 D 與剛好一個 T。 */
export function testState(
  rows: string[],
  enemies: { archetype: string; pos: Vec2 }[] = [],
  seed = 1,
): GameState {
  let start: Vec2 | null = null;
  rows.forEach((r, y) => {
    const x = r.indexOf('D');
    if (x >= 0 && !start) start = { x, y };
  });
  if (!start) throw new Error('測試地圖必須含 D');

  const raw: RawMap = {
    id: 'test',
    name: 'test',
    width: rows[0].length,
    height: rows.length,
    legend: LEGEND,
    tiles: rows,
    startDropPoint: start,
    enemies,
  };
  return createInitialState(seed, raw);
}

export function player(s: GameState): Unit {
  const u = activePlayerUnit(s);
  if (!u) throw new Error('沒有存活的玩家單位');
  return u;
}

export function unit(s: GameState, id: string): Unit {
  const u = findUnit(s, id);
  if (!u) throw new Error('找不到單位 ' + id);
  return u;
}

/** 直接把玩家單位放到指定位置／姿勢（測試專用捷徑）。 */
export function placePlayer(s: GameState, pos: Vec2, stance: 'STAND' | 'CROUCH' = 'STAND'): void {
  const u = player(s);
  u.pos = { ...pos };
  u.stance = stance;
}
