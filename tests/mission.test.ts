import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isPlayerTurn } from '../src/core/scheduler';
import { checkLegal } from '../src/core/commands';
import { abandonedItems, lootAt } from '../src/core/state';
import { run, testState, player, unit, freezeCombat, thawCombat, weaponIds, weaponIndexIn } from './helpers';

const ROOM = [
  '################',
  '#D....D.......T#',
  '#..............#',
  '#..............#',
  '#S............S#',
  '################',
];

function runEnemyTurn(s0: ReturnType<typeof testState>) {
  let s = s0;
  let guard = 0;
  while (!isPlayerTurn(s) && !s.pendingReinforcement && guard++ < 500) {
    s = run(s, { type: 'ADVANCE' });
  }
  return s;
}

// 這一檔測的是死亡與任務流程，不是命中率：凍結浮動，讓「開一槍打死自己」必定成立。
beforeAll(() => freezeCombat());
afterAll(() => thawCombat());

describe('§10 死亡、增援與屍體', () => {
  it('陣亡後留下屍體，屍體內含身上所有武器（含收納的重武器）', () => {
    let s = testState(ROOM);
    const p = player(s);
    p.hp = 3;
    // canAttack 不限制目標陣營（§8.2 刻意不做友軍傷害豁免），
    // 因此測試可以直接讓士兵對自己開一槍製造陣亡。
    s = run(s, { type: 'FIRE', target: p.pos }); // AR-9 傷害 3
    expect(s.casualties).toBe(1);
    expect(s.loot).toHaveLength(1);
    expect(weaponIds(s.loot[0]).sort()).toEqual(['ar9', 'rr4']);
    expect(s.pendingReinforcement).not.toBeNull();
    expect(s.activePlayerUnitId).toBeNull();
  });

  it('替補帶著自己的配裝，AP 為 0，從最近的空投點出現（v0.16 §4.2）', () => {
    let s = testState(ROOM);
    const p = player(s);
    p.hp = 3;
    p.pos = { x: 7, y: 1 };   // 靠近第二個空投點 (6,1)
    // 插隊版：只有已啟用的空投點可以降落。先啟用 (6,1)，
    // 否則替補只能回到起始空投點 —— 這正是「保險要事先買」的意思。
    s.activatedDrops.push('6,1');
    s = run(s, { type: 'FIRE', target: p.pos });
    expect(s.pendingReinforcement!.deathPos).toEqual({ x: 7, y: 1 });

    const next = s.roster[0];
    s = run(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: next });
    const fresh = unit(s, next);
    expect(fresh.pos).toEqual({ x: 6, y: 1 });      // 最近的空投點，不是起點
    // v0.16：替補不再是「配發一把 AR-9」，而是帶著他自己的配裝降落。
    // 測試用的派遣快照給每個人 AR-9 + RR-4，所以兩把都在。
    expect(fresh.equipped!.typeId).toBe('ar9');
    expect(fresh.equipped!.ammo).toBe(8);
    expect(fresh.stowed!.typeId).toBe('rr4');
    // 而且是**他自己那一把**，不是死者留在地上的那一把
    const corpse = s.loot.find((c) => c.kind === 'PLAYER_BODY')!;
    const onGround = corpse.items.filter((it) => it.kind === 'WEAPON')
      .map((it) => it.weapon!.instanceId);
    expect(onGround).not.toContain(fresh.equipped!.instanceId);
    expect(onGround).not.toContain(fresh.stowed!.instanceId);
    expect(s.deployed).toBe(2);
    expect(s.pendingReinforcement).toBeNull();
  });

  it('可以走回屍體處花 time.pickup 撿回重武器', () => {
    let s = testState(ROOM);
    const p = player(s);
    p.hp = 3;
    p.pos = { x: 6, y: 1 };
    s.activatedDrops.push('6,1');
    s = run(s, { type: 'FIRE', target: p.pos });
    s = run(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] });
    s = runEnemyTurn(s);

    const corpse = lootAt(s, { x: 6, y: 1 })!;
    expect(corpse).toBeTruthy();
    expect(player(s).pos).toEqual({ x: 6, y: 1 }); // 空投點就在屍體上
    const rrIndex = weaponIndexIn(corpse, 'rr4');

    const before = player(s).nextActAt;
    s = run(s, {
      type: 'PICKUP', lootId: corpse.id, itemIndex: rrIndex, slot: 'STOWED',
    });
    expect(player(s).stowed!.typeId).toBe('rr4');
    expect(player(s).nextActAt).toBeGreaterThan(before);   // 拾取花了時間
    // v0.16：替補自己也帶著一把 RR-4，換上死者那把之後自己那把落在同一堆上。
    // 這正是實例化的用處 —— 兩把同型號的槍分得出來是哪一把。
    expect(weaponIds(lootAt(s, { x: 6, y: 1 })).sort()).toEqual(['ar9', 'rr4']);
    const pile = lootAt(s, { x: 6, y: 1 })!;
    const left = pile.items.filter((it) => it.kind === 'WEAPON').map((it) => it.weapon!.instanceId);
    expect(left).not.toContain(player(s).stowed!.instanceId);
  });

  it('替換手持武器時，被換下來的槍免費留在同一具屍體上', () => {
    let s = testState(ROOM);
    const p = player(s);
    p.hp = 3;
    p.pos = { x: 6, y: 1 };
    s.activatedDrops.push('6,1');
    s = run(s, { type: 'FIRE', target: p.pos });
    s = run(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] });
    s = runEnemyTurn(s);
    const corpse = lootAt(s, { x: 6, y: 1 })!;
    const rrIndex = weaponIndexIn(corpse, 'rr4');
    s = run(s, {
      type: 'PICKUP', lootId: corpse.id, itemIndex: rrIndex, slot: 'EQUIPPED',
    });
    expect(player(s).equipped!.typeId).toBe('rr4');
    expect(weaponIds(lootAt(s, { x: 6, y: 1 })).sort()).toEqual(['ar9', 'ar9']);
  });

  it('屍體不阻擋移動', () => {
    let s = testState(ROOM);
    const p = player(s);
    p.hp = 3;
    p.pos = { x: 5, y: 2 };
    s = run(s, { type: 'FIRE', target: p.pos });
    s = run(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] });
    s = runEnemyTurn(s);
    player(s).pos = { x: 4, y: 2 };
    expect(checkLegal(s, { type: 'MOVE', dir: 'E' }).ok).toBe(true);
  });

  it('名冊耗盡時任務判定為 WIPED', () => {
    let s = testState(ROOM);
    for (let i = 0; i < 4; i++) {
      const p = player(s);
      p.hp = 3;
      
      
      s = run(s, { type: 'FIRE', target: p.pos });
      if (s.result === 'WIPED') break;
      s = run(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] });
      s = runEnemyTurn(s);
    }
    expect(s.result).toBe('WIPED');
    expect(s.result).not.toBe('ONGOING');
    expect(s.casualties).toBe(4);
    expect(s.roster).toHaveLength(0);
  });
});

describe('§11 任務目標與結束', () => {
  it('主目標需站在 TERMINAL 上或相鄰格互動，並花掉時間', () => {
    const s = testState(ROOM);
    player(s).pos = { x: 14, y: 1 };
    expect(checkLegal(s, { type: 'INTERACT', pos: { x: 14, y: 1 } }).ok).toBe(true);
    const after = run(s, { type: 'INTERACT', pos: { x: 14, y: 1 } });
    expect(after.objectives.main.done).toBe(true);
    expect(after.units[0].nextActAt).toBeGreaterThan(0);
  });

  it('次要目標各自獨立', () => {
    let s = testState(ROOM);
    expect(s.objectives.secondary).toHaveLength(2);
    player(s).pos = { x: 1, y: 4 };
    s = run(s, { type: 'INTERACT', pos: { x: 1, y: 4 } });
    expect(s.objectives.secondary.filter((o) => o.done)).toHaveLength(1);
  });

  it('v0.9：主目標未完成也可以撤離，但判定為 ABORTED（§5.1）', () => {
    let s = testState(ROOM);
    expect(player(s).pos).toEqual({ x: 1, y: 1 });
    expect(checkLegal(s, { type: 'INTERACT', pos: { x: 1, y: 1 } }).ok).toBe(true);
    s = run(s, { type: 'INTERACT', pos: { x: 1, y: 1 } });
    expect(s.result).toBe('ABORTED');
    // 戰利品照樣帶出：兩把槍 + 背包裡的初始彈藥
    expect(s.extracted.length).toBeGreaterThan(0);
    expect(s.extracted.some((it) => it.kind === 'WEAPON')).toBe(true);
    expect(s.extracted.some((it) => it.kind === 'AMMO')).toBe(true);
  });

  it('完成主目標後回到初始空投點互動 → SUCCESS', () => {
    let s = testState(ROOM);
    player(s).pos = { x: 14, y: 1 };
    s = run(s, { type: 'INTERACT', pos: { x: 14, y: 1 } });
    player(s).pos = { x: 1, y: 1 };
    s = run(s, { type: 'INTERACT', pos: { x: 1, y: 1 } });
    expect(s.result).toBe('SUCCESS');
    expect(s.result).not.toBe('ONGOING');
  });

  it('止損按鈕任何時候都可以按', () => {
    let s = testState(ROOM);
    expect(checkLegal(s, { type: 'ABORT' }).ok).toBe(true);
    s = run(s, { type: 'WAIT' });
    expect(checkLegal(s, { type: 'ABORT' }).ok).toBe(true); // 敵人回合中
    const aborted = run(s, { type: 'ABORT' });
    expect(aborted.result).toBe('ABORTED');
  });

  it('結算資訊：戰場遺留清單來自屍體（含背包內容與 DNA）', () => {
    let s = testState(ROOM);
    player(s).hp = 3;
    s = run(s, { type: 'FIRE', target: player(s).pos });
    expect(weaponIds(s.loot[0]).sort()).toEqual(['ar9', 'rr4']);
    const kinds = abandonedItems(s).map((it) => it.kind).sort();
    expect(kinds).toContain('WEAPON');
    expect(kinds).toContain('AMMO');     // 背包內容也留下（§3.3）
    expect(kinds).toContain('DNA');      // 一份 DNA（§4.4）
  });
});
