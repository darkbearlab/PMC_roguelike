/**
 * 系列動作（§5.5 / §5.6）。
 *
 * 無法以單一動作表達的行為，拆成數個依序執行的步驟。
 * **效果只在整套走完時發生** —— 走到一半的單位是暴露的、可被打斷的。
 *
 * v0.12 起每個序列標註**被打斷之後會怎樣**：
 *
 *   RESUMABLE  進度保留，下次從中斷的步驟接續   機械性動作（重武器裝填）
 *   RESTART    進度歸零，已花費的時間不退還     生理性、精密性動作（治療）
 *
 * 判準是**已經完成的物理狀態改變會不會自己消失**：
 * 退殼退了就是退了，不會自己裝回去；包紮包到一半被打斷，那塊敷料就廢了。
 *
 * 可續行的進度存在**物件**上（`Weapon.reloadProgress`），不是存在單位上 ——
 * 所以收起武器、換另一把、之後再換回來，進度仍在。
 */
import type { GameState, Sequence, SequenceInterrupt, Unit } from './state';
import { ITEMS, RULES } from './content';

export interface SequenceStepDef {
  id: string;
  label: string;
  time: number;
}

export interface SequenceDef {
  label: string;
  steps: SequenceStepDef[];
  sequenceType: SequenceInterrupt;
  /** 完成時要套用的效果（消耗品用）。 */
  effects?: { kind: string; amount: number }[];
}

/**
 * 序列定義。兩個來源：
 *  - `rules.json → sequences`（武器裝填之類的內建動作）
 *  - `items.json → <消耗品>.use`（資料驅動的消耗品，§4）
 *
 * 消耗品直接用它的 defId 當序列 id，所以新增一個消耗品不需要改程式。
 */
export function sequenceDef(id: string): SequenceDef | null {
  const raw = (RULES.sequences as Record<string, unknown>)[id];
  if (raw && typeof raw === 'object') {
    const d = raw as SequenceDef;
    return { ...d, sequenceType: d.sequenceType ?? 'RESTART' };
  }
  const item = ITEMS[id];
  if (item && item.use) {
    return { ...item.use, sequenceType: item.use.sequenceType ?? 'RESTART' };
  }
  return null;
}

export function interruptOf(id: string): SequenceInterrupt {
  return sequenceDef(id)?.sequenceType ?? 'RESTART';
}

/** 目前這一步的定義；序列已走完或不存在時回傳 null。 */
export function currentStep(seq: Sequence): SequenceStepDef | null {
  const def = sequenceDef(seq.id);
  if (!def || seq.index >= def.steps.length) return null;
  return def.steps[seq.index];
}

/** 這一步要花多少時間。 */
export function stepTime(seq: Sequence): number {
  const step = currentStep(seq);
  return step ? step.time : 0;
}

/** 走完這一步之後，整套序列是不是就完成了。 */
export function isLastStep(seq: Sequence): boolean {
  const def = sequenceDef(seq.id);
  return !!def && seq.index >= def.steps.length - 1;
}

/** 整套要花多少時間（UI 顯示「還要多久」用）。 */
export function totalTime(id: string): number {
  const def = sequenceDef(id);
  return def ? def.steps.reduce((a, s) => a + s.time, 0) : 0;
}

/** 從目前這一步算起，還要花多少時間。 */
export function remainingTime(seq: Sequence): number {
  const def = sequenceDef(seq.id);
  if (!def) return 0;
  return def.steps.slice(seq.index).reduce((a, s) => a + s.time, 0);
}

/** 給 UI 的進度描述，例如「裝填 RR-4：開栓退殼（1/2）」。 */
export function describe(seq: Sequence): string {
  const def = sequenceDef(seq.id);
  const step = currentStep(seq);
  if (!def || !step) return '';
  return def.label + '：' + step.label + '（' + (seq.index + 1) + '/' + def.steps.length + '）';
}

/** 這個單位正在進行系列動作嗎。 */
export function inSequence(u: Unit | null): boolean {
  return !!u && u.pendingSequence !== null;
}

/**
 * 開始一套序列。
 *
 * 可續行的序列從**物件上記著的進度**接續 —— 這就是「退回掩體再裝完」
 * 之所以成立的地方：總時間沒變，改變的只是投入的時間不會白費。
 */
export function begin(u: Unit, id: string): void {
  const resume = interruptOf(id) === 'RESUMABLE' && u.equipped
    ? u.equipped.reloadProgress
    : 0;
  u.pendingSequence = { id, index: resume };
}

/**
 * 走完一步。可續行的把進度記回物件上。
 */
export function advanceStep(u: Unit, seq: Sequence): void {
  seq.index += 1;
  if (interruptOf(seq.id) === 'RESUMABLE' && u.equipped) {
    u.equipped.reloadProgress = seq.index;
  }
}

/**
 * 中止序列（§5.3）：已花費的時間不退還，效果不發生，中止本身不花時間。
 *
 * 可續行的**保留進度**（進度在物件上，這裡本來就碰不到它）；
 * 須重來的把進度清掉。單位死亡時序列一併作廢 ——
 * 那是由 processDeaths 移除單位自然達成的。
 */
export function abort(u: Unit): void {
  const seq = u.pendingSequence;
  if (seq && interruptOf(seq.id) === 'RESTART' && u.equipped) {
    u.equipped.reloadProgress = 0;
  }
  u.pendingSequence = null;
}

/** 序列完成時要做的事。 */
export function applyCompletion(state: GameState, u: Unit, id: string): void {
  void state;
  const def = sequenceDef(id);
  if (!def) return;

  // 武器裝填：補滿並清掉進度
  if (id === 'RR4_RELOAD' && u.equipped) {
    u.equipped.reloadProgress = 0;
    return;   // 實際補彈由 commands.ts 的 refillFromBackpack 負責（要扣背包彈藥）
  }

  // 消耗品的效果。資料驅動：新增效果種類才需要動這裡。
  for (const e of def.effects ?? []) {
    if (e.kind === 'HEAL') u.hp = Math.min(u.maxHp, u.hp + e.amount);
  }
}
