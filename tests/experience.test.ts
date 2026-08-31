/**
 * §1 士兵個人經驗。
 *
 * **只由完成目標授予，擊殺不給** —— 擊殺經驗會讓最優解變成清場，
 * 而本作的設計是「你可以隨時走人」。綁在目標上，成長才與**做事**綁在一起。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RULES } from '../src/core/content';
import { applyCommand } from '../src/core/commands';
import {
  applyMissionResult, levelOf, makeDeployment, missionResultOf, newCompany, xpToNext,
} from '../src/core/meta';
import type { MetaState } from '../src/core/meta';
import { createInitialState } from '../src/core/setup';
import { effectiveMoveTime } from '../src/core/inventory';
import { advanceToPlayer, freezeCombat, player, run, testState, thawCombat } from './helpers';

const ROOM = [
  '##############',
  '#D...........#',
  '#............#',
  '#..S......S..#',
  '#..........T.#',
  '##############',
];

beforeAll(() => freezeCombat());
afterAll(() => thawCombat());

const co = (): MetaState => newCompany();

describe('§1.1 授予方式：只由完成目標授予', () => {
  it('完成次要目標給少量、主目標給較多，擊殺一律不給', () => {
    expect(RULES.experience.award.secondary).toBeGreaterThan(0);
    expect(RULES.experience.award.main)
      .toBeGreaterThan(RULES.experience.award.secondary);
  });

  it('打死敵人不會產生任何經驗', () => {
    let s = testState(ROOM, [{ archetype: 'RUNNER', pos: { x: 2, y: 1 } }]);
    player(s).pos = { x: 1, y: 1 };
    for (let i = 0; i < 4 && s.units.some((u) => u.faction === 'ENEMY'); i++) {
      s = run(s, { type: 'FIRE', target: { x: 2, y: 1 } });
      if (s.units.some((u) => u.faction === 'ENEMY')) s = advanceToPlayer(s);
    }
    expect(s.units.some((u) => u.faction === 'ENEMY'), '打死了').toBe(false);
    expect(Object.values(s.stats).some((v) => v.xp > 0), '擊殺不給經驗').toBe(false);
  });

  it('完成目標會記在**那個人**頭上（§1.2）', () => {
    let s = testState(ROOM);
    const me = player(s);
    me.pos = { x: 3, y: 2 };
    s = run(s, { type: 'INTERACT', pos: { x: 3, y: 3 } });
    expect(s.stats[me.id].xp).toBe(RULES.experience.award.secondary);
    const u = s.units.find((x) => x.id === me.id)!;
    u.pos = { x: 11, y: 3 };
    u.nextActAt = s.clock;
    s = applyCommand(s, { type: 'INTERACT', pos: { x: 11, y: 4 } }).state;
    expect(s.objectives.main.done).toBe(true);
    expect(s.stats[me.id].xp)
      .toBe(RULES.experience.award.secondary + RULES.experience.award.main);
  });
});

describe('§1.2 陣亡的士兵不保留經驗', () => {
  const base = (over: Record<string, unknown>) => ({
    mapName: 'x', contractCode: 'X', outcome: 'SUCCESS', clock: 1, rating: 'C',
    mainDone: true, secondaryDone: 1, issued: [], issuedWeaponIds: [], leftBehind: [],
    deployedIds: [], deadIds: [], survivorId: null, survivorEquippedId: null,
    survivorStowedId: null, extracted: [], kills: {}, damageTaken: {}, xpBy: {}, ...over,
  }) as never;

  it('活著回來的拿到經驗', () => {
    const m = co();
    const id = m.roster[0].id;
    const after = applyMissionResult(m, base({ deployedIds: [id], xpBy: { [id]: 80 } }));
    expect(after.roster.find((s) => s.id === id)!.xp).toBe(80);
  });

  it('**死了就什麼都沒有** —— 經驗隨他留在戰場上', () => {
    const m = co();
    const [a, b] = m.roster;
    const after = applyMissionResult(m, base({
      deployedIds: [a.id, b.id], deadIds: [a.id],
      xpBy: { [a.id]: 20, [b.id]: 60 },
    }));
    expect(after.roster.find((s) => s.id === a.id), '陣亡者被移除').toBeUndefined();
    expect(after.roster.find((s) => s.id === b.id)!.xp).toBe(60);
  });

  it('止損撤出仍然留得住已完成目標的經驗 —— 但那一趟通常拿不到主目標', () => {
    const m = co();
    const id = m.roster[0].id;
    const after = applyMissionResult(m, base({
      outcome: 'ABORTED', mainDone: false,
      deployedIds: [id], xpBy: { [id]: RULES.experience.award.secondary },
    }));
    expect(after.roster.find((s) => s.id === id)!.xp)
      .toBe(RULES.experience.award.secondary);
  });
});

describe('§1.3 / §1.4 經驗影響什麼', () => {
  it('影響命中、迴避與動作時間', () => {
    const lo = levelOf(0);
    const hi = levelOf(99999);
    expect(hi.aim).toBeGreaterThan(lo.aim);
    expect(hi.evasion).toBeGreaterThan(lo.evasion);
    expect(hi.actionScale).toBeLessThan(lo.actionScale);
  });

  it('**完全不影響生命值** —— 那是所有資源計算的基準', () => {
    const m = co();
    m.roster[0].xp = 99999;
    const plan = makeDeployment(m, m.roster[0].id);
    const d = plan.soldiers.find((x) => x.id === m.roster[0].id)!;
    expect(d.hp).toBe(RULES.meta.soldierHp);
    expect(d.maxHp).toBe(RULES.meta.soldierHp);
    expect(Object.keys(d.level)).not.toContain('hp');
    expect(Object.keys(d.level)).not.toContain('maxHp');
  });

  it('動作時間真的變快，但**移動與開火不受影響**', () => {
    const s = testState(ROOM);
    const me = player(s);
    me.equipped!.ammo = 0;          // 滿彈匣裝不了，那是另一條規則
    const before = {
      reload: applyCommand(s, { type: 'RELOAD' }).state.units
        .find((u) => u.id === me.id)!.nextActAt,
      move: effectiveMoveTime(me),
      fire: me.equipped!.fireTime,
    };
    me.actionScale = levelOf(99999).actionScale;
    const after = applyCommand(s, { type: 'RELOAD' }).state.units
      .find((u) => u.id === me.id)!.nextActAt;
    expect(after, '裝填變快').toBeLessThan(before.reload);
    expect(effectiveMoveTime(me), '移動由負重決定').toBe(before.move);
    expect(me.equipped!.fireTime, '開火由武器決定').toBe(before.fire);
  });
});

describe('§1.5 成長曲線要有天花板與遞減', () => {
  it('每一級的提升幅度遞減', () => {
    const t = RULES.experience.levels;
    for (let i = 2; i < t.length; i++) {
      const prev = t[i - 1].aim - t[i - 2].aim;
      const cur = t[i].aim - t[i - 1].aim;
      expect(cur, '第 ' + (i + 1) + ' 級的幅度').toBeLessThanOrEqual(prev);
    }
  });

  it('有明確上限 —— 那也是日後世代遞減的收斂點', () => {
    const top = RULES.experience.levels[RULES.experience.levels.length - 1];
    expect(levelOf(top.xp * 100)).toEqual(top);
    expect(xpToNext(top.xp)).toBeNull();
    expect(xpToNext(0)).toBeGreaterThan(0);
  });
});

describe('§1.2 撤離才留得住成長：與現金的取捨', () => {
  it('一場完整任務的經驗經由 missionResultOf 傳出來', () => {
    const s = createInitialState(1);
    s.stats.K441 = { kills: 3, damageTaken: 10, xp: 80 };
    const r = missionResultOf(s, { mapName: 'x', contractCode: 'X', rating: 'C' });
    expect(r.xpBy.K441).toBe(80);
    expect(r.kills.K441, '擊殺照樣記錄 —— 只是不換成經驗').toBe(3);
  });
});
