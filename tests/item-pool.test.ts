/**
 * §2 物品池與敵人抽取。
 *
 * 本節最重要的是那條**不變量**：世界上每一把遺產武器實例，在任何時刻都恰好
 * 存在於一個地方 —— 玩家軍械庫、玩家士兵身上、戰場地面、補給站現貨、
 * 或某個敵人手上。**抽走一把，補給站就少一把。**
 *
 * 「從池中抽出」與「在掉落表上擲出」看起來很像，經濟上完全相反：
 * 若實作成機率生成，v0.20 §2.2 的遺產武器結構性稀缺當場失效。
 */
import { describe, it, expect } from 'vitest';
import type { MetaState, MissionResult } from '../src/core/meta';
import {
  buyWeapon, drawEnemyWeapons, newCompany, recoverBattlefieldWeapons, sellWeapon,
  stampProvenance, wasOurs,
} from '../src/core/meta';
import { isLegacy } from '../src/core/economy';
import { RULES, archetype, mapById } from '../src/core/content';
import { createInitialState, testDeployment } from '../src/core/setup';
import { makeWeapon } from '../src/core/weapon';

const co = (): MetaState => newCompany();
const MAP = mapById('mission_01')!;
const archetypes = (): string[] => MAP.enemies.map((e) => e.archetype);

describe('§2.1 不變量：抽走一把，補給站就少一把', () => {
  it('敵人的武器是從池中**抽出**，不是憑空生成', () => {
    const m = co();
    const before = m.legacyStock.map((w) => w.instanceId);
    const drawn = drawEnemyWeapons(m, 7, archetypes());
    const after = m.legacyStock.map((w) => w.instanceId);
    const takenFromPool = drawn.filter((w) => w && before.includes(w.instanceId));
    // 從池子裡被拿走的，剛好就是池子少掉的那幾把
    expect(before.filter((id) => !after.includes(id)).sort())
      .toEqual(takenFromPool.map((w) => w!.instanceId).sort());
    // 池子只會變少，不會變多
    expect(after.length).toBe(before.length - takenFromPool.length);
  });

  it('土製武器不在池子裡 —— 它現在還做得出來', () => {
    const m = co();
    const drawn = drawEnemyWeapons(m, 3, archetypes()).filter(Boolean);
    const local = drawn.filter((w) => !isLegacy(w!.typeId));
    // localBias 明顯偏向土製，所以大多數敵人拿的是土製槍
    expect(local.length).toBeGreaterThan(0);
    for (const w of local) {
      expect(m.legacyStock.some((x) => x.instanceId === w!.instanceId)).toBe(false);
    }
  });

  it('只有 armed 的原型參與抽取；衝鋒型與裝甲型用內建武器', () => {
    const m = co();
    const kinds = archetypes();
    const drawn = drawEnemyWeapons(m, 5, kinds);
    kinds.forEach((k, i) => {
      if (archetype(k).armed) expect(drawn[i], k).not.toBeNull();
      else expect(drawn[i], k).toBeNull();
    });
  });

  it('池子空了就生成土製武器 —— 敵人不會空手站在那裡', () => {
    const m = co();
    m.legacyStock = [];
    const drawn = drawEnemyWeapons(m, 11, archetypes());
    for (const [i, k] of archetypes().entries()) {
      if (!archetype(k).armed) continue;
      expect(drawn[i], k).not.toBeNull();
      expect(isLegacy(drawn[i]!.typeId), k).toBe(false);
    }
  });

  it('**不排除任何武器類型** —— 抽得到就是抽得到', () => {
    const m = co();
    // 把整份遺產型錄塞進池子，關掉土製偏好，看它會不會挑掉某些型號
    const bias = RULES.enemyWeapons.localBias;
    try {
      RULES.enemyWeapons.localBias = 0;
      const seen = new Set<string>();
      for (let seed = 1; seed < 30; seed++) {
        const mm = co();
        mm.legacyStock = ['ar9', 'rr4', 'dmr7', 'lmg5', 'p9']
          .map((t) => makeWeapon({ nextEntitySerial: seed * 100 }, t));
        for (const w of drawEnemyWeapons(mm, seed, archetypes())) {
          if (w) seen.add(w.typeId);
        }
      }
      expect(seen.has('rr4'), '無後座力砲照樣抽得到').toBe(true);
      expect(seen.has('lmg5'), '輕機槍照樣抽得到').toBe(true);
    } finally {
      RULES.enemyWeapons.localBias = bias;
    }
    void m;
  });

  it('抽到的那幾把真的到了敵人手上（依地圖敵人順序）', () => {
    const m = co();
    const drawn = drawEnemyWeapons(m, 4, archetypes());
    const plan = testDeployment({ nextEntitySerial: 5000 });
    plan.enemyWeapons = drawn;
    const s = createInitialState(4, MAP, plan);
    const foes = s.units.filter((u) => u.faction === 'ENEMY');
    foes.forEach((e, i) => {
      if (!drawn[i]) { expect(e.equipped, e.id).toBeNull(); return; }
      expect(e.equipped!.instanceId, e.id).toBe(drawn[i]!.instanceId);
    });
  });

  it('射擊模式與攜行彈藥在生成時決定，整場不變（§3.2）', () => {
    const s2 = createInitialState(4, MAP);
    for (const e of s2.units.filter((u) => u.faction === 'ENEMY')) {
      if (!archetype(e.archetype).armed) { expect(e.equipped, e.id).toBeNull(); continue; }
      expect(e.equipped, e.id).not.toBeNull();
      expect(e.equipped!.modes).toContain(e.equipped!.mode);
      expect(e.reserveAmmo, e.id).toBe(
        e.equipped!.magazine * RULES.enemyWeapons.reserveMagazines,
      );
    }
  });
});

describe('§2.4 未回收的武器回到池子', () => {
  const result = (over: Partial<MissionResult> = {}): MissionResult => ({
    mapName: 'x', contractCode: 'X', outcome: 'SUCCESS', clock: 1, rating: 'C',
    mainDone: true, secondaryDone: 0, issued: [], issuedWeaponIds: [], leftBehind: [],
    deployedIds: [], deadIds: [], survivorId: null, survivorEquippedId: null,
    survivorStowedId: null, extracted: [], kills: {}, damageTaken: {}, ...over,
  } as MissionResult);

  it('留在戰場上的遺產武器依機率回池，其餘永久銷毀', () => {
    let recovered = 0;
    let destroyed = 0;
    for (let seed = 1; seed < 60; seed++) {
      const m = co();
      m.stockSeed = seed;
      const before = m.legacyStock.length;
      const gun = makeWeapon({ nextEntitySerial: 9000 + seed }, 'dmr7');
      recoverBattlefieldWeapons(m, result({ leftBehind: [gun] }));
      if (m.legacyStock.length > before) recovered++; else destroyed++;
    }
    expect(recovered, '回收會發生').toBeGreaterThan(0);
    expect(destroyed, '銷毀也會發生 —— 那是世界層級的消耗閥').toBeGreaterThan(0);
    // 預設 70/30，樣本 59 次，方向要對得上
    expect(recovered).toBeGreaterThan(destroyed);
  });

  it('土製武器不進回收判定 —— 作坊再做一把就好', () => {
    const m = co();
    const before = m.legacyStock.length;
    const gun = makeWeapon({ nextEntitySerial: 900 }, 'sg12p');
    recoverBattlefieldWeapons(m, result({ leftBehind: [gun] }));
    expect(m.legacyStock.length).toBe(before);
  });

  it('帶回來的槍不會被當成留在戰場上', () => {
    const m = co();
    const before = m.legacyStock.length;
    const gun = makeWeapon({ nextEntitySerial: 901 }, 'dmr7');
    recoverBattlefieldWeapons(m, result({
      leftBehind: [gun],
      extracted: [{
        id: 'W', kind: 'WEAPON', defId: 'WEAPON', name: gun.name,
        weight: gun.weight, qty: 1, weapon: gun,
      }],
    }));
    expect(m.legacyStock.length).toBe(before);
  });

  it('賣掉的遺產武器回到池子 —— 它沒有消失，只是換了位置', () => {
    const m = co();
    const w = m.armoury.find((x) => isLegacy(x.typeId))!;
    const before = m.legacyStock.length;
    sellWeapon(m, w.instanceId);
    expect(m.legacyStock.map((x) => x.instanceId)).toContain(w.instanceId);
    expect(m.legacyStock.length).toBe(before + 1);
    expect(m.armoury.map((x) => x.instanceId)).not.toContain(w.instanceId);
  });
});

describe('§4.5 識別自己的東西', () => {
  it('進過軍械庫的槍帶著本公司的章', () => {
    const m = co();
    for (const w of m.armoury) expect(wasOurs(w), w.instanceId).toBe(true);
  });

  it('買來的也一樣 —— 章蓋在「曾經屬於我們」這件事上', () => {
    const m = co();
    const w = m.legacyStock[0];
    buyWeapon(m, w.instanceId);
    expect(wasOurs(w)).toBe(true);
  });

  it('來歷只存勢力名稱，不存帳號或使用者識別', () => {
    const m = co();
    const w = stampProvenance(m, makeWeapon({ nextEntitySerial: 1 }, 'ar9'), 'ISSUED');
    for (const p of w.provenance) {
      expect(p.actor).toBe(RULES.meta.companyName);
      expect(p).not.toHaveProperty('userId');
      expect(p).not.toHaveProperty('account');
    }
  });

  it('同一個事件不會重複蓋章', () => {
    const m = co();
    const w = makeWeapon({ nextEntitySerial: 1 }, 'ar9');
    stampProvenance(m, w, 'ISSUED');
    stampProvenance(m, w, 'ISSUED');
    expect(w.provenance.filter((p) => p.event === 'ISSUED')).toHaveLength(1);
  });
});
