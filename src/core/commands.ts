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
import { activePlayerUnit, corpseAt } from './state';
import { DIR_VEC, facingToward, manhattan, sameTile } from './grid';
import { findTiles, tileAt } from './map';
import { canStep, findPath, nearestFreeTileOfType, occupiedBy, terrainPassable } from './pathfind';
import { canAttack, performAttack, type Legality } from './combat';
import { stepEnemy } from './ai';
import { RULES } from './content';
import { makeReinforcementSoldier } from './setup';
import { activeUnit, isMissionOver, isPlayerTurn, spend, syncClock } from './scheduler';
import * as seq from './sequence';
import { pushLog } from './log';
import type { CombatEvent, EventSink } from './events';

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
  | { type: 'SEQUENCE_STEP' }
  | { type: 'ABORT_SEQUENCE' }
  | { type: 'ADVANCE' }
  | { type: 'DEPLOY_REINFORCEMENT'; soldierId: string }
  | { type: 'ABORT' };

const OK: Legality = { ok: true, reason: '' };
const no = (reason: string): Legality => ({ ok: false, reason });

// ============================================================================
// 時間成本（§5.2）—— 全部從 data/rules.json 讀，不寫死
// ============================================================================

export function swapTime(u: Unit): number {
  return u.stowed ? RULES.time.swap[u.stowed.class] : Number.POSITIVE_INFINITY;
}

/**
 * 這個指令要花多少時間（§5.2）。UI 用它在按鈕上顯示花費。
 * 所有數值都來自資料檔，程式碼中不寫死。
 */
export function commandTime(state: GameState, cmd: Command): number | null {
  const u = activePlayerUnit(state);
  switch (cmd.type) {
    case 'MOVE': return u ? u.moveTime : RULES.time.move;
    case 'SET_STANCE':
    case 'TOGGLE_STANCE': return RULES.time.stance;
    case 'SET_FACING': return RULES.time.facing;
    case 'FIRE': return u && u.equipped ? u.equipped.fireTime : null;
    case 'RELOAD': {
      if (!u || !u.equipped) return null;
      return u.equipped.reloadTime;
    }
    case 'SEQUENCE_STEP': return u && u.pendingSequence ? seq.stepTime(u.pendingSequence) : null;
    case 'ABORT_SEQUENCE': return 0;
    case 'SWAP_WEAPON': return u ? swapTime(u) : null;
    case 'PICKUP': return RULES.time.pickup;
    case 'INTERACT': return RULES.time.interact;
    case 'WAIT': return RULES.time.wait;
    default: return null;
  }
}

// ============================================================================
// 合法性
// ============================================================================

const PLAYER_COMMANDS = new Set<Command['type']>([
  'MOVE', 'SET_STANCE', 'TOGGLE_STANCE', 'SET_FACING', 'FIRE',
  'RELOAD', 'SWAP_WEAPON', 'PICKUP', 'INTERACT', 'WAIT',
  'SEQUENCE_STEP', 'ABORT_SEQUENCE',
]);

/** 系列動作進行中時，這個單位輪到時只能執行下一步或中止（§5.5）。 */
const SEQUENCE_COMMANDS = new Set<Command['type']>(['SEQUENCE_STEP', 'ABORT_SEQUENCE']);

/**
 * 指令是否合法。UI 必須用這個來灰化按鈕，
 * 不要讓玩家點下去才被拒絕（§12.2）。
 */
export function checkLegal(state: GameState, cmd: Command): Legality {
  if (isMissionOver(state)) return no('任務已結束');

  // 止損：任何時候都可以按（§11.3）
  if (cmd.type === 'ABORT') return OK;

  if (cmd.type === 'DEPLOY_REINFORCEMENT') {
    if (!state.pendingReinforcement) return no('目前沒有待補的空缺');
    if (!state.roster.includes(cmd.soldierId)) return no('名冊中沒有這個編號');
    return OK;
  }

  // 陣亡待補期間，除了補人與止損以外什麼都不能做
  if (state.pendingReinforcement) return no('等待增援選擇');

  if (cmd.type === 'ADVANCE') {
    const u = activeUnit(state);
    if (!u) return no('場上沒有單位');
    return u.faction === 'ENEMY' ? OK : no('現在輪到玩家');
  }

  if (PLAYER_COMMANDS.has(cmd.type)) {
    if (!isPlayerTurn(state)) return no('還沒輪到你');
    const u = activePlayerUnit(state);
    if (!u) return no('場上沒有可操作的士兵');
    // 承諾中的單位只能把序列走完或中止
    if (u.pendingSequence && !SEQUENCE_COMMANDS.has(cmd.type)) {
      return no('正在' + seq.describe(u.pendingSequence) + '，只能繼續或中止');
    }
    return checkPlayerCommand(state, u, cmd);
  }
  return no('未知的指令');
}

function checkPlayerCommand(state: GameState, u: Unit, cmd: Command): Legality {
  switch (cmd.type) {
    case 'MOVE': {
      const to = { x: u.pos.x + DIR_VEC[cmd.dir].x, y: u.pos.y + DIR_VEC[cmd.dir].y };
      if (!terrainPassable(state, to)) return no('地形不可通行');
      if (occupiedBy(state, to, [u.id])) return no('該格已被佔據');
      if (!canStep(state, u.pos, to, { ignoreUnitIds: [u.id] })) return no('只能上下左右移動');
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
      return OK;
    }
    case 'SEQUENCE_STEP':
      return u.pendingSequence ? OK : no('沒有進行中的動作');
    case 'ABORT_SEQUENCE':
      return u.pendingSequence ? OK : no('沒有進行中的動作');
    case 'SWAP_WEAPON':
      return u.stowed ? OK : no('沒有收納的武器');
    case 'PICKUP': {
      const corpse = state.corpses.find((c) => c.id === cmd.corpseId);
      if (!corpse) return no('找不到這具屍體');
      if (!sameTile(corpse.pos, u.pos)) return no('必須站在屍體所在格');
      if (cmd.weaponIndex < 0 || cmd.weaponIndex >= corpse.weapons.length) return no('沒有這件裝備');
      return OK;
    }
    case 'INTERACT':
      return interactTargetLegality(state, u, cmd.pos);
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

/** 指令套用的完整結果：新狀態 + 這次產生的事件（§8.6）。 */
export interface CommandResult {
  state: GameState;
  events: CombatEvent[];
}

const NO_EVENTS: CombatEvent[] = [];

/**
 * 規則層唯一入口。
 *
 * 非法指令回傳「原本那個 state 物件」（`result.state === state`），
 * 讓 UI 與測試可以直接用 identity 比對。
 */
export function applyCommand(state: GameState, cmd: Command): CommandResult {
  if (!checkLegal(state, cmd).ok) return { state, events: NO_EVENTS };
  const s = cloneState(state);
  const events: EventSink = [];

  switch (cmd.type) {
    case 'ABORT':
      s.result = 'ABORTED';
      s.pendingReinforcement = null;
      pushLog(s, 'MISSION', '指揮部下令止損，任務中止。');
      break;
    case 'DEPLOY_REINFORCEMENT':
      deployReinforcement(s, cmd.soldierId, events);
      break;
    case 'ADVANCE': {
      // 排程器推進一格：clock 前進到該敵人的時刻，它做一件事，然後往後推
      syncClock(s);
      const actor = activeUnit(s);
      if (actor && actor.faction === 'ENEMY') {
        stepEnemy(s, actor.id, events);
        processDeaths(s, events);
      }
      break;
    }
    default:
      syncClock(s);
      applyPlayerCommand(s, cmd, events);
      break;
  }
  return { state: s, events };
}

function applyPlayerCommand(s: GameState, cmd: Command, events: EventSink): void {
  const u = activePlayerUnit(s);
  if (!u) return;
  let cost = commandTime(s, cmd) ?? 0;

  switch (cmd.type) {
    case 'MOVE': {
      const to = { x: u.pos.x + DIR_VEC[cmd.dir].x, y: u.pos.y + DIR_VEC[cmd.dir].y };
      u.facing = cmd.dir;
      u.pos = to;
      break;
    }
    case 'SET_STANCE':
      u.stance = cmd.stance;
      pushLog(s, 'INFO', u.name + (cmd.stance === 'CROUCH' ? ' 蹲下' : ' 起身'));
      break;
    case 'TOGGLE_STANCE':
      u.stance = u.stance === 'STAND' ? 'CROUCH' : 'STAND';
      pushLog(s, 'INFO', u.name + (u.stance === 'CROUCH' ? ' 蹲下' : ' 起身'));
      break;
    case 'SET_FACING':
      u.facing = cmd.facing;
      break;
    case 'FIRE': {
      performAttack(s, u.id, cmd.target, events);
      processDeaths(s, events);
      break;
    }
    case 'RELOAD': {
      const w = u.equipped as Weapon;
      if (w.reloadSequence) {
        // 系列動作：效果只在整套走完時發生（§5.5）
        seq.begin(u, w.reloadSequence);
        cost = 0;                       // 開始序列本身不花時間，第一步才花
        pushLog(s, 'INFO', u.name + ' 開始' + seq.describe(u.pendingSequence!));
      } else {
        w.ammo = w.magazine;
        events.push({ kind: 'RELOAD', unitId: u.id, pos: { x: u.pos.x, y: u.pos.y }, weaponName: w.name });
        pushLog(s, 'INFO', u.name + ' 裝填 ' + w.name);
      }
      break;
    }
    case 'SEQUENCE_STEP': {
      const active = u.pendingSequence;
      if (!active) break;
      const last = seq.isLastStep(active);
      if (last) {
        seq.applyCompletion(s, u, active.id);
        const w = u.equipped;
        if (w) {
          events.push({ kind: 'RELOAD', unitId: u.id, pos: { x: u.pos.x, y: u.pos.y }, weaponName: w.name });
        }
        pushLog(s, 'INFO', u.name + ' 完成裝填');
        u.pendingSequence = null;
      } else {
        active.index += 1;
      }
      break;
    }
    case 'ABORT_SEQUENCE':
      pushLog(s, 'INFO', u.name + ' 中止了動作，已花費的時間不退還');
      seq.abort(u);
      break;
    case 'SWAP_WEAPON': {
      const old = u.equipped;
      u.equipped = u.stowed;
      u.stowed = old;
      seq.abort(u);
      pushLog(s, 'INFO', u.name + ' 換裝為 ' + (u.equipped ? u.equipped.name : '空手'));
      break;
    }
    case 'PICKUP': {
      const corpse = s.corpses.find((c) => c.id === cmd.corpseId) as Corpse;
      const taken = corpse.weapons.splice(cmd.weaponIndex, 1)[0];
      const displaced = cmd.slot === 'EQUIPPED' ? u.equipped : u.stowed;
      if (displaced) corpse.weapons.push(displaced);
      if (cmd.slot === 'EQUIPPED') u.equipped = taken;
      else u.stowed = taken;
      pushLog(s, 'INFO', u.name + ' 從 ' + corpse.unitId + ' 的遺體取回 ' + taken.name);
      break;
    }
    case 'INTERACT': {
      const kind = interactTarget(s, u, cmd.pos);
      const f = facingToward(u.pos, cmd.pos);
      if (f) u.facing = f;
      if (kind === 'TERMINAL') {
        s.objectives.main.done = true;
        events.push({ kind: 'OBJECTIVE', pos: { ...cmd.pos }, text: '主目標完成' });
        pushLog(s, 'OBJECTIVE', '主目標完成：終端資料已取得。撤離點為初始空投點。');
      } else if (kind === 'SUPPLY') {
        const o = s.objectives.secondary.find((x) => sameTile(x.pos, cmd.pos));
        if (o) o.done = true;
        const n = s.objectives.secondary.filter((x) => x.done).length;
        events.push({ kind: 'OBJECTIVE', pos: { ...cmd.pos }, text: '次要目標 ' + n + '/' + s.objectives.secondary.length });
        pushLog(s, 'OBJECTIVE', '次要目標完成（' + n + '/' + s.objectives.secondary.length + '）');
      } else if (kind === 'EXTRACT') {
        s.result = 'SUCCESS';
        pushLog(s, 'MISSION', '撤離成功。');
        return;
      }
      break;
    }
    case 'WAIT':
      pushLog(s, 'INFO', u.name + ' 原地待命');
      break;
  }

  spend(s, u.id, cost);
}

// ============================================================================
// 死亡、增援與屍體（§10）
// ============================================================================

export function processDeaths(s: GameState, events?: EventSink): void {
  const dead = s.units.filter((u) => u.hp <= 0);
  for (const u of dead) {
    s.units = s.units.filter((x) => x.id !== u.id);

    events?.push({
      kind: 'KILL', unitId: u.id, pos: { x: u.pos.x, y: u.pos.y }, faction: u.faction, name: u.name,
    });

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

function deployReinforcement(s: GameState, soldierId: string, events: EventSink): void {
  const pending = s.pendingReinforcement;
  if (!pending) return;
  const spawn = reinforcementSpawn(s, pending.deathPos);
  if (!spawn) {
    s.result = 'WIPED';
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
  events.push({ kind: 'DEPLOY', unitId: unit.id, pos: { x: spawn.x, y: spawn.y } });
  pushLog(
    s, 'INFO',
    soldierId + ' 自空投點 (' + spawn.x + ',' + spawn.y + ') 落地，僅配發 AR-9。需要 ' + RULES.time.deploy + ' 時間才能行動。',
  );

  // 落地不能立刻行動 —— 這是 v0.6「落地當回合 AP 為 0」的時間換算（§5.2）
  unit.nextActAt = s.clock + RULES.time.deploy;
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
