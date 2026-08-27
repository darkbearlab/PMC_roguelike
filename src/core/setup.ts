/**
 * 初始狀態建立。所有數值來自 data/ 的 JSON，這裡不寫死任何平衡數字。
 */
import type { GameState, Objective, Unit, Vec2, Weapon } from './state';
import type { RawMap } from './map';
import { parseMap, findTiles } from './map';
import { createRng } from './rng';
import { ACTORS, MISSION_01, RULES, archetype, cloneWeapon, weaponById } from './content';

function makeUnit(
  archetypeId: string,
  id: string,
  name: string,
  pos: Vec2,
  weapons: { equipped: Weapon | null; stowed: Weapon | null },
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
    maxAp: a.maxAp,
    ap: a.maxAp,
    stance: 'STAND',
    facing: 'S',
    sightRange: a.sightRange,
    equipped: weapons.equipped,
    stowed: weapons.stowed,
    aiState: 'IDLE',
    lastKnownTarget: null,
    searchTimer: 0,
    shotsThisTurn: 0,
    justSpotted: false,
    attacksPerTurn: a.attacksPerTurn,
  };
}

/** 首發士兵：手持 AR-9（滿彈），收納 RR-4（滿彈）（§8.4）。 */
export function makeStartingSoldier(id: string, pos: Vec2): Unit {
  return makeUnit('SOLDIER', id, id, pos, {
    equipped: weaponById('ar9'),
    stowed: weaponById('rr4'),
  });
}

/** 增援士兵：只有預設配備，一把滿彈的 AR-9，沒有 RR-4（§10.1 第 6 點）。 */
export function makeReinforcementSoldier(id: string, pos: Vec2): Unit {
  const u = makeUnit('SOLDIER', id, id, pos, {
    equipped: weaponById('ar9'),
    stowed: null,
  });
  u.ap = 0; // 落地當回合不能行動
  return u;
}

export function makeEnemy(archetypeId: string, index: number, pos: Vec2): Unit {
  const a = archetype(archetypeId);
  if (!a.attack) throw new Error('敵人原型 ' + archetypeId + ' 缺少 attack 資料');
  const id = 'E' + String(index + 1).padStart(2, '0');
  const name = a.name + '-' + String(index + 1).padStart(2, '0');
  return makeUnit(archetypeId, id, name, pos, {
    equipped: cloneWeapon(a.attack),
    stowed: null,
  });
}

export function rosterIds(): string[] {
  const out: string[] = [];
  for (let i = 0; i < RULES.roster.size; i++) out.push(RULES.roster.idPrefix + (i + 1));
  return out;
}

export function createInitialState(seed: number, rawMap: RawMap = MISSION_01): GameState {
  const map = parseMap(rawMap);

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

  const units: Unit[] = [makeStartingSoldier(firstId, map.startDropPoint)];
  rawMap.enemies.forEach((e, i) => {
    if (!ACTORS[e.archetype]) throw new Error('地圖引用了未知的敵人原型 ' + e.archetype);
    units.push(makeEnemy(e.archetype, i, e.pos));
  });

  return {
    turn: 1,
    phase: 'PLAYER',
    map,
    units,
    corpses: [],
    roster,
    activePlayerUnitId: firstId,
    objectives: { main, secondary },
    casualties: 0,
    deployed: 1,
    rngSeed: seed >>> 0,
    rng: createRng(seed >>> 0),
    result: 'ONGOING',
    enemyQueue: [],
    pendingReinforcement: null,
    nextEntitySerial: 1,
    log: [
      { turn: 1, kind: 'MISSION', text: '任務開始：' + map.name },
      { turn: 1, kind: 'INFO', text: firstId + ' 已投入戰場。' },
      {
        turn: 1,
        kind: 'INFO',
        text: 'HUD 的防禦狀態採「最差情況」：在所有看得到你的敵人之中取掩蔽最低的那一個。',
      },
    ],
  };
}
