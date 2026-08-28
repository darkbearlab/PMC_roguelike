/**
 * 空投點啟用與戰爭迷霧（插隊版）。
 *
 * **兩件事互相咬合**：有迷霧之後，空投點必須先被找到才能啟用；
 * 而空投點啟用之後，死亡懲罰的性質就換掉了 ——
 * 原本「退回最近的空投點」是**地圖作者**透過間距控制的空間懲罰，
 * 現在它變成**玩家可以預先投資的東西**。
 */
import { describe, expect, it } from 'vitest';
import {
  activatedDropOptions, applyCommand, checkLegal, commandTime, interactTarget,
  isDropActivated, movePath,
} from '../src/core/commands';
import { RULES, mapById } from '../src/core/content';
import { blankExplored, isExplored, markExplored } from '../src/core/fog';
import { createInitialState } from '../src/core/setup';
import { findPath } from '../src/core/pathfind';
import { player, run, testState } from './helpers';
import type { GameState, Vec2 } from '../src/core/state';

/** 一張真的地圖，而且**沒有**預先探索 —— 這一組要測的就是迷霧本身。 */
function fresh(seed = 1): GameState {
  return createInitialState(seed, mapById('mission_01')!);
}

const drops = (s: GameState): Vec2[] => {
  const out: Vec2[] = [];
  for (let y = 0; y < s.map.height; y++) {
    for (let x = 0; x < s.map.width; x++) {
      if (s.map.tiles[y * s.map.width + x] === 'DROP_POINT') out.push({ x, y });
    }
  }
  return out;
};

const ROOM = [
  '##############',
  '#D......D....#',
  '#............#',
  '#...........T#',
  '##############',
];

describe('§1 空投點啟用', () => {
  it('起始空投點預設已啟用，其餘未啟用', () => {
    const s = fresh();
    expect(isDropActivated(s, s.map.startDropPoint)).toBe(true);
    const others = drops(s).filter(
      (p) => !(p.x === s.map.startDropPoint.x && p.y === s.map.startDropPoint.y),
    );
    expect(others.length).toBeGreaterThan(0);
    for (const p of others) expect(isDropActivated(s, p), p.x + ',' + p.y).toBe(false);
  });

  it('站在該格或相鄰格可以啟用，花 20（比一般互動貴）', () => {
    const s = fresh();
    const target = drops(s).find((p) => !isDropActivated(s, p))!;
    player(s).pos = { x: target.x, y: target.y };
    player(s).nextActAt = s.clock;
    expect(interactTarget(s, player(s), target)).toBe('ACTIVATE_DROP');
    expect(commandTime(s, { type: 'INTERACT', pos: target })).toBe(RULES.time.activateDrop);
    expect(RULES.time.activateDrop).toBeGreaterThan(RULES.time.interact);
    const after = run(s, { type: 'INTERACT', pos: target });
    expect(isDropActivated(after, target)).toBe(true);
  });

  it('啟用之後就不再是可互動的目標', () => {
    let s = fresh();
    const target = drops(s).find((p) => !isDropActivated(s, p))!;
    player(s).pos = { x: target.x, y: target.y };
    player(s).nextActAt = s.clock;
    s = run(s, { type: 'INTERACT', pos: target });
    expect(interactTarget(s, player(s), target)).toBeNull();
  });

  it('啟用會發出噪音 —— 布設信標會引來注意', () => {
    const s = fresh();
    expect(RULES.fog.activateNoise).toBeGreaterThan(0);
    const target = drops(s).find((p) => !isDropActivated(s, p))!;
    player(s).pos = { x: target.x, y: target.y };
    player(s).nextActAt = s.clock;
    const { events } = applyCommand(s, { type: 'INTERACT', pos: target });
    expect(events.some((e) => e.kind === 'NOISE')).toBe(true);
  });

  it('起始空投點是撤離點，不會被當成「待啟用」', () => {
    const s = fresh();
    player(s).pos = { x: s.map.startDropPoint.x, y: s.map.startDropPoint.y };
    expect(interactTarget(s, player(s), s.map.startDropPoint)).toBe('EXTRACT');
  });
});

describe('§2 增援只能從已啟用的空投點降落', () => {
  it('一開始只有起始空投點可選', () => {
    const s = fresh();
    // 玩家一開場就站在起始空投點上，先讓開（佔據的那一格不算可用）
    player(s).pos = { x: s.map.startDropPoint.x + 1, y: s.map.startDropPoint.y };
    const opts = activatedDropOptions(s);
    expect(opts).toHaveLength(1);
    expect(opts[0]).toEqual(s.map.startDropPoint);
  });

  it('啟用之後選項變多 —— 這就是「事先買的保險」', () => {
    let s = fresh();
    const target = drops(s).find((p) => !isDropActivated(s, p))!;
    player(s).pos = { x: target.x, y: target.y };
    player(s).nextActAt = s.clock;
    s = run(s, { type: 'INTERACT', pos: target });
    // 兩個都要讓開才數得到兩個 —— 佔據的那一格不算可用
    player(s).pos = { x: s.map.startDropPoint.x + 1, y: s.map.startDropPoint.y };
    expect(activatedDropOptions(s).length).toBe(2);
  });

  it('被單位佔據的空投點不可選', () => {
    const s = fresh();
    player(s).pos = { x: s.map.startDropPoint.x, y: s.map.startDropPoint.y };
    expect(activatedDropOptions(s)).toHaveLength(0);
  });

  it('指定的降落點必須是已啟用的 —— 不是就退回預設', () => {
    let s = testState(ROOM);
    player(s).pos = { x: 6, y: 1 };
    player(s).hp = 3;
    s = run(s, { type: 'FIRE', target: player(s).pos });
    s = run(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0], at: { x: 8, y: 1 } });
    expect(player(s).pos).toEqual({ x: 1, y: 1 });
  });

  it('啟用過的就選得到', () => {
    let s = testState(ROOM);
    s.activatedDrops.push('8,1');
    player(s).pos = { x: 6, y: 1 };
    player(s).hp = 3;
    s = run(s, { type: 'FIRE', target: player(s).pos });
    s = run(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0], at: { x: 8, y: 1 } });
    expect(player(s).pos).toEqual({ x: 8, y: 1 });
  });
});

describe('§3 戰爭迷霧', () => {
  it('一開場只有落點周圍是已探索的', () => {
    const s = fresh();
    expect(isExplored(s, player(s).pos)).toBe(true);
    expect(isExplored(s, { x: s.map.width - 2, y: s.map.height - 2 })).toBe(false);
    const known = s.explored.split('').filter((c) => c === '1').length;
    expect(known).toBeGreaterThan(0);
    expect(known).toBeLessThan(s.map.width * s.map.height);
  });

  it('走過去就永久標記為已探索 —— 走開也不會忘記', () => {
    const s = fresh();
    const spot = { x: player(s).pos.x + 3, y: player(s).pos.y };
    player(s).pos = { x: spot.x, y: spot.y };
    markExplored(s, player(s));
    expect(isExplored(s, spot)).toBe(true);
    player(s).pos = { x: s.map.startDropPoint.x, y: s.map.startDropPoint.y };
    markExplored(s, player(s));
    expect(isExplored(s, spot), '已探索是永久的').toBe(true);
  });

  it('每一個動作之後都會補一次探索', () => {
    let s = fresh();
    const before = s.explored.split('').filter((c) => c === '1').length;
    s = run(s, { type: 'MOVE', dir: 'S' });
    expect(s.explored.split('').filter((c) => c === '1').length).toBeGreaterThanOrEqual(before);
  });

  it('已探索狀態可完整序列化，而且是決定性的', () => {
    const play = (): string => {
      let s = fresh(4242);
      for (const dir of ['S', 'S', 'E', 'E', 'S'] as const) {
        s = applyCommand(s, { type: 'MOVE', dir }).state;
      }
      return s.explored;
    };
    expect(play()).toBe(play());
    const s = fresh();
    expect(JSON.parse(JSON.stringify(s)).explored).toBe(s.explored);
    expect(typeof s.explored).toBe('string');
  });

  it('blankExplored 的長度等於格數', () => {
    const s = fresh();
    expect(blankExplored(s.map)).toHaveLength(s.map.width * s.map.height);
  });
});

describe('§4 迷霧與介面', () => {
  it('**尋路移動不能走進未探索區域**', () => {
    const s = fresh();
    const far = { x: s.map.width - 2, y: s.map.height - 2 };
    expect(isExplored(s, far)).toBe(false);
    expect(movePath(s, far)).toBeNull();
  });

  it('**方向鍵不受限制** —— 探索本來就是一步一步走出來的', () => {
    const s = fresh();
    const ahead = { x: player(s).pos.x, y: player(s).pos.y + 1 };
    if (!isExplored(s, ahead)) {
      expect(checkLegal(s, { type: 'MOVE', dir: 'S' }).ok).toBe(true);
    }
  });

  it('迷霧是玩家的限制，不是世界的限制 —— AI 與驗證器的尋路不受影響', () => {
    const s = fresh();
    const far = { x: s.map.width - 2, y: s.map.height - 2 };
    expect(findPath(s, player(s).pos, far, { ignoreUnitIds: [player(s).id] })).not.toBeNull();
  });
});
