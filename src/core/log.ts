/** 戰鬥紀錄。屬於 GameState 的一部分，因此必須是決定性且可序列化的。 */
import type { GameState, LogKind } from './state';
import { RULES } from './content';

export function pushLog(state: GameState, kind: LogKind, text: string): void {
  state.log.push({ at: state.clock, kind, text });
  const max = RULES.log.maxEntries;
  if (state.log.length > max) state.log.splice(0, state.log.length - max);
}
