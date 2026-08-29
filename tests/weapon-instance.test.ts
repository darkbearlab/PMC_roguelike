/**
 * 武器實例、詞條與來歷（v0.15 附錄 A）。
 *
 * 這一版不實作任何詞條效果，所以這裡守的全是**形狀**：
 *  - 一把槍是一個實例，不是一個型號引用
 *  - 實例識別碼是決定性的
 *  - 詞條為空時，實際數值必然等於型號數值 —— 這一條是為了證明
 *    **套用點確實在生效**，日後填入詞條時才知道它沒有被繞過去
 */
import { describe, expect, it } from 'vitest';
import { WEAPONS } from '../src/core/content';
import {
  baseStats, duplicateWeapon, makeWeapon, resolveStats, weaponType, withAffixes,
} from '../src/core/weapon';
import type { Affix } from '../src/core/state';
import { createInitialState } from '../src/core/setup';
import { mapById } from '../src/core/content';
import { applyCommand } from '../src/core/commands';
import type { Command } from '../src/core/commands';
import { player, run, testState, weaponIds } from './helpers';

const serial = (): { nextEntitySerial: number } => ({ nextEntitySerial: 1 });

const ROOM = [
  '##############',
  '#D...........#',
  '#............#',
  '#...........T#',
  '##############',
];

describe('附錄 A §2 型號與實例分離', () => {
  it('兩把同型號的槍是兩個不同的實例，可分別追蹤', () => {
    const s = serial();
    const a = makeWeapon(s, 'ar9');
    const b = makeWeapon(s, 'ar9');
    expect(a.typeId).toBe(b.typeId);
    expect(a.instanceId).not.toBe(b.instanceId);
    // 而且互不影響：改一把的彈藥，另一把不動
    a.ammo = 0;
    expect(b.ammo).toBe(weaponType('ar9').ammo);
  });

  it('所有持有處都持有實例', () => {
    const s = createInitialState(1, mapById('mission_01')!);
    const p = s.units.find((u) => u.faction === 'PLAYER')!;
    expect(p.equipped!.instanceId).toBeTruthy();
    expect(p.stowed!.instanceId).toBeTruthy();
    expect(p.equipped!.instanceId).not.toBe(p.stowed!.instanceId);
    // §1：內建武器也是實例 —— 衝擊爪不會流通，但這條不留例外
    for (const u of s.units) {
      expect(u.intrinsic.instanceId, u.id).toBeTruthy();
      expect(u.intrinsic.intrinsic, u.id).toBe(true);
    }
    // 全場的 instanceId 互不重複（含內建武器）
    const ids = s.units.flatMap((u) => [u.equipped, u.stowed, u.intrinsic])
      .filter(Boolean).map((w) => w!.instanceId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('搬動一把槍（換手、掉落、撿起）保留它的 instanceId', () => {
    let s = testState(ROOM);
    const before = { eq: player(s).equipped!.instanceId, st: player(s).stowed!.instanceId };
    s = run(s, { type: 'SWAP_WEAPON' });
    expect(player(s).equipped!.instanceId).toBe(before.st);
    expect(player(s).stowed!.instanceId).toBe(before.eq);

    // 陣亡 → 兩把槍留在屍體上，識別碼不變
    player(s).hp = 3;
    s = run(s, { type: 'FIRE', target: player(s).pos });
    const body = s.loot.find((c) => c.kind === 'PLAYER_BODY')!;
    const onBody = body.items.filter((it) => it.kind === 'WEAPON')
      .map((it) => it.weapon!.instanceId).sort();
    expect(onBody).toEqual([before.eq, before.st].sort());
    expect(weaponIds(body).sort()).toEqual(['ar9', 'rr4']);
  });

  it('複製成另一把槍時識別碼才會換 —— 那是新的一把', () => {
    const s = serial();
    const a = makeWeapon(s, 'dmr7');
    const b = duplicateWeapon(s, a);
    expect(b.typeId).toBe(a.typeId);
    expect(b.instanceId).not.toBe(a.instanceId);
  });
});

describe('附錄 A §2.3 識別碼必須是決定性的', () => {
  it('相同種子 + 相同指令序列 → 相同的 instanceId 序列', () => {
    const cmds: Command[] = [
      { type: 'MOVE', dir: 'E' }, { type: 'MOVE', dir: 'E' },
      { type: 'SWAP_WEAPON' }, { type: 'RELOAD' },
    ];
    const play = (): string[] => {
      let s = createInitialState(31337, mapById('mission_02')!);
      for (const c of cmds) s = applyCommand(s, c).state;
      return s.units.flatMap((u) => [u.equipped, u.stowed])
        .filter(Boolean).map((w) => w!.instanceId);
    };
    const a = play();
    const b = play();
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('識別碼走的是納入序列化狀態的流水號，不是時間或 UUID', () => {
    const s = createInitialState(5, mapById('mission_01')!);
    const p = s.units.find((u) => u.faction === 'PLAYER')!;
    expect(p.equipped!.instanceId).toMatch(/^W\d+$/);
    // 整份狀態仍可完整序列化還原
    const round = JSON.parse(JSON.stringify(s));
    expect(round.units[0].equipped.instanceId).toBe(p.equipped!.instanceId);
    expect(typeof s.nextEntitySerial).toBe('number');
  });
});

describe('附錄 A §3 詞條：只有形狀，沒有效果', () => {
  it('每一把槍都有 affixes 與 provenance，而且是空的', () => {
    const s = createInitialState(9, mapById('mission_04')!);
    for (const u of s.units) {
      for (const w of [u.equipped, u.stowed, u.intrinsic]) {
        if (!w) continue;
        expect(Array.isArray(w.affixes), u.id).toBe(true);
        expect(w.affixes, u.id).toHaveLength(0);
        // 來歷不再一律為空：§4.5 起它是有用途的欄位。
        // 形狀仍然是「事件 + 勢力名稱」，而且**不得存放帳號或使用者識別**。
        expect(Array.isArray(w.provenance), u.id).toBe(true);
        for (const pv of w.provenance) {
          expect(typeof pv.event, u.id).toBe('string');
          expect(typeof pv.actor, u.id).toBe('string');
        }
      }
    }
  });

  it('詞條為空時，實際數值等於型號數值 —— 這一條在守套用點沒有被繞過去', () => {
    const s = serial();
    for (const t of WEAPONS) {
      const inst = makeWeapon(s, t.id);
      const base = baseStats(t);
      for (const k of Object.keys(base) as (keyof typeof base)[]) {
        expect(inst[k], t.id + '.' + String(k)).toEqual(base[k]);
      }
      expect(inst.ammo).toBe(t.ammo);
      expect(inst.mode).toBe(t.mode);
    }
  });

  it('套用點真的會套用（用一個假詞條證明它不是空殼）', () => {
    const t = weaponType('ar9');
    const affix: Affix = {
      id: 'TEST_ONLY', name: '測試用',
      modifiers: { accuracy: 0.05, reloadTime: -2 },
    };
    const out = resolveStats(baseStats(t), [affix]);
    expect(out.accuracy).toBeCloseTo(t.accuracy + 0.05, 5);
    expect(out.reloadTime).toBe(t.reloadTime - 2);
    // 沒被修正的欄位不動
    expect(out.damage).toBe(t.damage);
    expect(out.modes).toEqual(t.modes);
  });

  it('withAffixes 會重新走一次套用點，識別碼不變', () => {
    const s = serial();
    const w = makeWeapon(s, 'p9');
    const changed = withAffixes(w, [{ id: 'T', name: 'T', modifiers: { damage: 5 } }]);
    expect(changed.instanceId).toBe(w.instanceId);
    expect(changed.damage).toBe(w.damage + 5);
    // 再拿掉詞條就回到型號數值
    expect(withAffixes(changed, []).damage).toBe(weaponType('p9').damage);
  });
});

describe('附錄 A §4 來歷：隱私邊界先立下來', () => {
  it('actor 只存公司或勢力名稱，型別與註解都說清楚了', () => {
    const s = serial();
    const w = makeWeapon(s, 'sg12s', [], [
      { event: 'MANUFACTURED', actor: '凱恩迪思保全服務' },
    ]);
    expect(w.provenance[0].actor).toBe('凱恩迪思保全服務');
    expect(w.provenance[0].event).toBe('MANUFACTURED');
  });
});
