/**
 * 初始狀態建立。所有數值來自 data/ 的 JSON，這裡不寫死任何平衡數字。
 */
import type { Backpack, Facing, GameState, Item, LootPile, Objective, Unit, Vec2, Weapon } from './state';
import type { RawMap } from './map';
import { parseMap, findTiles } from './map';
import { createRng, nextFloat } from './rng';
import { ACTORS, MAPS, RULES, archetype, cloneWeapon, weaponById } from './content';
import { addItem, emptyBackpack, makeItem } from './inventory';

function makeUnit(
  archetypeId: string,
  id: string,
  name: string,
  pos: Vec2,
  weapons: { equipped: Weapon | null; stowed: Weapon | null },
  facing: Facing = 'S',
  backpack: Backpack | null = null,
): Unit {
  const a = archetype(archetypeId);
  return {
    id,
    faction: a.faction,
    archetype: archetypeId,
    name,
    pos: { x: pos.x, y: pos.y },
    hp: a.hp,
    maxHp: a.hp,
    armor: a.armor,
    armorSpread: a.armorSpread,
    aim: a.aim,
    evasion: a.evasion,
    stance: 'STAND',
    facing,
    sightRange: a.sightRange,
    equipped: weapons.equipped,
    stowed: weapons.stowed,
    backpack,
    aiState: 'IDLE',
    lastKnownTarget: null,
    searchTimer: 0,
    nextActAt: 0,
    moveTime: a.time.move,
    transitionTime: a.time.transition,
    transitioning: false,
    pendingSequence: null,
    declared: null,
    patrolLeft: 0,
  };
}

/**
 * 背包的初始內容（§1.2 / §3）。
 * 需要 state 是因為物品 id 走的是狀態的流水號，不是亂數。
 */
function fillBackpack(
  state: { nextEntitySerial: number },
  spec: { defId: string; qty: number }[],
): Backpack {
  const bag = emptyBackpack();
  for (const e of spec) addItem(bag, makeItem(state as never, e.defId, e.qty));
  return bag;
}

/** 首發士兵：手持 AR-9（滿彈），收納 RR-4（滿彈），背包帶初始彈藥（§8.4 / §1.2）。 */
export function makeStartingSoldier(
  state: { nextEntitySerial: number }, id: string, pos: Vec2,
): Unit {
  return makeUnit('SOLDIER', id, id, pos, {
    equipped: weaponById('ar9'),
    stowed: weaponById('rr4'),
  }, 'S', fillBackpack(state, RULES.backpack.startingItems));
}

/**
 * 增援士兵：只有預設配備，一把滿彈的 AR-9，沒有 RR-4（§10.1 第 6 點）。
 * 背包也只有步槍彈 —— 火箭彈在前一個人的屍體上。
 */
export function makeReinforcementSoldier(
  state: { nextEntitySerial: number }, id: string, pos: Vec2,
): Unit {
  return makeUnit('SOLDIER', id, id, pos, {
    equipped: weaponById('ar9'),
    stowed: null,
  }, 'S', fillBackpack(state, RULES.backpack.reinforcementItems));
  // nextActAt 由 deployReinforcement 依 clock 設定
}

/** @param facing 初始面向（§13.3）。未指定時預設為南。 */
export function makeEnemy(archetypeId: string, index: number, pos: Vec2, facing: Facing = 'S'): Unit {
  const a = archetype(archetypeId);
  if (!a.attack) throw new Error('敵人原型 ' + archetypeId + ' 缺少 attack 資料');
  const id = 'E' + String(index + 1).padStart(2, '0');
  const name = a.name + '-' + String(index + 1).padStart(2, '0');
  return makeUnit(archetypeId, id, name, pos, {
    equipped: cloneWeapon(a.attack),
    stowed: null,
  }, facing);
}

export function rosterIds(): string[] {
  const out: string[] = [];
  for (let i = 0; i < RULES.roster.size; i++) out.push(RULES.roster.idPrefix + (i + 1));
  return out;
}

/**
 * @param rawMap 指定地圖。**省略時用可播種亂數從四張圖裡挑一張**（§13.2）——
 *               選圖是規則的一部分，不是介面的一部分，所以它走 core/rng.ts，
 *               而且相同種子必然選到相同的圖。
 */
export function createInitialState(seed: number, rawMap?: RawMap): GameState {
  const rng = createRng(seed >>> 0);
  // 抽在最前面：後面所有的擲值順序才不會因為「有沒有指定地圖」而錯開。
  const picked = rawMap ?? MAPS[Math.floor(nextFloat(rng) * MAPS.length)];
  const map = parseMap(picked);

  const terminals = findTiles(map, 'TERMINAL');
  if (terminals.length !== 1) throw new Error('地圖必須剛好有 1 個 TERMINAL');
  const supplies = findTiles(map, 'SUPPLY');

  const main: Objective = { id: 'MAIN_TERMINAL', pos: terminals[0], done: false };
  const secondary: Objective[] = supplies.map((p, i) => ({
    id: 'SUPPLY_' + (i + 1),
    pos: p,
    done: false,
  }));

  const roster = rosterIds();
  const firstId = roster.shift();
  if (!firstId) throw new Error('名冊人數必須 >= 1');

  // 物品與屍體的 id 走同一個流水號，所以先開一個計數器再交給 state
  const serial = { nextEntitySerial: 1 };
  const units: Unit[] = [makeStartingSoldier(serial, firstId, map.startDropPoint)];
  picked.enemies.forEach((e, i) => {
    if (!ACTORS[e.archetype]) throw new Error('地圖引用了未知的敵人原型 ' + e.archetype);
    units.push(makeEnemy(e.archetype, i, e.pos, e.facing));
  });

  // 地圖搜刮點（§4.1）。地形是 LOOT，內容寫在地圖檔的 caches。
  const loot: LootPile[] = (picked.caches ?? []).map((c) => {
    const items: Item[] = c.items.map((e) => makeItem(serial as never, e.defId, e.qty));
    return {
      id: 'L' + serial.nextEntitySerial++,
      kind: 'CACHE' as const,
      pos: { x: c.pos.x, y: c.pos.y },
      label: c.label ?? '補給箱',
      items,
    };
  });

  return {
    clock: 0,
    map,
    units,
    loot,
    roster,
    activePlayerUnitId: firstId,
    objectives: { main, secondary },
    casualties: 0,
    deployed: 1,
    rngSeed: seed >>> 0,
    rng,
    result: 'ONGOING',
    pendingReinforcement: null,
    extracted: [],
    nextEntitySerial: serial.nextEntitySerial,
    log: [
      { at: 0, kind: 'MISSION', text: '任務開始：' + map.name },
      { at: 0, kind: 'INFO', text: firstId + ' 已投入戰場。' },
      {
        at: 0,
        kind: 'INFO',
        text: 'HUD 的防禦狀態採「最差情況」：在所有看得到你的敵人之中取掩蔽最低的那一個。',
      },
    ],
  };
}
