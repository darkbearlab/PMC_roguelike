/**
 * 彈藥型別與機構型式（v0.15 附錄 B）。
 *
 * 這一版不實作任何彈種效果，所以這裡守的全是**形狀**與**回歸**：
 *  - 彈藥的識別單位是型別，型別引用口徑
 *  - 所有存放處都以型別 id 為鍵
 *  - **玩家看得到的東西完全不變**
 */
import { describe, expect, it } from 'vitest';
import {
  AMMO_TYPES, ITEMS, RULES, WEAPONS, ammoType, ammoTypesForCalibre,
} from '../src/core/content';
import type { Calibre } from '../src/core/state';
import { countAmmo, countAmmoFor, feedableTypes, takeAmmoFor } from '../src/core/inventory';
import { allAmmoTypes, ammoLabel, checkKit } from '../src/core/loadout';
import type { CarriedKit } from '../src/core/loadout';
import { makeWeapon } from '../src/core/weapon';
import { createInitialState } from '../src/core/setup';
import { mapById } from '../src/core/content';
import { MAPS } from '../src/core/content';
import { ACTORS } from '../src/core/content';

const ids = (): string[] => Object.keys(AMMO_TYPES);

describe('附錄 B §20.2 彈藥型別引用口徑', () => {
  it('五種型別，每個口徑剛好一種，重量與先前一致', () => {
    expect(ids()).toHaveLength(5);
    for (const c of Object.keys(RULES.calibres) as Calibre[]) {
      const types = ammoTypesForCalibre(c);
      expect(types, c).toHaveLength(1);
      expect(types[0].def.weightPerRound, c).toBe(RULES.calibres[c].weightPerRound);
    }
  });

  it('型別 id 同時就是背包裡的 defId', () => {
    for (const id of ids()) {
      expect(ITEMS[id], id).toBeTruthy();
      expect(ITEMS[id].kind).toBe('AMMO');
      expect(ITEMS[id].ammoTypeId).toBe(id);
      expect(ITEMS[id].name).toBe(AMMO_TYPES[id].name);
      expect(ITEMS[id].weight).toBe(AMMO_TYPES[id].weightPerRound);
    }
  });

  it('預留欄位存在且為預設值 —— 本版不實作任何效果', () => {
    for (const id of ids()) {
      const a = ammoType(id);
      expect(a.damageModifier, id).toBe(1.0);
      expect(a.falloffModifier, id).toBe(1.0);
      expect(a.splashRadius, id).toBe(0);
      expect(a.allowedActions, id).toEqual([]);
    }
  });

  it('引用型別 id 的地方都指得到真的存在的型別', () => {
    const known = new Set(Object.keys(ITEMS));
    const check = (defId: string, where: string): void => {
      expect(known.has(defId), where + ' 引用了不存在的 ' + defId).toBe(true);
    };
    for (const e of RULES.backpack.startingItems) check(e.defId, 'startingItems');
    for (const e of RULES.backpack.reinforcementItems) check(e.defId, 'reinforcementItems');
    for (const id of Object.keys(RULES.loadout.ammoStep)) check(id, 'ammoStep');
    for (const id of Object.keys(RULES.loadout.default.ammo)) check(id, 'default.ammo');
    for (const [aid, a] of Object.entries(ACTORS)) {
      for (const l of a.loot ?? []) check(l.defId, aid + ' 的掉落表');
    }
    for (const m of MAPS) {
      for (const c of m.caches ?? []) for (const e of c.items) check(e.defId, m.id + ' 的補給箱');
    }
  });

  it('背包裡的彈藥以型別 id 為鍵，不是口徑', () => {
    const s = createInitialState(1, mapById('mission_01')!);
    const bag = s.units.find((u) => u.faction === 'PLAYER')!.backpack!;
    for (const it of bag.items.filter((x) => x.kind === 'AMMO')) {
      expect(it.ammoTypeId).toBe(it.defId);
      expect(AMMO_TYPES[it.ammoTypeId!], it.defId).toBeTruthy();
    }
    expect(countAmmo(bag, 'standard_5.56')).toBe(24);
    expect(countAmmo(bag, 'heat_84mm')).toBe(2);
    // 口徑字串不再是有效的鍵
    expect(countAmmo(bag, '5.56')).toBe(0);
  });

  it('「這把槍餵得到哪些型別」是一個集中的判斷，v0.15 就是同口徑的全部', () => {
    const s = createInitialState(1, mapById('mission_01')!);
    const p = s.units.find((u) => u.faction === 'PLAYER')!;
    expect(feedableTypes(p.equipped!)).toEqual(['standard_5.56']);
    expect(feedableTypes(p.stowed!)).toEqual(['heat_84mm']);
    expect(countAmmoFor(p.backpack, p.equipped!)).toBe(24);
    expect(takeAmmoFor(p.backpack, p.equipped!, 5)).toBe(5);
    expect(countAmmoFor(p.backpack, p.equipped!)).toBe(19);
  });
});

describe('附錄 B §20.3 機構型式', () => {
  it('七把武器都填了，而且值是對的', () => {
    const want: Record<string, string> = {
      ar9: 'AUTO', rr4: 'BREECH', sg12p: 'PUMP', sg12s: 'BREAK',
      dmr7: 'SEMI', lmg5: 'AUTO', p9: 'SEMI',
    };
    for (const w of WEAPONS) expect(w.action, w.id).toBe(want[w.id]);
  });

  it('本版不參與任何判斷：allowedActions 全空，所以誰都餵得到', () => {
    for (const id of ids()) expect(AMMO_TYPES[id].allowedActions).toEqual([]);
    // SG-12P（PUMP）與 SG-12S（BREAK）現在餵得到同一種東西
    const pump = WEAPONS.find((w) => w.id === 'sg12p')!;
    const brk = WEAPONS.find((w) => w.id === 'sg12s')!;
    expect(feedableTypes({ ...pump } as never)).toEqual(feedableTypes({ ...brk } as never));
  });
});

describe('附錄 B §20.4 玩家看得到的東西不變', () => {
  it('只有一種彈種時，介面顯示的是口徑名（與 v0.14 以前一樣）', () => {
    expect(ammoLabel('standard_5.56')).toBe('5.56×45mm');
    expect(ammoLabel('buckshot_12ga')).toBe('12 號徑');
    expect(ammoLabel('heat_84mm')).toBe('84mm 無後座力');
  });

  it('背包裡的名字也沒變', () => {
    expect(ITEMS['standard_5.56'].name).toBe('5.56 步槍彈');
    expect(ITEMS['buckshot_12ga'].name).toBe('12 號徑霰彈');
    expect(ITEMS.heat_84mm.name).toBe('84mm 火箭彈');
  });

  it('預設配裝的重量與級距完全沒動', () => {
    const serial = { nextEntitySerial: 1 };
    const kit: CarriedKit = {
      equipped: makeWeapon(serial, 'ar9'),
      stowed: makeWeapon(serial, 'rr4'),
      ammo: { 'standard_5.56': 24, heat_84mm: 2 },
      consumables: { SEALANT: 1 },
    };
    const c = checkKit(kit);
    expect(c.weight).toBeCloseTo(41.576, 3);
    expect(c.tier).toBe(0);
    expect(c.moveCost).toBe(10);
    expect(c.warnings).toEqual([]);
  });

  it('配裝畫面的彈藥列順序依口徑，同口徑的排在一起', () => {
    expect(allAmmoTypes()).toEqual([
      'standard_5.56', 'standard_7.62', 'buckshot_12ga', 'standard_9mm', 'heat_84mm',
    ]);
  });
});

describe('附錄 B §20.1 設定分層記在資料裡', () => {
  it('84mm 是遺產彈藥：不可本地生產', () => {
    expect(RULES.calibres['84mm'].localProduction).toBe('NONE');
    expect(RULES.calibres['12ga'].localProduction).toBe('EASY');
    expect(RULES.calibres['9mm'].localProduction).toBe('EASY');
    expect(RULES.calibres['5.56'].localProduction).toBe('HARD');
    expect(RULES.calibres['7.62'].localProduction).toBe('HARD');
  });
});
