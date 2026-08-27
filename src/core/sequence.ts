/**
 * 系列動作（§5.5）。
 *
 * 無法以單一動作表達的行為，拆成數個依序執行的步驟。
 * **效果只在整套走完時發生** —— 走到一半的單位是暴露的、可被打斷的。
 * 系列動作是這套系統裡「承諾」的表現形式。
 *
 * 本版唯一的使用者是 RR-4 裝填（開栓退殼 10 + 裝入彈藥 10），
 * 總花費與原本的單一動作 20 相同，但中途多了一個可被觀察、可被中止的狀態。
 */
import type { GameState, Sequence, Unit } from './state';
import { RULES } from './content';

export interface SequenceStepDef {
  id: string;
  label: string;
  time: number;
}

export interface SequenceDef {
  label: string;
  steps: SequenceStepDef[];
}

export function sequenceDef(id: string): SequenceDef | null {
  const raw = (RULES.sequences as Record<string, unknown>)[id];
  return raw && typeof raw === 'object' ? (raw as SequenceDef) : null;
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

/** 開始一套序列。 */
export function begin(u: Unit, id: string): void {
  u.pendingSequence = { id, index: 0 };
}

/**
 * 中止序列（§5.3）：已花費的時間不退還，效果不發生，中止本身不花時間。
 * 單位死亡時序列一併作廢 —— 那是由 processDeaths 移除單位自然達成的。
 */
export function abort(u: Unit): void {
  u.pendingSequence = null;
}

/** 序列完成時要做的事。目前只有 RR-4 裝填。 */
export function applyCompletion(state: GameState, u: Unit, id: string): void {
  void state;
  if (id === 'RR4_RELOAD' && u.equipped) u.equipped.ammo = u.equipped.magazine;
}
