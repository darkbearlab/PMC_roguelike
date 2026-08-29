/**
 * 經濟層（v0.20）。
 *
 * 這一版之前，玩家全滅之後免費補滿 —— 緊張感是真的，**但後果不是**。
 * 所以這一組測試守的是「代價真的存在，而且算得出來」。
 *
 * 價格結構只有一句話：**人可以再長，好槍不行。**
 */
import { describe, expect, it } from 'vitest';
import { ECONOMY, WEAPONS } from '../src/core/content';
import {
  ammoPrice, contractReward, debtTier, isLegacy, legacyStockFromSeed, localCatalogue,
  secondaryReward, sellValue, soldierPrice, weaponPrice,
} from '../src/core/economy';
import { makeWeapon } from '../src/core/weapon';
import type { MetaState, MissionResult } from '../src/core/meta';
import {
  assignWeapon, buySoldier, buyWeapon, freeAmmo, grantAmmo, grantWeapon, makeDeployment,
  missionLedger, newCompany, sellStock, sellWeapon, settleMission,
} from '../src/core/meta';

const co = (): MetaState => newCompany();
const P = ECONOMY.baseReward;

describe('§2.1 人便宜，好槍貴', () => {
  it('一名複製人約是 C 級合約報酬的一半', () => {
    expect(soldierPrice()).toBe(Math.round(0.5 * P));
    expect(soldierPrice()).toBeLessThan(contractReward('C'));
  });

  it('遺產武器明顯貴於土製武器', () => {
    const legacy = WEAPONS.filter((w) => w.origin === 'LEGACY').map((w) => weaponPrice(w.id));
    const local = WEAPONS.filter((w) => w.origin === 'LOCAL').map((w) => weaponPrice(w.id));
    expect(Math.min(...legacy)).toBeGreaterThan(Math.max(...local) * 3);
  });

  it('**最便宜的遺產武器仍然貴過一名士兵** —— 人可以再長，好槍不行', () => {
    const cheapest = Math.min(...WEAPONS.filter((w) => w.origin === 'LEGACY')
      .map((w) => weaponPrice(w.id)));
    expect(cheapest).toBeGreaterThan(soldierPrice());
  });

  it('分界線是自動循環：手動循環的是土製的，其餘都是遺產', () => {
    // 內建近戰不上架 —— 它長在身上，不是一件商品（§1.2）
    expect(localCatalogue().sort()).toEqual(['rb7', 'sg12p', 'sg12s']);
    expect(isLegacy('ar9')).toBe(true);
    expect(isLegacy('sg12s')).toBe(false);
    expect(isLegacy('rb7'), '拉栓是手動循環，所以做得出來').toBe(false);
  });
});

describe('§2.2 遺產武器的稀缺是結構性的', () => {
  it('現貨是 1～3 件，而且只有遺產武器', () => {
    for (let seed = 1; seed < 40; seed++) {
      const stock = legacyStockFromSeed(seed);
      expect(stock.length).toBeGreaterThanOrEqual(ECONOMY.legacyStock.min);
      expect(stock.length).toBeLessThanOrEqual(ECONOMY.legacyStock.max);
      expect(new Set(stock).size, '同一批不重複').toBe(stock.length);
      for (const id of stock) expect(isLegacy(id), id).toBe(true);
    }
  });

  it('**不保證你想要的型號會出現**', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed < 30; seed++) {
      const stock = legacyStockFromSeed(seed);
      if (!stock.includes('rr4')) seen.add('缺過 RR-4');
      if (!stock.includes('lmg5')) seen.add('缺過 LMG-5');
    }
    expect(seen.size).toBe(2);
  });

  it('**現貨不會重抽** —— 重抽會憑空生出武器，也會憑空消滅武器', () => {
    const m = co();
    const before = m.legacyStock.map((w) => w.instanceId);
    const r = base(m);
    const { meta: after } = settleMission(m, r);
    expect(after.contractsCompleted).toBe(1);
    // 這一場什麼都沒留在戰場上，所以池子一件不多、一件不少
    expect(after.legacyStock.map((w) => w.instanceId)).toEqual(before);
    expect(m.legacyStock.every((w) => isLegacy(w.typeId))).toBe(true);
    // 同一份存檔重跑一次，結果一模一樣（決定論）
    const again = settleMission(m, r).meta;
    expect(again.legacyStock.map((w) => w.instanceId))
      .toEqual(after.legacyStock.map((w) => w.instanceId));
  });

  it('買走就沒了 —— 架上擺的是實例，不是型號', () => {
    const m = co();
    const w = m.legacyStock[0];
    expect(buyWeapon(m, w.instanceId)).not.toBeNull();
    expect(m.legacyStock.map((x) => x.instanceId)).not.toContain(w.instanceId);
    expect(m.armoury.map((x) => x.instanceId), '換了位置，不是被複製')
      .toContain(w.instanceId);
    // 架上沒有的遺產武器買不到 —— 型號 id 也買不到，因為架上賣的不是型號
    expect(buyWeapon(m, 'dmr7')).toBeNull();
    // 土製的隨時買得到
    expect(buyWeapon(m, 'sg12p')).not.toBeNull();
  });
});

/** 一份最小的任務結果，預設什麼都沒發生。 */
function base(m: MetaState, over: Partial<MissionResult> = {}): MissionResult {
  return {
    mapName: '測試場', contractCode: '委-TEST', rating: 'C',
    outcome: 'SUCCESS', clock: 100, mainDone: true, secondaryDone: 0,
    issued: [], issuedWeaponIds: [], leftBehind: [], deployedIds: [m.roster[0].id], deadIds: [],
    survivorId: null, survivorEquippedId: null, survivorStowedId: null,
    extracted: [], kills: {}, damageTaken: {}, ...over,
  };
}

describe('§3.1 合約報酬', () => {
  it('報酬依難度評級縮放', () => {
    expect(contractReward('C')).toBe(P);
    expect(contractReward('S')).toBeGreaterThan(contractReward('A'));
    expect(contractReward('A')).toBeGreaterThan(contractReward('B'));
    expect(contractReward('B')).toBeGreaterThan(contractReward('C'));
  });

  it('**主目標完成才給主要報酬**', () => {
    const m = co();
    const done = settleMission(m, base(m, { mainDone: true }));
    const notDone = settleMission(m, base(m, { mainDone: false, outcome: 'ABORTED' }));
    expect(done.ledger.reward).toBe(contractReward('C'));
    expect(notDone.ledger.reward).toBe(0);
  });

  it('止損撤離時仍然拿得到已完成的次要目標獎金', () => {
    const m = co();
    const { ledger } = settleMission(m, base(m, {
      mainDone: false, secondaryDone: 2, outcome: 'ABORTED',
    }));
    expect(ledger.reward).toBe(0);
    expect(ledger.secondary).toBe(secondaryReward('C', 2));
    expect(ledger.creditsEarned).toBeGreaterThan(0);
  });

  it('報酬真的入帳', () => {
    const m = co();
    const before = m.credits;
    const { meta } = settleMission(m, base(m));
    expect(meta.credits).toBe(before + contractReward('C'));
  });
});

describe('§2.3 設計意圖：打得好與打得爛的差別', () => {
  const withGun = (): { m: MetaState; id: string; gun: string } => {
    const m = co();
    const s = m.roster[0];
    const w = m.armoury.find((x) => x.typeId === 'ar9')!;
    assignWeapon(m, w.instanceId, s.id, 'equipped');
    return { m, id: s.id, gun: w.instanceId };
  };

  it('零陣亡完成一份合約 → 純利約一份報酬', () => {
    const { m, id, gun } = withGun();
    const { ledger } = settleMission(m, base(m, {
      deployedIds: [id], survivorId: id, survivorEquippedId: gun, issuedWeaponIds: [gun],
      extracted: [{
        id: 'W', kind: 'WEAPON', defId: 'WEAPON', name: 'AR-9', weight: 7, qty: 1,
        weapon: m.armoury.find((x) => x.instanceId === gun)!,
      }],
    }));
    expect(ledger.weaponsLost).toBe(0);
    expect(ledger.net).toBeCloseTo(contractReward('C'), -1);
  });

  it('陣亡一人並丟掉他的槍 → 大幅吃掉利潤', () => {
    const { m, id, gun } = withGun();
    const { ledger } = settleMission(m, base(m, {
      deployedIds: [id], deadIds: [id], issuedWeaponIds: [gun],
    }));
    expect(ledger.soldiersLost).toBe(soldierPrice());
    expect(ledger.weaponsLost).toBe(sellValue(weaponPrice('ar9')));
    expect(ledger.net).toBeLessThan(contractReward('C'));
  });

  it('遺留一把遺產武器**比死一個士兵更痛**（§8.3 的設計意圖）', () => {
    expect(sellValue(weaponPrice('rr4'))).toBeGreaterThan(soldierPrice());
    expect(sellValue(weaponPrice('lmg5'))).toBeGreaterThan(soldierPrice());
  });

  it('全滅：相當於欠下一份以上合約的收入', () => {
    const m = co();
    const ids = m.roster.map((s) => s.id);
    m.roster.forEach((s, i) => {
      const w = m.armoury[i];
      if (w) assignWeapon(m, w.instanceId, s.id, 'equipped');
    });
    const guns = m.armoury.map((w) => w.instanceId);
    const { ledger } = settleMission(m, base(m, {
      outcome: 'WIPED', mainDone: false, deployedIds: ids, deadIds: ids, issuedWeaponIds: guns,
    }));
    expect(ledger.reward).toBe(0);
    expect(ledger.net).toBeLessThan(-contractReward('C'));
  });
});

describe('§3.2 出售', () => {
  it('售價是買價乘上折扣', () => {
    expect(sellValue(1000)).toBe(Math.round(1000 * ECONOMY.sellDiscount));
    expect(ECONOMY.sellDiscount).toBeGreaterThan(0);
    expect(ECONOMY.sellDiscount).toBeLessThan(1);
  });

  it('賣掉未指派的槍，錢進帳、槍離開軍械庫', () => {
    const m = co();
    const w = m.armoury.find((x) => x.typeId === 'ar9')!;
    const before = m.credits;
    const got = sellWeapon(m, w.instanceId);
    expect(got).toBe(sellValue(weaponPrice('ar9')));
    expect(m.credits).toBe(before + got);
    expect(m.armoury.some((x) => x.instanceId === w.instanceId)).toBe(false);
  });

  it('**有人拿著的槍不能賣** —— 先在配裝畫面收回來', () => {
    const m = co();
    const w = m.armoury[0];
    assignWeapon(m, w.instanceId, m.roster[0].id, 'equipped');
    const before = m.credits;
    expect(sellWeapon(m, w.instanceId)).toBe(0);
    expect(m.credits).toBe(before);
    expect(m.armoury.some((x) => x.instanceId === w.instanceId)).toBe(true);
  });

  it('雜物終於有用途了 —— 從 v0.9 躺到現在', () => {
    const m = co();
    m.salvage = { SCRAP: 3, CORE: 1, DNA: 2 };
    const before = m.credits;
    expect(sellStock(m, 'CORE', 1)).toBeGreaterThan(0);
    expect(sellStock(m, 'DNA', 2)).toBeGreaterThan(0);
    expect(m.credits).toBeGreaterThan(before);
    expect(m.salvage.CORE).toBeUndefined();
    expect(m.salvage.DNA).toBeUndefined();
  });

  it('賣掉共用庫存的彈藥', () => {
    const m = co();
    const n = freeAmmo(m, 'standard_5.56');
    expect(sellStock(m, 'standard_5.56', n)).toBe(sellValue(ammoPrice('standard_5.56', n)));
    expect(freeAmmo(m, 'standard_5.56')).toBe(0);
  });
});

describe('§4 債務：系統不禁止，只標價', () => {
  it('信用點可以為負，買東西不會被擋下來', () => {
    const m = co();
    m.credits = 0;
    for (let i = 0; i < 5; i++) buySoldier(m);
    expect(m.credits).toBeLessThan(0);
    expect(m.roster.length).toBe(newCompany().roster.length + 5);
  });

  it('**信用點為負時仍可取得基礎複製人**（§4.4 的保底）', () => {
    const m = co();
    m.credits = -99999;
    const n = m.roster.length;
    buySoldier(m);
    expect(m.roster.length).toBe(n + 1);
  });

  it('負債分三級，越欠越深', () => {
    expect(debtTier(10)).toBeNull();
    expect(debtTier(0)).toBeNull();
    expect(debtTier(-1)).toBe('MILD');
    expect(debtTier(-100000)).toBe('DIRE');
    const tiers = ECONOMY.debtTiers.map((t) => t.id);
    expect(tiers).toEqual(['MILD', 'SEVERE', 'DIRE']);
  });

  it('負債時會收到董事會的信，同一級只寄一次', () => {
    const m = co();
    m.credits = -10;
    const r = base(m, { mainDone: false, outcome: 'ABORTED' });
    const first = settleMission(m, r).meta;
    expect(first.mail).toEqual(['MILD']);
    const second = settleMission(first, r).meta;
    expect(second.mail).toEqual(['MILD']);      // 同一級不重複
    second.credits = ECONOMY.debtTiers[2].below - 1;
    const third = settleMission(second, r).meta;
    expect(third.mail).toContain('DIRE');
  });

  it('沒有硬性失敗 —— 負債不會讓任何東西變成不可用', () => {
    const m = co();
    m.credits = -5000;
    expect(() => {
      buySoldier(m);
      grantWeapon(m, 'sg12p');
      grantAmmo(m, 'standard_5.56', 24);
      settleMission(m, base(m));
    }).not.toThrow();
  });
});

describe('§5.4 損益表', () => {
  it('分得出「真的入帳」與「估值」', () => {
    const m = co();
    const { ledger } = settleMission(m, base(m, {
      secondaryDone: 1,
      extracted: [{
        id: 'S', kind: 'VALUABLE', defId: 'CORE', name: '動力核心',
        weight: 6, qty: 2, value: 5,
      }],
    }));
    expect(ledger.creditsEarned).toBe(ledger.reward + ledger.secondary);
    expect(ledger.salvage).toBeGreaterThan(0);
    // 戰利品沒有直接入帳 —— 要拿去補給站賣
    expect(ledger.net).toBe(ledger.creditsEarned + ledger.salvage
      - ledger.soldiersLost - ledger.weaponsLost - ledger.suppliesLost);
  });

  it('消耗掉的物資 = 帶出去的減掉帶回來的', () => {
    const m = co();
    const { ledger } = settleMission(m, base(m, {
      issued: [{ defId: 'standard_5.56', qty: 24 }],
      extracted: [{
        id: 'A', kind: 'AMMO', defId: 'standard_5.56', name: '5.56 步槍彈',
        weight: 0.024, qty: 9, ammoTypeId: 'standard_5.56',
      }],
    }));
    expect(ledger.suppliesLost).toBe(sellValue(ammoPrice('standard_5.56', 15)));
  });

  it('**自己發下去的彈藥帶回來不算收益** —— 那只是沒有損耗', () => {
    const m = co();
    const { ledger } = settleMission(m, base(m, {
      issued: [{ defId: 'standard_5.56', qty: 60 }],
      extracted: [{
        id: 'A', kind: 'AMMO', defId: 'standard_5.56', name: '5.56 步槍彈',
        weight: 0.024, qty: 60, ammoTypeId: 'standard_5.56',
      }],
    }));
    expect(ledger.salvage).toBe(0);
    expect(ledger.suppliesLost).toBe(0);
  });

  it('從自己屍體撿回整套裝備 = 打平，不是賺錢', () => {
    const m = co();
    const w = m.armoury[0];
    const { ledger } = settleMission(m, base(m, {
      issuedWeaponIds: [w.instanceId],
      issued: [{ defId: 'standard_5.56', qty: 60 }],
      extracted: [
        { id: 'W', kind: 'WEAPON', defId: 'WEAPON', name: w.name,
          weight: w.weight, qty: 1, weapon: w },
        { id: 'A', kind: 'AMMO', defId: 'standard_5.56', name: '5.56 步槍彈',
          weight: 0.024, qty: 60, ammoTypeId: 'standard_5.56' },
      ],
    }));
    // 回去撿屍體是止血，不是發財：損益回到「只有合約報酬」那一格。
    expect(ledger.net).toBe(ledger.creditsEarned);
    expect(ledger.salvage).toBe(0);
    expect(ledger.weaponsLost).toBe(0);
    expect(ledger.suppliesLost).toBe(0);
  });

  it('超出發放量的部分才是真的撿到的', () => {
    const m = co();
    const { ledger } = settleMission(m, base(m, {
      issued: [{ defId: 'standard_5.56', qty: 24 }],
      extracted: [{
        id: 'A', kind: 'AMMO', defId: 'standard_5.56', name: '5.56 步槍彈',
        weight: 0.024, qty: 40, ammoTypeId: 'standard_5.56',
      }],
    }));
    expect(ledger.salvage).toBe(sellValue(ammoPrice('standard_5.56', 16)));
    expect(ledger.suppliesLost).toBe(0);
  });

  it('帶回來的槍不算戰利品收入 —— 它回到軍械庫，不是賣掉', () => {
    const m = co();
    const w = m.armoury[0];
    const { ledger } = settleMission(m, base(m, {
      issuedWeaponIds: [w.instanceId],
      extracted: [{
        id: 'W', kind: 'WEAPON', defId: 'WEAPON', name: w.name,
        weight: w.weight, qty: 1, weapon: w,
      }],
    }));
    expect(ledger.salvage).toBe(0);
    expect(ledger.weaponsLost).toBe(0);
  });

  it('任務紀錄記下損益', () => {
    const m = co();
    const { meta, ledger } = settleMission(m, base(m));
    expect(meta.missionLog[0].net).toBe(ledger.net);
  });

  it('missionLedger 是純函數：不動 MetaState', () => {
    const m = co();
    const snapshot = JSON.stringify(m);
    missionLedger(m, base(m, { deadIds: [m.roster[0].id] }));
    expect(JSON.stringify(m)).toBe(snapshot);
  });
});

describe('§6 存檔', () => {
  it('新的欄位都在，schemaVersion 已遞增', () => {
    const m = co();
    expect(typeof m.credits).toBe('number');
    expect(m.contractsCompleted).toBe(0);
    expect(Array.isArray(m.legacyStock)).toBe(true);
    expect(typeof m.stockSeed).toBe('number');
    expect(m.mail).toEqual([]);
    expect(m.schemaVersion).toBeGreaterThanOrEqual(2);
  });

  it('整份狀態仍可完整序列化還原', () => {
    const m = co();
    const { meta } = settleMission(m, base(m));
    const round = JSON.parse(JSON.stringify(meta)) as MetaState;
    expect(round.credits).toBe(meta.credits);
    expect(round.legacyStock).toEqual(meta.legacyStock);
    // 還原之後接著抽現貨，結果與沒還原時相同
    expect(settleMission(round, base(round)).meta.legacyStock)
      .toEqual(settleMission(meta, base(meta)).meta.legacyStock);
  });

  it('派遣快照不受經濟層影響 —— 任務仍然不讀 MetaState', () => {
    const m = co();
    assignWeapon(m, m.armoury[0].instanceId, m.roster[0].id, 'equipped');
    const plan = makeDeployment(m, m.roster[0].id);
    expect(JSON.stringify(plan)).not.toContain('credits');
    expect(JSON.stringify(plan)).not.toContain('legacyStock');
  });
});

describe('§5 損益表的資產區塊', () => {
  it('武器不進現金損益 —— 兩條底線，資產不計入損益', () => {
    const m = co();
    const w = m.armoury[0];
    const { ledger } = settleMission(m, base(m, {
      issuedWeaponIds: [w.instanceId],
    }));
    // 帶出去沒帶回來 → 資產損失，但現金損益裡看不到它
    expect(ledger.assetsLost).toHaveLength(1);
    expect(ledger.assetsLost[0].name).toBe(w.name);
    expect(ledger.assetNet).toBeLessThan(0);
    expect(ledger.net).toBe(ledger.creditsEarned + ledger.salvage
      - ledger.soldiersLost - ledger.suppliesLost);
  });

  it('撿到的槍列在「取得」，一樣不進現金損益', () => {
    const m = co();
    const loot = makeWeapon({ nextEntitySerial: 7000 }, 'dmr7');
    const { ledger } = settleMission(m, base(m, {
      extracted: [{
        id: 'W', kind: 'WEAPON', defId: 'WEAPON', name: loot.name,
        weight: loot.weight, qty: 1, weapon: loot,
      }],
    }));
    expect(ledger.assetsGained).toHaveLength(1);
    expect(ledger.assetsGained[0].value).toBeGreaterThan(0);
    expect(ledger.assetNet).toBeGreaterThan(0);
    expect(ledger.salvage, '槍不是戰利品收入').toBe(0);
    expect(ledger.net, '現金損益只有合約報酬').toBe(ledger.creditsEarned);
  });

  it('自己帶出去又帶回來的槍**兩邊都不列** —— 什麼都沒發生', () => {
    const m = co();
    const w = m.armoury[0];
    const { ledger } = settleMission(m, base(m, {
      issuedWeaponIds: [w.instanceId],
      extracted: [{
        id: 'W', kind: 'WEAPON', defId: 'WEAPON', name: w.name,
        weight: w.weight, qty: 1, weapon: w,
      }],
    }));
    expect(ledger.assetsGained).toHaveLength(0);
    expect(ledger.assetsLost).toHaveLength(0);
    expect(ledger.assetNet).toBe(0);
  });
});
