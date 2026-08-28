/**
 * §5.6 兩種中斷行為、§12.19 準備與使用、§4 戰地封合劑。
 *
 * 恢復必須慢、必須不完全、必須稀有 —— 這一組測試盯的就是那三條。
 * 如果恢復又快又便宜，「士兵是消耗品、死亡是支出、名冊耗盡才是失敗」
 * 這三件事會同時失去意義。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { checkLegal, findBagItem } from '../src/core/commands';
import { interruptOf, sequenceDef, totalTime } from '../src/core/sequence';
import { ITEMS, RULES } from '../src/core/content';
import { totalWeight } from '../src/core/inventory';
import { lootAt } from '../src/core/state';
import { advanceToPlayer, freezeCombat, player, run, testState, thawCombat } from './helpers';

const OPEN = [
  '##############',
  '#D...........#',
  '#............#',
  '#...........T#',
  '##############',
];

beforeAll(() => freezeCombat());
afterAll(() => thawCombat());

const sealantOf = (s: ReturnType<typeof testState>) =>
  player(s).backpack!.items.find((it) => it.defId === 'SEALANT')!;

/** 準備 + 使用 + 走完整套序列。 */
function useSealant(s: ReturnType<typeof testState>): ReturnType<typeof testState> {
  let t = run(s, { type: 'PREPARE', itemId: sealantOf(s).id });
  t = advanceToPlayer(t);
  t = run(t, { type: 'USE_ITEM' });
  for (let i = 0; i < 4 && player(t).pendingSequence; i++) {
    t = run(t, { type: 'SEQUENCE_STEP' });
    t = advanceToPlayer(t);
  }
  return t;
}

describe('§4 戰地封合劑：慢、不完全、稀有', () => {
  it('資料驅動：定義全部在 items.json 裡', () => {
    const def = ITEMS.SEALANT;
    expect(def.kind).toBe('CONSUMABLE');
    expect(def.weight).toBe(5);
    expect(def.use!.sequenceType).toBe('RESTART');
    expect(def.use!.steps).toHaveLength(2);
    expect(totalTime('SEALANT')).toBe(40);
    expect(def.use!.effects).toEqual([{ kind: 'HEAL', amount: 25 }]);
  });

  it('慢：40 時間等同四次移動，所以無法在交火中進行', () => {
    expect(totalTime('SEALANT')).toBe(RULES.time.move * 4);
  });

  it('士兵初始攜帶一個', () => {
    const s = testState(OPEN);
    expect(sealantOf(s).qty).toBe(1);
  });

  it('恢復 25 HP，而且不會超過上限', () => {
    let s = testState(OPEN);
    player(s).hp = 20;
    s = useSealant(s);
    expect(player(s).hp).toBe(45);

    let t = testState(OPEN);
    player(t).hp = 55;
    t = useSealant(t);
    expect(player(t).hp).toBe(60);           // 上限 60，不超量
  });

  it('不完全：滿血 60，一個封合劑回四成，永遠回不滿', () => {
    const heal = ITEMS.SEALANT.use!.effects![0].amount;
    expect(heal).toBeLessThan(60);
    expect(heal / 60).toBeLessThan(0.5);
  });

  it('用掉就沒了，而且準備欄跟著空掉', () => {
    let s = testState(OPEN);
    player(s).hp = 20;
    s = useSealant(s);
    expect(player(s).backpack!.items.some((it) => it.defId === 'SEALANT')).toBe(false);
    expect(player(s).preparedId).toBeNull();
  });

  it('總花費真的是 40（兩步各 20）', () => {
    let s = testState(OPEN);
    player(s).hp = 10;
    s = run(s, { type: 'PREPARE', itemId: sealantOf(s).id });
    const afterPrepare = player(s).nextActAt;
    expect(afterPrepare).toBe(RULES.time.prepare);
    s = advanceToPlayer(s);
    s = run(s, { type: 'USE_ITEM' });
    expect(player(s).nextActAt).toBe(afterPrepare);   // 開始序列本身不花時間
    s = run(s, { type: 'SEQUENCE_STEP' });
    s = advanceToPlayer(s);
    s = run(s, { type: 'SEQUENCE_STEP' });
    expect(player(s).nextActAt - afterPrepare).toBe(40);
  });
});

describe('§12.19 準備欄', () => {
  it('準備花 10 —— 免費的話準備欄就只是多一次點擊', () => {
    let s = testState(OPEN);
    expect(RULES.time.prepare).toBe(10);
    s = run(s, { type: 'PREPARE', itemId: sealantOf(s).id });
    expect(player(s).nextActAt).toBe(10);
  });

  it('準備欄只有一格：再準備一件就換掉', () => {
    let s = testState(OPEN);
    const bag = player(s).backpack!;
    bag.items.push({
      id: 'SEC', kind: 'CONSUMABLE', defId: 'SEALANT', name: '戰地封合劑', weight: 5, qty: 1,
    });
    s = run(s, { type: 'PREPARE', itemId: sealantOf(s).id });
    const first = player(s).preparedId;
    s = advanceToPlayer(s);
    s = run(s, { type: 'PREPARE', itemId: 'SEC' });
    expect(player(s).preparedId).toBe('SEC');
    expect(player(s).preparedId).not.toBe(first);
  });

  it('準備欄是空的時候不能使用', () => {
    const s = testState(OPEN);
    expect(player(s).preparedId).toBeNull();
    const legal = checkLegal(s, { type: 'USE_ITEM' });
    expect(legal.ok).toBe(false);
    expect(legal.reason).toContain('準備欄是空的');
  });

  it('只有消耗品可以準備', () => {
    const s = testState(OPEN);
    const ammo = player(s).backpack!.items.find((it) => it.kind === 'AMMO')!;
    expect(checkLegal(s, { type: 'PREPARE', itemId: ammo.id }).ok).toBe(false);
  });

  it('東西仍然在背包裡：重量、陣亡遺留、撤離帶出全部自動跟著走', () => {
    let s = testState(OPEN);
    const before = totalWeight(player(s).backpack);
    s = run(s, { type: 'PREPARE', itemId: sealantOf(s).id });
    expect(totalWeight(player(s).backpack)).toBe(before);
    expect(findBagItem(player(s), player(s).preparedId)).not.toBeNull();
  });
});

describe('§5.6 兩種中斷行為', () => {
  it('RR-4 裝填是可續行，封合劑是須重來', () => {
    expect(interruptOf('RR4_RELOAD')).toBe('RESUMABLE');
    expect(interruptOf('SEALANT')).toBe('RESTART');
    expect(sequenceDef('RR4_RELOAD')!.steps).toHaveLength(2);
  });

  it('須重來：中途中止，進度歸零、時間不退還、效果不發生', () => {
    let s = testState(OPEN);
    player(s).hp = 20;
    s = run(s, { type: 'PREPARE', itemId: sealantOf(s).id });
    s = advanceToPlayer(s);
    s = run(s, { type: 'USE_ITEM' });
    s = run(s, { type: 'SEQUENCE_STEP' });          // 走完第一步（止血）
    const spent = player(s).nextActAt;
    expect(spent).toBe(RULES.time.prepare + 20);

    s = advanceToPlayer(s);
    s = run(s, { type: 'ABORT_SEQUENCE' });
    expect(player(s).hp).toBe(20);                   // 效果不發生
    expect(player(s).nextActAt).toBe(spent);         // 時間不退還
    expect(player(s).pendingSequence).toBeNull();

    // 再用一次要從頭來：整整 40
    s = advanceToPlayer(s);
    s = run(s, { type: 'USE_ITEM' });
    expect(player(s).pendingSequence!.index).toBe(0);
  });

  it('可續行：RR-4 中斷後保留進度，下次從中斷處接續', () => {
    let s = testState(OPEN);
    const p = player(s);
    p.equipped = p.stowed;                            // 換成 RR-4
    p.stowed = null;
    p.equipped!.ammo = 0;

    s = run(s, { type: 'RELOAD' });
    s = run(s, { type: 'SEQUENCE_STEP' });            // 開栓退殼完成
    expect(player(s).equipped!.reloadProgress).toBe(1);

    s = advanceToPlayer(s);
    s = run(s, { type: 'ABORT_SEQUENCE' });
    expect(player(s).equipped!.reloadProgress).toBe(1);   // 進度保留

    // 接續：只剩一步
    s = advanceToPlayer(s);
    s = run(s, { type: 'RELOAD' });
    expect(player(s).pendingSequence!.index).toBe(1);
    const at = player(s).nextActAt;
    s = run(s, { type: 'SEQUENCE_STEP' });
    expect(player(s).nextActAt - at).toBe(10);            // 只花剩下那一步
    expect(player(s).equipped!.ammo).toBe(1);
    expect(player(s).equipped!.reloadProgress).toBe(0);
  });

  it('半裝填的 RR-4 不可使用', () => {
    let s = testState(OPEN, [{ archetype: 'HULK', pos: { x: 6, y: 1 } }]);
    const p = player(s);
    p.equipped = p.stowed;
    p.stowed = null;
    p.equipped!.ammo = 0;
    s = run(s, { type: 'RELOAD' });
    s = run(s, { type: 'SEQUENCE_STEP' });
    s = advanceToPlayer(s);
    s = run(s, { type: 'ABORT_SEQUENCE' });

    const legal = checkLegal(s, { type: 'FIRE', target: { x: 6, y: 1 } });
    expect(legal.ok).toBe(false);
    expect(legal.reason).toContain('槍膛開著');
  });

  it('進度存在武器上：收起來、換槍、再換回來，進度仍在', () => {
    let s = testState(OPEN);
    const p = player(s);
    p.equipped = p.stowed;                            // 手持 RR-4
    p.stowed = null;
    p.equipped!.ammo = 0;
    s = run(s, { type: 'RELOAD' });
    s = run(s, { type: 'SEQUENCE_STEP' });
    s = advanceToPlayer(s);
    s = run(s, { type: 'ABORT_SEQUENCE' });

    // 撿一把 AR-9 換上去，RR-4 進收納
    const rr4 = player(s).equipped!;
    player(s).stowed = rr4;
    player(s).equipped = null;
    s = advanceToPlayer(s);
    s = run(s, { type: 'SWAP_WEAPON' });
    expect(player(s).equipped!.id).toBe('rr4');
    expect(player(s).equipped!.reloadProgress).toBe(1);   // 換來換去進度都還在
  });
});

describe('§12.20 丟棄', () => {
  it('丟棄不花時間，東西落在腳下成為可搜刮的堆', () => {
    let s = testState(OPEN);
    const it = sealantOf(s);
    const before = totalWeight(player(s).backpack);
    s = run(s, { type: 'DROP', itemId: it.id });
    expect(player(s).nextActAt).toBe(0);                 // 不花時間
    expect(totalWeight(player(s).backpack)).toBe(before - 5);
    const pile = lootAt(s, player(s).pos);
    expect(pile).not.toBeNull();
    expect(pile!.items.some((x) => x.defId === 'SEALANT')).toBe(true);
  });

  it('丟掉負重就真的變輕：移動時間跟著回到基準', () => {
    let s = testState(OPEN);
    expect(totalWeight(player(s).backpack)).toBe(23);
    s = run(s, { type: 'DROP', itemId: sealantOf(s).id });
    expect(totalWeight(player(s).backpack)).toBe(18);
    s = run(s, { type: 'MOVE', dir: 'E' });
    expect(player(s).nextActAt).toBe(10);                // 卸下之後回到基準速度
  });

  it('丟掉準備欄裡的東西，準備欄跟著清空', () => {
    let s = testState(OPEN);
    const it = sealantOf(s);
    s = run(s, { type: 'PREPARE', itemId: it.id });
    expect(player(s).preparedId).toBe(it.id);
    s = advanceToPlayer(s);
    s = run(s, { type: 'DROP', itemId: it.id });
    expect(player(s).preparedId).toBeNull();
  });

  it('丟下去的東西撿得回來', () => {
    let s = testState(OPEN);
    s = run(s, { type: 'DROP', itemId: sealantOf(s).id });
    const pile = lootAt(s, player(s).pos)!;
    s = run(s, { type: 'TAKE_ALL', lootId: pile.id });
    expect(player(s).backpack!.items.some((it) => it.defId === 'SEALANT')).toBe(true);
  });
});
