import { describe, it, expect } from 'vitest';
import { applyCommand } from '../src/core/commands';
import { testState, player, unit } from './helpers';

function runEnemyTurn(s0: ReturnType<typeof testState>) {
  let s = s0;
  let guard = 0;
  while (s.phase === 'ENEMY' && !s.pendingReinforcement && guard++ < 500) {
    s = applyCommand(s, { type: 'ENEMY_STEP' });
  }
  return s;
}

const HALL = [
  '########################',
  '#D.....................#',
  '#......................#',
  '#.....................T#',
  '########################',
];

describe('§9.1 AI 狀態機', () => {
  it('IDLE 的敵人在沒有視線與噪音時原地不動', () => {
    let s = testState(
      ['##########', '#D..#....#', '#...#....#', '#...#...T#', '##########'],
      [{ archetype: 'RUNNER', pos: { x: 7, y: 2 } }],
    );
    const before = { ...unit(s, 'E01').pos };
    s = applyCommand(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(unit(s, 'E01').aiState).toBe('IDLE');
    expect(unit(s, 'E01').pos).toEqual(before);
  });

  it('取得視線 → ALERT，並朝玩家移動', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 8, y: 1 } }]);
    s = applyCommand(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(unit(s, 'E01').aiState).toBe('ALERT');
    expect(unit(s, 'E01').pos.x).toBeLessThan(8);
  });

  it('衝鋒型 3 AP：一回合移動 3 格，比玩家快，風箏流不成立', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 10, y: 1 } }]);
    s = applyCommand(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(unit(s, 'E01').pos.x).toBe(7); // 10 → 7
    // 玩家一回合最多退 2 格，敵人一回合逼近 3 格 → 距離必定縮短
    expect(unit(s, 'E01').maxAp).toBeGreaterThan(player(s).maxAp);
  });

  it('相鄰時攻擊；衝鋒型 3 AP 可以連打 3 下', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 2, y: 1 } }]);
    const hp0 = player(s).hp;
    s = applyCommand(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(player(s).hp).toBe(hp0 - 9); // 3 傷害 × 3 次
  });

  it('裝甲型 1 AP：一回合只能做一件事', () => {
    let s = testState(HALL, [{ archetype: 'HULK', pos: { x: 2, y: 1 } }]);
    const hp0 = player(s).hp;
    s = applyCommand(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(player(s).hp).toBe(hp0 - 6);
  });

  it('射手型每回合上限 1 次攻擊', () => {
    let s = testState(HALL, [{ archetype: 'SHOOTER', pos: { x: 5, y: 1 } }]);
    const hp0 = player(s).hp;
    s = applyCommand(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(player(s).hp).toBe(hp0 - 2);
    expect(unit(s, 'E01').shotsThisTurn).toBe(1);
  });

  it('蹲在半身掩體後 → 敵人失去視線，轉入 SEARCH', () => {
    //  一整排半身掩體把上下兩半完全隔開（沒有繞路可走），
    //  這樣測到的就純粹是姿勢對視線的影響，不會被 AI 的走位干擾。
    //       01234567
    //  y=1  #D.....#   玩家 (2,1)
    //  y=2  #++++++#
    //  y=3  #......#   敵人 (2,3)
    let s = testState(
      ['########', '#D....T#', '#++++++#', '#......#', '########'],
      [{ archetype: 'RUNNER', pos: { x: 2, y: 3 } }],
    );
    player(s).pos = { x: 2, y: 1 };

    // 站著 → 越過半身掩體互相看得見
    s = applyCommand(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(unit(s, 'E01').aiState).toBe('ALERT');
    expect(unit(s, 'E01').pos).toEqual({ x: 2, y: 3 }); // 沒有路可以繞過來

    // 蹲下（免費）→ 掩體雙向阻擋
    s = applyCommand(s, { type: 'SET_STANCE', stance: 'CROUCH' });
    s = applyCommand(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(unit(s, 'E01').aiState).toBe('SEARCH');

    // 再站起來 → 又被看見
    s = applyCommand(s, { type: 'SET_STANCE', stance: 'STAND' });
    s = applyCommand(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(unit(s, 'E01').aiState).toBe('ALERT');
  });

  it('SEARCH 計時歸零後回到 IDLE', () => {
    let s = testState(
      ['##########', '#D..#....#', '#...#....#', '#...#...T#', '##########'],
      [{ archetype: 'RUNNER', pos: { x: 8, y: 3 } }],
    );
    const e = unit(s, 'E01');
    e.aiState = 'SEARCH';
    e.searchTimer = 1;
    e.lastKnownTarget = { x: 8, y: 1 };
    for (let i = 0; i < 6; i++) {
      s = applyCommand(s, { type: 'WAIT' });
      s = runEnemyTurn(s);
    }
    expect(unit(s, 'E01').aiState).toBe('IDLE');
    expect(unit(s, 'E01').lastKnownTarget).toBeNull();
  });

  it('噪音讓 IDLE 敵人轉為 SEARCH 並真的朝開火點移動', () => {
    //  玩家在 (1,1) 開槍；RUNNER 在牆的另一側看不到玩家，但噪音不受牆阻擋
    let s = testState(
      [
        '################',
        '#D....#........#',
        '#..............#',  // x=6 這一列是門
        '#.....#.......T#',
        '################',
      ],
      [
        { archetype: 'HULK', pos: { x: 3, y: 1 } },   // 射擊目標
        { archetype: 'RUNNER', pos: { x: 7, y: 3 } }, // 牆後、噪音半徑 6 內（距離 6）
      ],
    );
    const before = { ...unit(s, 'E02').pos };
    s = applyCommand(s, { type: 'FIRE', target: { x: 3, y: 1 } });
    expect(unit(s, 'E02').aiState).toBe('SEARCH');
    expect(unit(s, 'E02').lastKnownTarget).toEqual({ x: 1, y: 1 });

    s = applyCommand(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    const after = unit(s, 'E02').pos;
    expect(after).not.toEqual(before);
    // 距離開火點變近了
    const d = (p: { x: number; y: number }) => Math.max(Math.abs(p.x - 1), Math.abs(p.y - 1));
    expect(d(after)).toBeLessThan(d(before));
  });

  it('AI 是決定性的：相同狀態跑兩次結果完全一致', () => {
    const build = () =>
      testState(HALL, [
        { archetype: 'RUNNER', pos: { x: 10, y: 1 } },
        { archetype: 'SHOOTER', pos: { x: 14, y: 3 } },
        { archetype: 'HULK', pos: { x: 6, y: 2 } },
      ]);
    const run = () => {
      let s = build();
      for (let t = 0; t < 6; t++) {
        s = applyCommand(s, { type: 'WAIT' });
        s = runEnemyTurn(s);
        if (s.phase === 'MISSION_END' || s.pendingReinforcement) break;
      }
      return JSON.stringify(s);
    };
    expect(run()).toBe(run());
  });
});
