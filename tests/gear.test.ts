/**
 * 任務中的裝備管理（v0.18）。
 *
 * 這一版補的是一個**缺失的動詞**。實測發現：空投下來的替補走到屍體旁邊，
 * 屍體上躺著一把無後座力砲，但他自己的主手與收納欄都滿了 ——
 * 而遊戲裡沒有任何動作可以騰出位置。
 *
 * **這使本作的核心決策整個失效。**「要不要冒險走回去撿自己的屍體」
 * 從第一輪設計到現在是這款遊戲最重要的單一決策，
 * 而玩家走過去之後做不了任何事。
 */
import { describe, expect, it } from 'vitest';
import { checkLegal, commandTime } from '../src/core/commands';
import { RULES } from '../src/core/content';
import { carriedWeight, countAmmo } from '../src/core/inventory';
import { player, run, testState, testWeapon, weaponIndexIn } from './helpers';
import { lootAt } from '../src/core/state';
import type { GameState } from '../src/core/state';

const ROOM = [
  '##############',
  '#D...........#',
  '#............#',
  '#...........T#',
  '##############',
];

const bagWeapons = (s: GameState): string[] =>
  player(s).backpack!.items.filter((it) => it.kind === 'WEAPON').map((it) => it.weapon!.typeId);

describe('§2.1 三個新的裝備移動動作', () => {
  it('主手 → 背包：手上空出來，槍還在身上', () => {
    let s = testState(ROOM);
    const gun = player(s).equipped!;
    expect(commandTime(s, { type: 'MOVE_GEAR', from: 'EQUIPPED', to: 'BACKPACK' })).toBe(10);
    s = run(s, { type: 'MOVE_GEAR', from: 'EQUIPPED', to: 'BACKPACK' });
    expect(player(s).equipped).toBeNull();
    expect(bagWeapons(s)).toContain('ar9');
    // 三個位置都計入負重 → 搬動不改變總重
    expect(player(s).backpack!.items.some((it) => it.weapon?.instanceId === gun.instanceId)).toBe(true);
    expect(player(s).nextActAt).toBe(10);
  });

  it('收納欄 → 背包：花費依**被搬動的那一把**（RR-4 是重武器）', () => {
    let s = testState(ROOM);
    expect(commandTime(s, { type: 'MOVE_GEAR', from: 'STOWED', to: 'BACKPACK' })).toBe(20);
    s = run(s, { type: 'MOVE_GEAR', from: 'STOWED', to: 'BACKPACK' });
    expect(player(s).stowed).toBeNull();
    expect(bagWeapons(s)).toContain('rr4');
    expect(player(s).nextActAt).toBe(20);
  });

  it('背包 → 收納欄：這就是 v0.9 規格預期、但一直沒實作的那個動作', () => {
    let s = testState(ROOM);
    s = run(s, { type: 'MOVE_GEAR', from: 'STOWED', to: 'BACKPACK' });
    const it = player(s).backpack!.items.find((x) => x.kind === 'WEAPON')!;
    expect(player(s).stowed).toBeNull();
    s = run(s, { type: 'MOVE_GEAR', from: 'BACKPACK', to: 'STOWED', itemId: it.id });
    expect(player(s).stowed!.typeId).toBe('rr4');
    expect(bagWeapons(s)).not.toContain('rr4');
  });

  it('目的地有東西就對調，換出來的那把進背包', () => {
    let s = testState(ROOM);
    const p = player(s);
    const extra = testWeapon('p9');
    p.backpack!.items.push({
      id: 'W-EXTRA', kind: 'WEAPON', defId: 'WEAPON', name: extra.name,
      weight: extra.weight, qty: 1, weapon: extra,
    });
    s = run(s, { type: 'MOVE_GEAR', from: 'BACKPACK', to: 'STOWED', itemId: 'W-EXTRA' });
    expect(player(s).stowed!.typeId).toBe('p9');
    expect(bagWeapons(s)).toEqual(['rr4']);   // 被換出來的 RR-4 進了背包
  });

  it('搬動不改變身上的總重 —— 三個位置都算', () => {
    let s = testState(ROOM);
    const before = carriedWeight(player(s));
    s = run(s, { type: 'MOVE_GEAR', from: 'EQUIPPED', to: 'BACKPACK' });
    expect(carriedWeight(player(s))).toBeCloseTo(before, 3);
    s = run(s, { type: 'MOVE_GEAR', from: 'STOWED', to: 'BACKPACK' });
    expect(carriedWeight(player(s))).toBeCloseTo(before, 3);
  });

  it('非法情況會被擋下，而且說得出原因', () => {
    let s = testState(ROOM);
    expect(checkLegal(s, { type: 'MOVE_GEAR', from: 'BACKPACK', to: 'EQUIPPED' }).ok).toBe(false);
    expect(checkLegal(s, { type: 'MOVE_GEAR', from: 'STOWED', to: 'STOWED' }).ok).toBe(false);
    expect(checkLegal(s, { type: 'MOVE_GEAR', from: 'BACKPACK', to: 'STOWED' }).ok).toBe(false);
    s = run(s, { type: 'MOVE_GEAR', from: 'EQUIPPED', to: 'BACKPACK' });
    const legal = checkLegal(s, { type: 'MOVE_GEAR', from: 'EQUIPPED', to: 'BACKPACK' });
    expect(legal.ok).toBe(false);
    expect(legal.reason).toContain('手上沒有武器');
  });

  it('丟棄仍然不花時間（v0.12 §5.4 不變）', () => {
    let s = testState(ROOM);
    s = run(s, { type: 'MOVE_GEAR', from: 'EQUIPPED', to: 'BACKPACK' });
    const it = player(s).backpack!.items.find((x) => x.kind === 'WEAPON')!;
    const before = player(s).nextActAt;
    s = run(s, { type: 'DROP', itemId: it.id });
    expect(player(s).nextActAt).toBe(before);
    expect(RULES.time.drop).toBe(0);
  });
});

describe('§2.2 收納欄為空時可直接拾取到收納欄', () => {
  it('只花 10 時間，不必先進背包再換一次', () => {
    let s = testState(ROOM);
    s = run(s, { type: 'MOVE_GEAR', from: 'STOWED', to: 'BACKPACK' });
    const it = player(s).backpack!.items.find((x) => x.kind === 'WEAPON')!;
    s = run(s, { type: 'DROP', itemId: it.id });
    const pile = lootAt(s, player(s).pos)!;
    const idx = weaponIndexIn(pile, 'rr4');
    const before = player(s).nextActAt;
    s = run(s, { type: 'PICKUP', lootId: pile.id, itemIndex: idx, slot: 'STOWED' });
    expect(player(s).stowed!.typeId).toBe('rr4');
    expect(player(s).nextActAt - before).toBe(RULES.loot.takeTime);
  });
});

describe('§4 核心情境：替補接手前一個人的裝備', () => {
  it('七個步驟全部可行，而且回收的是**原本那一把槍**', () => {
    let s = testState(ROOM);
    const a = player(s);
    const rr4Id = a.stowed!.instanceId;
    a.pos = { x: 6, y: 1 };
    // 1. A 陣亡，屍體上有兩把槍與整個背包
    a.hp = 3;
    s = run(s, { type: 'FIRE', target: { x: 6, y: 1 } });
    const body = s.loot.find((c) => c.kind === 'PLAYER_BODY')!;
    expect(body.items.some((it) => it.weapon?.instanceId === rr4Id)).toBe(true);

    // 2-3. B 空投下來，帶著自己的配裝（測試快照給的是 AR-9 + RR-4），走到屍體旁
    s = run(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] });
    const b = player(s);
    b.pos = { x: 6, y: 1 };
    b.nextActAt = s.clock;
    expect(b.equipped).not.toBeNull();
    expect(b.stowed).not.toBeNull();

    // 4. 把自己的槍移進背包騰出位置，再從屍體拿走 A 的 RR-4
    s = run(s, { type: 'MOVE_GEAR', from: 'STOWED', to: 'BACKPACK' });
    const pile = lootAt(s, { x: 6, y: 1 })!;
    const idx = pile.items.findIndex((it) => it.weapon?.instanceId === rr4Id);
    expect(idx).toBeGreaterThanOrEqual(0);
    s = run(s, { type: 'PICKUP', lootId: pile.id, itemIndex: idx, slot: 'STOWED' });
    expect(player(s).stowed!.instanceId).toBe(rr4Id);

    // 5. 一併取走屍體上的彈藥
    const ammoBefore = countAmmo(player(s).backpack, 'standard_5.56');
    const ai = lootAt(s, { x: 6, y: 1 })!.items.findIndex((it) => it.ammoTypeId === 'standard_5.56');
    if (ai >= 0) {
      s = run(s, { type: 'PICKUP', lootId: pile.id, itemIndex: ai });
      expect(countAmmo(player(s).backpack, 'standard_5.56')).toBeGreaterThan(ammoBefore);
    }

    // 6-7. 帶著走 —— 身上那把仍是 A 原本那一把
    expect(player(s).stowed!.instanceId).toBe(rr4Id);
  });
});
