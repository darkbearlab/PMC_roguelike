/**
 * §2 戰場回饋層：規則層必須吐出足以「不開日誌就理解戰況」的事件。
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { applyCommand } from '../src/core/commands';
import { resetToHitPolicy, setToHitPolicy } from '../src/core/combat';
import type { CombatEvent } from '../src/core/events';
import { advanceToPlayer, freezeCombat, player, run, testState, testWeapon, thawCombat, unit } from './helpers';

afterEach(() => resetToHitPolicy());

// 這一檔測的是機制不是浮動：把傷害／護甲的 spread 歸零、命中改必中，
// 斷言才寫得出確切數字。浮動本身另有專門的測試。
beforeAll(() => freezeCombat());
afterAll(() => thawCombat());

const ROOM = [
  '################',
  '#D.............#',
  '#..............#',
  '#.............T#',
  '################',
];

const kinds = (es: CombatEvent[]): string[] => es.map((e) => e.kind);
const pick = <K extends CombatEvent['kind']>(es: CombatEvent[], k: K) =>
  es.filter((e) => e.kind === k) as Extract<CombatEvent, { kind: K }>[];

describe('§2.3 三種結果必須可區分', () => {
  it('有效命中：IMPACT 有傷害、blocked 為 0', () => {
    const s = testState(ROOM, [{ archetype: 'RUNNER', pos: { x: 4, y: 1 } }]);
    unit(s, 'E01').hp = 100;   // 墊高血量，這條測的是傷害與 blocked，不是擊殺
    const { events } = applyCommand(s, { type: 'FIRE', target: { x: 4, y: 1 } });
    const hit = pick(events, 'IMPACT')[0];
    expect(hit.amount).toBe(30);
    expect(hit.blocked).toBe(0);
    expect(hit.lethal).toBe(false);
    expect(pick(events, 'MISS')).toHaveLength(0);
  });

  it('命中但被擋下大半：IMPACT 的 blocked >= amount，畫面才分得出「打中了但沒用」', () => {
    const s = testState(ROOM, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
    const { events } = applyCommand(s, { type: 'FIRE', target: { x: 4, y: 1 } });
    const hit = pick(events, 'IMPACT')[0];
    expect(hit.amount).toBe(10);     // 保底
    expect(hit.blocked).toBe(20);    // 護甲吃掉的
    expect(hit.blocked).toBeGreaterThanOrEqual(hit.amount);  // 回饋層據此改用「無效」表現
  });

  it('重武器打同一個裝甲型就不是「被擋下大半」，玩家看得出換槍有效', () => {
    const s = testState(ROOM, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
    player(s).equipped = testWeapon('rr4');
    const { events } = applyCommand(s, { type: 'FIRE', target: { x: 4, y: 1 } });
    const hit = pick(events, 'IMPACT')[0];
    expect(hit.amount).toBe(100);
    expect(hit.blocked).toBe(20);
    expect(hit.blocked).toBeLessThan(hit.amount);
  });

  it('未命中：有 MISS 與 hit=false 的彈道，沒有任何 IMPACT', () => {
    setToHitPolicy(() => 0);
    const s = testState(ROOM, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
    const { events } = applyCommand(s, { type: 'FIRE', target: { x: 4, y: 1 } });
    expect(pick(events, 'IMPACT')).toHaveLength(0);
    expect(pick(events, 'MISS')).toHaveLength(1);
    expect(pick(events, 'SHOT')[0].hit).toBe(false);
    // 未命中照樣產生噪音（§8.1）
    expect(pick(events, 'NOISE')).toHaveLength(1);
  });
});

describe('§2.2 其餘事件都看得到', () => {
  it('開火有彈道、有噪音半徑', () => {
    const s = testState(ROOM, [{ archetype: 'RUNNER', pos: { x: 4, y: 1 } }]);
    const { events } = applyCommand(s, { type: 'FIRE', target: { x: 4, y: 1 } });
    const shot = pick(events, 'SHOT')[0];
    expect(shot.from).toEqual({ x: 1, y: 1 });
    expect(shot.to).toEqual({ x: 4, y: 1 });
    expect(pick(events, 'NOISE')[0].radius).toBe(6);
  });

  it('擊殺有獨立的 KILL 事件，且 IMPACT 標記為 lethal', () => {
    const s = testState(ROOM, [{ archetype: 'RUNNER', pos: { x: 4, y: 1 } }]);
    unit(s, 'E01').hp = 20;
    const { events } = applyCommand(s, { type: 'FIRE', target: { x: 4, y: 1 } });
    expect(pick(events, 'IMPACT')[0].lethal).toBe(true);
    expect(pick(events, 'KILL')[0]).toMatchObject({ unitId: 'E01', faction: 'ENEMY' });
  });

  it('彈匣打空有 AMMO_OUT，不只是 HUD 默默歸零', () => {
    let s = testState(ROOM, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
    player(s).equipped!.ammo = 1;
    const { events } = applyCommand(s, { type: 'FIRE', target: { x: 4, y: 1 } });
    expect(pick(events, 'AMMO_OUT')).toHaveLength(1);
    s = advanceToPlayer(run(s, { type: 'FIRE', target: { x: 4, y: 1 } }));
    expect(applyCommand(s, { type: 'RELOAD' }).events.map((e) => e.kind)).toContain('RELOAD');
  });

  it('敵人警戒狀態改變有 AI_STATE 事件，且區分得出「剛發現」', () => {
    const s = testState(
      ['####################', '#D.................#', '#..................#', '#.................T#', '####################'],
      [{ archetype: 'RUNNER', pos: { x: 5, y: 2 } }],
    );
    // 敵人回合的第一步就會偵測到玩家：IDLE -> ALERT
    const enemyTurn = applyCommand(run(s, { type: 'WAIT' }), { type: 'ADVANCE' });
    const st = pick(enemyTurn.events, 'AI_STATE');
    expect(st).toHaveLength(1);
    expect(st[0].from).toBe('IDLE');
    expect(st[0].to).toBe('ALERT');
    // 從 IDLE 轉入 → 這一回合不開火，回饋層據此給不同的表現
    expect(enemyTurn.state.units.find((u) => u.id === 'E01')!.transitioning).toBe(true);
  });

  it('完成目標與空投落地都有事件', () => {
    const s = testState(ROOM);
    player(s).pos = { x: 13, y: 3 };
    expect(kinds(applyCommand(s, { type: 'INTERACT', pos: { x: 14, y: 3 } }).events))
      .toContain('OBJECTIVE');

    let d = testState(ROOM);
    player(d).hp = 30;
    d = run(d, { type: 'FIRE', target: player(d).pos });
    expect(kinds(applyCommand(d, { type: 'DEPLOY_REINFORCEMENT', soldierId: d.roster[0] }).events))
      .toContain('DEPLOY');
  });
});

describe('§2.5 回饋層不得污染規則層', () => {
  it('GameState 裡沒有任何動畫時間軸或播放狀態', () => {
    const s = testState(ROOM);
    const json = JSON.stringify(s);
    for (const banned of ['effect', 'anim', 'tween', 'elapsed', 'born', 'ttl', 'timeline', 'playing']) {
      expect(json.toLowerCase(), banned).not.toContain('"' + banned);
    }
    expect(Object.keys(s).sort()).toEqual([
      'activePlayerUnitId', 'casualties', 'clock', 'deadSoldierIds', 'deployed',
      'deployment', 'extracted', 'extractedBy', 'log', 'loot', 'map',
      'nextEntitySerial', 'objectives', 'pendingReinforcement', 'result', 'rng',
      'rngSeed', 'roster', 'stats', 'units',
    ]);
  });

  it('事件是決定性的：相同種子與指令序列產生相同事件序列', () => {
    const play = (): string => {
      let s = testState(ROOM, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
      const all: CombatEvent[] = [];
      for (const cmd of [
        { type: 'FIRE' as const, target: { x: 4, y: 1 } },
        { type: 'FIRE' as const, target: { x: 4, y: 1 } },
        { type: 'ADVANCE' as const },
        { type: 'ADVANCE' as const },
      ]) {
        const r = applyCommand(s, cmd);
        s = r.state;
        all.push(...r.events);
      }
      return JSON.stringify(all);
    };
    expect(play()).toBe(play());
  });

  it('事件可完整序列化為 JSON', () => {
    const s = testState(ROOM, [{ archetype: 'HULK', pos: { x: 4, y: 1 } }]);
    const { events } = applyCommand(s, { type: 'FIRE', target: { x: 4, y: 1 } });
    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
  });
});
