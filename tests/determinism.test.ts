/**
 * §3.1 / §14 決定論驗收。
 */
import { describe, it, expect } from 'vitest';
import { isPlayerTurn } from '../src/core/scheduler';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from '../src/core/commands';

import { createInitialState } from '../src/core/setup';
import { applyCommand } from '../src/core/commands';
import type { GameState } from '../src/core/state';

/** applyCommand 現在回傳 { state, events }（§8.6）；這裡只取狀態。 */
function run(s: GameState, cmd: Command): GameState {
  return applyCommand(s, cmd).state;
}
import { createRng, nextFloat } from '../src/core/rng';
import { MISSION_01 } from '../src/core/content';

/** 一段夠長、會經過移動／姿勢／開火／裝填／敵人回合的指令序列。 */
const SCRIPT: Command[] = [
  { type: 'TOGGLE_STANCE' },
  { type: 'MOVE', dir: 'S' },
  { type: 'MOVE', dir: 'S' },
  { type: 'ADVANCE' },
  { type: 'MOVE', dir: 'SE' },
  { type: 'MOVE', dir: 'SE' },
  { type: 'MOVE', dir: 'S' },
  { type: 'MOVE', dir: 'S' },
  { type: 'MOVE', dir: 'S' },
  { type: 'MOVE', dir: 'S' },
  { type: 'MOVE', dir: 'SE' },
  { type: 'MOVE', dir: 'E' },
  { type: 'TOGGLE_STANCE' },
  { type: 'MOVE', dir: 'E' },
  { type: 'MOVE', dir: 'E' },
  { type: 'FIRE', target: { x: 11, y: 9 } },
  { type: 'FIRE', target: { x: 11, y: 9 } },
  { type: 'RELOAD' },
  { type: 'SWAP_WEAPON' },
  { type: 'WAIT' },
];

/** 送出指令；敵人回合時自動跑到底。 */
function play(seed: number): string {
  let s = createInitialState(seed);
  for (const cmd of SCRIPT) {
    let guard = 0;
    while (!isPlayerTurn(s) && !s.pendingReinforcement && guard++ < 2000) {
      s = run(s, { type: 'ADVANCE' });
    }
    if (s.pendingReinforcement && s.roster.length) {
      s = run(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] });
      continue;
    }
    if (s.result !== 'ONGOING') break;
    s = run(s, cmd);
  }
  let guard = 0;
  while (!isPlayerTurn(s) && !s.pendingReinforcement && guard++ < 2000) {
    s = run(s, { type: 'ADVANCE' });
  }
  return JSON.stringify(s);
}

describe('決定論', () => {
  it('相同種子 + 相同指令序列 → 相同最終狀態', () => {
    expect(play(12345)).toBe(play(12345));
  });

  it('狀態可完整序列化為 JSON，且還原後可繼續推進出相同結果', () => {
    let s = createInitialState(999);
    for (let i = 0; i < 8; i++) {
      const cmd = SCRIPT[i];
      while (!isPlayerTurn(s)) s = run(s, { type: 'ADVANCE' });
      s = run(s, cmd);
    }
    const snapshot = JSON.stringify(s);
    const restored = JSON.parse(snapshot);
    expect(JSON.stringify(restored)).toBe(snapshot);

    const contA = run(s, { type: 'FIRE', target: { x: 11, y: 9 } });
    const contB = run(restored, { type: 'FIRE', target: { x: 11, y: 9 } });
    expect(JSON.stringify(contB)).toBe(JSON.stringify(contA));
  });

  it('applyCommand 不會修改傳入的狀態', () => {
    const s = createInitialState(7);
    const before = JSON.stringify(s);
    run(s, { type: 'MOVE', dir: 'S' });
    run(s, { type: 'TOGGLE_STANCE' });
    expect(JSON.stringify(s)).toBe(before);
  });

  it('非法指令回傳同一個 state 物件', () => {
    const s = createInitialState(7);
    expect(run(s, { type: 'MOVE', dir: 'N' })).toBe(s); // 撞牆
    expect(run(s, { type: 'ADVANCE' })).toBe(s);     // 不是敵人回合
  });

  it('rngSeed 可從外部指定，不同種子產生不同亂數序列', () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 8 }, () => nextFloat(a));
    const seqB = Array.from({ length: 8 }, () => nextFloat(b));
    expect(seqA).not.toEqual(seqB);
    expect(a.count).toBe(8);
    const a2 = createRng(1);
    expect(Array.from({ length: 8 }, () => nextFloat(a2))).toEqual(seqA);
  });

  it('RNG 狀態隨 GameState 一起序列化還原', () => {
    let s = createInitialState(42);
    s = run(s, { type: 'FIRE', target: { x: 11, y: 9 } });
    const restored = JSON.parse(JSON.stringify(s));
    expect(nextFloat(restored.rng)).toBe(nextFloat(structuredClone(s).rng));
  });
});

describe('§3.1 架構硬性要求', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  /** 去掉註解，避免掃到說明文字裡的字樣。 */
  function code(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  it('src/ 全程沒有直接呼叫 Math.random()', () => {
    const needle = 'Math' + '.' + 'random';
    const offenders = walk('src').filter((f) => code(f).includes(needle));
    expect(offenders).toEqual([]);
  });

  it('core/ 沒有 import 任何 DOM / Canvas / 瀏覽器 API', () => {
    const banned = /\b(document|window|navigator|localStorage|requestAnimationFrame|HTMLElement|CanvasRenderingContext2D|fetch)\b/;
    const offenders = walk(join('src', 'core')).filter((f) => banned.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('地圖資料檔符合 §13.1 的設計要求', () => {
    const flat = MISSION_01.tiles.join('');
    expect((flat.match(/D/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((flat.match(/S/g) ?? []).length).toBe(2);
    expect((flat.match(/T/g) ?? []).length).toBe(1);
    expect(MISSION_01.enemies.length).toBeGreaterThanOrEqual(8);
    expect(MISSION_01.enemies.length).toBeLessThanOrEqual(10);
    const kinds = new Set(MISSION_01.enemies.map((e) => e.archetype));
    expect([...kinds].sort()).toEqual(['HULK', 'RUNNER', 'SHOOTER']);
  });
});
