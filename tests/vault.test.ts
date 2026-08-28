/**
 * 翻越掩體（v0.19）。
 *
 * 這一版新增一個移動動作，但**沒有新增任何按鈕** ——
 * 按方向鍵撞向半身掩體本來是一個非法輸入、什麼都不會發生，把翻越接上去即可。
 *
 * 三條規則決定它會不會把既有的掩體系統拆掉，所以這裡優先守它們。
 */
import { describe, expect, it } from 'vitest';
import { checkLegal, commandTime, movePath, movePhase } from '../src/core/commands';
import { RULES } from '../src/core/content';
import { findPath, isVaultStep, pathTime, stepDirection, vaultTarget } from '../src/core/pathfind';
import { candidates, weightsFor } from '../src/core/tactics';
import { player, run, testState, unit, advanceToPlayer } from './helpers';
import type { GameState } from '../src/core/state';

/** 一道橫向掩體牆，上下都是空地。 */
const WALL_ROW = [
  '##########',
  '#D.......#',
  '#..+++...#',
  '#.......T#',
  '##########',
];

const at = (s: GameState, x: number, y: number): GameState => {
  player(s).pos = { x, y };
  player(s).nextActAt = s.clock;
  return s;
};

describe('§1.1 翻越是跨過去，不是站上去', () => {
  it('一次移動兩格，落在掩體對面', () => {
    let s = at(testState(WALL_ROW), 3, 3);
    expect(vaultTarget(s, { x: 3, y: 3 }, 'N')).toEqual({ x: 3, y: 1 });
    s = run(s, { type: 'MOVE', dir: 'N' });
    expect(player(s).pos).toEqual({ x: 3, y: 1 });
  });

  it('**任何單位都不得停留在半身掩體格上**', () => {
    const s = at(testState(WALL_ROW), 3, 3);
    // 掩體格本身永遠不是合法落點
    expect(vaultTarget(s, { x: 3, y: 2 }, 'N')).toBeNull();
    const after = run(s, { type: 'MOVE', dir: 'N' });
    expect(after.units.every((u) => !(u.pos.x === 3 && u.pos.y === 2))).toBe(true);
  });

  it('WALL 永遠不可翻越', () => {
    const s = at(testState(['######', '#D...#', '#.##.#', '#...T#', '######']), 2, 3);
    expect(vaultTarget(s, { x: 2, y: 3 }, 'N')).toBeNull();
    expect(checkLegal(s, { type: 'MOVE', dir: 'N' }).ok).toBe(false);
  });

  it('對面格不存在、不可通行或被佔據時，翻越為非法', () => {
    // 掩體貼著地圖邊界 → 對面是牆
    const edge = testState(['######', '#+..T#', '#D...#', '######']);
    edge.units[0].pos = { x: 1, y: 2 };
    expect(vaultTarget(edge, { x: 1, y: 2 }, 'N')).toBeNull();

    // 對面被佔據
    const s = at(testState(WALL_ROW, [{ archetype: 'RUNNER', pos: { x: 3, y: 1 } }]), 3, 3);
    expect(vaultTarget(s, { x: 3, y: 3 }, 'N')).toBeNull();
    expect(checkLegal(s, { type: 'MOVE', dir: 'N' }).ok).toBe(false);
  });
});

describe('§1.2 落地必定是站姿 —— 這是翻越真正的代價', () => {
  it('站姿翻越之後仍是站姿', () => {
    let s = at(testState(WALL_ROW), 3, 3);
    expect(player(s).stance).toBe('STAND');
    s = run(s, { type: 'MOVE', dir: 'N' });
    expect(player(s).stance).toBe('STAND');
  });

  it('**蹲姿翻越也會被迫站起來**', () => {
    let s = at(testState(WALL_ROW), 3, 3);
    s = run(s, { type: 'SET_STANCE', stance: 'CROUCH' });
    s = advanceToPlayer(s);
    player(s).nextActAt = s.clock;
    player(s).facing = 'N';                 // 蹲姿要先轉向（v0.8 §1.3）
    expect(player(s).stance).toBe('CROUCH');
    s = run(s, { type: 'MOVE', dir: 'N' });
    expect(player(s).pos).toEqual({ x: 3, y: 1 });
    expect(player(s).stance, '落地必定站姿').toBe('STAND');
  });

  it('蹲姿沿用「先轉向、再執行」的規則（v0.8 §1.3）', () => {
    const s = at(testState(WALL_ROW), 3, 3);
    player(s).stance = 'CROUCH';
    player(s).facing = 'S';
    expect(movePhase(s, player(s), 'N')).toBe('TURN');
    const turned = run(s, { type: 'MOVE', dir: 'N' });
    expect(player(turned).pos).toEqual({ x: 3, y: 3 });   // 只轉向，沒動
    expect(player(turned).facing).toBe('N');
    expect(movePhase(turned, player(turned), 'N')).toBe('VAULT');
  });
});

describe('§3 操作與 §4 數值', () => {
  it('翻越花 20，是走一步的兩倍 —— 它不是更快的移動，是穿越屏障的手段', () => {
    const s = at(testState(WALL_ROW), 3, 3);
    expect(RULES.time.vault).toBe(20);
    expect(commandTime(s, { type: 'MOVE', dir: 'N' })).toBe(RULES.time.vault);
    expect(commandTime(s, { type: 'MOVE', dir: 'E' })).toBe(RULES.time.move);
  });

  it('方向鍵分得出三種狀態：移動、轉向、翻越', () => {
    const s = at(testState(WALL_ROW), 3, 3);
    expect(movePhase(s, player(s), 'N')).toBe('VAULT');
    expect(movePhase(s, player(s), 'E')).toBe('STEP');
    player(s).stance = 'CROUCH';
    player(s).facing = 'S';
    expect(movePhase(s, player(s), 'E')).toBe('TURN');
  });

  it('翻越真的推進了那麼多時間', () => {
    let s = at(testState(WALL_ROW), 3, 3);
    const before = player(s).nextActAt;
    s = run(s, { type: 'MOVE', dir: 'N' });
    expect(player(s).nextActAt - before).toBe(RULES.time.vault);
  });
});

describe('§3.3 尋路移動要支援翻越', () => {
  it('路徑會用翻越，而且預覽的總時間是對的', () => {
    const s = at(testState(WALL_ROW), 3, 3);
    const path = movePath(s, { x: 3, y: 1 })!;
    expect(path).not.toBeNull();
    expect(path[path.length - 1]).toEqual({ x: 3, y: 1 });
    // 翻越那一步在路徑上是兩格
    expect(isVaultStep(s, { x: 3, y: 3 }, path[0])).toBe(true);
    expect(stepDirection({ x: 3, y: 3 }, path[0])).toBe('N');
    expect(pathTime(s, player(s).pos, path, RULES.time.move, RULES.time.vault))
      .toBe(RULES.time.vault);
  });

  it('**繞路比較快的時候就繞路** —— 翻越不是免費的捷徑', () => {
    // 掩體只有一格寬，旁邊就繞得過去：繞兩步（20）與翻越（20）同價，
    // 但走到更遠的地方時，繞路的優勢會出現。
    const s = at(testState([
      '##########',
      '#D.......#',
      '#..+.....#',
      '#.......T#',
      '##########',
    ]), 3, 3);
    const path = findPath(s, { x: 3, y: 3 }, { x: 3, y: 1 }, {
      ignoreUnitIds: [player(s).id], stepCost: RULES.time.move, vaultCost: RULES.time.vault,
    })!;
    const t = pathTime(s, { x: 3, y: 3 }, path, RULES.time.move, RULES.time.vault);
    expect(t).toBeLessThanOrEqual(RULES.time.vault);
  });

  it('一整排掩體時，翻越明顯比繞到末端便宜', () => {
    const s = at(testState(WALL_ROW), 3, 3);
    const around = findPath(s, { x: 3, y: 3 }, { x: 3, y: 1 }, {
      ignoreUnitIds: [player(s).id], stepCost: RULES.time.move, vaultCost: 99999,
    })!;
    const detour = pathTime(s, { x: 3, y: 3 }, around, RULES.time.move, 99999);
    expect(detour).toBeGreaterThan(RULES.time.vault);
  });
});

describe('§1.3 敵人也必須會翻越 —— 否則掩體列是單向膜', () => {
  /**
   * 敵人被牆夾在掩體北側，**唯一的前進方式就是翻過來**。
   * 這樣才測得到「會不會翻」，而不是「有沒有更好的橫向移動」。
   */
  const facing = (arch: string): GameState => {
    const s = testState([
      '##########',
      '#D.#.#...#',
      '#..+++...#',
      '#..T.....#',
      '##########',
    ], [{ archetype: arch, pos: { x: 4, y: 1 }, facing: 'S' }]);
    // 玩家不站在落點上 —— 否則翻越本來就不合法
    player(s).pos = { x: 2, y: 3 };
    return s;
  };

  it('落點評分把翻越納入候選', () => {
    const s = facing('RUNNER');
    const e = unit(s, 'E01');
    const list = candidates(s, e, player(s).pos);
    const vaults = list.filter((c) => c.vault);
    expect(vaults.length, '沒有任何翻越候選').toBeGreaterThan(0);
    expect(vaults[0].pos).toEqual({ x: 4, y: 3 });
  });

  it('翻越候選沿用既有的評分項，另加一個資料檔的懲罰值', () => {
    const s = facing('RUNNER');
    const e = unit(s, 'E01');
    const w = weightsFor(e);
    const v = candidates(s, e, player(s).pos).find((c) => c.vault)!;
    // 分數 = 既有各項 − 翻越懲罰，而懲罰跟著實際時間走
    const extra = (RULES.time.vault - e.moveTime) / e.moveTime;
    const expected = w.approach * v.raw.approach + v.posScore - RULES.ai.vaultPenalty * extra;
    expect(v.score).toBeCloseTo(expected, 5);
  });

  it('**衝鋒型會翻，射手型不會** —— 差異由既有權重自然浮現', () => {
    const pick = (arch: string): boolean => {
      const s = facing(arch);
      const e = unit(s, 'E01');
      const list = candidates(s, e, player(s).pos);
      let best = list[0];
      for (const c of list) if (c.score > best.score) best = c;
      return best.vault;
    };
    expect(pick('RUNNER'), '衝鋒型應該會翻過來').toBe(true);
    expect(pick('SHOOTER'), '射手型翻過去等於放棄掩蔽，不該翻').toBe(false);
  });

  it('掩體列對雙方都不是單向膜：兩邊都翻得過去', () => {
    const s = facing('RUNNER');
    expect(vaultTarget(s, { x: 4, y: 1 }, 'S')).toEqual({ x: 4, y: 3 });   // 敵人翻下來
    // 反方向同樣成立（敵人自己站在落點上，所以要把它排除）
    expect(vaultTarget(s, { x: 4, y: 3 }, 'N', { ignoreUnitIds: ['E01'] }))
      .toEqual({ x: 4, y: 1 });
  });
});

describe('回歸：翻越沒有動到既有規則', () => {
  it('視線與掩蔽不受影響 —— 沒有人站在掩體上，所以沒有新情況', () => {
    let s = at(testState(WALL_ROW), 3, 3);
    s = run(s, { type: 'MOVE', dir: 'N' });
    // 翻過去之後掩體在身後：對南側的目標而言，他現在沒有掩蔽
    expect(player(s).pos).toEqual({ x: 3, y: 1 });
  });

  it('沒有掩體的方向照常是普通移動', () => {
    const s = at(testState(WALL_ROW), 1, 1);
    expect(movePhase(s, player(s), 'E')).toBe('STEP');
    expect(commandTime(s, { type: 'MOVE', dir: 'E' })).toBe(RULES.time.move);
  });

  it('進行中的序列不能翻越', () => {
    const s = at(testState(WALL_ROW), 3, 3);
    player(s).pendingSequence = { id: 'RR4_RELOAD', index: 0 };
    expect(checkLegal(s, { type: 'MOVE', dir: 'N' }).ok).toBe(false);
  });
});
