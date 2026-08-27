/**
 * §9.2 落點評分與 §9.3 姿勢、巡視。
 *
 * 戰術層在 v0.10 之前只有玩家會用：掩蔽、側翼、姿勢、面向全是單向的。
 * 這一組驗的是敵人開始用同一套詞彙，而且三種原型用得不一樣。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bestCandidate, flankSide, scoreCandidate, weightsFor } from '../src/core/tactics';
import { takeEnemyAction } from '../src/core/ai';
import { ACTORS, RULES } from '../src/core/content';
import { advanceOnce, freezeCombat, player, testState, thawCombat, unit } from './helpers';

/** 玩家躲在牆角，敵人在開闊地 —— 用來看敵人會不會繞。 */
const CORNER = [
  '##################',
  '#................#',
  '#................#',
  '#....#...........#',
  '#....D...........#',
  '#................#',
  '#...............T#',
  '##################',
];

const at = (x: number, y: number) => ({ x, y });

beforeAll(() => freezeCombat());
afterAll(() => thawCombat());

describe('§9.2 權重依原型不同', () => {
  it('三種原型的權重不一樣 —— 否則會退化成同一種打法', () => {
    const runner = ACTORS.RUNNER.ai!;
    const shooter = ACTORS.SHOOTER.ai!;
    const hulk = ACTORS.HULK.ai!;
    // 衝鋒型：只管接近
    expect(runner.approach).toBeGreaterThan(runner.selfCover);
    expect(runner.selfCover).toBe(0);
    expect(runner.targetExposure).toBe(0);
    // 射手型：繞側翼壓倒接近
    expect(shooter.targetExposure).toBeGreaterThan(shooter.approach);
    expect(shooter.selfCover).toBeGreaterThan(shooter.approach);
    // 裝甲型：緩慢推進，不靠掩體
    expect(hulk.approach).toBeGreaterThan(hulk.selfCover);
    expect(hulk.approach).toBeLessThan(runner.approach);
  });

  it('只有射手型會蹲下', () => {
    expect(ACTORS.SHOOTER.ai!.crouchInCover).toBe(true);
    expect(ACTORS.RUNNER.ai!.crouchInCover).toBe(false);
    expect(ACTORS.HULK.ai!.crouchInCover).toBe(false);
  });
});

describe('§9.2 評分項目', () => {
  it('approach：走近為 +1、走遠為 −1、原地為 0', () => {
    const s = testState(CORNER, [{ archetype: 'RUNNER', pos: at(10, 4) }]);
    const e = unit(s, 'E01');
    const w = weightsFor(e);
    const p = player(s).pos;
    expect(scoreCandidate(s, e, at(9, 4), p, w).raw.approach).toBe(1);
    expect(scoreCandidate(s, e, at(11, 4), p, w).raw.approach).toBe(-1);
    // 曼哈頓距離下，任何一步正交移動都必然 ±1；只有原地才是 0
    expect(scoreCandidate(s, e, at(10, 3), p, w).raw.approach).toBe(-1);
    expect(scoreCandidate(s, e, at(10, 4), p, w).raw.approach).toBe(0);
  });

  it('targetExposure：玩家有掩蔽的方向分數低，繞掉之後分數高', () => {
    const s = testState(CORNER, [{ archetype: 'SHOOTER', pos: at(10, 4) }]);
    const e = unit(s, 'E01');
    const w = weightsFor(e);
    const p = player(s).pos;                    // (5,4)，北邊 (5,3) 是牆
    // 從正東打過去 → 玩家的北鄰不在射手那一側，沒有掩蔽
    const east = scoreCandidate(s, e, at(10, 4), p, w).raw.targetExposure;
    // 從東北打過去 → 玩家的北鄰 (5,3) 是牆，產生掩蔽
    const northEast = scoreCandidate(s, e, at(10, 2), p, w).raw.targetExposure;
    expect(east).toBeGreaterThan(northEast);
  });

  it('selfCover：貼著牆的落點分數比開闊地高', () => {
    const s = testState(CORNER, [{ archetype: 'SHOOTER', pos: at(6, 3) }]);
    const e = unit(s, 'E01');
    const w = weightsFor(e);
    const p = player(s).pos;
    const beside = scoreCandidate(s, e, at(6, 3), p, w).raw.selfCover;   // 西鄰 (5,3) 是牆
    const open = scoreCandidate(s, e, at(8, 5), p, w).raw.selfCover;
    expect(beside).toBeGreaterThan(open);
  });
});

describe('§9.2 決定性', () => {
  it('同一個局面永遠選同一格，重算一百次結果一致', () => {
    const s = testState(CORNER, [{ archetype: 'SHOOTER', pos: at(10, 4) }]);
    const e = unit(s, 'E01');
    const first = bestCandidate(s, e, player(s).pos).pos;
    for (let i = 0; i < 100; i++) {
      expect(bestCandidate(s, e, player(s).pos).pos).toEqual(first);
    }
  });

  it('候選只有四個正交鄰格加原地', () => {
    const s = testState(CORNER, [{ archetype: 'RUNNER', pos: at(10, 4) }]);
    const e = unit(s, 'E01');
    const best = bestCandidate(s, e, player(s).pos);
    expect(Math.abs(best.pos.x - e.pos.x) + Math.abs(best.pos.y - e.pos.y)).toBeLessThanOrEqual(1);
  });

  it('flankSide 以畫面為準，左右不會反過來', () => {
    const target = at(5, 5);
    expect(flankSide(target, at(10, 5), at(10, 4))).not.toBe(flankSide(target, at(10, 5), at(10, 6)));
  });
});

describe('§9.3 姿勢與巡視', () => {
  it('射手型在有掩蔽處會蹲下，衝鋒型不會', () => {
    for (const [arch, expected] of [['SHOOTER', 'CROUCH'], ['RUNNER', 'STAND']] as const) {
      let s = testState(CORNER, [{ archetype: arch, pos: at(6, 3) }]);   // 西鄰是牆
      const e = unit(s, 'E01');
      e.aiState = 'ALERT';
      e.lastKnownTarget = { ...player(s).pos };
      s.units[0].nextActAt = 9999;
      for (let i = 0; i < 3; i++) {
        s = advanceOnce(s);
        s.units[0].nextActAt = 9999;
        if (unit(s, 'E01').stance === 'CROUCH') break;
      }
      expect(unit(s, 'E01').stance, arch).toBe(expected);
    }
  });

  it('巡視花掉時間，不會讓排程器空轉', () => {
    let s = testState(CORNER, [{ archetype: 'SHOOTER', pos: at(14, 6), facing: 'E' }]);
    s.units[0].nextActAt = 99999;
    const before = unit(s, 'E01').nextActAt;
    s = advanceOnce(s);
    expect(unit(s, 'E01').nextActAt - before).toBe(RULES.ai.patrolTurnTime);
  });

  it('IDLE 敵人一千次行動不會無限迴圈，時間一直前進', () => {
    let s = testState(CORNER, [
      { archetype: 'SHOOTER', pos: at(14, 6), facing: 'E' },
      { archetype: 'HULK', pos: at(15, 2), facing: 'E' },
    ]);
    // 讓它們永遠找不到玩家，才測得到「純 IDLE 的巡視不會空轉」
    s.activePlayerUnitId = null;
    s.units[0].nextActAt = 1e9;
    let last = -1;
    for (let i = 0; i < 1000; i++) {
      s = advanceOnce(s);
      expect(s.clock).toBeGreaterThanOrEqual(last);
      last = s.clock;
    }
    expect(s.clock).toBeGreaterThan(1000);
  });

  it('SEARCH 抵達最後已知位置後會先巡視再放棄', () => {
    let s = testState(CORNER, [{ archetype: 'SHOOTER', pos: at(14, 6), facing: 'E' }]);
    const e = unit(s, 'E01');
    e.aiState = 'SEARCH';
    e.searchTimer = RULES.ai.searchTime;
    e.lastKnownTarget = at(14, 6);           // 已經站在上面
    s.units[0].nextActAt = 1e9;

    // 第一次行動是「站定」，接著才開始環顧四周
    s = advanceOnce(s);
    expect(unit(s, 'E01').aiState).toBe('SEARCH');
    expect(unit(s, 'E01').patrolLeft).toBe(RULES.ai.searchWrapUpTurns);

    const facings: string[] = [];
    for (let i = 0; i < RULES.ai.searchWrapUpTurns; i++) {
      s = advanceOnce(s);
      facings.push(s.units.find((u) => u.id === 'E01')!.facing);
    }
    expect(s.units.find((u) => u.id === 'E01')!.aiState).toBe('IDLE');
    expect(new Set(facings).size).toBe(facings.length);   // 每次都真的轉了
  });
});

describe('§9.1 總開關', () => {
  it('關掉之後行為回到 v0.9：貪婪逼近、不蹲、不巡視、不宣告', () => {
    const before = RULES.ai.tacticalBehaviour;
    try {
      RULES.ai.tacticalBehaviour = false;
      // 放遠一點，讓它打不到 → 這樣看得出是不是貪婪逼近
      let s = testState(CORNER, [{ archetype: 'SHOOTER', pos: at(15, 4) }]);
      const e = unit(s, 'E01');
      e.aiState = 'ALERT';
      e.lastKnownTarget = { ...player(s).pos };
      s.units[0].nextActAt = 9999;
      s = advanceOnce(s);
      const after = unit(s, 'E01');
      expect(after.declared).toBeNull();     // 不宣告
      expect(after.stance).toBe('STAND');    // 不蹲
      expect(after.pos).toEqual(at(14, 4));  // 貪婪逼近：直線走近一格
    } finally {
      RULES.ai.tacticalBehaviour = before;
    }
  });

  it('takeEnemyAction 永遠回傳大於 0 的花費', () => {
    const s = testState(CORNER, [{ archetype: 'HULK', pos: at(10, 4) }]);
    expect(takeEnemyAction(s, 'E01')).toBeGreaterThan(0);
  });
});

/**
 * 玩家固守掩體時，敵人會繞到掩蔽失效的方向（§9.2 的驗收重點）。
 *
 * 掩蔽只看目標**朝向射手那一側**的正交鄰格，所以射手換個角度就能消掉它 ——
 * 側翼是掩蔽的解法。v0.10 之前這條只有玩家會用。
 */
const FLANKABLE = [
  '############',
  '#..........#',
  '#..........#',
  '#..........#',
  '#....#.....#',
  '#....D.....#',
  '#..........#',
  '#.........T#',
  '############',
];

describe('§9.2 敵人會繞掉玩家的掩蔽', () => {
  it('玩家北邊有牆時，射手會從斜上方繞到同一列', () => {
    let s = testState(FLANKABLE, [{ archetype: 'SHOOTER', pos: at(9, 4) }]);
    const e = unit(s, 'E01');
    e.aiState = 'ALERT';
    e.facing = 'W';
    e.lastKnownTarget = { ...player(s).pos };
    s.units[0].nextActAt = 1e6;

    // 站在 (9,4) 時，玩家的北鄰 (5,4) 是牆 → 玩家有掩蔽
    const w = weightsFor(e);
    const before = scoreCandidate(s, e, at(9, 4), player(s).pos, w);
    expect(before.raw.targetExposure).toBeLessThan(1);
    expect(before.raw.canShoot).toBe(1);            // 而且它本來就打得到

    s = advanceOnce(s);
    const after = unit(s, 'E01');
    // 打得到卻還是移動了 —— 因為換到同一列之後玩家就沒有掩蔽了
    expect(after.pos).toEqual(at(9, 5));
    const now = scoreCandidate(s, after, after.pos, player(s).pos, weightsFor(after));
    expect(now.raw.targetExposure).toBe(1);
    expect(now.raw.canShoot).toBe(1);               // 繞完仍然打得到
  });

  it('敵人不會為了躲而放棄射線：換過去的落點一定也打得到', () => {
    let s = testState(FLANKABLE, [{ archetype: 'SHOOTER', pos: at(9, 4) }]);
    const e = unit(s, 'E01');
    e.aiState = 'ALERT';
    e.facing = 'W';
    e.lastKnownTarget = { ...player(s).pos };
    player(s).hp = 9999;                 // 讓玩家撐得住，才看得完整段移動
    player(s).maxHp = 9999;
    s.units[0].nextActAt = 1e6;
    for (let i = 0; i < 4; i++) {
      s = advanceOnce(s);
      s.units[0].nextActAt = 1e6;
      const now = unit(s, 'E01');
      if (!now) break;
      expect(scoreCandidate(s, now, now.pos, player(s).pos, weightsFor(now)).raw.canShoot).toBe(1);
    }
  });

  it('衝鋒型不繞：權重一面倒在 approach，走的是直線', () => {
    let s = testState(FLANKABLE, [{ archetype: 'RUNNER', pos: at(9, 4) }]);
    const e = unit(s, 'E01');
    e.aiState = 'ALERT';
    e.facing = 'W';
    e.lastKnownTarget = { ...player(s).pos };
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);
    expect(unit(s, 'E01').declared!.kind).toBe('ADVANCE');
  });
});
