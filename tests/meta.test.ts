/**
 * 局外層（v0.16）。
 *
 * 這一版是分水嶺：專案至此蓋好的核心機制 —— 陣亡掉落、屍體回收、
 * 帶著戰利品提早撤離、止損、名冊耗盡 —— 在此之前**全部沒有作用**。
 * 所以這一組測試守的是「後果真的發生了」。
 */
import { describe, expect, it } from 'vitest';
import type { MetaState, MissionResult } from '../src/core/meta';
import {
  applyMissionResult, assignWeapon, emptyLoadout, freeAmmo, grantAmmo, grantConsumable,
  grantSoldier, grantWeapon, holderOf, makeDeployment, missionResultOf, moveAmmo,
  newCompany, resolveLoadout, unassignedWeapons, unassignSlot,
} from '../src/core/meta';
import { checkKit } from '../src/core/loadout';
import { RULES, mapById } from '../src/core/content';
import { createInitialState } from '../src/core/setup';
import { applyCommand } from '../src/core/commands';
import { weaponItem } from '../src/core/inventory';

const co = (): MetaState => newCompany();

describe('§7.4 新公司的起始狀態', () => {
  it('四名士兵，但**東西不夠分** —— 第一次進配裝就該遇到這個處境', () => {
    const m = co();
    expect(m.roster).toHaveLength(RULES.meta.start.soldiers);
    expect(m.armoury.length).toBeLessThan(m.roster.length * 2);
    for (const s of m.roster) {
      expect(s.loadout.equippedWeaponId).toBeNull();
      expect(s.serviceRecord.missions).toBe(0);
      expect(s.designation).toContain('Gen.1');
    }
  });

  it('起始內容全部來自資料檔', () => {
    const m = co();
    expect(m.armoury.map((w) => w.typeId)).toEqual(RULES.meta.start.weapons);
    for (const [id, n] of Object.entries(RULES.meta.start.ammo)) {
      expect(freeAmmo(m, id), id).toBe(n);
    }
  });

  it('實例計數器在 MetaState 裡，而且會被推進（§1.2）', () => {
    const m = co();
    const before = m.instanceCounter;
    grantWeapon(m, 'p9');
    expect(m.instanceCounter).toBeGreaterThan(before);
    // 序列化還原之後接著發，不會撞號
    const round = JSON.parse(JSON.stringify(m)) as MetaState;
    const w = grantWeapon(round, 'p9');
    expect(m.armoury.some((x) => x.instanceId === w.instanceId)).toBe(false);
  });
});

describe('§3.2 同一把槍只能給一個人', () => {
  it('指派給第二個人時會自動從第一個人身上拔掉', () => {
    const m = co();
    const w = m.armoury[0];
    const [a, b] = m.roster;
    assignWeapon(m, w.instanceId, a.id, 'equipped');
    expect(holderOf(m, w.instanceId)!.id).toBe(a.id);
    assignWeapon(m, w.instanceId, b.id, 'equipped');
    expect(holderOf(m, w.instanceId)!.id).toBe(b.id);
    expect(a.loadout.equippedWeaponId).toBeNull();
  });

  it('同一把槍不會同時出現在兩個欄位', () => {
    const m = co();
    const w = m.armoury[0];
    const a = m.roster[0];
    assignWeapon(m, w.instanceId, a.id, 'equipped');
    assignWeapon(m, w.instanceId, a.id, 'stowed');
    expect(a.loadout.equippedWeaponId).toBeNull();
    expect(a.loadout.stowedWeaponId).toBe(w.instanceId);
  });

  it('槍不夠分：四個人配不滿，未指派清單看得出來', () => {
    const m = co();
    m.roster.forEach((s, i) => {
      const w = m.armoury[i];
      if (w) assignWeapon(m, w.instanceId, s.id, 'equipped');
    });
    const armed = m.roster.filter((s) => s.loadout.equippedWeaponId !== null);
    expect(armed.length).toBe(Math.min(m.roster.length, m.armoury.length));
    expect(unassignedWeapons(m).length).toBe(m.armoury.length - armed.length);
  });

  it('收回軍械庫之後別人才拿得到', () => {
    const m = co();
    const w = m.armoury[0];
    assignWeapon(m, w.instanceId, m.roster[0].id, 'equipped');
    unassignSlot(m, m.roster[0].id, 'equipped');
    expect(holderOf(m, w.instanceId)).toBeNull();
    expect(unassignedWeapons(m).some((x) => x.instanceId === w.instanceId)).toBe(true);
  });
});

describe('§3.2 彈藥是共用庫存，逐人分配', () => {
  it('拿走就從庫存扣，還回去就加回來', () => {
    const m = co();
    const s = m.roster[0];
    const before = freeAmmo(m, 'standard_5.56');
    expect(moveAmmo(m, s.id, 'standard_5.56', 12)).toBe(12);
    expect(s.loadout.ammo['standard_5.56']).toBe(12);
    expect(freeAmmo(m, 'standard_5.56')).toBe(before - 12);
    moveAmmo(m, s.id, 'standard_5.56', -12);
    expect(freeAmmo(m, 'standard_5.56')).toBe(before);
    expect(s.loadout.ammo['standard_5.56']).toBeUndefined();
  });

  it('拿不到超過庫存的量', () => {
    const m = co();
    const s = m.roster[0];
    const stock = freeAmmo(m, 'standard_5.56');
    expect(moveAmmo(m, s.id, 'standard_5.56', stock + 100)).toBe(stock);
    expect(freeAmmo(m, 'standard_5.56')).toBe(0);
    // 第二個人就沒得拿了 —— 這正是「分配資源」的意思
    expect(moveAmmo(m, m.roster[1].id, 'standard_5.56', 6)).toBe(0);
  });

  it('還不會還出負數', () => {
    const m = co();
    expect(moveAmmo(m, m.roster[0].id, 'standard_7.62', -10)).toBe(0);
  });
});

describe('§3.3 兩種配裝原型在操作上成立', () => {
  it('主攻與回收：一個吃緊、一個刻意留空', () => {
    const m = co();
    const [atk, rec] = m.roster;
    const ar9 = m.armoury.find((w) => w.typeId === 'ar9')!;
    const rr4 = m.armoury.find((w) => w.typeId === 'rr4')!;
    const p9 = m.armoury.find((w) => w.typeId === 'p9')!;
    assignWeapon(m, ar9.instanceId, atk.id, 'equipped');
    assignWeapon(m, rr4.instanceId, atk.id, 'stowed');
    moveAmmo(m, atk.id, 'standard_5.56', 48);
    moveAmmo(m, atk.id, 'heat_84mm', 3);
    grantConsumable(m, 'SEALANT', 0);

    assignWeapon(m, p9.instanceId, rec.id, 'equipped');
    moveAmmo(m, rec.id, 'standard_9mm', 30);

    const a = checkKit(resolveLoadout(m, atk.loadout));
    const r = checkKit(resolveLoadout(m, rec.loadout));
    expect(a.weight).toBeGreaterThan(40);
    expect(r.weight).toBeLessThan(10);
    // 回收型的空間差距，就是他能背回來的東西
    expect((r.headroom ?? 0) - (a.headroom ?? 0)).toBeGreaterThan(30);
  });
});

describe('§1.1 派遣快照：任務期間不讀寫 MetaState', () => {
  const armed = (): MetaState => {
    const m = co();
    m.roster.forEach((s, i) => {
      const w = m.armoury[i];
      if (w) assignWeapon(m, w.instanceId, s.id, 'equipped');
      moveAmmo(m, s.id, 'standard_5.56', 6);
    });
    return m;
  };

  it('快照含全部名冊與各自的配裝，武器是深複製', () => {
    const m = armed();
    const plan = makeDeployment(m, m.roster[0].id);
    expect(plan.soldiers).toHaveLength(m.roster.length);
    expect(plan.firstId).toBe(m.roster[0].id);
    const snap = plan.soldiers[0];
    expect(snap.equipped!.instanceId).toBe(m.roster[0].loadout.equippedWeaponId);
    const before = m.armoury[0].ammo;
    snap.equipped!.ammo = 0;
    expect(m.armoury[0].ammo).toBe(before);
  });

  it('任務只讀快照 —— 首發帶著他自己的東西上場', () => {
    const m = armed();
    const plan = makeDeployment(m, m.roster[1].id);
    const s = createInitialState(1, mapById('mission_01')!, plan);
    const p = s.units.find((u) => u.faction === 'PLAYER')!;
    expect(p.id).toBe(m.roster[1].id);
    expect(p.equipped!.instanceId).toBe(m.roster[1].loadout.equippedWeaponId);
    expect(s.roster).toHaveLength(m.roster.length - 1);
    expect(s.roster).not.toContain(m.roster[1].id);
  });

  it('沒有配裝的人可以被派出，赤手空拳', () => {
    const m = co();
    const plan = makeDeployment(m, m.roster[0].id);
    const s = createInitialState(1, mapById('mission_01')!, plan);
    const p = s.units.find((u) => u.faction === 'PLAYER')!;
    expect(p.equipped).toBeNull();
    expect(p.stowed).toBeNull();
  });

  it('決定論：相同種子 + 相同快照 → 完全相同的狀態', () => {
    const m = armed();
    const a = createInitialState(777, mapById('mission_03')!, makeDeployment(m, m.roster[0].id));
    const b = createInitialState(777, mapById('mission_03')!, makeDeployment(m, m.roster[0].id));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('§5 把任務結果套用回公司', () => {
  const base = (): MetaState => {
    const m = co();
    const [a, b] = m.roster;
    assignWeapon(m, m.armoury[0].instanceId, a.id, 'equipped');
    assignWeapon(m, m.armoury[1].instanceId, a.id, 'stowed');
    assignWeapon(m, m.armoury[2].instanceId, b.id, 'equipped');
    moveAmmo(m, a.id, 'standard_5.56', 24);
    return m;
  };
  const result = (over: Partial<MissionResult>): MissionResult => ({
    mapName: '測試場', contractCode: '委-TEST', outcome: 'ABORTED', clock: 100,
    deployedIds: [], deadIds: [], survivorId: null, extracted: [],
    kills: {}, damageTaken: {}, ...over,
  });

  it('陣亡：士兵永久移除，他身上的槍也永久移除', () => {
    const m = base();
    const a = m.roster[0];
    const lost = [a.loadout.equippedWeaponId!, a.loadout.stowedWeaponId!];
    const after = applyMissionResult(m, result({ deployedIds: [a.id], deadIds: [a.id] }));
    expect(after.roster.some((s) => s.id === a.id)).toBe(false);
    for (const id of lost) {
      expect(after.armoury.some((w) => w.instanceId === id), id).toBe(false);
    }
    expect(after.roster.some((s) => s.id === m.roster[1].id)).toBe(true);
    expect(after.armoury.some((w) => w.instanceId === m.roster[1].loadout.equippedWeaponId)).toBe(true);
  });

  it('止損：人回來，但身上的一切留在戰場上', () => {
    const m = base();
    const a = m.roster[0];
    const after = applyMissionResult(m, result({ deployedIds: [a.id] }));
    const s = after.roster.find((x) => x.id === a.id)!;
    expect(s).toBeTruthy();
    expect(s.loadout).toEqual(emptyLoadout());
    expect(after.armoury).toHaveLength(m.armoury.length - 2);
  });

  it('撤離：帶出來的槍回到軍械庫，而且仍是同一個 instanceId', () => {
    const m = base();
    const a = m.roster[0];
    const plan = makeDeployment(m, a.id);
    const snap = plan.soldiers.find((d) => d.id === a.id)!;
    const st = createInitialState(1, mapById('mission_01')!, plan);
    const carried = weaponItem(st, snap.equipped!);
    const after = applyMissionResult(m, result({
      outcome: 'SUCCESS', deployedIds: [a.id], survivorId: a.id, extracted: [carried],
    }));
    const id = snap.equipped!.instanceId;
    expect(after.armoury.some((w) => w.instanceId === id)).toBe(true);
    expect(after.armoury.some((w) => w.instanceId === snap.stowed!.instanceId)).toBe(false);
    expect(after.roster.find((s) => s.id === a.id)!.loadout.equippedWeaponId).toBe(id);
  });

  it('帶出的彈藥併回共用庫存', () => {
    const m = base();
    const a = m.roster[0];
    const before = freeAmmo(m, 'standard_5.56');
    const after = applyMissionResult(m, result({
      outcome: 'SUCCESS', deployedIds: [a.id], survivorId: a.id,
      extracted: [{
        id: 'X', kind: 'AMMO', defId: 'standard_5.56', name: '5.56 步槍彈',
        weight: 0.024, qty: 9, ammoTypeId: 'standard_5.56',
      }],
    }));
    expect(freeAmmo(after, 'standard_5.56')).toBe(before + 9);
  });

  it('服役紀錄跨任務累積', () => {
    const m = base();
    const a = m.roster[0];
    let after = applyMissionResult(m, result({
      deployedIds: [a.id], survivorId: a.id, kills: { [a.id]: 3 }, damageTaken: { [a.id]: 20 },
    }));
    after = applyMissionResult(after, result({
      contractCode: '委-TEST2', deployedIds: [a.id], survivorId: a.id, kills: { [a.id]: 1 },
    }));
    const rec = after.roster.find((s) => s.id === a.id)!.serviceRecord;
    expect(rec.missions).toBe(2);
    expect(rec.kills).toBe(4);
    expect(rec.damageTaken).toBe(20);
    expect(rec.contracts).toEqual(['委-TEST', '委-TEST2']);
  });

  it('生還者生命值全額恢復（佔位規則，§5.3）', () => {
    const m = base();
    m.roster[0].hp = 12;
    const after = applyMissionResult(m, result({ deployedIds: [m.roster[0].id] }));
    const s = after.roster.find((x) => x.id === m.roster[0].id)!;
    expect(s.hp).toBe(s.maxHp);
  });

  it('套用是純函數：原本的 MetaState 沒被改到', () => {
    const m = base();
    const snapshot = JSON.stringify(m);
    applyMissionResult(m, result({ deployedIds: [m.roster[0].id], deadIds: [m.roster[0].id] }));
    expect(JSON.stringify(m)).toBe(snapshot);
  });

  it('missionResultOf 只讀 GameState', () => {
    const m = base();
    const plan = makeDeployment(m, m.roster[0].id);
    let st = createInitialState(1, mapById('mission_01')!, plan);
    st = applyCommand(st, { type: 'WAIT' }).state;
    const r = missionResultOf(st, { mapName: st.map.name, contractCode: '委-X' });
    expect(r.deployedIds).toEqual([m.roster[0].id]);
    expect(r.deadIds).toEqual([]);
    expect(r.survivorId).toBeNull();
  });
});

describe('§6 暫時補給站（全部 0 元）', () => {
  it('領到的武器是新的實例，identity 各自獨立', () => {
    const m = co();
    const a = grantWeapon(m, 'p9');
    const b = grantWeapon(m, 'p9');
    expect(a.typeId).toBe(b.typeId);
    expect(a.instanceId).not.toBe(b.instanceId);
    expect(holderOf(m, a.instanceId)).toBeNull();
  });

  it('徵召的士兵沒有配裝 —— 東西還是要你自己分', () => {
    const m = co();
    const n = m.roster.length;
    const s = grantSoldier(m);
    expect(m.roster).toHaveLength(n + 1);
    expect(s.loadout).toEqual(emptyLoadout());
    expect(s.designation).toContain('Gen.1');
  });

  it('補給站的內容來自資料檔', () => {
    const m = co();
    const before = freeAmmo(m, 'buckshot_12ga');
    grantAmmo(m, 'buckshot_12ga', RULES.meta.supply.ammoBatch.buckshot_12ga);
    expect(freeAmmo(m, 'buckshot_12ga'))
      .toBe(before + RULES.meta.supply.ammoBatch.buckshot_12ga);
  });
});
