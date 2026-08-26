import { describe, it, expect } from 'vitest';
import { applyCommand, checkLegal } from '../src/core/commands';
import { abandonedWeapons, corpseAt } from '../src/core/state';
import { testState, player, unit } from './helpers';

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
  while (s.phase === 'ENEMY' && !s.pendingReinforcement && guard++ < 500) {
    s = applyCommand(s, { type: 'ENEMY_STEP' });
  }
  return s;
}

describe('§10 死亡、增援與屍體', () => {
  it('陣亡後留下屍體，屍體內含身上所有武器（含收納的重武器）', () => {
    let s = testState(ROOM);
    const p = player(s);
    p.hp = 3;
    // canAttack 不限制目標陣營（§8.2 刻意不做友軍傷害豁免），
    // 因此測試可以直接讓士兵對自己開一槍製造陣亡。
    s = applyCommand(s, { type: 'FIRE', target: p.pos }); // AR-9 傷害 3
    expect(s.casualties).toBe(1);
    expect(s.corpses).toHaveLength(1);
    expect(s.corpses[0].weapons.map((w) => w.id).sort()).toEqual(['ar9', 'rr4']);
    expect(s.pendingReinforcement).not.toBeNull();
    expect(s.activePlayerUnitId).toBeNull();
  });

  it('增援只帶 AR-9，AP 為 0，從最近的空投點出現', () => {
    let s = testState(ROOM);
    const p = player(s);
    p.hp = 3;
    p.pos = { x: 7, y: 1 };   // 靠近第二個空投點 (6,1)
    s = applyCommand(s, { type: 'FIRE', target: p.pos });
    expect(s.pendingReinforcement!.deathPos).toEqual({ x: 7, y: 1 });

    const next = s.roster[0];
    s = applyCommand(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: next });
    const fresh = unit(s, next);
    expect(fresh.pos).toEqual({ x: 6, y: 1 });      // 最近的空投點，不是起點
    expect(fresh.equipped!.id).toBe('ar9');
    expect(fresh.equipped!.ammo).toBe(6);
    expect(fresh.stowed).toBeNull();                 // 重武器留在屍體上
    expect(s.deployed).toBe(2);
    expect(s.pendingReinforcement).toBeNull();
  });

  it('可以走回屍體處花 1 AP 撿回重武器', () => {
    let s = testState(ROOM);
    const p = player(s);
    p.hp = 3;
    p.pos = { x: 6, y: 1 };
    s = applyCommand(s, { type: 'FIRE', target: p.pos });
    s = applyCommand(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] });
    s = runEnemyTurn(s);

    const corpse = corpseAt(s, { x: 6, y: 1 })!;
    expect(corpse).toBeTruthy();
    expect(player(s).pos).toEqual({ x: 6, y: 1 }); // 空投點就在屍體上
    const rrIndex = corpse.weapons.findIndex((w) => w.id === 'rr4');

    const apBefore = player(s).ap;
    s = applyCommand(s, {
      type: 'PICKUP', corpseId: corpse.id, weaponIndex: rrIndex, slot: 'STOWED',
    });
    expect(player(s).stowed!.id).toBe('rr4');
    expect(player(s).ap).toBe(apBefore - 1);
    expect(corpseAt(s, { x: 6, y: 1 })!.weapons.map((w) => w.id)).toEqual(['ar9']);
  });

  it('替換手持武器時，被換下來的槍免費留在同一具屍體上', () => {
    let s = testState(ROOM);
    const p = player(s);
    p.hp = 3;
    p.pos = { x: 6, y: 1 };
    s = applyCommand(s, { type: 'FIRE', target: p.pos });
    s = applyCommand(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] });
    s = runEnemyTurn(s);
    const corpse = corpseAt(s, { x: 6, y: 1 })!;
    const rrIndex = corpse.weapons.findIndex((w) => w.id === 'rr4');
    s = applyCommand(s, {
      type: 'PICKUP', corpseId: corpse.id, weaponIndex: rrIndex, slot: 'EQUIPPED',
    });
    expect(player(s).equipped!.id).toBe('rr4');
    expect(corpseAt(s, { x: 6, y: 1 })!.weapons.map((w) => w.id).sort()).toEqual(['ar9', 'ar9']);
  });

  it('屍體不阻擋移動', () => {
    let s = testState(ROOM);
    const p = player(s);
    p.hp = 3;
    p.pos = { x: 5, y: 2 };
    s = applyCommand(s, { type: 'FIRE', target: p.pos });
    s = applyCommand(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] });
    s = runEnemyTurn(s);
    player(s).pos = { x: 4, y: 2 };
    expect(checkLegal(s, { type: 'MOVE', dir: 'E' }).ok).toBe(true);
  });

  it('名冊耗盡時任務判定為 WIPED', () => {
    let s = testState(ROOM);
    for (let i = 0; i < 4; i++) {
      const p = player(s);
      p.hp = 3;
      p.ap = 2;
      s.phase = 'PLAYER';
      s.enemyQueue = [];
      s = applyCommand(s, { type: 'FIRE', target: p.pos });
      if (s.result === 'WIPED') break;
      s = applyCommand(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] });
      s = runEnemyTurn(s);
    }
    expect(s.result).toBe('WIPED');
    expect(s.phase).toBe('MISSION_END');
    expect(s.casualties).toBe(4);
    expect(s.roster).toHaveLength(0);
  });
});

describe('§11 任務目標與結束', () => {
  it('主目標需站在 TERMINAL 上互動，花 1 AP', () => {
    const s = testState(ROOM);
    player(s).pos = { x: 14, y: 1 };
    expect(checkLegal(s, { type: 'INTERACT' }).ok).toBe(true);
    const after = applyCommand(s, { type: 'INTERACT' });
    expect(after.objectives.main.done).toBe(true);
    expect(after.units[0].ap).toBe(1);
  });

  it('次要目標各自獨立', () => {
    let s = testState(ROOM);
    expect(s.objectives.secondary).toHaveLength(2);
    player(s).pos = { x: 1, y: 4 };
    s = applyCommand(s, { type: 'INTERACT' });
    expect(s.objectives.secondary.filter((o) => o.done)).toHaveLength(1);
  });

  it('主目標未完成時不能從初始空投點撤離', () => {
    const s = testState(ROOM);
    expect(player(s).pos).toEqual({ x: 1, y: 1 });
    const r = checkLegal(s, { type: 'INTERACT' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('主目標');
  });

  it('完成主目標後回到初始空投點互動 → SUCCESS', () => {
    let s = testState(ROOM);
    player(s).pos = { x: 14, y: 1 };
    s = applyCommand(s, { type: 'INTERACT' });
    player(s).pos = { x: 1, y: 1 };
    s = applyCommand(s, { type: 'INTERACT' });
    expect(s.result).toBe('SUCCESS');
    expect(s.phase).toBe('MISSION_END');
  });

  it('止損按鈕任何時候都可以按', () => {
    let s = testState(ROOM);
    expect(checkLegal(s, { type: 'ABORT' }).ok).toBe(true);
    s = applyCommand(s, { type: 'WAIT' });
    expect(checkLegal(s, { type: 'ABORT' }).ok).toBe(true); // 敵人回合中
    const aborted = applyCommand(s, { type: 'ABORT' });
    expect(aborted.result).toBe('ABORTED');
  });

  it('結算資訊：戰場遺留裝備清單來自屍體', () => {
    let s = testState(ROOM);
    player(s).hp = 3;
    s = applyCommand(s, { type: 'FIRE', target: player(s).pos });
    expect(abandonedWeapons(s).map((w) => w.id).sort()).toEqual(['ar9', 'rr4']);
  });
});
