import type { Facing, GameState, Unit, Vec2, WeaponInstance } from '../src/core/state';
import { activePlayerUnit, findUnit } from '../src/core/state';
import type { RawMap } from '../src/core/map';
import { createInitialState } from '../src/core/setup';
import type { Command } from '../src/core/commands';
import { applyCommand } from '../src/core/commands';
import { isPlayerTurn } from '../src/core/scheduler';
import { makeWeapon } from '../src/core/weapon';
import { facingToward } from '../src/core/grid';
import { archetype } from '../src/core/content';
import type { CombatEvent } from '../src/core/events';

/**
 * 套用指令並只取新狀態。
 * applyCommand 現在回傳 { state, events }（§8.6），非法指令的 state 仍是原物件，
 * 所以 `expect(run(s, cmd)).toBe(s)` 這種 identity 比對照樣成立。
 */
export function run(s: GameState, cmd: Command): GameState {
  return applyCommand(s, cmd).state;
}

/**
 * 推進排程器直到再次輪到玩家（或任務結束／等待補人）。
 * v0.7 沒有「敵人回合」了 —— 這只是「一直讓非玩家單位行動」。
 */
export function advanceToPlayer(s0: GameState, limit = 500): GameState {
  let s = s0;
  let guard = 0;
  while (guard++ < limit) {
    if (s.result !== 'ONGOING' || s.pendingReinforcement) break;
    if (isPlayerTurn(s)) break;
    const next = applyCommand(s, { type: 'ADVANCE' }).state;
    if (next === s) break;
    s = next;
  }
  return s;
}

/** 推進排程器一格（讓目前輪到的非玩家單位做一件事）。 */
export function advanceOnce(s: GameState): GameState {
  return applyCommand(s, { type: 'ADVANCE' }).state;
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
/**
 * @param enemies 未指定 `facing` 時，測試用敵人**預設面向出生點**。
 *
 * v0.8 起敵人的視野是前方半平面（§7.5），預設面向南的話絕大多數既有測試裡的
 * 敵人會突然看不見玩家 —— 那些測試想驗的是偵測、掩蔽、AI 狀態機，不是面向。
 * 面向本身有自己的測試檔（sight.test.ts），要驗盲區就在那裡明寫 `facing`。
 */
export function testState(
  rows: string[],
  enemies: { archetype: string; pos: Vec2; facing?: Facing }[] = [],
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
    enemies: enemies.map((e) => ({
      ...e,
      facing: e.facing ?? facingToward(e.pos, start as Vec2) ?? 'S',
    })),
  };
  const st = createInitialState(seed, raw);
  // **測試地圖預設全部已探索。**戰爭迷霧有自己的測試檔（tests/fog.test.ts）；
  // 其餘測試在測的是移動、射擊、掩蔽，不該被「還沒走過去」擋住。
  st.explored = '1'.repeat(st.map.width * st.map.height);
  // **持槍的敵人一律配一把固定的槍。**正式流程裡他們是從物品池抽的（§2），
  // 但那個隨機性屬於局外層 —— 測掩蔽、視線與 AI 的檔案不該因為某一場抽到削短霰彈槍
  // （射程 3）就整批失效。要驗抽取本身的請直接呼叫 drawEnemyWeapons。
  for (const u of st.units) {
    if (u.faction !== 'ENEMY') continue;
    if (!archetype(u.archetype).armed) continue;
    armEnemy(st, u.id, TEST_ENEMY_WEAPON);
  }
  return st;
}

/** 測試裡持槍敵人的預設武器。射程 8、單發、傷害 30。 */
export const TEST_ENEMY_WEAPON = 'ar9';

/**
 * 把一把指定的槍塞到敵人手上，備彈給滿。
 *
 * 「備彈給滿」是刻意的：**彈藥管理有自己的測試檔**（tests/enemy-ammo.test.ts），
 * 其餘測試不該因為敵人打到第九發沒子彈而變成在測別的東西。
 */
export function armEnemy(s: GameState, id: string, typeId: string): void {
  const e = unit(s, id);
  e.equipped = makeWeapon(s, typeId);
  // 「夠打整場」而不是「無限」：§3 起**備彈也有重量**，
  // 塞 9999 發會讓每個測試敵人都變成超重的慢速目標，那會弄壞別的測試。
  e.reserveAmmo = e.equipped.magazine * 40;
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
    d: [],
    roll: RULES.combat.enableToHitRoll,
  };
  // 敵人的攻擊現在也是 weapons.json 裡的武器（§1），所以上面那一行就夠了
  for (const x of WEAPONS) x.damageSpread = 0;
  for (const k of ARCH_IDS) ACTORS[k].armorSpread = 0;
  RULES.combat.enableToHitRoll = false;
  resetToHitPolicy();
}

export function thawCombat(): void {
  if (!frozen) return;
  WEAPONS.forEach((x, i) => { x.damageSpread = frozen!.w[i]; });
  ARCH_IDS.forEach((k, i) => { ACTORS[k].armorSpread = frozen!.a[i]; });
  RULES.combat.enableToHitRoll = frozen.roll;
  frozen = null;
  resetToHitPolicy();
}

// ---------------------------------------------------------------------------
// v0.9：搜刮堆（LootPile）的小工具。武器現在是 Item，不再是 pile.weapons。
// ---------------------------------------------------------------------------
import type { LootPile } from '../src/core/state';

/** 這一堆裡的武器 id（依序）。 */
export function weaponIds(pile: LootPile | null | undefined): string[] {
  if (!pile) return [];
  return pile.items.filter((it) => it.kind === 'WEAPON').map((it) => it.weapon!.typeId);
}

/** 指定武器在這一堆裡的 index，找不到回傳 -1。 */
export function weaponIndexIn(pile: LootPile, weaponId: string): number {
  return pile.items.findIndex((it) => it.kind === 'WEAPON' && it.weapon!.typeId === weaponId);
}

/** 這一堆裡某種物品的總數（彈藥用）。 */
export function itemQty(pile: LootPile | null | undefined, defId: string): number {
  if (!pile) return 0;
  return pile.items.filter((it) => it.defId === defId).reduce((a, it) => a + it.qty, 0);
}

/**
 * 清空背包，讓士兵回到「基準速度」（移動一格 10）。
 *
 * v0.12 起初始配備多了一個封合劑（重 5），總重 23 越過第一級門檻 20，
 * 所以士兵一開場就是移動 12。**排程器、轉向、時間成本那些測試量的是機制，
 * 不是這一版的配裝**，所以它們先卸下負重再測；
 * 「初始配備到底多重」由 loot.test.ts 單獨釘住。
 */
export function unburden(s: GameState): GameState {
  const u = activePlayerUnit(s);
  if (u && u.backpack) u.backpack.items = [];
  return s;
}

/**
 * 測試用：造一把獨立的槍實例（v0.15 附錄 A）。
 * 正式流程一律從 `createInitialState` 的流水號取號；這裡用一個獨立計數器，
 * 只是為了讓測試能隨手拿一把槍來擺弄。
 */
const probeSerial = { nextEntitySerial: 900001 };
export function testWeapon(typeId: string): WeaponInstance {
  return makeWeapon(probeSerial, typeId);
}
