import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { RULES } from '../src/core/content';
import { effectiveMoveTime } from '../src/core/inventory';
import { isPlayerTurn } from '../src/core/scheduler';
import { advanceOnce, advanceToPlayer, run, testState, player, unit, freezeCombat, thawCombat } from './helpers';

/** 推進到再次輪到玩家。v0.7 沒有「敵人回合」，這只是「讓非玩家單位一直行動」。 */
function runEnemyTurn(s0: ReturnType<typeof testState>) {
  return advanceToPlayer(s0);
}

const HALL = [
  '########################',
  '#D.....................#',
  '#......................#',
  '#.....................T#',
  '########################',
];

// 這一檔測的是 AI 行為，不是命中與傷害浮動：凍結浮動讓斷言寫得出確切數字。
beforeAll(() => freezeCombat());
afterAll(() => thawCombat());

describe('§9.1 AI 狀態機', () => {
  it('IDLE 的敵人在沒有視線與噪音時原地不動', () => {
    let s = testState(
      ['##########', '#D..#....#', '#...#....#', '#...#...T#', '##########'],
      [{ archetype: 'RUNNER', pos: { x: 7, y: 2 } }],
    );
    const before = { ...unit(s, 'E01').pos };
    s = run(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(unit(s, 'E01').aiState).toBe('IDLE');
    expect(unit(s, 'E01').pos).toEqual(before);
  });

  it('取得視線 → ALERT，並朝玩家移動', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 8, y: 1 } }]);
    s = run(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(unit(s, 'E01').aiState).toBe('ALERT');
    expect(unit(s, 'E01').pos.x).toBeLessThan(8);
  });

  it('衝鋒型 3 AP：一回合移動 3 格，比玩家快，風箏流不成立', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 10, y: 1 } }]);
    s = run(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(unit(s, 'E01').pos.x).toBeLessThan(10);
    // v0.7 改用時間表達；§3 起那個時間**由負重決定**，不是由原型指派 ——
    // 只有一把爪的複製人重量 0，落在極輕級（7），所以他追得上帶槍的玩家。
    expect(effectiveMoveTime(unit(s, 'E01')))
      .toBeLessThan(effectiveMoveTime(player(s)));
  });

  it('轉換那一次不攻擊，之後每次輪到它就打一下（§9.2 階段轉換耗時）', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 2, y: 1 } }]);
    player(s).maxHp = 300;
    player(s).hp = 300;

    // 第一次輪到它：從 IDLE 轉入 ALERT，這一下不做別的事
    s = run(s, { type: 'WAIT' });
    s = advanceOnce(s);
    expect(unit(s, 'E01').aiState).toBe('ALERT');
    expect(unit(s, 'E01').transitioning).toBe(true);
    expect(player(s).hp).toBe(300);

    // 下一次輪到它才開打
    s = advanceOnce(s);
    expect(unit(s, 'E01').transitioning).toBe(false);
    expect(player(s).hp).toBe(300 - 30);

    // 打完之後它推到 15，玩家在 10 —— 排程器把行動權交回玩家，
    // 這正是「嚴格交錯」的樣子，不再是「敵人一口氣打三下」
    expect(isPlayerTurn(s)).toBe(true);
  });

  it('已在 SEARCH 的敵人重新取得視線可以立刻開火 —— 堵住無限騷擾迴圈', () => {
    let s = testState(HALL, [{ archetype: 'RUNNER', pos: { x: 2, y: 1 } }]);
    player(s).maxHp = 300;
    player(s).hp = 300;
    // 直接把敵人擺成「搜索中」，模擬玩家剛退出視線又回來
    const e = unit(s, 'E01');
    e.aiState = 'SEARCH';
    e.searchTimer = RULES.ai.searchTime;
    e.lastKnownTarget = { ...player(s).pos };

    s = run(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(unit(s, 'E01').aiState).toBe('ALERT');
    expect(unit(s, 'E01').transitioning).toBe(false);   // 沒有反應窗口
    expect(player(s).hp).toBeLessThan(300);           // 當場就開打
  });

  it('裝甲型很慢：反應窗口過後，一次輪到它也只做得了一件事', () => {
    let s = testState(HALL, [{ archetype: 'HULK', pos: { x: 2, y: 1 } }]);
    player(s).maxHp = 300;
    player(s).hp = 300;
    s = run(s, { type: 'WAIT' });
    s = runEnemyTurn(s);          // 發現的那一回合
    s = run(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(player(s).hp).toBe(300 - 60);
  });

  it('射手型的節奏由它手上那把槍決定，不再是原型內嵌的數字', () => {
    let s = testState(HALL, [{ archetype: 'SHOOTER', pos: { x: 5, y: 1 } }]);
    player(s).maxHp = 300;
    player(s).hp = 300;
    // §1：射手型的攻擊改成一把真的槍（§2 起是從物品池抽的）。
    // 「每回合上限 1 次」這條 v0.6 的規則早在 v0.7 就被時間取代了 ——
    // 真正的性質是：**一次輪到只做得了一件事**，而那件事花多久由槍決定。
    const w = unit(s, 'E01').equipped!;
    s = run(s, { type: 'WAIT' });
    s = runEnemyTurn(s);                    // 發現的那一回合（反應窗口）
    const before = player(s).hp;
    const at = unit(s, 'E01').nextActAt;
    s = run(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    const shots = (before - player(s).hp) / w.damage;
    expect(Number.isInteger(shots), '傷害必定是這把槍的整數倍').toBe(true);
    expect(unit(s, 'E01').nextActAt - at, '花的時間 = 開火次數 × 這把槍的 fireTime')
      .toBe(shots * w.fireTime);
  });

  it('蹲在半身掩體後 → 敵人失去視線，轉入 SEARCH', () => {
    //  一整排半身掩體把上下兩半完全隔開（沒有繞路可走），
    //  這樣測到的就純粹是姿勢對視線的影響，不會被 AI 的走位干擾。
    //       01234567
    //  y=1  #D....T#   玩家 (2,1)
    //  y=2  #++++++#
    //  y=3  #......#   敵人 (2,3)
    let s = testState(
      ['########', '#D....T#', '#++++++#', '#......#', '########'],
      [{ archetype: 'RUNNER', pos: { x: 2, y: 3 } }],
    );
    player(s).pos = { x: 2, y: 1 };

    // 站著 → 越過半身掩體互相看得見
    s = run(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(unit(s, 'E01').aiState).toBe('ALERT');
    expect(unit(s, 'E01').pos).toEqual({ x: 2, y: 3 }); // 沒有路可以繞過來

    // 蹲下（免費）→ 掩體雙向阻擋
    s = run(s, { type: 'SET_STANCE', stance: 'CROUCH' });
    s = run(s, { type: 'WAIT' });
    s = runEnemyTurn(s);
    expect(unit(s, 'E01').aiState).toBe('SEARCH');

    // 再站起來 → 又被看見
    s = run(s, { type: 'SET_STANCE', stance: 'STAND' });
    s = run(s, { type: 'WAIT' });
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
      s = run(s, { type: 'WAIT' });
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
        { archetype: 'RUNNER', pos: { x: 7, y: 1 } }, // 牆的另一側，曼哈頓距離剛好 6
      ],
    );
    const before = { ...unit(s, 'E02').pos };
    s = run(s, { type: 'FIRE', target: { x: 3, y: 1 } });
    expect(unit(s, 'E02').aiState).toBe('SEARCH');
    expect(unit(s, 'E02').lastKnownTarget).toEqual({ x: 1, y: 1 });

    // 推進一段時間：E02 先付轉換時間，再繞過門往開火點走
    for (let i = 0; i < 40; i++) {
      s = isPlayerTurn(s) ? run(s, { type: 'WAIT' }) : advanceOnce(s);
    }
    const after = unit(s, 'E02').pos;
    expect(after).not.toEqual(before);
    // 距離開火點變近了
    const d = (p: { x: number; y: number }) => Math.abs(p.x - 1) + Math.abs(p.y - 1);
    expect(d(after)).toBeLessThan(d(before));
  });

  it('AI 是決定性的：相同狀態跑兩次結果完全一致', () => {
    const build = () =>
      testState(HALL, [
        { archetype: 'RUNNER', pos: { x: 10, y: 1 } },
        { archetype: 'SHOOTER', pos: { x: 14, y: 3 } },
        { archetype: 'HULK', pos: { x: 6, y: 2 } },
      ]);
    const playOnce = () => {
      let s = build();
      for (let t = 0; t < 6; t++) {
        s = run(s, { type: 'WAIT' });
        s = runEnemyTurn(s);
        if (s.result !== 'ONGOING' || s.pendingReinforcement) break;
      }
      return JSON.stringify(s);
    };
    expect(playOnce()).toBe(playOnce());
  });
});
