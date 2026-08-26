/**
 * Command 型別與 applyCommand()（§3.1 / §5）。
 *
 * 這是規則層唯一的入口：
 *   applyCommand(state, command) => newState
 * 相同的初始狀態 + 相同的指令序列，必須產生完全相同的結果。
 *
 * 渲染層與 UI 層唯讀 GameState，不得直接改寫狀態，一律透過發出 Command。
 * 非法指令回傳「原本那個 state 物件」（identity 不變），讓 UI 可以直接比對。
 */
import type {
  Corpse, Facing, GameState, Stance, Unit, Vec2, Weapon,
} from './state';
import { activePlayerUnit, corpseAt, findUnit } from './state';
import { DIR_VEC, facingToward, manhattan, sameTile } from './grid';
import { findTiles, tileAt } from './map';
import { canStep, findPath, nearestFreeTileOfType, occupiedBy, terrainPassable } from './pathfind';
import { canAttack, performAttack, type Legality } from './combat';
import { beginEnemyTurn, stepEnemy } from './ai';
import { RULES } from './content';
import { makeReinforcementSoldier } from './setup';
import { pushLog } from './log';

export type WeaponSlot = 'EQUIPPED' | 'STOWED';

export type Command =
  | { type: 'MOVE'; dir: Facing }
  | { type: 'SET_STANCE'; stance: Stance }
  | { type: 'TOGGLE_STANCE' }
  | { type: 'SET_FACING'; facing: Facing }
  | { type: 'FIRE'; target: Vec2 }
  | { type: 'RELOAD' }
  | { type: 'SWAP_WEAPON' }
  | { type: 'PICKUP'; corpseId: string; weaponIndex: number; slot: WeaponSlot }
  | { type: 'INTERACT'; pos: Vec2 }
  | { type: 'WAIT' }
  | { type: 'ENEMY_STEP' }
  | { type: 'DEPLOY_REINFORCEMENT'; soldierId: string }
  | { type: 'ABORT' };

const OK: Legality = { ok: true, reason: '' };
const no = (reason: string): Legality => ({ ok: false, reason });

// ============================================================================
// AP 成本（§5.2）—— 全部從 data/rules.json 讀，不寫死
// ============================================================================

export function swapCost(u: Unit): number {
  return u.stowed ? RULES.ap.swapCost[u.stowed.class] : Number.POSITIVE_INFINITY;
}

/** 指令的 AP 成本；無法計算時回傳 null。UI 用來顯示成本。 */
export function commandCost(state: GameState, cmd: Command): number | null {
  const u = activePlayerUnit(state);
  switch (cmd.type) {
    case 'MOVE': return RULES.ap.moveCost;
    case 'SET_STANCE':
    case 'TOGGLE_STANCE': return RULES.ap.stanceCost;
    case 'SET_FACING': return RULES.ap.facingCost;
    case 'FIRE': return u && u.equipped ? u.equipped.fireCost : null;
    case 'RELOAD': return u && u.equipped ? u.equipped.reloadCost : null;
    case 'SWAP_WEAPON': return u ? swapCost(u) : null;
    case 'PICKUP': return RULES.ap.pickupCost;
    case 'INTERACT': return RULES.ap.interactCost;
    case 'WAIT': return u ? u.ap : null;
    default: return null;
  }
}

// ============================================================================
// 合法性
// ============================================================================

const PLAYER_COMMANDS = new Set<Command['type']>([
  'MOVE', 'SET_STANCE', 'TOGGLE_STANCE', 'SET_FACING', 'FIRE',
  'RELOAD', 'SWAP_WEAPON', 'PICKUP', 'INTERACT', 'WAIT',
]);

/**
 * 指令是否合法。UI 必須用這個來灰化按鈕，
 * 不要讓玩家點下去才被拒絕（§12.2）。
 */
export function checkLegal(state: GameState, cmd: Command): Legality {
  if (state.result !== 'ONGOING') return no('任務已結束');

  // 止損：任何時候都可以按（§11.3）
  if (cmd.type === 'ABORT') return OK;

  if (cmd.type === 'DEPLOY_REINFORCEMENT') {
    if (!state.pendingReinforcement) return no('目前沒有待補的空缺');
    if (!state.roster.includes(cmd.soldierId)) return no('名冊中沒有這個編號');
    return OK;
  }

  // 陣亡待補期間，除了補人與止損以外什麼都不能做
  if (state.pendingReinforcement) return no('等待增援選擇');

  if (cmd.type === 'ENEMY_STEP') {
    return state.phase === 'ENEMY' ? OK : no('現在不是敵人回合');
  }

  if (PLAYER_COMMANDS.has(cmd.type)) {
    if (state.phase !== 'PLAYER') return no('現在不是玩家回合');
    const u = activePlayerUnit(state);
    if (!u) return no('場上沒有可操作的士兵');
    return checkPlayerCommand(state, u, cmd);
  }
  return no('未知的指令');
}

function checkPlayerCommand(state: GameState, u: Unit, cmd: Command): Legality {
  switch (cmd.type) {
    case 'MOVE': {
      if (u.ap < RULES.ap.moveCost) return no('AP 不足');
      const to = { x: u.pos.x + DIR_VEC[cmd.dir].x, y: u.pos.y + DIR_VEC[cmd.dir].y };
      if (!terrainPassable(state, to)) return no('地形不可通行');
      if (occupiedBy(state, to, [u.id])) return no('該格已被佔據');
      if (!canStep(state, u.pos, to, { ignoreUnitIds: [u.id] })) return no('不能斜穿角落');
      return OK;
    }
    case 'SET_STANCE':
      return u.stance === cmd.stance ? no('已經是這個姿勢') : OK;
    case 'TOGGLE_STANCE':
    case 'SET_FACING':
      return OK;
    case 'FIRE':
      return canAttack(state, u, cmd.target, u.equipped);
    case 'RELOAD': {
      if (!u.equipped) return no('沒有裝備武器');
      if (u.equipped.ammo >= u.equipped.magazine) return no('彈匣已滿');
      if (u.ap < u.equipped.reloadCost) return no('AP 不足（需要 ' + u.equipped.reloadCost + '）');
      return OK;
    }
    case 'SWAP_WEAPON': {
      if (!u.stowed) return no('沒有收納的武器');
      const c = swapCost(u);
      if (u.ap < c) return no('AP 不足（需要 ' + c + '）');
      return OK;
    }
    case 'PICKUP': {
      if (u.ap < RULES.ap.pickupCost) return no('AP 不足');
      const corpse = state.corpses.find((c) => c.id === cmd.corpseId);
      if (!corpse) return no('找不到這具屍體');
      if (!sameTile(corpse.pos, u.pos)) return no('必須站在屍體所在格');
      if (cmd.weaponIndex < 0 || cmd.weaponIndex >= corpse.weapons.length) return no('沒有這件裝備');
      return OK;
    }
    case 'INTERACT': {
      if (u.ap < RULES.ap.interactCost) return no('AP 不足');
      return interactTargetLegality(state, u, cmd.pos);
    }
    case 'WAIT':
      return OK;
    default:
      return no('未知的指令');
  }
}

export type InteractKind = 'TERMINAL' | 'SUPPLY' | 'EXTRACT';

/** 互動距離：站在目標格上或正交相鄰皆可（曼哈頓 <= 1）。 */
export const INTERACT_REACH = 1;

/**
 * 指定格子上有什麼可以互動的（§11.1）。
 * v0.3 起改為「相鄰格互動」，不必站上去。
 */
export function interactKindAt(state: GameState, pos: Vec2): InteractKind | null {
  const t = tileAt(state.map, pos);
  if (t === 'TERMINAL') {
    return !state.objectives.main.done && sameTile(state.objectives.main.pos, pos)
      ? 'TERMINAL'
      : null;
  }
  if (t === 'SUPPLY') {
    const o = state.objectives.secondary.find((x) => sameTile(x.pos, pos));
    return o && !o.done ? 'SUPPLY' : null;
  }
  if (t === 'DROP_POINT' && sameTile(pos, state.map.startDropPoint)) {
    return state.objectives.main.done ? 'EXTRACT' : null;
  }
  return null;
}

/** 這個單位現在能不能對 pos 互動。 */
export function interactTarget(state: GameState, u: Unit, pos: Vec2): InteractKind | null {
  if (manhattan(u.pos, pos) > INTERACT_REACH) return null;
  return interactKindAt(state, pos);
}

function interactTargetLegality(state: GameState, u: Unit, pos: Vec2): Legality {
  if (manhattan(u.pos, pos) > INTERACT_REACH) return no('距離太遠，要站到相鄰格');
  if (interactKindAt(state, pos)) return OK;
  const t = tileAt(state.map, pos);
  if (t === 'DROP_POINT' && sameTile(pos, state.map.startDropPoint)) {
    return no('主目標尚未完成，無法撤離');
  }
  if (t === 'TERMINAL' || t === 'SUPPLY') return no('這個目標已經完成');
  return no('這一格沒有可互動的東西');
}

// ============================================================================
// applyCommand
// ============================================================================

function cloneState(state: GameState): GameState {
  return structuredClone(state);
}

export function applyCommand(state: GameState, cmd: Command): GameState {
  if (!checkLegal(state, cmd).ok) return state;
  const s = cloneState(state);

  switch (cmd.type) {
    case 'ABORT': {
      s.result = 'ABORTED';
      s.phase = 'MISSION_END';
      s.pendingReinforcement = null;
      pushLog(s, 'MISSION', '指揮部下令止損，任務中止。');
      return s;
    }
    case 'DEPLOY_REINFORCEMENT':
      deployReinforcement(s, cmd.soldierId);
      return s;
    case 'ENEMY_STEP':
      enemyStep(s);
      return s;
    default:
      applyPlayerCommand(s, cmd);
      return s;
  }
}

function applyPlayerCommand(s: GameState, cmd: Command): void {
  const u = activePlayerUnit(s);
  if (!u) return;
  let forceEndTurn = false;

  switch (cmd.type) {
    case 'MOVE': {
      const to = { x: u.pos.x + DIR_VEC[cmd.dir].x, y: u.pos.y + DIR_VEC[cmd.dir].y };
      u.facing = cmd.dir;
      u.pos = to;
      u.ap -= RULES.ap.moveCost;
      break;
    }
    case 'SET_STANCE':
      u.stance = cmd.stance;
      u.ap -= RULES.ap.stanceCost;
      pushLog(s, 'INFO', u.name + (cmd.stance === 'CROUCH' ? ' 蹲下' : ' 起身'));
      break;
    case 'TOGGLE_STANCE':
      u.stance = u.stance === 'STAND' ? 'CROUCH' : 'STAND';
      u.ap -= RULES.ap.stanceCost;
      pushLog(s, 'INFO', u.name + (u.stance === 'CROUCH' ? ' 蹲下' : ' 起身'));
      break;
    case 'SET_FACING':
      u.facing = cmd.facing;
      u.ap -= RULES.ap.facingCost;
      break;
    case 'FIRE': {
      const weapon = u.equipped as Weapon;
      performAttack(s, u.id, cmd.target);
      processDeaths(s);
      if (weapon.endsTurn) forceEndTurn = true;
      break;
    }
    case 'RELOAD': {
      const w = u.equipped as Weapon;
      u.ap -= w.reloadCost;
      w.ammo = w.magazine;
      pushLog(s, 'INFO', u.name + ' 裝填 ' + w.name);
      break;
    }
    case 'SWAP_WEAPON': {
      const cost = swapCost(u);
      const old = u.equipped;
      u.equipped = u.stowed;
      u.stowed = old;
      u.ap -= cost;
      pushLog(s, 'INFO', u.name + ' 換裝為 ' + (u.equipped ? u.equipped.name : '空手'));
      break;
    }
    case 'PICKUP': {
      const corpse = s.corpses.find((c) => c.id === cmd.corpseId) as Corpse;
      const taken = corpse.weapons.splice(cmd.weaponIndex, 1)[0];
      // 丟棄免費：被替換下來的武器留在同一具屍體上（§10.2）
      const displaced = cmd.slot === 'EQUIPPED' ? u.equipped : u.stowed;
      if (displaced) corpse.weapons.push(displaced);
      if (cmd.slot === 'EQUIPPED') u.equipped = taken;
      else u.stowed = taken;
      u.ap -= RULES.ap.pickupCost;
      pushLog(s, 'INFO', u.name + ' 從 ' + corpse.unitId + ' 的遺體取回 ' + taken.name);
      break;
    }
    case 'INTERACT': {
      const kind = interactTarget(s, u, cmd.pos);
      const f = facingToward(u.pos, cmd.pos);
      if (f) u.facing = f;
      u.ap -= RULES.ap.interactCost;
      if (kind === 'TERMINAL') {
        s.objectives.main.done = true;
        pushLog(s, 'OBJECTIVE', '主目標完成：終端資料已取得。撤離點為初始空投點。');
      } else if (kind === 'SUPPLY') {
        const o = s.objectives.secondary.find((x) => sameTile(x.pos, cmd.pos));
        if (o) o.done = true;
        const n = s.objectives.secondary.filter((x) => x.done).length;
        pushLog(s, 'OBJECTIVE', '次要目標完成（' + n + '/' + s.objectives.secondary.length + '）');
      } else if (kind === 'EXTRACT') {
        s.result = 'SUCCESS';
        s.phase = 'MISSION_END';
        pushLog(s, 'MISSION', '撤離成功。');
        return;
      }
      break;
    }
    case 'WAIT':
      u.ap = 0;
      pushLog(s, 'INFO', u.name + ' 原地待命');
      forceEndTurn = true;
      break;
  }

  afterPlayerAction(s, forceEndTurn);
}

function afterPlayerAction(s: GameState, forceEndTurn: boolean): void {
  if (s.phase === 'MISSION_END') return;
  // 陣亡待補：暫停，等玩家從名冊選人
  if (s.pendingReinforcement) return;
  const u = activePlayerUnit(s);
  if (!u) return;
  // AP 歸零時自動結束玩家回合，不需要按結束鍵（§5.1）
  if (forceEndTurn || u.ap <= 0) endPlayerTurn(s);
}

// ============================================================================
// 回合流程（§5.1）
// ============================================================================

function endPlayerTurn(s: GameState): void {
  s.phase = 'ENEMY';
  beginEnemyTurn(s);
}

function endEnemyTurn(s: GameState): void {
  s.turn += 1;
  s.phase = 'PLAYER';
  const u = activePlayerUnit(s);
  if (u) {
    u.ap = u.maxAp;
    u.shotsThisTurn = 0;
  }
  pushLog(s, 'INFO', '── 第 ' + s.turn + ' 回合 ──');
}

/** 敵人回合的一個原子步驟。UI 反覆送出 ENEMY_STEP 直到 phase 回到 PLAYER。 */
function enemyStep(s: GameState): void {
  if (s.enemyQueue.length === 0) {
    endEnemyTurn(s);
    return;
  }
  const id = s.enemyQueue[0];
  const before = findUnit(s, id);
  if (!before) {
    s.enemyQueue.shift();
    return;
  }
  const apBefore = before.ap;
  const outcome = stepEnemy(s, id);
  processDeaths(s);

  const after = findUnit(s, id);
  // 沒有實際消耗 AP 的 CONTINUE 一律當作 DONE，確保驅動迴圈必定收斂。
  if (!after || outcome === 'DONE' || after.ap <= 0 || after.ap >= apBefore) {
    s.enemyQueue.shift();
  }

  if (s.phase === 'MISSION_END') return;
  if (s.pendingReinforcement) return; // 暫停，等玩家補人後再繼續
  if (s.enemyQueue.length === 0) endEnemyTurn(s);
}

// ============================================================================
// 死亡、增援與屍體（§10）
// ============================================================================

export function processDeaths(s: GameState): void {
  const dead = s.units.filter((u) => u.hp <= 0);
  for (const u of dead) {
    s.units = s.units.filter((x) => x.id !== u.id);
    s.enemyQueue = s.enemyQueue.filter((id) => id !== u.id);

    if (u.faction === 'ENEMY') {
      // 敵人死亡：直接移除，不留屍體、不掉落物品（§10.3）
      pushLog(s, 'DEATH', u.name + ' 被擊倒');
      continue;
    }

    // 玩家單位死亡（§10.1）：屍體與身上所有武器留在原地
    const weapons: Weapon[] = [];
    if (u.equipped) weapons.push(u.equipped);
    if (u.stowed) weapons.push(u.stowed);
    s.corpses.push({
      id: 'C' + s.nextEntitySerial++,
      pos: { x: u.pos.x, y: u.pos.y },
      unitId: u.id,
      weapons,
    });
    s.casualties += 1;
    if (s.activePlayerUnitId === u.id) s.activePlayerUnitId = null;
    pushLog(s, 'DEATH', u.name + ' 陣亡於 (' + u.pos.x + ',' + u.pos.y + ')，裝備遺留原地');

    if (s.roster.length === 0) {
      s.result = 'WIPED';
      s.phase = 'MISSION_END';
      s.pendingReinforcement = null;
      pushLog(s, 'MISSION', '名冊耗盡。任務失敗。');
      return;
    }
    s.pendingReinforcement = { deathPos: { x: u.pos.x, y: u.pos.y }, deadUnitId: u.id };
  }
}

/** 找出距離死亡地點最近、且未被佔據的 DROP_POINT（§10.1 第 5 點）。 */
export function reinforcementSpawn(s: GameState, deathPos: Vec2): Vec2 | null {
  const drops = findTiles(s.map, 'DROP_POINT');
  const best = nearestFreeTileOfType(s, deathPos, drops);
  if (best) return best;
  // 極端狀況：所有空投點都被佔住。退而求其次，找離初始空投點最近的空格。
  return findFreeTileNear(s, s.map.startDropPoint);
}

function findFreeTileNear(s: GameState, origin: Vec2): Vec2 | null {
  if (terrainPassable(s, origin) && !occupiedBy(s, origin)) return origin;
  for (let r = 1; r < Math.max(s.map.width, s.map.height); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const p = { x: origin.x + dx, y: origin.y + dy };
        if (!terrainPassable(s, p) || occupiedBy(s, p)) continue;
        if (findPath(s, origin, p)) return p;
      }
    }
  }
  return null;
}

function deployReinforcement(s: GameState, soldierId: string): void {
  const pending = s.pendingReinforcement;
  if (!pending) return;
  const spawn = reinforcementSpawn(s, pending.deathPos);
  if (!spawn) {
    s.result = 'WIPED';
    s.phase = 'MISSION_END';
    s.pendingReinforcement = null;
    pushLog(s, 'MISSION', '沒有可用的空投點。任務失敗。');
    return;
  }

  s.roster = s.roster.filter((id) => id !== soldierId);
  const unit = makeReinforcementSoldier(soldierId, spawn);
  const f = facingToward(spawn, pending.deathPos);
  if (f) unit.facing = f;
  s.units.push(unit);
  s.activePlayerUnitId = unit.id;
  s.deployed += 1;
  s.pendingReinforcement = null;
  pushLog(
    s, 'INFO',
    soldierId + ' 自空投點 (' + spawn.x + ',' + spawn.y + ') 落地，僅配發 AR-9。本回合無法行動。',
  );

  // 落地當回合 AP 為 0：若此刻仍是玩家回合，直接進入敵人回合。
  if (s.phase === 'PLAYER') endPlayerTurn(s);
}

// ============================================================================
// UI 便利查詢（唯讀）
// ============================================================================

/** 走到指定格所需的路徑（不含起點）。null = 走不到。長度即所需 AP。 */
export function movePath(state: GameState, to: Vec2): Vec2[] | null {
  const u = activePlayerUnit(state);
  if (!u) return null;
  return findPath(state, u.pos, to, { ignoreUnitIds: [u.id] });
}

export function corpseUnder(state: GameState): Corpse | null {
  const u = activePlayerUnit(state);
  return u ? corpseAt(state, u.pos) : null;
}
