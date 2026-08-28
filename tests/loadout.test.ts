/**
 * 口徑、武器批次與出擊前配裝（v0.15）。
 *
 * 這一組守的是三件事：
 *  1. **AR-9 與 RR-4 的數值沒有被動到**（重量欄位除外）—— 它們是六個版本調出來的參考點
 *  2. 標籤 → 準備 → 出擊那條鏈上的每一段都由資料驅動
 *  3. 換算尺（1 單位 = 0.5 公斤）真的被遵守
 */
import { describe, expect, it } from 'vitest';
import { AMMO_TYPES, ITEMS, RULES, WEAPONS, ammoTypesForCalibre } from '../src/core/content';
import type { Calibre } from '../src/core/state';
import {
  allAmmoTypes, checkLoadout, cloneLoadout, defaultLoadout, equipFromLoadout,
  loadoutBreakdown, loadoutWeight, selectableConsumables,
} from '../src/core/loadout';
import type { Loadout } from '../src/core/loadout';
import { carriedWeight, countAmmo, countAmmoFor, totalWeight } from '../src/core/inventory';
import { createInitialState } from '../src/core/setup';
import { mapById } from '../src/core/content';
import { cheapestMode, effectiveMode, shotsFor } from '../src/core/combat';
import { testWeapon } from './helpers';

const W = (id: string) => WEAPONS.find((w) => w.id === id)!;

describe('§1 口徑系統', () => {
  it('口徑是獨立的資料實體，武器以引用方式指定', () => {
    for (const w of WEAPONS) {
      expect(RULES.calibres[w.calibre], w.id + ' 的口徑不存在').toBeTruthy();
    }
  });

  it('共用是刻意的：AR-9 與 LMG-5 同吃 5.56，兩把霰彈槍同吃 12ga', () => {
    expect(W('ar9').calibre).toBe('5.56');
    expect(W('lmg5').calibre).toBe('5.56');
    expect(W('sg12p').calibre).toBe('12ga');
    expect(W('sg12s').calibre).toBe('12ga');
  });

  it('彈藥的識別單位是型別，型別引用口徑（附錄 B §2.2）', () => {
    for (const id of allAmmoTypes()) {
      const a = AMMO_TYPES[id];
      expect(RULES.calibres[a.calibreId], id + ' 的口徑不存在').toBeTruthy();
      // 型別 id 同時就是它在背包裡的 defId
      expect(ITEMS[id], id + ' 沒有對應的背包物品').toBeTruthy();
      expect(ITEMS[id].kind).toBe('AMMO');
      expect(ITEMS[id].weight).toBe(a.weightPerRound);
      expect(ITEMS[id].ammoTypeId).toBe(id);
    }
    // v0.15：每個口徑剛好一種型別，數值與附錄前相同
    for (const c of Object.keys(RULES.calibres) as Calibre[]) {
      const types = ammoTypesForCalibre(c);
      expect(types, c).toHaveLength(1);
      expect(types[0].def.weightPerRound).toBe(RULES.calibres[c].weightPerRound);
    }
  });

  it('預留欄位存在且是預設值 —— 本版不實作任何效果', () => {
    for (const id of allAmmoTypes()) {
      const a = AMMO_TYPES[id];
      expect(a.damageModifier, id).toBe(1.0);
      expect(a.falloffModifier, id).toBe(1.0);
      expect(a.splashRadius, id).toBe(0);
      expect(a.allowedActions, id).toEqual([]);
    }
  });

  it('七把武器都填了機構型式，而且本版不參與任何判斷', () => {
    const want: Record<string, string> = {
      ar9: 'AUTO', rr4: 'BREECH', sg12p: 'PUMP', sg12s: 'BREAK',
      dmr7: 'SEMI', lmg5: 'AUTO', p9: 'SEMI',
    };
    for (const w of WEAPONS) expect(w.action, w.id).toBe(want[w.id]);
  });

  it('新增一把槍只要指定既有口徑就能吃既有彈藥', () => {
    const l: Loadout = { primary: 'lmg5', stowed: null, ammo: { 'standard_5.56': 30 }, consumables: {} };
    const kit = equipFromLoadout({ nextEntitySerial: 1 }, l);
    // LMG-5 與 AR-9 不同型號，但同口徑 —— 背包裡那堆 5.56 兩把都吃得到
    expect(countAmmoFor(kit.backpack, kit.equipped!)).toBe(30);
  });
});

describe('§2 武器表', () => {
  it('AR-9 與 RR-4 的數值完全未變（重量欄位除外）', () => {
    const ar9 = W('ar9');
    expect([ar9.damage, ar9.damageSpread, ar9.range, ar9.magazine, ar9.fireTime, ar9.reloadTime])
      .toEqual([30, 5, 8, 8, 10, 10]);
    expect([ar9.accuracy, ar9.optimalRange, ar9.falloffPerTile]).toEqual([0.55, 5, 0.08]);
    expect(ar9.noiseRadius).toBe(6);
    const rr4 = W('rr4');
    expect([rr4.damage, rr4.damageSpread, rr4.range, rr4.magazine, rr4.fireTime, rr4.reloadTime])
      .toEqual([120, 20, 12, 1, 20, 20]);
    expect([rr4.accuracy, rr4.optimalRange, rr4.falloffPerTile]).toEqual([0.5, 8, 0.10]);
    expect([rr4.noiseRadius, rr4.splash]).toEqual([14, 1]);
    expect(rr4.reloadSequence).toBe('RR4_RELOAD');
  });

  it('七把武器，全部 penetration 為 0（穿甲本次擱置）', () => {
    expect(WEAPONS).toHaveLength(7);
    for (const w of WEAPONS) expect(w.penetration, w.id).toBe(0);
  });

  it('衰減曲線造成角色分化，不是靠傷害數字', () => {
    // 削短型：貼身之王，四格外等於沒有
    const s = W('sg12s');
    expect(s.optimalRange).toBe(1);
    expect(s.accuracy - (4 - s.optimalRange) * s.falloffPerTile).toBeLessThan(RULES.combat.hitFloor);
    // 精確步槍：14 格內完全不衰減
    const d = W('dmr7');
    expect((14 - d.optimalRange) * d.falloffPerTile).toBe(0);
    expect(d.accuracy - (16 - d.optimalRange) * d.falloffPerTile).toBeGreaterThan(RULES.combat.hitFloor);
    // 而且它的基礎命中比 AR-9 還低 —— 長處是「遠處也一樣準」，不是「準」
    expect(d.accuracy).toBeLessThan(W('ar9').accuracy);
  });
});

describe('§3 兩個新機制', () => {
  it('泵動霰彈槍是增量裝填，且不是系列動作', () => {
    const w = W('sg12p');
    expect(w.reloadMode).toBe('INCREMENTAL');
    expect(w.reloadSequence).toBeNull();
  });

  it('削短型有齊射，吃 2 發、2 次獨立判定', () => {
    expect(W('sg12s').modes).toContain('VOLLEY');
    expect(RULES.fireModes.VOLLEY.shots).toBe(2);
    expect(shotsFor({ ...testWeapon('sg12s'), mode: 'VOLLEY', ammo: 2 })).toBe(2);
  });

  it('可用模式清單資料化：每把武器只循環自己有的', () => {
    expect(W('sg12p').modes).toEqual(['SINGLE']);
    expect(W('lmg5').modes).toEqual(['BURST', 'AUTO']);
    expect(W('p9').modes).toEqual(['SINGLE', 'BURST']);
    for (const w of WEAPONS) {
      expect(w.modes.length, w.id + ' 沒有可用模式').toBeGreaterThan(0);
      expect(w.modes).toContain(w.mode);
      for (const m of w.modes) expect(RULES.fireModes[m], w.id + ' 的模式 ' + m).toBeTruthy();
    }
  });

  it('沒有單發的武器，降級不會退到它沒有的模式', () => {
    // LMG-5 只有點放與連發。剩一發時兩種都撐不住 ——
    // 這時不可以顯示「單發」，那是這把槍沒有的模式。
    const lmg = { ...testWeapon('lmg5'), mode: 'AUTO' as const, ammo: 1 };
    expect(cheapestMode(lmg)).toBe('BURST');
    expect(W('lmg5').modes).toContain(effectiveMode(lmg));
  });

  it('齊射的降級路徑：只剩一發就退回單發', () => {
    expect(effectiveMode({ ...testWeapon('sg12s'), mode: 'VOLLEY', ammo: 1 })).toBe('SINGLE');
    expect(effectiveMode({ ...testWeapon('sg12s'), mode: 'VOLLEY', ammo: 2 })).toBe('VOLLEY');
  });
});

describe('§4 換算尺與負重', () => {
  it('武器重量依 §4.2 的現實換算表', () => {
    const want: Record<string, number> = {
      ar9: 7, rr4: 20, sg12p: 7, sg12s: 5, dmr7: 11, lmg5: 15, p9: 2,
    };
    for (const [id, w] of Object.entries(want)) expect(W(id).weight, id).toBe(w);
    expect(ITEMS.SEALANT.weight).toBe(2);
  });

  it('門檻是 55 / 78 / 100', () => {
    expect(RULES.backpack.maxWeight).toBe(100);
    expect(RULES.backpack.weightTiers.map((t) => [t.maxWeight, t.moveCost]))
      .toEqual([[55, 10], [78, 12], [100, 14]]);
  });

  it('預設配裝 41.6，落在第一級且有餘裕（§4.3）', () => {
    const c = checkLoadout(defaultLoadout());
    expect(c.weight).toBeCloseTo(41.576, 3);
    expect(c.tier).toBe(0);
    expect(c.moveCost).toBe(10);
    expect(c.overweight).toBe(false);
    expect(c.headroom).toBeCloseTo(13.424, 3);
  });

  it('輕武器彈藥的重量幾乎不構成壓力，真正咬人的是 84mm（§1.3）', () => {
    expect(RULES.calibres['5.56'].weightPerRound * 24).toBeLessThan(1);
    expect(RULES.calibres['84mm'].weightPerRound * 2).toBe(12);
  });

  it('武器重量計入負重 —— 不然「多帶一把槍」就是免費的', () => {
    const s = createInitialState(1, mapById('mission_01')!);
    const p = s.units.find((u) => u.faction === 'PLAYER')!;
    expect(carriedWeight(p) - totalWeight(p.backpack)).toBe(27);   // AR-9 7 + RR-4 20
    expect(carriedWeight(p)).toBeCloseTo(checkLoadout(defaultLoadout()).weight, 3);
  });
});

describe('§5 配裝', () => {
  it('可選內容全部由資料推導，不寫死', () => {
    expect(allAmmoTypes()).toEqual(Object.keys(AMMO_TYPES));
    expect(selectableConsumables()).toContain('SEALANT');
    for (const id of selectableConsumables()) expect(ITEMS[id].use).toBeTruthy();
  });

  it('帶槍不帶對應彈藥 → 警告，但不阻擋（§5.4）', () => {
    const c = checkLoadout({ primary: 'dmr7', stowed: null, ammo: {}, consumables: {} });
    expect(c.warnings.some((w) => w.includes('DMR-7'))).toBe(true);
    expect(c.overweight).toBe(false);            // 警告不是阻擋
  });

  it('什麼武器都不帶也只是警告', () => {
    const c = checkLoadout({ primary: null, stowed: null, ammo: {}, consumables: {} });
    expect(c.warnings.some((w) => w.includes('沒有帶任何武器'))).toBe(true);
    expect(c.overweight).toBe(false);
  });

  it('超重是硬限制', () => {
    const c = checkLoadout({ primary: 'rr4', stowed: 'lmg5', ammo: { 'heat_84mm': 12 }, consumables: {} });
    expect(c.weight).toBeGreaterThan(RULES.backpack.maxWeight);
    expect(c.overweight).toBe(true);
  });

  it('配裝真的變成士兵身上的東西', () => {
    const l: Loadout = {
      primary: 'sg12s', stowed: 'p9',
      ammo: { 'buckshot_12ga': 12, 'standard_9mm': 30 }, consumables: { SEALANT: 2 },
    };
    const s = createInitialState(1, mapById('mission_01')!, l);
    const p = s.units.find((u) => u.faction === 'PLAYER')!;
    expect(p.equipped!.typeId).toBe('sg12s');
    expect(p.stowed!.typeId).toBe('p9');
    expect(countAmmo(p.backpack, 'buckshot_12ga')).toBe(12);
    expect(countAmmo(p.backpack, 'standard_9mm')).toBe(30);
    expect(countAmmo(p.backpack, 'standard_5.56')).toBe(0);
    expect(carriedWeight(p)).toBeCloseTo(loadoutWeight(l), 3);
  });

  it('可以只帶一把，另一欄留空', () => {
    const l: Loadout = { primary: 'p9', stowed: null, ammo: { 'standard_9mm': 20 }, consumables: {} };
    const s = createInitialState(1, mapById('mission_01')!, l);
    const p = s.units.find((u) => u.faction === 'PLAYER')!;
    expect(p.stowed).toBeNull();
    expect(carriedWeight(p)).toBeCloseTo(2 + 20 * 0.024, 3);
  });

  it('決定論不受影響：相同種子 + 相同配裝 → 相同狀態', () => {
    const l: Loadout = { primary: 'dmr7', stowed: 'p9', ammo: { 'standard_7.62': 20 }, consumables: {} };
    const a = createInitialState(4242, mapById('mission_02')!, cloneLoadout(l));
    const b = createInitialState(4242, mapById('mission_02')!, cloneLoadout(l));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('重量明細加起來等於總重', () => {
    const l = defaultLoadout();
    const sum = loadoutBreakdown(l).reduce((a, x) => a + x.weight, 0);
    expect(sum).toBeCloseTo(loadoutWeight(l), 3);
  });
});

describe('§6 至少三種明顯不同、各有適用場合的組合', () => {
  const combos: [string, Loadout][] = [
    ['近遠互補', { primary: 'sg12s', stowed: 'dmr7', ammo: { 'buckshot_12ga': 12, 'standard_7.62': 20 }, consumables: { SEALANT: 1 } }],
    ['通用＋反裝甲', defaultLoadout()],
    ['火力＋應急', { primary: 'lmg5', stowed: 'p9', ammo: { 'standard_5.56': 90, 'standard_9mm': 30 }, consumables: { SEALANT: 1 } }],
    ['狹窄空間', { primary: 'sg12p', stowed: 'ar9', ammo: { 'buckshot_12ga': 20, 'standard_5.56': 32 }, consumables: { SEALANT: 1 } }],
  ];

  it('四種組合都出得了門，而且重量差得出來', () => {
    const ws = combos.map(([, l]) => checkLoadout(l));
    for (const [i, c] of ws.entries()) {
      expect(c.overweight, combos[i][0] + ' 超重').toBe(false);
      expect(c.tier, combos[i][0] + ' 一出門就被拖慢').toBe(0);
    }
    // 最輕與最重的差距要夠大，否則「選哪一組」不構成決定
    const min = Math.min(...ws.map((c) => c.weight));
    const max = Math.max(...ws.map((c) => c.weight));
    expect(max - min).toBeGreaterThan(15);
  });

  it('每種組合的射程涵蓋不同 —— 這才叫組合，不是換皮', () => {
    const spans = combos.map(([, l]) => {
      const rs = [l.primary, l.stowed].filter(Boolean).map((id) => W(id as string).range);
      return { min: Math.min(...rs), max: Math.max(...rs) };
    });
    expect(spans[0].max - spans[0].min).toBeGreaterThan(10);   // 近遠互補真的很互補
    expect(spans[2].max).toBeLessThan(spans[0].max);           // 火力組打不到那麼遠
  });
});
