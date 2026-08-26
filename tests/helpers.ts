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

// ---------------------------------------------------------------------------
// v0.5：戰鬥現在有三個擲值。測「機制」的時候要把浮動關掉，
// 測「浮動」的時候才打開 —— 兩者混在一起會讓斷言變成在賭運氣。
// ---------------------------------------------------------------------------
import { resetToHitPolicy, setToHitPolicy } from '../src/core/combat';
import { ACTORS, RULES, WEAPONS } from '../src/core/content';

/** 強制必中／必不中。測非命中相關的機制時用。 */
export function forceHit(): void { setToHitPolicy(() => 1); }
export function forceMiss(): void { setToHitPolicy(() => 0); }
export function restoreHitPolicy(): void { resetToHitPolicy(); }

const ARCH_IDS = Object.keys(ACTORS).filter((k) => !k.startsWith('_'));
let frozen: { w: number[]; a: number[]; d: number[]; roll: boolean } | null = null;

/** 把傷害與護甲的浮動歸零、命中改為必中，讓斷言可以寫確切數字。 */
export function freezeCombat(): void {
  if (frozen) return;
  frozen = {
    w: WEAPONS.map((x) => x.damageSpread),
    a: ARCH_IDS.map((k) => ACTORS[k].armorSpread),
    d: ARCH_IDS.map((k) => ACTORS[k].attack?.damageSpread ?? 0),
    roll: RULES.combat.enableToHitRoll,
  };
  for (const x of WEAPONS) x.damageSpread = 0;
  for (const k of ARCH_IDS) {
    ACTORS[k].armorSpread = 0;
    if (ACTORS[k].attack) ACTORS[k].attack!.damageSpread = 0;
  }
  RULES.combat.enableToHitRoll = false;
  resetToHitPolicy();
}

export function thawCombat(): void {
  if (!frozen) return;
  WEAPONS.forEach((x, i) => { x.damageSpread = frozen!.w[i]; });
  ARCH_IDS.forEach((k, i) => {
    ACTORS[k].armorSpread = frozen!.a[i];
    if (ACTORS[k].attack) ACTORS[k].attack!.damageSpread = frozen!.d[i];
  });
  RULES.combat.enableToHitRoll = frozen.roll;
  frozen = null;
  resetToHitPolicy();
}
