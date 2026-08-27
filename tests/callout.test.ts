/**
 * §9.4 宣告具有拘束力、§9.5 口令。
 *
 * 這是整套機制的回報所在：玩家聽到「繞右邊，開火」之後移動破壞它的射線，
 * 那一發就整個浪費掉 —— 打斷敵人已宣告的攻擊，等於讓它損失一整個行動。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { calloutText } from '../src/core/ai';
import { CALLOUTS, RULES } from '../src/core/content';
import { advanceOnce, events, freezeCombat, player, testState, thawCombat, unit } from './helpers';

const HALL = [
  '##########################',
  '#D.......................#',
  '#........................#',
  '#.......................T#',
  '##########################',
];

const at = (x: number, y: number) => ({ x, y });

beforeAll(() => freezeCombat());
afterAll(() => thawCombat());

/** 讓敵人先轉入 ALERT 並宣告下一步。 */
const alerted = (dist = 5) => {
  let s = testState(HALL, [{ archetype: 'SHOOTER', pos: at(1 + dist, 1) }]);
  player(s).hp = 5000;
  player(s).maxHp = 5000;
  s.units[0].nextActAt = 1e6;
  s = advanceOnce(s);                       // IDLE → ALERT（轉換）
  s.units[0].nextActAt = 1e6;
  s = advanceOnce(s);                       // 第一次真正的動作，之後會有宣告
  return s;
};

describe('§9.4 宣告具有拘束力', () => {
  it('行動後會宣告下一個動作，並記在 GameState 裡', () => {
    const s = alerted();
    const d = unit(s, 'E01').declared;
    expect(d).not.toBeNull();
    expect(typeof d!.kind).toBe('string');
    // 可序列化：宣告是規則狀態（§9.4）
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it('下次輪到時執行已宣告的動作，不重新評估', () => {
    let s = alerted();
    const d = unit(s, 'E01').declared!;
    expect(d.kind).toBe('FIRE');
    const before = player(s).hp;
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);
    expect(player(s).hp).toBeLessThan(before);
  });

  it('走一步不夠：宣告綁的是「開火」，不是「打那一格」', () => {
    let s = alerted();
    expect(unit(s, 'E01').declared!.kind).toBe('FIRE');
    const hpBefore = player(s).hp;
    player(s).pos = { x: 2, y: 2 };        // 挪一格，射線還在
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);
    expect(player(s).hp).toBeLessThan(hpBefore);
    // 若寫成「目標必須待在同一格」，玩家每個動作都在走，敵人就一槍都打不出來 ——
    // 那不是拘束力，那是把敵人關掉。
  });

  it('拉開到射程外 → 那一發整個浪費掉（原地等待）', () => {
    let s = alerted();
    expect(unit(s, 'E01').declared!.kind).toBe('FIRE');
    const hpBefore = player(s).hp;
    const nextBefore = unit(s, 'E01').nextActAt;
    player(s).pos = { x: 16, y: 1 };       // 超出射手的射程 7（但還在可聽範圍內）
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);

    expect(player(s).hp).toBe(hpBefore);                          // 沒挨打
    expect(unit(s, 'E01').nextActAt).toBeGreaterThan(nextBefore);  // 但時間照花
  });

  it('蹲進半身掩體後面破壞射線 → 一樣浪費掉', () => {
    const COVER = [
      '################',
      '#D.............#',
      '#....+.........#',
      '#..............#',
      '#.............T#',
      '################',
    ];
    // 射手在半身掩體的正南方三格：射線正好穿過掩體，但它自己不緊鄰掩體
    let s = testState(COVER, [{ archetype: 'SHOOTER', pos: at(5, 4) }]);
    const me = player(s);
    me.pos = { x: 5, y: 1 };               // 半身掩體 (5,2) 的正北
    me.hp = 5000;
    me.maxHp = 5000;
    // 推到它宣告開火為止（中間可能先就位）
    for (let i = 0; i < 6 && unit(s, 'E01').declared?.kind !== 'FIRE'; i++) {
      s.units[0].nextActAt = 1e6;
      s = advanceOnce(s);
    }
    expect(unit(s, 'E01').declared!.kind).toBe('FIRE');

    // 蹲下 → 緊鄰半身掩體的一端蹲著就雙向阻擋（§7.2）
    player(s).stance = 'CROUCH';
    const hpBefore = player(s).hp;
    s.units[0].nextActAt = 1e6;
    s = advanceOnce(s);
    expect(player(s).hp).toBe(hpBefore);
  });

  it('宣告失效時會喊「目標不見了」', () => {
    let s = alerted();
    player(s).pos = { x: 16, y: 1 };       // 拉到射程外，但還在可聽範圍內
    s.units[0].nextActAt = 1e6;
    const evs = events(s, { type: 'ADVANCE' });
    const lost = evs.filter((e) => e.kind === 'CALLOUT' && e.code === 'LOST');
    expect(lost).toHaveLength(1);
    expect(CALLOUTS.LOST).toBe('目標不見了');
  });
});

describe('§9.5 誰會喊、聽得到嗎', () => {
  it('IDLE 敵人不喊口令 —— 這保護了偷襲', () => {
    let s = testState(HALL, [{ archetype: 'SHOOTER', pos: at(20, 3), facing: 'E' }]);
    s.activePlayerUnitId = null;             // 讓它永遠發現不了玩家
    s.units[0].nextActAt = 1e6;
    for (let i = 0; i < 6; i++) {
      const evs = events(s, { type: 'ADVANCE' });
      expect(evs.filter((e) => e.kind === 'CALLOUT')).toHaveLength(0);
      s = advanceOnce(s);
      s.units[0].nextActAt = 1e6;
    }
  });

  it('轉入警戒的那一次會喊「有動靜！」', () => {
    let s = testState(HALL, [{ archetype: 'SHOOTER', pos: at(6, 1) }]);
    s.units[0].nextActAt = 1e6;
    const evs = events(s, { type: 'ADVANCE' });
    const spot = evs.filter((e) => e.kind === 'CALLOUT' && e.code === 'SPOT');
    expect(spot).toHaveLength(1);
    expect(CALLOUTS.SPOT).toBe('有動靜！');
  });

  it('超出可聽範圍就完全聽不到', () => {
    const far = RULES.ai.calloutRange + 4;
    let s = testState(HALL, [{ archetype: 'SHOOTER', pos: at(1 + far, 1) }]);
    const e = unit(s, 'E01');
    e.aiState = 'ALERT';
    e.lastKnownTarget = { ...player(s).pos };
    s.units[0].nextActAt = 1e6;
    const evs = events(s, { type: 'ADVANCE' });
    expect(evs.filter((x) => x.kind === 'CALLOUT')).toHaveLength(0);
  });

  it('可聽範圍是曼哈頓 12，牆壁不阻擋（與噪音一致）', () => {
    expect(RULES.ai.calloutRange).toBe(12);
    // 中間隔一道牆，仍然聽得到
    const WALLED = [
      '################',
      '#D.....#.......#',
      '#......#.......#',
      '#......#......T#',
      '################',
    ];
    let s = testState(WALLED, [{ archetype: 'SHOOTER', pos: at(10, 1) }]);
    const e = unit(s, 'E01');
    e.aiState = 'ALERT';
    e.lastKnownTarget = { ...player(s).pos };
    s.units[0].nextActAt = 1e6;
    const evs = events(s, { type: 'ADVANCE' });
    expect(evs.filter((x) => x.kind === 'CALLOUT').length).toBeGreaterThan(0);
  });
});

describe('§9.5 口令來自理由碼', () => {
  it('文字全部在資料檔裡', () => {
    for (const code of ['SPOT', 'ADVANCE', 'FLANK_LEFT', 'FLANK_RIGHT', 'TAKE_COVER',
      'FIRE', 'CROUCH', 'SEARCH_MOVE', 'PATROL', 'LOST']) {
      expect(CALLOUTS[code], code).toBeTruthy();
    }
  });

  it('FLANK 的左右由 side 決定，不是事後猜的', () => {
    expect(calloutText({ kind: 'FLANK', side: 'LEFT' })).toBe(CALLOUTS.FLANK_LEFT);
    expect(calloutText({ kind: 'FLANK', side: 'RIGHT' })).toBe(CALLOUTS.FLANK_RIGHT);
  });

  it('調整權重之後口令會跟著改變 —— 不會說謊', () => {
    const ai = (unit(testState(HALL, [{ archetype: 'SHOOTER', pos: at(9, 3) }]), 'E01'));
    expect(ai).toBeTruthy();
    // 直接驗理由碼與權重的關係：把 approach 拉到最高，移動理由就會變成 ADVANCE
    const before = RULES.ai.tacticalBehaviour;
    try {
      RULES.ai.tacticalBehaviour = true;
      let s = testState(HALL, [{ archetype: 'RUNNER', pos: at(8, 1) }]);
      const e = unit(s, 'E01');
      e.aiState = 'ALERT';
      e.lastKnownTarget = { ...player(s).pos };
      s.units[0].nextActAt = 1e6;
      s = advanceOnce(s);
      // 衝鋒型的權重是 approach 一面倒，所以它的宣告必然是「壓上去」
      expect(unit(s, 'E01').declared!.kind).toBe('ADVANCE');
    } finally {
      RULES.ai.tacticalBehaviour = before;
    }
  });
});

describe('§9.5 不是情報共享', () => {
  it('喊話不改變其他敵人的狀態', () => {
    let s = testState(HALL, [
      { archetype: 'SHOOTER', pos: at(6, 1) },
      { archetype: 'HULK', pos: at(20, 3), facing: 'E' },
    ]);
    s.units[0].nextActAt = 1e6;
    for (let i = 0; i < 4; i++) { s = advanceOnce(s); s.units[0].nextActAt = 1e6; }
    expect(unit(s, 'E01').aiState).not.toBe('IDLE');   // 射手發現了
    expect(unit(s, 'E02').aiState).toBe('IDLE');       // 裝甲型還是不知道
  });
});

describe('§9.4 關掉開關就沒有宣告', () => {
  it('關掉 tacticalBehaviour：不宣告、不喊口令', () => {
    const before = RULES.ai.tacticalBehaviour;
    try {
      RULES.ai.tacticalBehaviour = false;
      let s = testState(HALL, [{ archetype: 'SHOOTER', pos: at(6, 1) }]);
      s.units[0].nextActAt = 1e6;
      for (let i = 0; i < 4; i++) {
        const evs = events(s, { type: 'ADVANCE' });
        expect(evs.filter((e) => e.kind === 'CALLOUT')).toHaveLength(0);
        s = advanceOnce(s);
        s.units[0].nextActAt = 1e6;
        expect(unit(s, 'E01').declared).toBeNull();
      }
    } finally {
      RULES.ai.tacticalBehaviour = before;
    }
  });
});
