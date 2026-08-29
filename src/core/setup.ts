/**
 * 初始狀態建立。所有數值來自 data/ 的 JSON，這裡不寫死任何平衡數字。
 */
import type {
  Backpack, Facing, GameState, Item, LootPile, Objective, Unit, Vec2, WeaponInstance,
} from './state';
import type { RawMap } from './map';
import { parseMap, findTiles } from './map';
import type { RngState } from './rng';
import { createRng, nextFloat, nextInt } from './rng';
import { ACTORS, MAPS, RULES, archetype } from './content';
import { makeWeapon } from './weapon';
import { addItem, emptyBackpack, makeItem } from './inventory';
import { blankExplored, markExplored } from './fog';
import type { Deployment, DeployedSoldier } from './meta';

function makeUnit(
  archetypeId: string,
  id: string,
  name: string,
  pos: Vec2,
  weapons: { equipped: WeaponInstance | null; stowed: WeaponInstance | null },
  facing: Facing = 'S',
  backpack: Backpack | null = null,
  serial: { nextEntitySerial: number } = { nextEntitySerial: 0 },
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
    // 內建武器也是實例（§1.2）。它不會流通，但「所有持有處都持有實例」不留例外。
    intrinsic: makeWeapon(serial, a.intrinsic),
    reserveAmmo: 0,
    setUp: false,
    announcedDry: false,
    backpack,
    aiState: 'IDLE',
    lastKnownTarget: null,
    searchTimer: 0,
    nextActAt: 0,
    moveTime: a.time.move,
    transitionTime: a.time.transition,
    transitioning: false,
    pendingSequence: null,
    preparedId: null,
    declared: null,
    patrolLeft: 0,
  };
}

/**
 * 依派遣快照造一名士兵（v0.16 §4.2）。
 *
 * **首發與替補走同一條路** —— 替補不再是「配發一把 AR-9」，
 * 而是**帶著他自己的配裝**降落。沒有配裝的人就赤手空拳，那是玩家的責任。
 *
 * 派遣快照是 `createInitialState` 的輸入之一，所以決定論不受影響：
 * 相同的種子 **加上** 相同的快照，結果完全相同。
 */
export function makeDeployedUnit(
  state: { nextEntitySerial: number }, d: DeployedSoldier, pos: Vec2,
): Unit {
  const bag = emptyBackpack();
  for (const e of d.items) {
    if (e.qty > 0) addItem(bag, makeItem(state as never, e.defId, e.qty));
  }
  const u = makeUnit('SOLDIER', d.id, d.designation, pos, {
    equipped: d.equipped ? JSON.parse(JSON.stringify(d.equipped)) as WeaponInstance : null,
    stowed: d.stowed ? JSON.parse(JSON.stringify(d.stowed)) as WeaponInstance : null,
  }, 'S', bag, state);
  u.hp = d.hp;
  u.maxHp = d.maxHp;
  return u;
}

/**
 * 生成一把土製武器給敵人（§2.3）。
 *
 * **土製不在池子裡** —— 它現在還做得出來，所以是無限供給的那一層。
 * 池中沒有適用的遺產武器時就補上一把這個，敵人不會空手站在那裡。
 */
export function makeLocalEnemyWeapon(
  serial: { nextEntitySerial: number }, rng: RngState,
): WeaponInstance {
  const table = RULES.enemyWeapons.localTypes;
  const total = table.reduce((a, t) => a + t.weight, 0);
  let roll = nextInt(rng, Math.max(1, total));
  let pick = table[table.length - 1].id;
  for (const t of table) {
    if (roll < t.weight) { pick = t.id; break; }
    roll -= t.weight;
  }
  return makeWeapon(serial, pick, [], [
    { event: 'MANUFACTURED', actor: '本地作坊' },
  ]);
}

/**
 * 敵人生成時把武器配到位（§3.2）。
 *
 * 兩件事都在**生成時**決定、整場不變：
 *  - **射擊模式**從該武器的可用模式中抽一種。同一原型的兩個敵人因此打法不同 ——
 *    一個單發、一個連發，是免費的變化。
 *  - **攜行彈藥**是有限的。打光就只剩內建近戰（§3.4）。
 */
function issueWeapon(u: Unit, w: WeaponInstance | null, rng: RngState): void {
  u.equipped = w;
  if (!w) return;
  w.mode = w.modes[nextInt(rng, w.modes.length)] ?? w.mode;
  u.reserveAmmo = w.magazine * RULES.enemyWeapons.reserveMagazines;
}

/**
 * @param facing 初始面向（§13.3）。未指定時預設為南。
 * @param weapon 從物品池抽到的那一把（§2）。null 代表這個原型不持槍 ——
 *               它照樣有內建武器，只是打不到遠處。
 */
export function makeEnemy(
  serial: { nextEntitySerial: number },
  archetypeId: string, index: number, pos: Vec2, facing: Facing = 'S',
  weapon: WeaponInstance | null = null,
  rng?: RngState,
): Unit {
  const id = 'E' + String(index + 1).padStart(2, '0');
  const a = archetype(archetypeId);
  const name = a.name + '-' + String(index + 1).padStart(2, '0');
  const u = makeUnit(archetypeId, id, name, pos, { equipped: null, stowed: null },
    facing, null, serial);
  if (rng) issueWeapon(u, weapon, rng);
  else u.equipped = weapon;
  return u;
}

/** 測試與機器人用的固定名冊 id。正式流程的名冊來自 MetaState。 */
export function rosterIds(): string[] {
  const out: string[] = [];
  for (let i = 0; i < RULES.roster.size; i++) out.push(RULES.roster.idPrefix + (i + 1));
  return out;
}

/**
 * @param rawMap 指定地圖。**省略時用可播種亂數從四張圖裡挑一張**（§13.2）——
 *               選圖是規則的一部分，不是介面的一部分，所以它走 core/rng.ts，
 *               而且相同種子必然選到相同的圖。
 * @param deployment 派遣快照（v0.16 §1.1）。**任務期間不讀寫 MetaState**，
 *                   替補也是從這份快照裡取。省略時用測試用的預設名冊。
 */
export function createInitialState(
  seed: number, rawMap?: RawMap, deployment?: Deployment,
): GameState {
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

  const serial = { nextEntitySerial: 1 };
  const plan = deployment ?? testDeployment(serial);
  const firstId = plan.firstId;
  const first = plan.soldiers.find((d) => d.id === firstId);
  if (!first) throw new Error('派遣快照裡沒有首發士兵 ' + firstId);
  const roster = plan.soldiers.filter((d) => d.id !== firstId).map((d) => d.id);

  // 物品與屍體的 id 走同一個流水號，所以先開一個計數器再交給 state
  const units: Unit[] = [makeDeployedUnit(serial, first, map.startDropPoint)];
  // 敵人的武器：**從物品池抽出**（§2）。派遣快照裡帶著局外層抽好的那幾把 ——
  // 抽取必須發生在局外層，因為抽走一把，補給站就少一把。
  // 沒有快照時（測試與機器人）就生成土製武器，決定論仍然只看種子。
  picked.enemies.forEach((e, i) => {
    if (!ACTORS[e.archetype]) throw new Error('地圖引用了未知的敵人原型 ' + e.archetype);
    const drawn = plan.enemyWeapons ? (plan.enemyWeapons[i] ?? null) : undefined;
    const w = drawn !== undefined
      ? (drawn && JSON.parse(JSON.stringify(drawn)) as WeaponInstance)
      : (archetype(e.archetype).armed ? makeLocalEnemyWeapon(serial, rng) : null);
    units.push(makeEnemy(serial, e.archetype, i, e.pos, e.facing, w, rng));
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

  const state: GameState = {
    clock: 0,
    map,
    units,
    loot,
    roster,
    activePlayerUnitId: firstId,
    objectives: { main, secondary },
    casualties: 0,
    deployed: 1,
    explored: blankExplored(map),
    // 起始空投點預設已啟用 —— 他就是從那裡下來的
    activatedDrops: [map.startDropPoint.x + ',' + map.startDropPoint.y],
    identifiedWeapons: [],
    deployment: plan.soldiers,
    stats: {},
    deadSoldierIds: [],
    extractedBy: null,
    rngSeed: seed >>> 0,
    rng,
    result: 'ONGOING',
    pendingReinforcement: null,
    extracted: [],
    nextEntitySerial: serial.nextEntitySerial,
    log: [
      { at: 0, kind: 'MISSION', text: '任務開始：' + map.name },
      { at: 0, kind: 'INFO', text: first.designation + ' 已投入戰場。' },
      {
        at: 0,
        kind: 'INFO',
        text: 'HUD 的防禦狀態採「最差情況」：在所有看得到你的敵人之中取掩蔽最低的那一個。',
      },
    ],
  };
  // 落地當下就看得見周圍 —— 迷霧從第一幀就是對的
  markExplored(state, units[0]);
  return state;
}

/**
 * 測試與機器人用的派遣快照：四名數值相同的士兵，都帶預設配備。
 *
 * 正式流程的快照來自 `MetaState`（§1.1）。這一份存在的理由是
 * **機器人基準必須跟得上**：它要能在不碰局外層的情況下跑出可比較的數據（§9 回歸）。
 */
export function testDeployment(serial: { nextEntitySerial: number }): Deployment {
  const ids = rosterIds();
  const spec = RULES.backpack.startingItems.map((e) => ({ defId: e.defId, qty: e.qty }));
  return {
    firstId: ids[0],
    soldiers: ids.map((id) => ({
      id,
      designation: id + ' Gen.1',
      hp: RULES.meta.soldierHp,
      maxHp: RULES.meta.soldierHp,
      equipped: makeWeapon(serial, 'ar9'),
      stowed: makeWeapon(serial, 'rr4'),
      items: spec,
    })),
  };
}
