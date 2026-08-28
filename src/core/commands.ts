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
  Facing, FireMode, GameState, Item, LootPile, Stance, Unit, Vec2, Weapon, WeaponInstance,
} from './state';
import { activePlayerUnit, lootAt } from './state';
import { DIR_VEC, facingToward, manhattan, sameTile } from './grid';
import { findTiles, tileAt } from './map';
import { canStep, findPath, nearestFreeTileOfType, occupiedBy, terrainPassable } from './pathfind';
import { canAttack, performAttack, type Legality } from './combat';
import { stepEnemy } from './ai';
import { RULES, archetype, fireModeOrder } from './content';
import { nextFloat } from './rng';
import {
  addItem, affordableQty, canCarry, carriedWeight, countAmmoFor, effectiveMoveTime, makeItem,
  maxWeight, takeAmmoFor, weaponItem,
} from './inventory';
import { makeDeployedUnit } from './setup';
import { activeUnit, isMissionOver, isPlayerTurn, spend, syncClock } from './scheduler';
import * as seq from './sequence';
import { pushLog } from './log';
import type { CombatEvent, EventSink } from './events';

/** 拾取到哪裡。BACKPACK 的武器不能使用，要先換到手持或收納欄（§3.1）。 */
export type WeaponSlot = 'EQUIPPED' | 'STOWED' | 'BACKPACK';

export type Command =
  | { type: 'MOVE'; dir: Facing }
  | { type: 'SET_STANCE'; stance: Stance }
  | { type: 'TOGGLE_STANCE' }
  | { type: 'SET_FACING'; facing: Facing }
  | { type: 'FIRE'; target: Vec2 }
  | { type: 'RELOAD' }
  | { type: 'SWAP_WEAPON' }
  /**
   * 在主手、收納欄與背包之間搬一把槍（v0.18）。
   *
   * v0.9 起規格就預期這件事可行（「撿到的第三把武器可以放進背包，
   * 要先換到收納欄」），但那個動作從來沒有被實作 —— 於是空投下來的替補
   * 走到屍體旁邊之後，**沒有任何動作可以騰出位置**，
   * 而「要不要冒險走回去撿自己的屍體」是這款遊戲最重要的單一決策。
   *
   * `from` 為 BACKPACK 時要指定 `itemId`。
   */
  | { type: 'MOVE_GEAR'; from: WeaponSlot; to: WeaponSlot; itemId?: string }
  | { type: 'PICKUP'; lootId: string; itemIndex: number; slot?: WeaponSlot }
  | { type: 'TAKE_ALL'; lootId: string }
  | { type: 'CYCLE_FIRE_MODE' }
  /** 把背包裡的一件消耗品放進準備欄（§12.19）。花 time.prepare。 */
  | { type: 'PREPARE'; itemId: string }
  /** 使用準備欄裡的東西。開始一套序列，效果只在走完時發生。 */
  | { type: 'USE_ITEM' }
  /** 丟棄背包裡的一件東西，落在腳下成為可搜刮的堆。不花時間。 */
  | { type: 'DROP'; itemId: string }
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

/**
 * 換槍的時間（v0.15）。**寫在武器上**，因為它是武器的性質不是類別的性質：
 * 手槍拔出來只要 5，輕機槍要 20。沒寫的退回類別預設值。
 */
export function weaponSwapTime(w: Weapon): number {
  return w.swapTime ?? RULES.time.swap[w.class];
}

/**
 * 某個位置上的那把槍（v0.18）。`BACKPACK` 要指定 itemId。
 * 找不到就是 null —— 呼叫端據此判定合法性與花費。
 */
export function gearAt(
  u: Unit, slot: WeaponSlot, itemId?: string,
): WeaponInstance | null {
  if (slot === 'EQUIPPED') return u.equipped;
  if (slot === 'STOWED') return u.stowed;
  const it = findBagItem(u, itemId ?? null);
  return it && it.kind === 'WEAPON' && it.weapon ? it.weapon : null;
}

export function swapTime(u: Unit): number {
  return u.stowed ? weaponSwapTime(u.stowed) : Number.POSITIVE_INFINITY;
}

/**
 * 這個指令要花多少時間（§5.2）。UI 用它在按鈕上顯示花費。
 * 所有數值都來自資料檔，程式碼中不寫死。
 */
/**
 * 蹲姿的「先轉向、再移動」（§12.14）。
 *
 * 蹲下時方向鍵若與當前面向不同，這一下**只轉向**（0 時間），要再按一次才走。
 * 這是刻意的防呆：蹲姿的視野是面向決定的，玩家想調整視野時最不該發生的事
 * 就是意外離開掩體。站立時面向不影響任何規則，所以直接走。
 */
export function movePhase(u: Unit, dir: Facing): 'TURN' | 'STEP' {
  return u.stance === 'CROUCH' && u.facing !== dir ? 'TURN' : 'STEP';
}

export function commandTime(state: GameState, cmd: Command): number | null {
  const u = activePlayerUnit(state);
  switch (cmd.type) {
    case 'MOVE':
      if (!u) return RULES.time.move;
      // 移動時間受負重影響（§3.2）。轉向不算移動，所以不受負重影響。
      return movePhase(u, cmd.dir) === 'TURN' ? RULES.time.facing : effectiveMoveTime(u);
    case 'SET_STANCE':
    case 'TOGGLE_STANCE': return RULES.time.stance;
    case 'SET_FACING': return RULES.time.facing;
    case 'FIRE': return u && u.equipped ? u.equipped.fireTime : null;
    case 'RELOAD': {
      if (!u || !u.equipped) return null;
      // 增量裝填的 reloadTime 就是「一發」的時間，兩者剛好同一個欄位（§3.1）
      return u.equipped.reloadTime;
    }
    case 'SEQUENCE_STEP': return u && u.pendingSequence ? seq.stepTime(u.pendingSequence) : null;
    case 'ABORT_SEQUENCE': return 0;
    case 'SWAP_WEAPON': return u ? swapTime(u) : null;
    case 'MOVE_GEAR': {
      // 花費依**被搬動的那一把**決定（v0.15 起寫在武器上，未寫則退回類別預設）
      const w = u ? gearAt(u, cmd.from, cmd.itemId) : null;
      return w ? weaponSwapTime(w) : null;
    }
    case 'PICKUP':
    case 'TAKE_ALL': return RULES.loot.takeTime;
    case 'CYCLE_FIRE_MODE': return 0;   // 切換模式不花時間（§2.5）
    case 'PREPARE': return RULES.time.prepare;
    case 'DROP': return RULES.time.drop;
    case 'USE_ITEM': {
      // 開始序列本身不花時間，第一步才花（與裝填一致）
      if (!u || !u.preparedId) return null;
      return 0;
    }
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
  'RELOAD', 'SWAP_WEAPON', 'PICKUP', 'TAKE_ALL', 'INTERACT', 'WAIT',
  'SEQUENCE_STEP', 'ABORT_SEQUENCE', 'CYCLE_FIRE_MODE',
  'PREPARE', 'USE_ITEM', 'DROP', 'MOVE_GEAR',
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
      // 蹲姿的第一下是轉向，轉向永遠合法 —— 面向牆壁蹲著也是一種選擇
      if (movePhase(u, cmd.dir) === 'TURN') return OK;
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
      const w = u.equipped;
      if (!w) return no('沒有裝備武器');
      // 已經退殼、還沒裝完的槍，這一步是「接著裝」而不是「彈匣已滿」
      if (w.ammo >= w.magazine && w.reloadProgress === 0) return no('彈匣已滿');
      // v0.9：彈藥是背包裡的資源（§1.1）。背包空了就裝不了。
      if (w.magazine < 99 && countAmmoFor(u.backpack, w) <= 0) return no('沒有備用彈藥');
      return OK;
    }
    case 'CYCLE_FIRE_MODE': {
      const w = u.equipped;
      if (!w) return no('沒有裝備武器');
      return w.modes.length > 1
        ? OK
        : no('這把武器只有' + RULES.fireModes[w.modes[0] ?? 'SINGLE'].full);
    }
    case 'PREPARE': {
      const it = findBagItem(u, cmd.itemId);
      if (!it) return no('背包裡沒有這件東西');
      if (it.kind !== 'CONSUMABLE') return no('只有消耗品可以準備');
      if (u.preparedId === it.id) return no('已經準備好了');
      return OK;
    }
    case 'USE_ITEM': {
      if (!u.preparedId) return no('準備欄是空的');
      const it = findBagItem(u, u.preparedId);
      if (!it) return no('準備欄裡的東西不見了');
      return seq.sequenceDef(it.defId) ? OK : no('這件東西不能用');
    }
    case 'DROP': {
      const it = findBagItem(u, cmd.itemId);
      return it ? OK : no('背包裡沒有這件東西');
    }
    case 'SEQUENCE_STEP':
      return u.pendingSequence ? OK : no('沒有進行中的動作');
    case 'ABORT_SEQUENCE':
      return u.pendingSequence ? OK : no('沒有進行中的動作');
    case 'SWAP_WEAPON':
      return u.stowed ? OK : no('沒有收納的武器');
    case 'MOVE_GEAR': {
      if (cmd.from === cmd.to) return no('原地不動');
      if (cmd.to === 'EQUIPPED') return no('要拿到手上請用換武器');
      const w = gearAt(u, cmd.from, cmd.itemId);
      if (!w) {
        return no(cmd.from === 'BACKPACK' ? '背包裡沒有這把槍'
          : cmd.from === 'EQUIPPED' ? '手上沒有武器' : '收納欄是空的');
      }
      if (cmd.to === 'BACKPACK' && !u.backpack) return no('沒有背包');
      // **不必檢查重量**：三個位置的東西全部計入負重（§1），
      // 所以搬動不改變身上的總重，只改變「拿不拿得到」。
      return OK;
    }
    case 'PICKUP': {
      const pile = state.loot.find((c) => c.id === cmd.lootId);
      if (!pile) return no('找不到這一堆東西');
      if (manhattan(pile.pos, u.pos) > INTERACT_REACH) return no('距離太遠，要站到相鄰格');
      const item = pile.items[cmd.itemIndex];
      if (!item) return no('沒有這件東西');
      // 換裝不佔背包，但 v0.15 起武器本身計重 —— 換一把更重的槍會加負重，
      // 只是它換掉的那一把同時落地，所以淨值幾乎不會超過上限。
      if (item.kind === 'WEAPON' && cmd.slot !== 'BACKPACK') return OK;
      return canCarry(u, item) ? OK : no('背包裝不下');
    }
    case 'TAKE_ALL': {
      const pile = state.loot.find((c) => c.id === cmd.lootId);
      if (!pile) return no('找不到這一堆東西');
      if (manhattan(pile.pos, u.pos) > INTERACT_REACH) return no('距離太遠，要站到相鄰格');
      if (pile.items.length === 0) return no('這裡已經空了');
      // 一件都拿不動時要擋下來。否則按下去只是白花 10 時間，
      // 而且會讓「一直按」變成一個無限迴圈（笨機器人實測抓到的）。
      const room = maxWeight() - carriedWeight(u);
      const anything = pile.items.some((it) => it.weight <= 0 || it.weight <= room);
      return anything ? OK : no('背包一件都裝不下');
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
  // v0.9：撤離不再需要先完成主目標（§5.1）。任務不是打開了就必須打完的副本，
  // 而是一個可以走人的工地 —— 系統不禁止，只標價：主目標沒完成就是合約失敗，
  // 但背包裡的東西照樣帶出去。
  if (t === 'DROP_POINT' && sameTile(pos, state.map.startDropPoint)) return 'EXTRACT';
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
      if (movePhase(u, cmd.dir) === 'TURN') { u.facing = cmd.dir; break; }
      u.facing = cmd.dir;
      u.pos = { x: u.pos.x + DIR_VEC[cmd.dir].x, y: u.pos.y + DIR_VEC[cmd.dir].y };
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
        // 增量裝填：一次只補一發（§3.1）。**不是系列動作** ——
        // 這一發裝完就是一個完整結束的動作，沒有進度要保存，
        // 所以玩家可以在任何一發之後直接開槍。
        const one = w.reloadMode === 'INCREMENTAL';
        const got = refillFromBackpack(u, w, one ? 1 : undefined);
        events.push({ kind: 'RELOAD', unitId: u.id, pos: { x: u.pos.x, y: u.pos.y }, weaponName: w.name });
        pushLog(s, 'INFO', u.name + ' 裝填 ' + w.name + '（+' + got + '，' + w.ammo + '/' + w.magazine + '）'
          + (one && w.ammo < w.magazine ? '　還可以繼續裝' : ''));
      }
      break;
    }
    case 'SEQUENCE_STEP': {
      const active = u.pendingSequence;
      if (!active) break;
      if (!seq.isLastStep(active)) { seq.advanceStep(u, active); break; }

      const isReload = active.id === 'RR4_RELOAD';
      seq.applyCompletion(s, u, active.id);
      if (isReload && u.equipped) {
        const got = refillFromBackpack(u, u.equipped);
        events.push({
          kind: 'RELOAD', unitId: u.id, pos: { x: u.pos.x, y: u.pos.y }, weaponName: u.equipped.name,
        });
        pushLog(s, 'INFO', u.name + ' 完成裝填（+' + got + '）');
      } else {
        // 消耗品：走完才生效，而且用掉就沒了（§4）
        const it = findBagItem(u, u.preparedId);
        if (it) {
          consumeOne(u, it);
          if (!findBagItem(u, it.id)) u.preparedId = null;
        }
        pushLog(s, 'INFO', u.name + ' 完成' + (seq.sequenceDef(active.id)?.label ?? '動作'));
      }
      u.pendingSequence = null;
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
    case 'MOVE_GEAR': {
      moveGear(s, u, cmd.from, cmd.to, cmd.itemId);
      // 搬裝備跟換槍一樣會中斷手上的序列 —— 你正在裝填的那把槍被收走了
      seq.abort(u);
      break;
    }
    case 'PICKUP': {
      const pile = s.loot.find((c) => c.id === cmd.lootId) as LootPile;
      const item = pile.items[cmd.itemIndex];
      takeOne(s, u, pile, cmd.itemIndex, cmd.slot);
      pushLog(s, 'INFO', u.name + ' 從' + pile.label + '取走 ' + itemLabel(item));
      break;
    }
    case 'TAKE_ALL': {
      const pile = s.loot.find((c) => c.id === cmd.lootId) as LootPile;
      // 由後往前拿，索引才不會在刪除時位移。超重就盡可能拿（§4.3）。
      let taken = 0;
      let left = 0;
      for (let i = pile.items.length - 1; i >= 0; i--) {
        const got = takeOne(s, u, pile, i, 'BACKPACK');
        if (got) taken += 1; else left += 1;
      }
      pushLog(
        s, 'INFO',
        u.name + ' 搜刮' + pile.label + '：取得 ' + taken + ' 項'
          + (left > 0 ? '，' + left + ' 項因背包塞不下留在原地' : ''),
      );
      break;
    }
    case 'CYCLE_FIRE_MODE': {
      const w = u.equipped as Weapon;
      w.mode = nextFireMode(w);
      pushLog(s, 'INFO', u.name + ' 切換為' + RULES.fireModes[w.mode].full);
      break;
    }
    case 'PREPARE': {
      const it = findBagItem(u, cmd.itemId) as Item;
      u.preparedId = it.id;
      pushLog(s, 'INFO', u.name + ' 把 ' + it.name + ' 拿到隨手可及的地方');
      break;
    }
    case 'USE_ITEM': {
      const it = findBagItem(u, u.preparedId) as Item;
      seq.begin(u, it.defId);
      cost = 0;                       // 開始序列本身不花時間，第一步才花
      pushLog(s, 'INFO', u.name + ' 開始' + seq.describe(u.pendingSequence!));
      break;
    }
    case 'DROP': {
      const it = findBagItem(u, cmd.itemId) as Item;
      dropAtFeet(s, u, it);
      pushLog(s, 'INFO', u.name + ' 丟下 ' + itemLabel(it));
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
        extract(s, u);
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
// 彈藥、拾取、射擊模式、撤離（§1 / §2 / §4 / §5）
// ============================================================================

/** 從背包補滿槍。回傳實際補進去的發數 —— 背包不足時就補多少算多少（§1.1）。 */
export function refillFromBackpack(u: Unit, w: Weapon, limit?: number): number {
  if (w.magazine >= 99) { w.ammo = w.magazine; return 0; }   // 敵人的攻擊不吃彈藥
  const need = Math.min(w.magazine - w.ammo, limit ?? Number.POSITIVE_INFINITY);
  const got = takeAmmoFor(u.backpack, w, need);
  w.ammo += got;
  return got;
}

/** 從背包裡找一件東西。 */
export function findBagItem(u: Unit, id: string | null): Item | null {
  if (!id || !u.backpack) return null;
  return u.backpack.items.find((it) => it.id === id) ?? null;
}

/** 用掉一件（堆疊的只扣一個）。 */
function consumeOne(u: Unit, item: Item): void {
  if (!u.backpack) return;
  item.qty -= 1;
  if (item.qty <= 0) u.backpack.items = u.backpack.items.filter((x) => x.id !== item.id);
}

/**
 * 丟到腳下（§12.20）。腳下已經有一堆就併進去，沒有就新開一堆。
 *
 * 丟棄是這一版的重點功能而不是附屬品：負重直接拖慢移動，
 * 而移動速度在被追擊時就等於生存率。玩家必須能在戰鬥中決定
 * 「這批戰利品不值得我用命換」。
 */
function dropAtFeet(s: GameState, u: Unit, item: Item): void {
  if (!u.backpack) return;
  u.backpack.items = u.backpack.items.filter((x) => x.id !== item.id);
  if (u.preparedId === item.id) u.preparedId = null;
  const here = s.loot.find((c) => sameTile(c.pos, u.pos));
  if (here) { here.items.push(item); return; }
  s.loot.push({
    id: 'L' + s.nextEntitySerial++,
    kind: 'CACHE',
    pos: { x: u.pos.x, y: u.pos.y },
    label: '丟在地上的東西',
    items: [item],
  });
}

/** UI 與紀錄用的物品標籤。 */
export function itemLabel(it: Item): string {
  return it.qty > 1 ? it.name + ' ×' + it.qty : it.name;
}

/**
 * 從一堆東西裡取走第 index 項。回傳有沒有真的拿到。
 *
 * 武器可以直接換到手持／收納欄（不佔背包，§3.1），其餘一律進背包。
 * 換下來的槍留在原地那一堆裡 —— 跟 v0.1 起的「丟棄免費」是同一條規則。
 */
function takeOne(
  s: GameState, u: Unit, pile: LootPile, index: number, slot?: WeaponSlot,
): boolean {
  const item = pile.items[index];
  if (!item) return false;

  if (item.kind === 'WEAPON' && item.weapon && slot && slot !== 'BACKPACK') {
    pile.items.splice(index, 1);
    const displaced = slot === 'EQUIPPED' ? u.equipped : u.stowed;
    if (displaced) pile.items.push(weaponItem(s, displaced));
    if (slot === 'EQUIPPED') u.equipped = item.weapon;
    else u.stowed = item.weapon;
    return true;
  }

  if (!u.backpack) return false;
  // 塞不下整堆時，可堆疊的東西就拿得下的部分（§4.3「盡可能拿」）
  const n = item.kind === 'AMMO' || item.kind === 'VALUABLE'
    ? affordableQty(u, item)
    : (canCarry(u, item) ? item.qty : 0);
  if (n <= 0) return false;

  if (n >= item.qty) {
    pile.items.splice(index, 1);
    addItem(u.backpack, item);
  } else {
    item.qty -= n;
    addItem(u.backpack, { ...item, id: 'I' + s.nextEntitySerial++, qty: n });
  }
  return true;
}

/** 下一個射擊模式（§2.5：點一下循環切換），只在這把槍支援的模式之間輪。 */
export function nextFireMode(w: Weapon): FireMode {
  const order = fireModeOrder().filter((m) => w.modes.includes(m));
  if (order.length === 0) return w.mode;
  const i = order.indexOf(w.mode);
  return order[(i + 1) % order.length];
}

/**
 * 撤離（§5.1）。背包內的一切帶出，兩把槍也帶出。
 * 主目標完成 → SUCCESS；未完成 → ABORTED（合約失敗），但戰利品照樣帶出。
 */
function extract(s: GameState, u: Unit): void {
  const out: Item[] = [];
  if (u.backpack) out.push(...u.backpack.items);
  if (u.equipped) out.push(weaponItem(s, u.equipped));
  if (u.stowed) out.push(weaponItem(s, u.stowed));
  s.extracted = out;
  s.extractedBy = u.id;
  s.result = s.objectives.main.done ? 'SUCCESS' : 'ABORTED';
  pushLog(
    s, 'MISSION',
    s.objectives.main.done
      ? '撤離成功。帶出 ' + out.length + ' 項物資。'
      : '主目標未完成即撤離：合約失敗，但帶出 ' + out.length + ' 項物資。',
  );
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
      // v0.9：敵人死亡也留下可搜刮的屍體（§4.2）。掉落表在 actors.json，
      // **每一項依序各抽一次亂數**，抽值順序固定，與掉不掉得到無關。
      const drops: Item[] = [];
      for (const d of archetype(u.archetype).loot ?? []) {
        const roll = nextFloat(s.rng);
        if (roll < d.chance) drops.push(makeItem(s, d.defId, d.qty));
      }
      s.loot.push({
        id: 'L' + s.nextEntitySerial++,
        kind: 'ENEMY_BODY',
        pos: { x: u.pos.x, y: u.pos.y },
        label: u.name + ' 的殘骸',
        items: drops,
      });
      pushLog(s, 'DEATH', u.name + ' 被擊倒'
        + (drops.length ? '，殘骸可搜刮' : '，身上沒有可用的東西'));
      continue;
    }

    // 玩家單位死亡（§10.1 / §3.3）：兩把槍、**背包全部內容**與一份 DNA 留在原地。
    // 這讓屍體回收從「回去撿那把砲」變成「回去撿我這一路搜刮的所有東西」——
    // 玩家越貪，回去的動機越強，風險也越大。
    const items: Item[] = [];
    if (u.equipped) items.push(weaponItem(s, u.equipped));
    if (u.stowed) items.push(weaponItem(s, u.stowed));
    if (u.backpack) items.push(...u.backpack.items);
    items.push(makeItem(s, RULES.loot.dnaDefId));
    s.loot.push({
      id: 'L' + s.nextEntitySerial++,
      kind: 'PLAYER_BODY',
      pos: { x: u.pos.x, y: u.pos.y },
      label: u.id + ' 的遺體',
      items,
    });
    s.casualties += 1;
    s.deadSoldierIds.push(u.id);
    if (s.activePlayerUnitId === u.id) s.activePlayerUnitId = null;
    pushLog(
      s, 'DEATH',
      u.name + ' 陣亡於 (' + u.pos.x + ',' + u.pos.y + ')，'
        + '兩把槍、背包內容與一份 DNA 遺留原地',
    );

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

  const spec = s.deployment.find((d) => d.id === soldierId);
  if (!spec) return;
  s.roster = s.roster.filter((id) => id !== soldierId);
  const unit = makeDeployedUnit(s, spec, spawn);
  const f = facingToward(spawn, pending.deathPos);
  if (f) unit.facing = f;
  s.units.push(unit);
  s.activePlayerUnitId = unit.id;
  s.deployed += 1;
  s.pendingReinforcement = null;
  events.push({ kind: 'DEPLOY', unitId: unit.id, pos: { x: spawn.x, y: spawn.y } });
  // v0.16：替補帶著**他自己的配裝**降落（§4.2）。沒有配裝的人就赤手空拳。
  const kit = unit.equipped ? unit.equipped.name : '赤手空拳';
  pushLog(
    s, 'INFO',
    unit.name + ' 自空投點 (' + spawn.x + ',' + spawn.y + ') 落地，攜 ' + kit
      + '。需要 ' + RULES.time.deploy + ' 時間才能行動。',
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

export function lootUnder(state: GameState): LootPile | null {
  const u = activePlayerUnit(state);
  return u ? lootAt(state, u.pos) : null;
}

/**
 * 在主手、收納欄與背包之間搬一把槍（v0.18 §2）。
 *
 * **三個位置的東西全部計入負重**，所以搬動不改變身上的總重 ——
 * 改變的是「拿不拿得到」。這也是為什麼它要花時間：
 * 在敵火下騰位置應該是件蠢事，在掩體後應該是可行的。
 *
 * 目的地已經有東西時就對調（收納欄換出來的那把進背包），
 * 這比「先清空再搬」少按一次，而且淨重量一樣不變。
 */
function moveGear(
  s: GameState, u: Unit, from: WeaponSlot, to: WeaponSlot, itemId?: string,
): void {
  const w = gearAt(u, from, itemId);
  if (!w || !u.backpack) return;

  // 先從來源位置取下
  if (from === 'EQUIPPED') u.equipped = null;
  else if (from === 'STOWED') u.stowed = null;
  else u.backpack.items = u.backpack.items.filter((it) => it.weapon !== w);

  // 目的地原本的東西讓位
  if (to === 'STOWED') {
    const displaced = u.stowed;
    u.stowed = w;
    if (displaced) addItem(u.backpack, weaponItem(s, displaced));
  } else {
    addItem(u.backpack, weaponItem(s, w));
  }

  const where: Record<WeaponSlot, string> = {
    EQUIPPED: '手持', STOWED: '收納欄', BACKPACK: '背包',
  };
  pushLog(s, 'INFO', u.name + ' 把 ' + w.name + ' 從' + where[from] + '移到' + where[to]);
}
