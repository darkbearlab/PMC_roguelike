/**
 * 敵人決策（§9）。
 *
 * v0.7 起沒有「敵人回合」：排程器輪到某個敵人時，它**選一個動作**執行，
 * 然後依該動作的時間花費往後推。
 *
 * v0.10 起多了三件事：
 *  1. **落點評分**（core/tactics.ts）取代貪婪逼近 —— 敵人會找掩體、會繞側翼
 *  2. **警戒巡視** —— IDLE 的盲區會轉，背刺從白拿變成需要抓時機
 *  3. **宣告下一個動作**（口令）—— 說了就一定做，玩家可以打斷
 *
 * 全部由 `ai.tacticalBehaviour` 開關控制；關掉就完全回到 v0.9 的行為。
 *
 * 硬性要求：
 *  - AI 必須是決定性的。平手一律以固定規則決勝，不得使用亂數。
 *  - **AI 不得選擇 0 成本動作**（面向），否則排程器會無限迴圈（§5.4）。
 *    所以「警戒巡視」是一個有時間花費的獨立動作，不是免費轉向。
 */
import type { EventSink } from './events';
import type { Declaration, GameState, Unit, Vec2, Weapon } from './state';
import { activePlayerUnit, findUnit } from './state';
import { facingToward, manhattan, sameTile } from './grid';
import { unitSees } from './sight';
import { hasLineOfSight } from './los';
import {
  attackWeapon, canAttack, canAttackAny, identify, isIdentified, outOfAmmo, performAttack,
} from './combat';
import { findPath, isVaultStep, occupiedBy } from './pathfind';
import { spend } from './scheduler';
import { CALLOUTS, RULES } from './content';
import {
  bestCandidate, betterFiringPosition, flankSide, moveReason, scoreCandidate, weightsFor,
} from './tactics';
import { pushLog } from './log';
import * as seq from './sequence';

const tactical = (): boolean => RULES.ai.tacticalBehaviour;

/** 順時針的四方向。巡視轉 90 度用；固定方向讓玩家可以觀察、計時、抓空檔。 */
const CW: Record<string, 'N' | 'E' | 'S' | 'W'> = { N: 'E', E: 'S', S: 'W', W: 'N' };
function turn90(u: Unit): 'N' | 'E' | 'S' | 'W' {
  const f = u.facing;
  if (f === 'N' || f === 'E' || f === 'S' || f === 'W') return CW[f];
  return 'N';   // 斜向（追擊時面向目標留下的）一律先扶正
}

/**
 * 敵人偵測（§7.4）：對玩家有視線且在有效視野內。
 * 回傳「應該轉換到哪個狀態」，或 null 代表不需要轉換。
 */
function desiredState(state: GameState, e: Unit): 'ALERT' | 'SEARCH' | null {
  const player = activePlayerUnit(state);
  // v0.8：這裡用的是**現在**的面向，不是「先轉頭再看」——
  // 你只能轉向已經注意到的東西，不能先假設自己會轉對邊。
  const sees = !!player && unitSees(state.map, e, player);

  if (sees) return e.aiState === 'ALERT' ? null : 'ALERT';
  if (e.aiState === 'ALERT') return 'SEARCH';
  return null;
}

function transitionCost(e: Unit, to: 'ALERT' | 'SEARCH'): number {
  if (to === 'ALERT') return e.aiState === 'SEARCH' ? 0 : e.transitionTime;
  return 0;
}

function applyTransition(
  state: GameState, e: Unit, to: 'ALERT' | 'SEARCH', events?: EventSink,
): number {
  const from = e.aiState;
  const cost = transitionCost(e, to);
  events?.push({
    kind: 'AI_STATE', unitId: e.id, pos: { x: e.pos.x, y: e.pos.y }, from, to,
  });
  const player = activePlayerUnit(state);
  if (to === 'ALERT') {
    e.aiState = 'ALERT';
    if (player) {
      e.lastKnownTarget = { x: player.pos.x, y: player.pos.y };
      faceToward(e, player.pos);          // ALERT 一律面向目標（§9.1）
    }
    pushLog(state, 'AI', e.name + (cost > 0 ? ' 發現目標（尚未進入狀況）' : ' 重新鎖定目標'));
  } else {
    e.aiState = 'SEARCH';
    e.searchTimer = RULES.ai.searchTime;
    e.patrolLeft = 0;
    pushLog(state, 'AI', e.name + ' 失去目標，開始搜索');
  }
  return cost;
}

/** 轉向某個位置。轉向不花時間（§5.2），所以它永遠是別的動作的附帶效果。 */
function faceToward(u: Unit, target: Vec2): void {
  const f = facingToward(u.pos, target);
  if (f) u.facing = f;
}

/**
 * 走到指定的格。**可能是翻越**（v0.19 §1.3）——
 * 否則掩體列會變成單向膜：玩家穿得過去，敵人只能繞路，
 * 那會直接架空 v0.10 的側翼繞行機制。
 */
function stepTo(state: GameState, e: Unit, next: Vec2): number | null {
  if (occupiedBy(state, next, [e.id])) return null;
  const vault = isVaultStep(state, e.pos, next);
  if (!vault && manhattan(e.pos, next) !== 1) return null;
  const f = facingToward(e.pos, next);
  if (f) e.facing = f;
  e.pos = { x: next.x, y: next.y };
  e.setUp = false;              // 換了位置就要重架（§4.4）
  if (vault) {
    e.stance = 'STAND';                 // §1.2：落地必定站姿，敵人也一樣
    return RULES.time.vault;
  }
  return e.moveTime;
}

// ============================================================================
// 彈藥（§3）
// ============================================================================

/** 該裝填了嗎（§3.2）：**只在彈匣打空後才裝填，絕不提前。** */
function shouldReload(e: Unit): boolean {
  const w = e.equipped;
  if (!w || w.intrinsic) return false;
  if (w.reloadProgress > 0) return true;          // 退了殼就一定要裝完
  return w.ammo <= 0 && e.reserveAmmo > 0;
}

/**
 * 從攜行彈藥補進彈匣。回傳實際補了幾發。
 *
 * 敵人沒有背包（§3.2）—— 他們不做裝備管理，備彈只是一個數字。
 */
function refillFromReserve(e: Unit): number {
  const w = e.equipped;
  if (!w) return 0;
  const want = w.magazine - w.ammo;
  const got = Math.min(want, e.reserveAmmo);
  w.ammo += got;
  e.reserveAmmo -= got;
  w.reloadProgress = 0;
  return got;
}

/**
 * 執行一次裝填動作，回傳花掉的時間（§3.2）。
 *
 * **走與玩家相同的裝填流程與時間成本**，含增量裝填與系列動作：
 * 拿泵動霰彈槍的敵人一次只填一發，拿無後座力砲的要開栓、再裝填 ——
 * 那兩個空檔是玩家真的抓得到的東西。
 */
function doReload(state: GameState, e: Unit, events?: EventSink): number {
  const w = e.equipped as Weapon;
  if (w.reloadSequence) {
    const def = seq.sequenceDef(w.reloadSequence);
    const steps = def ? def.steps.length : 1;
    const idx = Math.min(w.reloadProgress, steps - 1);
    const cost = def ? def.steps[idx].time : w.reloadTime;
    w.reloadProgress = idx + 1;
    if (w.reloadProgress >= steps) {
      const got = refillFromReserve(e);
      events?.push({ kind: 'RELOAD', unitId: e.id, pos: { ...e.pos }, weaponName: w.name });
      pushLog(state, 'AI', e.name + ' 裝填完成（+' + got + '）');
    } else {
      pushLog(state, 'AI', e.name + ' ' + (def ? def.steps[idx].label : '裝填'));
    }
    return cost;
  }
  const one = w.reloadMode === 'INCREMENTAL' ? 1 : undefined;
  const want = one ?? (w.magazine - w.ammo);
  const got = Math.min(want, e.reserveAmmo);
  w.ammo += got;
  e.reserveAmmo -= got;
  events?.push({ kind: 'RELOAD', unitId: e.id, pos: { ...e.pos }, weaponName: w.name });
  pushLog(state, 'AI', e.name + ' 裝填 ' + w.name + '（+' + got + '，' + w.ammo + '/' + w.magazine + '）');
  return w.reloadTime;
}

// ============================================================================
// 口令與宣告（§9.4 / §9.5）
// ============================================================================

/**
 * 口令的文字。由理由碼查資料檔，不是事後推測 —— 否則調權重之後口令會說謊。
 *
 * **未識別的武器不得被口令洩漏**（§4.3）：`weaponName` 只有在該武器已識別
 * 或本來就藏不住時才會傳進來。否則玩家可以靠聽的繞過整個識別系統。
 */
export function calloutText(d: Declaration, weaponName?: string): string {
  if (d.kind === 'FLANK') return CALLOUTS[d.side === 'RIGHT' ? 'FLANK_RIGHT' : 'FLANK_LEFT'];
  if (weaponName) {
    const named = CALLOUTS[d.kind + '_NAMED'];
    if (named) return named.replace('{weapon}', weaponName);
  }
  return CALLOUTS[d.kind] ?? d.kind;
}

/**
 * 喊一聲。**只在玩家聽得到時才發事件**（§9.5）：
 * 可聽範圍是曼哈頓 12，牆壁不阻擋（與噪音機制一致）。
 *
 * IDLE 的敵人一律不喊 —— 這保護了偷襲，也讓「什麼時候變吵」本身成為訊號。
 */
function shout(state: GameState, e: Unit, d: Declaration, events?: EventSink): void {
  if (!tactical() || !events) return;
  if (e.aiState === 'IDLE') return;
  const player = activePlayerUnit(state);
  if (!player) return;
  if (manhattan(e.pos, player.pos) > RULES.ai.calloutRange) return;
  // §4.3：認得出來才說得出名字。
  const name = isIdentified(state, e.equipped) ? e.equipped?.name : undefined;
  events.push({
    kind: 'CALLOUT',
    unitId: e.id,
    pos: { x: e.pos.x, y: e.pos.y },
    code: d.kind === 'FLANK' ? 'FLANK_' + (d.side ?? 'LEFT') : d.kind,
    text: calloutText(d, name),
  });
}

/** 已宣告的動作現在還做得到嗎（§9.4）。做不到就改成原地等待。 */
function stillValid(state: GameState, e: Unit, d: Declaration): boolean {
  switch (d.kind) {
    case 'FIRE': {
      // 宣告的是「我要開火」，不是「我要打那一格」。
      // 失效條件就是 §9.4 列的三件事：脫離視線、脫離射程、已死亡 ——
      // 所以玩家**走一步不夠**，要真的破壞射線或拉開距離才吃得掉這一發。
      //
      // （寫成「目標必須待在同一格」試過，結果是笨機器人幾乎每個動作都在走，
      //   於是敵人一槍都打不出來 —— 那不是拘束力，那是把敵人關掉。）
      //
      // 用 canAttackAny：主手不行但人就貼在旁邊時，那一下改用內建近戰（§1.4），
      // 宣告依然有效。拿刀的衝鋒型從頭到尾走的就是這條路。
      const player = activePlayerUnit(state);
      if (!player) return false;
      return canAttackAny(state, e, player.pos).ok;
    }
    case 'ADVANCE':
    case 'FLANK':
    case 'TAKE_COVER':
    case 'SEARCH_MOVE':
      if (!d.to) return false;
      if (manhattan(e.pos, d.to) !== 1) return false;
      return !occupiedBy(state, d.to, [e.id]);
    case 'CROUCH':
      return e.stance === 'STAND';
    case 'SETUP': {
      // 架設是為了打那一發。射線在架好之前就斷了，架設本身就沒有意義了。
      const player = activePlayerUnit(state);
      return !!player && canAttack(state, e, player.pos, e.equipped).ok;
    }
    case 'RELOAD':
      return shouldReload(e);
    default:
      return true;
  }
}

/** 執行一個已決定的動作，回傳花掉的時間。 */
function execute(state: GameState, e: Unit, d: Declaration, events?: EventSink): number {
  switch (d.kind) {
    case 'FIRE': {
      // 重新瞄準到目標現在的位置：宣告綁的是「做什麼」，不是「瞄哪一格」。
      const player = activePlayerUnit(state);
      const aim = player ? player.pos : (d.target as Vec2);
      const weapon = attackWeapon(state, e, aim);
      performAttack(state, e.id, aim, events);
      return weapon ? weapon.fireTime : RULES.time.wait;
    }
    case 'RELOAD':
      return doReload(state, e, events);
    case 'SETUP':
      // 架設：這一整個動作只是把砲架起來，還沒有任何東西射出去（§4.4）
      e.setUp = true;
      identify(state, e.equipped);
      pushLog(state, 'AI', e.name + ' 架起 ' + (e.equipped ? e.equipped.name : '武器'));
      return RULES.time.weaponSetup;
    case 'CROUCH':
      e.stance = 'CROUCH';
      return RULES.time.stance;
    case 'PATROL':
      e.facing = d.facing ?? turn90(e);
      return RULES.ai.patrolTurnTime;
    case 'ADVANCE':
    case 'FLANK':
    case 'TAKE_COVER':
    case 'SEARCH_MOVE':
      return stepTo(state, e, d.to as Vec2) ?? RULES.time.wait;
    default:
      return RULES.time.wait;
  }
}

// ============================================================================
// 決策（§9.2 / §9.3）
// ============================================================================

/** ALERT 時要做什麼。回傳一個宣告，不執行。 */
function decideAlert(state: GameState, e: Unit): Declaration {
  const player = activePlayerUnit(state);
  if (!player) return { kind: 'HOLD' };

  if (!tactical()) {
    // v0.9 的行為：能打就打，不能打就貪婪逼近
    if (canAttackAny(state, e, player.pos).ok) {
      return { kind: 'FIRE', target: { ...player.pos } };
    }
    const path = findPath(state, e.pos, player.pos, {
      allowGoalOccupied: true, ignoreUnitIds: [e.id],
    });
    if (path && path.length > 0 && !occupiedBy(state, path[0], [e.id])) {
      return { kind: 'ADVANCE', to: { ...path[0] } };
    }
    return { kind: 'HOLD' };
  }

  // §3.4：沒子彈了就得衝上來，或者死在原地。
  // 射手型的權重是保持距離、找掩體 —— 一個只剩刀的射手若繼續躲在掩體後，
  // 會變成一個永遠不會結束的僵局，而且看起來很蠢。
  const w = weightsFor(e);
  // 有掩蔽又看得到目標 → 先蹲下就位（§9.3）。代價是視野縮成前方半平面，
  // 也就是敵人變強的同時也給了玩家新的突破口 —— 這是刻意保留的。
  //
  // 「對玩家有視線」必須以**蹲下之後**為準：緊鄰半身掩體蹲下會雙向阻擋（§7.2），
  // 蹲進去就等於把自己弄瞎，然後失去目標、轉入搜索、站起來、再蹲一次。
  // 玩家在同一個位置也不會蹲 —— 他會站著越過掩體開槍。
  if (w.crouchInCover && e.stance === 'STAND') {
    const here = scoreCandidate(state, e, e.pos, player.pos, w);
    const stillSees = hasLineOfSight(state.map, e.pos, 'CROUCH', player.pos, player.stance);
    if (here.raw.selfCover > 0 && here.raw.canShoot > 0 && stillSees) return { kind: 'CROUCH' };
  }

  // 打空了就裝填（§3.2）。**只在彈匣打空後才裝填，絕不提前** ——
  // 玩家因此可以數敵人開了幾槍、知道換彈的窗口什麼時候到、在那個空檔衝上去。
  if (shouldReload(e)) return { kind: 'RELOAD' };

  if (canAttack(state, e, player.pos, e.equipped).ok) {
    // 顯眼武器要先架起來（§4.4）：一次架設換一次射擊，中途被打斷就整個作廢。
    if (e.equipped && e.equipped.conspicuous && !e.setUp) return { kind: 'SETUP' };
    // 打得到就打 —— 除非換一格能打得更好（掩蔽更好、對方的掩蔽更差）。
    // 換過去必須**也還打得到**，所以敵人永遠不會為了躲而放棄射線（§9.2）。
    const better = betterFiringPosition(state, e, player.pos);
    if (better) {
      const stay = scoreCandidate(state, e, e.pos, player.pos, weightsFor(e));
      const reason = moveReason(better, stay, weightsFor(e));
      const d: Declaration = { kind: reason, to: { ...better.pos } };
      if (reason === 'FLANK') d.side = flankSide(player.pos, e.pos, better.pos);
      return d;
    }
    return { kind: 'FIRE', target: { ...player.pos } };
  }

  // 主手打不到但人就在旁邊 —— 用內建近戰（§1.4）。
  // 這是彈盡的敵人「衝上來」之後真的能做的那件事。
  if (canAttackAny(state, e, player.pos).ok) return { kind: 'FIRE', target: { ...player.pos } };

  const best = bestCandidate(state, e, player.pos);
  if (best.stay) return { kind: 'HOLD' };
  const stay = scoreCandidate(state, e, e.pos, player.pos, w);
  const reason = moveReason(best, stay, w);
  const d: Declaration = { kind: reason, to: { ...best.pos } };
  if (reason === 'FLANK') d.side = flankSide(player.pos, e.pos, best.pos);
  return d;
}

/** 搜索該收工了嗎：時間到、沒有線索、或已經站在最後已知位置上。 */
function searchExhausted(e: Unit): boolean {
  return e.searchTimer <= 0 || !e.lastKnownTarget || sameTile(e.pos, e.lastKnownTarget);
}

/** SEARCH 時要做什麼。 */
function decideSearch(state: GameState, e: Unit): Declaration {
  // 抵達最後已知位置之後先巡視幾次再放棄（§9.3）——
  // 引開一個敵人之後它會在那裡多待一陣子並環顧四周，噪音引誘才有價值。
  if (e.patrolLeft > 0) return { kind: 'PATROL', facing: turn90(e) };
  if (searchExhausted(e)) return { kind: 'HOLD' };
  const path = findPath(state, e.pos, e.lastKnownTarget as Vec2, {
    allowGoalOccupied: true, ignoreUnitIds: [e.id],
  });
  if (path && path.length > 0 && !occupiedBy(state, path[0], [e.id])) {
    return { kind: 'SEARCH_MOVE', to: { ...path[0] } };
  }
  return { kind: 'HOLD' };
}

/**
 * IDLE 時要做什麼：原地警戒與警戒巡視**交替**（§9.3）。
 *
 * 固定周期是刻意的：玩家可以觀察、計時、抓空檔切入。
 * **盲區從白拿變成需要時機的解謎** —— 這比隨機轉向有趣得多，
 * 也符合「隨機性放在局面、決策留給玩家」的原則。
 */
function decideIdle(e: Unit): Declaration {
  if (!tactical()) return { kind: 'HOLD' };
  return e.declared && e.declared.kind === 'PATROL'
    ? { kind: 'HOLD' }
    : { kind: 'PATROL', facing: turn90(e) };
}

function decide(state: GameState, e: Unit): Declaration {
  if (e.aiState === 'ALERT') return decideAlert(state, e);
  if (e.aiState === 'SEARCH') return decideSearch(state, e);
  return decideIdle(e);
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 排程器輪到這個敵人：執行一個動作，並回傳它花掉的時間。
 *
 * 流程（§9.4）：
 *  1. 需要換狀態就先換 —— 那本身就是這一次的動作
 *  2. 有已宣告的動作 → **照做，不重新評估**；做不到就原地等待並喊「目標不見了」
 *  3. 沒有宣告 → 當場決定並執行
 *  4. 最後決定下一個動作、記下來、喊出來
 *
 * 保證回傳 > 0，否則排程器會卡在同一個單位上。
 */
export function takeEnemyAction(state: GameState, enemyId: string, events?: EventSink): number {
  const e = findUnit(state, enemyId);
  if (!e || e.faction !== 'ENEMY') return RULES.time.wait;

  // 這一次行動一開始就先清掉「剛轉換完」；只有真的做了耗時的轉換才會再設回 true。
  e.transitioning = false;

  // 1. 需要換狀態的話，這一次的行動就是換狀態（可能花 0，那就接著做事）
  const want = desiredState(state, e);
  if (want) {
    const cost = applyTransition(state, e, want, events);
    if (cost > 0) {
      e.transitioning = true;    // 玩家的反應窗口：已經發現你，但這一下用掉了
      // 「發現你」的那一聲。轉換本身就是這一次的動作，下一個動作等下次再決定 ——
      // 世界在反應窗口裡會變，現在宣告的東西到時候多半已經不對了。
      e.declared = null;
      shout(state, e, { kind: 'SPOT' }, events);
      return cost;
    }
  }

  // 2/3. 執行已宣告的動作，或當場決定
  let acted: Declaration;
  let cost: number;
  const pending = e.declared;
  if (tactical() && pending) {
    if (stillValid(state, e, pending)) {
      acted = pending;
      cost = execute(state, e, pending, events);
    } else {
      // 宣告失效：這一整個行動就浪費掉了。這正是玩家打斷它的回報（§9.4）。
      //
      // §4.4：架好的砲也一起作廢。**斷掉射線之後那一砲整個不算** ——
      // 這就是「看到砲 → 聽到口令 → 看到他在架 → 你有一個完整的行動」的回報。
      acted = { kind: 'LOST' };
      cost = RULES.time.wait;
      if (e.setUp) pushLog(state, 'AI', e.name + ' 架好的' + (e.equipped ? e.equipped.name : '武器') + '白架了');
      e.setUp = false;
      pushLog(state, 'AI', e.name + ' 撲了個空');
      shout(state, e, acted, events);
    }
  } else {
    acted = decide(state, e);
    cost = execute(state, e, acted, events);
  }
  e.declared = null;

  // SEARCH 的收尾（§9.3）：抵達最後已知位置後**先巡視幾次**再轉回 IDLE。
  // 關掉開關時完全照 v0.9：一到就放棄，沒有收尾。
  if (e.aiState === 'SEARCH') {
    e.searchTimer -= cost;         // 搜索是時間量，不是回合數
    if (!tactical()) {
      if (searchExhausted(e)) { giveUp(state, e, events); return Math.max(1, cost); }
    } else if (acted.kind === 'PATROL') {
      e.patrolLeft -= 1;
      if (e.patrolLeft <= 0) { giveUp(state, e, events); return Math.max(1, cost); }
    } else if (searchExhausted(e) && e.patrolLeft === 0) {
      e.patrolLeft = RULES.ai.searchWrapUpTurns;   // 站定了，開始環顧四周
    }
  }

  // §3.3：彈盡是一個**真的戰術訊號**，不只是風味。第一次沒子彈時喊一聲。
  if (outOfAmmo(e) && !e.announcedDry) {
    e.announcedDry = true;
    pushLog(state, 'AI', e.name + ' 打光了彈藥，改用近戰');
    shout(state, e, { kind: 'NO_AMMO' }, events);
  }

  // 4. 決定並宣告下一個動作。宣告具有拘束力，所以它是規則狀態，進 GameState。
  if (tactical() && e.aiState !== 'IDLE') {
    const next = decide(state, e);
    e.declared = next;
    shout(state, e, next, events);
  } else if (tactical()) {
    e.declared = decide(state, e);   // IDLE 也排下一步，但不出聲（§9.5）
  }

  return Math.max(1, cost);
}

function giveUp(state: GameState, e: Unit, events?: EventSink): void {
  events?.push({
    kind: 'AI_STATE', unitId: e.id, pos: { x: e.pos.x, y: e.pos.y }, from: e.aiState, to: 'IDLE',
  });
  e.aiState = 'IDLE';
  e.lastKnownTarget = null;
  e.patrolLeft = 0;
  e.declared = null;
  pushLog(state, 'AI', e.name + ' 放棄搜索');
}

/** 排程器驅動用：讓這個敵人做一件事並付出時間代價。 */
export function stepEnemy(state: GameState, enemyId: string, events?: EventSink): void {
  const cost = takeEnemyAction(state, enemyId, events);
  spend(state, enemyId, Math.max(1, cost));
}
