/**
 * 傷害解算（§8）。
 *
 * 重要：MVP 階段每一發都必中，但實作方式不是「省略擲骰」，
 * 而是把完整的擲骰管線做出來，只讓機率函式固定回傳 1.0。
 * 未命中路徑是真的活著的程式碼，不是空分支。
 */
import type { FireMode, GameState, Unit, Vec2, Weapon } from './state';
import { findUnit, unitAt } from './state';
import { clamp, facingToward, manhattan } from './grid';
import { hasLineOfSight } from './los';
import { isBackstab } from './sight';
import { nextFloat } from './rng';
import { coverAgainst, type CoverLevel } from './cover';
import { shooterStanceBonus, targetStancePenalty } from './stance';
import { RULES } from './content';
import { pushLog } from './log';
import type { EventSink } from './events';

export interface AttackResult {
  hit: boolean;
  roll: number;          // 保留，供除錯與戰鬥紀錄顯示
  chance: number;        // 保留，同上
  impactPos: Vec2;       // 實際彈著點。MVP 階段永遠等於目標格
  damageByUnit: { unitId: string; amount: number }[];
}

export type ToHitFn = (
  attacker: Unit,
  target: Unit | null,
  weapon: Weapon,
  state: GameState,
) => number;

// ============================================================================
// 命中率函式（§8.1）
//
// 要啟用擲骰，把 data/rules.json 的 combat.alwaysHit 改成 false 就好。
// 這兩個實作以外的程式碼與 UI 一律不用動。
// ============================================================================

/**
 * 這把槍**實際會用**的射擊模式（§2.6）。
 *
 * 槍內子彈不足以支撐所選模式時自動降級（連發→點放→單發），
 * 不讓玩家在彈藥不足時無法開火，也不無聲降級 —— UI 顯示的一律是這個值。
 */
export function effectiveMode(w: Weapon): FireMode {
  if (w.intrinsic) return w.mode;                 // 內建武器彈藥無限（§1.2）
  const order = RULES.fireModes.order;
  const idx = order.indexOf(w.mode);
  for (let i = idx; i >= 0; i--) {
    const m = order[i];
    if (!w.modes.includes(m)) continue;
    if (RULES.fireModes[m].shots <= w.ammo) return m;
  }
  // 全部都撐不住的時候，退到這把槍**自己**最省彈的模式。
  // v0.15 起有些武器根本沒有單發（LMG-5 只有點放與連發），
  // 所以這裡不能寫死 SINGLE —— 那會顯示一個它沒有的模式。
  return cheapestMode(w);
}

/** 這把槍最省彈的可用模式。order 由左而右耗彈遞增，所以取第一個命中的。 */
export function cheapestMode(w: Weapon): FireMode {
  for (const m of RULES.fireModes.order) if (w.modes.includes(m)) return m;
  return w.mode;
}

/** 這次開火會打幾發（§2.1）。 */
export function shotsFor(w: Weapon): number {
  return RULES.fireModes[effectiveMode(w)].shots;
}

/** 模式的命中修正：單發 +0.10、點放 0、連發 −0.10（§2.1）。 */
export function modeAccuracy(w: Weapon): number {
  return RULES.fireModes[effectiveMode(w)].accuracy;
}

/** 對照用：一律必中。把 data/rules.json 的 combat.enableToHitRoll 設為 false 即啟用。 */
export const alwaysHitChance: ToHitFn = () => RULES.combat.hitCeil;

/**
 * 命中率（§8.1）。
 *
 *   命中率 = clamp(
 *       武器基礎命中 + 射手 aim + 射手姿勢加成
 *     − 目標 evasion − 目標姿勢減免 − 掩蔽減免 − 射程衰減
 *   , 下限, 1.0)
 *
 * 掩蔽是獨立於視線的鄰格掃描（core/cover.ts），不走射線。
 */
export const rolledHitChance: ToHitFn = (attacker, target, weapon, state) => {
  const dist = target ? manhattan(attacker.pos, target.pos) : 0;
  const falloff = Math.max(0, dist - weapon.optimalRange) * weapon.falloffPerTile;
  const back = isBackstab(state.map, attacker, target);
  const cover = back && RULES.combat.backstab.ignoreCover
    ? 0
    : target ? coverAgainst(state.map, target.pos, attacker.pos).penalty : 0;
  const raw = weapon.accuracy
    + attacker.aim
    + shooterStanceBonus(attacker)
    + modeAccuracy(weapon)
    + (back ? RULES.combat.backstab.bonus : 0)
    - (target ? target.evasion : 0)
    - targetStancePenalty(target)
    - cover
    - falloff;
  return clamp(raw, RULES.combat.hitFloor, RULES.combat.hitCeil);
};

/** 命中率的組成明細，供 UI 說明「為什麼這麼低」。 */
export interface HitBreakdown {
  chance: number;
  base: number;
  shooterCrouch: number;
  targetCrouch: number;
  cover: number;
  coverLevel: CoverLevel;
  coverTiles: Vec2[];
  falloff: number;
  /** 背刺成立（§8.8）：目標對我沒有視線。此時 cover 已經被歸零。 */
  backstab: boolean;
  backstabBonus: number;
  /** 實際會用的射擊模式（可能是自動降級後的，§2.6）。 */
  mode: FireMode;
  /** 這次開火打幾發、耗幾發子彈。 */
  shots: number;
  /** 模式的命中修正。 */
  modeBonus: number;
  /** 玩家選的模式與實際模式不同 = 因彈藥不足降級了。 */
  downgraded: boolean;
}

export function hitBreakdown(
  attacker: Unit, target: Unit, weapon: Weapon, state: GameState,
): HitBreakdown {
  const info = coverAgainst(state.map, target.pos, attacker.pos);
  const dist = manhattan(attacker.pos, target.pos);
  const back = isBackstab(state.map, attacker, target);
  const ignored = back && RULES.combat.backstab.ignoreCover;
  return {
    chance: toHitChance(attacker, target, weapon, state),
    base: weapon.accuracy,
    shooterCrouch: shooterStanceBonus(attacker),
    targetCrouch: targetStancePenalty(target),
    cover: ignored ? 0 : info.penalty,
    // 掩蔽格照樣回報：玩家要看得出「本來有掩蔽，是背刺讓它失效」
    coverLevel: info.level,
    coverTiles: info.tiles,
    falloff: Math.max(0, dist - weapon.optimalRange) * weapon.falloffPerTile,
    backstab: back,
    backstabBonus: back ? RULES.combat.backstab.bonus : 0,
    mode: effectiveMode(weapon),
    shots: shotsFor(weapon),
    modeBonus: modeAccuracy(weapon),
    downgraded: effectiveMode(weapon) !== weapon.mode,
  };
}

function defaultPolicy(): ToHitFn {
  return RULES.combat.enableToHitRoll ? rolledHitChance : alwaysHitChance;
}

let activePolicy: ToHitFn = defaultPolicy();

/** 測試用注入點（§15 驗收：把命中率強制為 0，驗證未命中路徑完整可用）。 */
export function setToHitPolicy(fn: ToHitFn): void {
  activePolicy = fn;
}

export function resetToHitPolicy(): void {
  activePolicy = defaultPolicy();
}

export function toHitChance(
  attacker: Unit,
  target: Unit | null,
  weapon: Weapon,
  state: GameState,
): number {
  return activePolicy(attacker, target, weapon, state);
}

// ============================================================================
// 傷害
// ============================================================================

/**
 * 實際傷害 = max(保底, 傷害擲值 - max(0, 護甲擲值 - 穿甲))（§8.2）。
 * 保底值來自 data/rules.json 的 combat.minDamage，不寫死 ——
 * 生命值規模放大時保底也要跟著放大，否則等於實質取消保底。
 */
export function damageAfterArmor(raw: number, armor: number, penetration = 0): number {
  return Math.max(RULES.combat.minDamage, raw - Math.max(0, armor - penetration));
}

/** base ± spread 的均勻整數。spread 為 0 時結果固定，但**仍然消耗一個亂數**。 */
export function rollSpread(state: GameState, base: number, spread: number): number {
  const f = nextFloat(state.rng);
  if (spread <= 0) return base;
  return base - spread + Math.floor(f * (2 * spread + 1));
}

/** 傷害區間（UI 用）。已把護甲與穿甲算進去。 */
export function damageRange(weapon: Weapon, target: Unit | null): { min: number; max: number } {
  const armor = target ? target.armor : 0;
  const aSpread = target ? target.armorSpread : 0;
  const lo = damageAfterArmor(weapon.damage - weapon.damageSpread, armor + aSpread, weapon.penetration);
  const hi = damageAfterArmor(weapon.damage + weapon.damageSpread, armor - aSpread, weapon.penetration);
  return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
}

/** 護甲區間（UI 用）。 */
export function armorRange(target: Unit | null): { min: number; max: number } {
  if (!target) return { min: 0, max: 0 };
  return { min: target.armor - target.armorSpread, max: target.armor + target.armorSpread };
}

// ============================================================================
// 合法性檢查（先於解算，§8.1）
// ============================================================================

export interface Legality {
  ok: boolean;
  reason: string;
}

const OK: Legality = { ok: true, reason: '' };
const no = (reason: string): Legality => ({ ok: false, reason });

export function canAttack(
  state: GameState,
  attacker: Unit,
  targetPos: Vec2,
  weapon: Weapon | null,
): Legality {
  if (!weapon) return no('沒有裝備武器');
  // 已退殼、未裝填的槍打不出東西（§5.6）。ammo 也會是 0，但講清楚比較好懂。
  if (weapon.reloadProgress > 0) return no('槍膛開著，還沒裝填完');
  if (weapon.ammo <= 0) return no('彈藥耗盡');
  if (manhattan(attacker.pos, targetPos) > weapon.range) return no('超出射程');

  const target = unitAt(state, targetPos);
  const targetStance = target ? target.stance : 'STAND';
  if (!hasLineOfSight(state.map, attacker.pos, attacker.stance, targetPos, targetStance)) {
    return no('沒有視線');
  }
  return OK;
}

/**
 * 這一下攻擊實際會用哪一把（§1.4）。
 *
 * **主手優先；主手打不出去而目標就在旁邊時，自動改用內建近戰。**
 * 沒有切換動作、沒有新按鈕、不花時間 —— 它長在身上，本來就在手邊。
 *
 * 這條規則的存在理由很單純：彈藥現在是有限資源，
 * 打光的單位若完全無法攻擊，那不是資源壓力，是把他關掉。
 */
export function attackWeapon(state: GameState, u: Unit, targetPos: Vec2): Weapon | null {
  if (u.equipped && canAttack(state, u, targetPos, u.equipped).ok) return u.equipped;
  if (u.intrinsic && canAttack(state, u, targetPos, u.intrinsic).ok) return u.intrinsic;
  return null;
}

/** 這一下會不會用到內建近戰（介面要說清楚，§1.4）。 */
export function usesIntrinsic(state: GameState, u: Unit, targetPos: Vec2): boolean {
  return attackWeapon(state, u, targetPos) === u.intrinsic;
}

/** 攻擊的合法性：主手不行就看內建近戰行不行。 */
export function canAttackAny(state: GameState, u: Unit, targetPos: Vec2): Legality {
  if (attackWeapon(state, u, targetPos)) return OK;
  // 理由取主手的 —— 玩家問的是「為什麼那把槍打不到」，不是「為什麼刀捅不到」
  return u.equipped ? canAttack(state, u, targetPos, u.equipped) : no('沒有裝備武器');
}

/**
 * 這個敵人**打光了**嗎（§3.4）。
 *
 * 判準是「他有一把槍，而那把槍已經榨乾了」——
 * **不是**「他沒有槍」。衝鋒型與裝甲型從來就沒有槍，
 * 他們不是彈盡，他們本來就是那樣打的：把他們也算進來會誤改他們的落點權重。
 */
export function outOfAmmo(e: Unit): boolean {
  const w = e.equipped;
  if (!w || w.intrinsic) return false;
  return w.ammo <= 0 && e.reserveAmmo <= 0 && w.reloadProgress === 0;
}

// ============================================================================
// 武器識別（§4.2）
// ============================================================================

/** 認出這把武器。已識別的狀態在這一場裡保留。 */
export function identify(state: GameState, w: Weapon | null): void {
  if (!w || w.intrinsic) return;
  if (state.identifiedWeapons.includes(w.instanceId)) return;
  state.identifiedWeapons.push(w.instanceId);
}

/**
 * 玩家看得出這把武器是什麼嗎（§4.2）。三個層級：
 *
 *  - **未識別**：只看到敵人，看不出武器
 *  - **已識別**：該敵人開過火，或雙方距離 ≤ 門檻
 *  - **恆常可見**：`conspicuous` 的武器藏不住，從任何距離都看得到
 */
export function isIdentified(state: GameState, w: Weapon | null): boolean {
  if (!w) return false;
  if (w.conspicuous) return true;
  return state.identifiedWeapons.includes(w.instanceId);
}

/**
 * 走近就認得出來（§4.2）。玩家單位行動之後掃一次，與迷霧同一個時機。
 *
 * 只認**敵人**手上的 —— 自己那把本來就知道是什麼。
 */
export function markIdentified(state: GameState, u: Unit): void {
  if (u.faction !== 'PLAYER') return;
  const reach = RULES.ai.identifyRange;
  for (const e of state.units) {
    if (e.faction !== 'ENEMY') continue;
    if (manhattan(u.pos, e.pos) > reach) continue;
    identify(state, e.equipped);
  }
}

// ============================================================================
// 噪音（§8.3）
// ============================================================================

/**
 * 開火噪音。半徑內處於 IDLE 的敵人轉為 SEARCH 並把開火位置記為 lastKnownTarget。
 * 噪音刻意不受牆壁阻擋。
 */
export function emitNoise(state: GameState, origin: Vec2, radius: number, events?: EventSink): void {
  if (radius <= 0) return;
  events?.push({ kind: 'NOISE', pos: { x: origin.x, y: origin.y }, radius });
  for (const u of state.units) {
    if (u.faction !== 'ENEMY') continue;
    if (u.aiState !== 'IDLE') continue;
    if (manhattan(u.pos, origin) > radius) continue;
    events?.push({
      kind: 'AI_STATE', unitId: u.id, pos: { x: u.pos.x, y: u.pos.y }, from: u.aiState, to: 'SEARCH',
    });
    u.aiState = 'SEARCH';
    u.lastKnownTarget = { x: origin.x, y: origin.y };
    u.searchTimer = RULES.ai.searchTime;
    // IDLE → SEARCH 也是一次狀態轉換，一樣要付該原型的轉換時間（§9.2）。
    // 表現形式是把它的下次行動時刻往後推 —— 聽到聲音到真的開始找，中間有反應遲滯。
    u.nextActAt = Math.max(u.nextActAt, state.clock) + u.transitionTime;
    u.transitioning = true;
    pushLog(state, 'NOISE', u.name + ' 聽見槍聲，前往 (' + origin.x + ',' + origin.y + ') 搜索');
  }
}

// ============================================================================
// 解算（§8.1 的順序必須照這樣）
// ============================================================================

/**
 * 解算一次攻擊：抽亂數 → 判定命中 → 套用傷害 → 產生噪音 → 寫紀錄。
 * 不處理 AP、彈藥、死亡；那些由呼叫端（performAttack / processDeaths）負責。
 */
/**
 * 服役紀錄的原料（v0.16 §4.4）。擊殺與承受傷害都記在**士兵 id** 上，
 * 任務結束後併進 `ServiceRecord`。
 *
 * **這是純數值士兵唯一的人格來源** —— 玩家的感情不是對角色設定產生的，
 * 是對「這傢伙活下來了」產生的。
 */
function recordHit(
  state: GameState, attacker: Unit, victim: Unit, amount: number, lethal: boolean,
): void {
  const bump = (id: string, k: 'kills' | 'damageTaken', n: number): void => {
    const cur = state.stats[id] ?? { kills: 0, damageTaken: 0 };
    cur[k] += n;
    state.stats[id] = cur;
  };
  if (victim.faction === 'PLAYER') bump(victim.id, 'damageTaken', amount);
  // 友軍傷害（濺射打到自己）不算擊殺
  if (lethal && attacker.faction === 'PLAYER' && victim.faction === 'ENEMY') {
    bump(attacker.id, 'kills', 1);
  }
}

export function resolveAttack(
  state: GameState,
  attackerId: string,
  targetPos: Vec2,
  weapon: Weapon,
  events?: EventSink,
): AttackResult {
  const attacker = findUnit(state, attackerId);
  if (!attacker) throw new Error('resolveAttack: 找不到攻擊者 ' + attackerId);

  const target = unitAt(state, targetPos);
  const chance = toHitChance(attacker, target, weapon, state);

  // ------------------------------------------------------------------
  // 亂數順序紀律（§8.5）：一次攻擊固定抽三個值，順序永遠是
  //   1. 命中  2. 傷害  3. 主目標護甲
  // 而且**無論該項是否生效一律照抽** —— 即使擲骰關閉、即使護甲為 0、
  // 即使這一發沒中。亂數序列的長度必須與設定無關，否則切換開關或調數值
  // 會讓所有以種子重現的紀錄與測試失效。
  // ------------------------------------------------------------------
  const roll = nextFloat(state.rng);
  const hit = roll < chance;
  const damageRoll = rollSpread(state, weapon.damage, weapon.damageSpread);
  const primaryArmorRoll = target
    ? rollSpread(state, target.armor, target.armorSpread)
    : rollSpread(state, 0, 0);

  // impactPos 與目標格分離，是為了日後的「未命中偏移」與濺射失準落點。
  // MVP 階段永遠等於目標格。
  const impactPos: Vec2 = { x: targetPos.x, y: targetPos.y };

  const damageByUnit: { unitId: string; amount: number }[] = [];
  /** 每個受害者被護甲吃掉多少，供回饋層區分「打中但沒用」與「沒打中」。 */
  const blockedByUnit = new Map<string, number>();

  events?.push({
    kind: 'SHOT',
    from: { x: attacker.pos.x, y: attacker.pos.y },
    to: { x: targetPos.x, y: targetPos.y },
    hit,
    weaponId: weapon.typeId,
    splash: weapon.splash,
  });

  if (hit) {
    const primary = unitAt(state, impactPos);
    if (primary) {
      const amount = damageAfterArmor(damageRoll, primaryArmorRoll, weapon.penetration);
      damageByUnit.push({ unitId: primary.id, amount });
      blockedByUnit.set(primary.id, Math.max(0, damageRoll - amount));
    }
    if (weapon.splash > 0) {
      // 濺射對半徑內其他單位造成 floor(傷害擲值 / 2)，同樣扣減護甲、同樣保底。
      // 刻意不做友軍傷害豁免（§8.2）。
      // 每個濺射受害者各自再擲一次護甲（§8.2「每一發都擲」），
      // 依 state.units 的順序，所以仍然完全決定性。
      const splashRaw = Math.floor(damageRoll / 2);
      for (const u of state.units) {
        if (primary && u.id === primary.id) continue;
        if (manhattan(u.pos, impactPos) > weapon.splash) continue;
        const armorRoll = rollSpread(state, u.armor, u.armorSpread);
        const amount = damageAfterArmor(splashRaw, armorRoll, weapon.penetration);
        damageByUnit.push({ unitId: u.id, amount });
        blockedByUnit.set(u.id, Math.max(0, splashRaw - amount));
      }
    }
  }

  // ---- 套用傷害 ----
  for (const d of damageByUnit) {
    const u = findUnit(state, d.unitId);
    if (!u) continue;
    // 連發的第二、三發可能打在已經倒下的目標上（判定照抽，§8）。
    // 那些發不再算「擊殺」，否則畫面上會連跳三次「擊殺」。
    const wasAlive = u.hp > 0;
    u.hp -= d.amount;
    recordHit(state, attacker, u, d.amount, wasAlive && u.hp <= 0);
    events?.push({
      kind: 'IMPACT',
      unitId: u.id,
      pos: { x: u.pos.x, y: u.pos.y },
      amount: d.amount,
      blocked: blockedByUnit.get(u.id) ?? 0,
      lethal: wasAlive && u.hp <= 0,
    });
  }
  if (!hit) {
    events?.push({
      kind: 'MISS',
      pos: { x: targetPos.x, y: targetPos.y },
      impactPos: { x: impactPos.x, y: impactPos.y },
    });
  }

  // ---- 紀錄（未命中也必須看得到）----
  const targetLabel = target ? target.name : '(' + targetPos.x + ',' + targetPos.y + ')';
  if (hit) {
    pushLog(state, 'HIT', attacker.name + ' 以 ' + weapon.name + ' 命中 ' + targetLabel);
    for (const d of damageByUnit) {
      const u = findUnit(state, d.unitId);
      pushLog(state, 'DAMAGE', '　' + (u ? u.name : d.unitId) + ' 受到 ' + d.amount + ' 點傷害');
    }
  } else {
    pushLog(state, 'MISS', attacker.name + ' 以 ' + weapon.name + ' 射擊 ' + targetLabel + ' — 未命中');
  }

  // ---- 噪音：命中與否都照樣產生（§8.1 未命中路徑）----
  emitNoise(state, attacker.pos, weapon.noiseRadius, events);

  return { hit, roll, chance, impactPos, damageByUnit };
}

/**
 * 執行一次完整的開火動作：扣彈藥、轉向、依模式解算 1～3 發。
 * 呼叫前必須先過 canAttack()。命中與否都會扣時間與彈藥（§8.1）。
 *
 * **連發不是「一次判定但命中率較高」**（§2.2），而是 N 次各自獨立的完整判定：
 * 各自擲命中、各自擲傷害、各自擲護甲。這讓連發同時具備傷害上限（全中即三倍）
 * 與高變異，「我需要它現在就死」因而成為一個真正的選項。
 *
 * 亂數順序紀律（§8）：**即使前一發已擊殺目標，剩餘的判定仍照抽**（結果自然落空），
 * 亂數序列的長度才與模式選擇無關。
 *
 * 回傳最後一發的解算結果；整體命中與否看 `hits`。
 */
export function performAttack(
  state: GameState,
  attackerId: string,
  targetPos: Vec2,
  events?: EventSink,
): BurstResult {
  const attacker = findUnit(state, attackerId);
  const weapon = attacker ? attackWeapon(state, attacker, targetPos) : null;
  if (!attacker || !weapon) {
    throw new Error('performAttack: 攻擊者狀態無效 ' + attackerId);
  }
  const mode = effectiveMode(weapon);
  const shots = RULES.fireModes[mode].shots;

  // 開火就會被認出來拿的是什麼（§4.2）—— 開槍是最誠實的自我介紹。
  identify(state, weapon);
  // 顯眼武器打完就要重新架設（§4.4）：一次架設換一次射擊，不能架一次連打。
  attacker.setUp = false;

  // 時間成本由排程器統一處理（commands.ts / ai.ts），這裡只管彈藥與朝向
  // 內建武器彈藥無限（§1.2）—— 它長在身上，沒有彈匣可以打空。
  if (!weapon.intrinsic) weapon.ammo -= shots;
  const f = facingToward(attacker.pos, targetPos);
  if (f) attacker.facing = f;

  const results: AttackResult[] = [];
  for (let i = 0; i < shots; i++) {
    results.push(resolveAttack(state, attackerId, targetPos, weapon, events));
  }

  // 空倉提示排在彈道與傷害之後，順序才符合玩家看到的因果
  if (weapon.ammo <= 0 && !weapon.intrinsic) {
    events?.push({ kind: 'AMMO_OUT', unitId: attacker.id, pos: { x: attacker.pos.x, y: attacker.pos.y } });
  }
  return {
    mode,
    shots,
    results,
    hits: results.filter((r) => r.hit).length,
    totalDamage: results.reduce(
      (a, r) => a + r.damageByUnit.reduce((b, d) => b + d.amount, 0), 0,
    ),
  };
}

/** 一次開火動作的完整結果（可能含多發，§2.2）。 */
export interface BurstResult {
  mode: FireMode;
  shots: number;
  results: AttackResult[];
  hits: number;
  totalDamage: number;
}
