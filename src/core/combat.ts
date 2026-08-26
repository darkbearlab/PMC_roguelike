/**
 * 傷害解算（§8）。
 *
 * 重要：MVP 階段每一發都必中，但實作方式不是「省略擲骰」，
 * 而是把完整的擲骰管線做出來，只讓機率函式固定回傳 1.0。
 * 未命中路徑是真的活著的程式碼，不是空分支。
 */
import type { GameState, Unit, Vec2, Weapon } from './state';
import { findUnit, unitAt } from './state';
import { clamp, facingToward, manhattan } from './grid';
import { hasLineOfSight } from './los';
import { nextFloat } from './rng';
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

/** MVP：固定必中。 */
export const alwaysHitChance: ToHitFn = () => RULES.combat.hitCeil;

/** 預留公式。combat.alwaysHit = false 時啟用。 */
export const rolledHitChance: ToHitFn = (attacker, target, weapon) => {
  const dist = target ? manhattan(attacker.pos, target.pos) : 0;
  const falloff = Math.max(0, dist - weapon.optimalRange) * weapon.falloffPerTile;
  const raw = weapon.accuracy + attacker.aim - (target ? target.evasion : 0) - falloff;
  return clamp(raw, RULES.combat.hitFloor, RULES.combat.hitCeil);
};

function defaultPolicy(): ToHitFn {
  return RULES.combat.alwaysHit ? alwaysHitChance : rolledHitChance;
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
 * 實際傷害 = max(保底, 原始傷害 - 護甲)（§8.2）。
 * 保底值來自 data/rules.json 的 combat.minDamage，不寫死 ——
 * 生命值規模放大時保底也要跟著放大，否則等於實質取消保底。
 */
export function damageAfterArmor(raw: number, armor: number): number {
  return Math.max(RULES.combat.minDamage, raw - armor);
}

/**
 * 這一槍打在這個目標身上會造成多少傷害。
 *
 * 目前上下限相同（傷害不浮動）。回傳區間是為了讓 UI 現在就用區間格式排版，
 * 日後加入浮動傷害時只要改這個函式，版面不用動（§12.4）。
 */
export function damageRange(weapon: Weapon, targetArmor: number): { min: number; max: number } {
  const d = damageAfterArmor(weapon.damage, targetArmor);
  return { min: d, max: d };
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
  if (weapon.ammo <= 0) return no('彈藥耗盡');
  if (attacker.ap < weapon.fireCost) return no('AP 不足（需要 ' + weapon.fireCost + '）');
  if (attacker.shotsThisTurn >= attacker.attacksPerTurn) return no('本回合攻擊次數已達上限');
  if (manhattan(attacker.pos, targetPos) > weapon.range) return no('超出射程');

  const target = unitAt(state, targetPos);
  const targetStance = target ? target.stance : 'STAND';
  if (!hasLineOfSight(state.map, attacker.pos, attacker.stance, targetPos, targetStance)) {
    return no('沒有視線');
  }
  return OK;
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
    u.searchTimer = RULES.ai.searchTimer;
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

  // 無論 chance 是多少，都必須抽一個亂數。
  // 這讓 MVP 與日後啟用擲骰時的 RNG 序列長度一致，重播不會錯位（§8.1）。
  const roll = nextFloat(state.rng);
  const hit = roll < chance;

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
    weaponId: weapon.id,
    splash: weapon.splash,
  });

  if (hit) {
    const primary = unitAt(state, impactPos);
    if (primary) {
      const amount = damageAfterArmor(weapon.damage, primary.armor);
      damageByUnit.push({ unitId: primary.id, amount });
      blockedByUnit.set(primary.id, Math.max(0, weapon.damage - amount));
    }
    if (weapon.splash > 0) {
      // 濺射對半徑內其他單位造成 floor(damage / 2)，同樣扣減護甲、同樣保底 1。
      // 刻意不做友軍傷害豁免（§8.2）。
      const splashRaw = Math.floor(weapon.damage / 2);
      for (const u of state.units) {
        if (primary && u.id === primary.id) continue;
        if (manhattan(u.pos, impactPos) > weapon.splash) continue;
        const amount = damageAfterArmor(splashRaw, u.armor);
        damageByUnit.push({ unitId: u.id, amount });
        blockedByUnit.set(u.id, Math.max(0, splashRaw - amount));
      }
    }
  }

  // ---- 套用傷害 ----
  for (const d of damageByUnit) {
    const u = findUnit(state, d.unitId);
    if (!u) continue;
    u.hp -= d.amount;
    events?.push({
      kind: 'IMPACT',
      unitId: u.id,
      pos: { x: u.pos.x, y: u.pos.y },
      amount: d.amount,
      blocked: blockedByUnit.get(u.id) ?? 0,
      lethal: u.hp <= 0,
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
 * 執行一次完整的開火動作：扣 AP、扣彈藥、記次數、轉向、解算。
 * 呼叫前必須先過 canAttack()。命中與否都會扣 AP 與彈藥（§8.1）。
 */
export function performAttack(
  state: GameState,
  attackerId: string,
  targetPos: Vec2,
  events?: EventSink,
): AttackResult {
  const attacker = findUnit(state, attackerId);
  if (!attacker || !attacker.equipped) {
    throw new Error('performAttack: 攻擊者狀態無效 ' + attackerId);
  }
  const weapon = attacker.equipped;

  attacker.ap -= weapon.fireCost;
  weapon.ammo -= 1;
  attacker.shotsThisTurn += 1;
  const f = facingToward(attacker.pos, targetPos);
  if (f) attacker.facing = f;
  const result = resolveAttack(state, attackerId, targetPos, weapon, events);
  // 空倉提示排在彈道與傷害之後，順序才符合玩家看到的因果
  if (weapon.ammo <= 0 && weapon.magazine < 99) {
    events?.push({ kind: 'AMMO_OUT', unitId: attacker.id, pos: { x: attacker.pos.x, y: attacker.pos.y } });
  }
  return result;
}
