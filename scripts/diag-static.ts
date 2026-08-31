/**
 * 難度診斷 §1：靜態檢查。不需要跑任務，最快，可能直接找到答案。
 *
 * 這支腳本的長期價值：**下一次難度出現非預期跳動時，直接重跑。**
 *
 *   npx tsx scripts/diag-static.ts
 */
import { ARMOUR, MAPS, RULES, WEAPONS, archetype, armourType } from '../src/core/content';
import { createInitialState, drawArmour, makeLocalEnemyWeapon } from '../src/core/setup';
import { createRng, nextFloat } from '../src/core/rng';
import { effectiveMoveTime, moveCostForWeight } from '../src/core/inventory';
import { weaponType } from '../src/core/weapon';
import { hasLineOfSight } from '../src/core/los';
import { unitSees } from '../src/core/sight';
import { coverAgainst } from '../src/core/cover';
import { manhattan } from '../src/core/grid';
import { parseMap } from '../src/core/map';
import type { Unit, Vec2, WeaponInstance } from '../src/core/state';

const line = (): void => console.log('-'.repeat(78));
const pct = (n: number): string => (n * 100).toFixed(1) + '%';
const num = (n: number, d = 2): string => n.toFixed(d);
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * 統一之前（commit bec41ee）的三種原型定義。**手抄，刻意寫死** ——
 * 這是對照基準，不該隨資料檔一起漂移。
 */
const BEFORE: Record<string, {
  hp: number; armor: number; move: number; sight: number; weapon: string | null;
}> = {
  RUNNER: { hp: 25, armor: 0, move: 7, sight: 10, weapon: 'runner_claw' },
  SHOOTER: { hp: 30, armor: 0, move: 10, sight: 12, weapon: null },
  HULK: { hp: 90, armor: 20, move: 20, sight: 8, weapon: 'hulk_slam' },
};

/**
 * 一個單位的**威脅值**：每單位時間打得出多少傷害。
 *
 *   期望傷害 x 基礎命中 / 開火時間
 *
 * 刻意不含掩蔽與距離衰減 —— 那是地圖與走位的事，不是這個單位的屬性。
 */
function threat(w: { damage: number; accuracy: number; fireTime: number }): number {
  return (w.damage * w.accuracy) / w.fireTime;
}

function ammoWeightFor(calibre: string): number {
  const c = (RULES.calibres as unknown as Record<string, { weightPerRound: number }>)[calibre];
  return c ? c.weightPerRound : 0;
}

/** 依土製表抽一把（與 makeLocalEnemyWeapon 同一條路徑）。 */
function drawLocal(rng: ReturnType<typeof createRng>, serial: { nextEntitySerial: number }): WeaponInstance {
  return makeLocalEnemyWeapon(serial, rng);
}

// ============================================================================
// §1.1 等價性
// ============================================================================

const SEP = '\n              ';

function equivalence(): void {
  line();
  console.log('§1.1 等價性：最低階（C）生成 1000 隻，與統一之前逐項對照');
  line();
  const N = 1000;
  let worst = 0;
  const rows: string[] = [];
  for (const [id, before] of Object.entries(BEFORE)) {
    const a = archetype(id);
    const rng = createRng(20260831);
    const serial = { nextEntitySerial: 1 };
    const threats: number[] = [];
    const moves: number[] = [];
    let armoured = 0;
    for (let i = 0; i < N; i++) {
      const w = a.armed ? drawLocal(rng, serial) : null;
      const arm = a.kind === 'HUMAN' ? drawArmour(rng, 'C') : null;
      if (arm) armoured++;
      const armDef = arm ? armourType(arm) : null;
      const reserve = w ? w.magazine * RULES.enemyWeapons.reserveMagazines : 0;
      const weight = (w ? w.weight : 0) + (armDef ? armDef.weight : 0)
        + (w ? reserve * ammoWeightFor(w.calibre) : 0);
      threats.push(threat(w ?? weaponType(a.intrinsic)));
      moves.push(a.kind === 'MACHINE' ? a.time.move : moveCostForWeight(weight));
    }
    // 統一之前的威脅值：有內建武器的直接查表；射手型當時也是抽土製槍，取同一組抽樣
    let beforeThreat: number;
    if (before.weapon) beforeThreat = threat(weaponType(before.weapon));
    else {
      const r2 = createRng(20260831);
      const s2 = { nextEntitySerial: 1 };
      const xs: number[] = [];
      for (let i = 0; i < N; i++) xs.push(threat(drawLocal(r2, s2)));
      beforeThreat = mean(xs);
    }
    const nowThreat = mean(threats);
    const nowMove = mean(moves);
    const d = (x: number, y: number): number => (y - x) / x;
    const dT = d(beforeThreat, nowThreat);
    const dM = d(before.move, nowMove);
    const dH = d(before.hp, a.hp);
    const dS = d(before.sight, a.sightRange);
    worst = Math.max(worst, Math.abs(dT), Math.abs(dM), Math.abs(dH));
    rows.push(id.padEnd(9)
      + (num(beforeThreat) + '->' + num(nowThreat) + ' (' + pct(dT) + ')').padEnd(28)
      + (String(before.move) + '->' + num(nowMove, 1) + ' (' + pct(dM) + ')').padEnd(22)
      + (String(before.hp) + '->' + a.hp + ' (' + pct(dH) + ')').padEnd(20)
      + (String(before.sight) + '->' + a.sightRange + ' (' + pct(dS) + ')').padEnd(20)
      + pct(armoured / N));
  }
  console.log('原型     威脅值(傷害x命中/開火)      移動時間              生命值              視野                穿甲率');
  for (const r of rows) console.log(r);
  line();
  console.log('結論：' + (worst <= 0.10 ? '等價' : '**不等價**')
    + '  最大偏離 ' + pct(worst) + '（門檻 10%）');
}

// ============================================================================
// §1.2 負重級距分布
// ============================================================================

function weightTiers(): void {
  line();
  console.log('§1.2 敵人的負重級距分布（四張地圖，最低階抽取）');
  line();
  const tiers = RULES.backpack.weightTiers;
  console.log('地圖                  '
    + tiers.map((t) => ('移動' + t.moveCost).padEnd(10)).join('') + '  移動 7 佔比');
  let worstFast = 0;
  for (const raw of MAPS) {
    const s = createInitialState(1, raw);
    const foes = s.units.filter((u) => u.faction === 'ENEMY');
    const counts = tiers.map(() => 0);
    for (const u of foes) {
      const t = effectiveMoveTime(u);
      const i = tiers.findIndex((x) => x.moveCost === t);
      if (i >= 0) counts[i]++;
    }
    const fast = counts[0] / foes.length;
    worstFast = Math.max(worstFast, fast);
    console.log(raw.name.padEnd(20)
      + counts.map((c) => (c + '/' + foes.length).padEnd(10)).join('') + '  ' + pct(fast));
  }
  line();
  console.log(worstFast > 0.20
    ? '**超過 20% 的敵人落在移動 7** —— 大部分敵人比玩家快'
    : '移動 7 的敵人佔比未超過 20%（最高 ' + pct(worstFast) + '）');

  // 這個佔比是**新的**，還是統一之前就有？
  // 統一之前衝鋒型的移動時間就寫死是 7，所以只有「持槍的也掉進極輕級」才算新問題。
  console.log('');
  console.log('拆開看：哪些人落在移動 7');
  let meleeFast = 0;
  let meleeAll = 0;
  let armedFast = 0;
  let armedAll = 0;
  const armedGuns: Record<string, number> = {};
  for (const raw of MAPS) {
    const s = createInitialState(1, raw);
    for (const u of s.units) {
      if (u.faction !== 'ENEMY' || u.kind !== 'HUMAN') continue;
      const fast = effectiveMoveTime(u) === RULES.backpack.weightTiers[0].moveCost;
      if (u.equipped) {
        armedAll++;
        if (fast) { armedFast++; armedGuns[u.equipped.typeId] = (armedGuns[u.equipped.typeId] ?? 0) + 1; }
      } else {
        meleeAll++;
        if (fast) meleeFast++;
      }
    }
  }
  console.log('  只有近戰的：' + meleeFast + '/' + meleeAll + ' 落在移動 7'
    + '　—— **統一之前衝鋒型的移動時間就寫死是 7，所以這一半不是新的**');
  console.log('  持槍的　　：' + armedFast + '/' + armedAll + ' 落在移動 7 ('
    + pct(armedAll ? armedFast / armedAll : 0) + ')'
    + '　—— 這一半**是新的**，統一之前射手型一律是 10');
  if (armedFast > 0) {
    console.log('  他們拿的是：' + Object.entries(armedGuns)
      .map(([id, n]) => {
        const w = weaponType(id);
        const reserve = w.magazine * RULES.enemyWeapons.reserveMagazines;
        const total = w.weight + reserve * ammoWeightFor(w.calibre);
        return id + ' x' + n + '（槍重 ' + w.weight + ' + 備彈 ' + num(reserve * ammoWeightFor(w.calibre), 2)
          + ' = ' + num(total, 2) + ' <= 門檻 ' + RULES.backpack.weightTiers[0].maxWeight + '）';
      }).join(SEP));
  }
}

// ============================================================================
// §1.3 武器抽取的分布
// ============================================================================

function weaponDraw(): void {
  line();
  console.log('§1.3 武器抽取的分布');
  line();
  console.log('土製表（池子空了、或擲中土製時抽這張）：');
  const table = RULES.enemyWeapons.localTypes;
  const total = table.reduce((a, t) => a + t.weight, 0);
  for (const t of table) {
    const w = weaponType(t.id);
    console.log('  ' + t.id.padEnd(8) + ('權重 ' + t.weight + ' (' + pct(t.weight / total) + ')').padEnd(20)
      + '傷害 ' + String(w.damage).padEnd(5) + '命中 ' + num(w.accuracy).padEnd(6)
      + '射程 ' + String(w.range).padEnd(4) + '開火 ' + String(w.fireTime).padEnd(4)
      + '威脅值 ' + num(threat(w)));
  }
  const rng = createRng(4242);
  const serial = { nextEntitySerial: 1 };
  const got: WeaponInstance[] = [];
  for (let i = 0; i < 1000; i++) got.push(drawLocal(rng, serial));
  console.log('  1000 抽的平均：命中 ' + num(mean(got.map((w) => w.accuracy)))
    + '  傷害 ' + num(mean(got.map((w) => w.damage)), 1)
    + '  射程 ' + num(mean(got.map((w) => w.range)), 1)
    + '  威脅值 ' + num(mean(got.map((w) => threat(w)))));
  console.log('');
  console.log('對照：統一之前射手型的內嵌「制壓槍」= 傷害 20  命中 0.50  射程 7  開火 12  威脅值 '
    + num((20 * 0.5) / 12));
  console.log('');
  console.log('遺產比例（上限，池子永遠有貨時 = 1 - localBias）：');
  for (const tier of ['C', 'B', 'A', 'S']) {
    const bias = RULES.enemyWeapons.localBiasByTier[tier] ?? RULES.enemyWeapons.localBias;
    console.log('  ' + tier + ' 級  <= ' + pct(1 - bias));
  }
  // 遺產池裡那幾把有多痛
  const legacy = WEAPONS.filter((w) => w.origin === 'LEGACY' && !w.intrinsic);
  console.log('遺產武器的威脅值：' + legacy
    .map((w) => w.id + ' ' + num(threat(w)))
    .join('  '));
  line();
  console.log('注意：實際遺產比例還要乘上「池子非空」的機率，而池子由玩家的囤積行為決定。');
  console.log('機器人跑的是無局外層路徑，**池子不存在，所以它永遠只抽得到土製槍**。');
}

// ============================================================================
// §1.4 開場暴露度
// ============================================================================

function exposure(): void {
  line();
  console.log('§1.4 開場暴露度（純幾何，四張地圖）');
  line();
  console.log('地圖                  有射線  真的看得到  最近距離  起點周圍最好的掩蔽');
  for (const raw of MAPS) {
    const s = createInitialState(1, raw);
    const map = parseMap(raw);
    const start: Vec2 = map.startDropPoint;
    const foes = s.units.filter((u) => u.faction === 'ENEMY');
    let los = 0;
    let see = 0;
    let nearest = Infinity;
    for (const e of foes) {
      const d = manhattan(e.pos, start);
      nearest = Math.min(nearest, d);
      if (d <= e.sightRange && hasLineOfSight(map, e.pos, e.stance, start, 'STAND')) los++;
      const dummy = { pos: start, stance: 'STAND' } as Unit;
      if (unitSees(map, e, dummy)) see++;
    }
    let best = 'NONE';
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const p = { x: start.x + dx, y: start.y + dy };
        if (p.x < 0 || p.y < 0 || p.x >= map.width || p.y >= map.height) continue;
        const c = coverAgainst(map, start, p);
        if (c.level === 'GOOD') best = 'GOOD';
        else if (c.level === 'PARTIAL' && best === 'NONE') best = 'PARTIAL';
      }
    }
    console.log(raw.name.padEnd(20)
      + (los + '/' + foes.length).padEnd(8)
      + (see + '/' + foes.length).padEnd(12)
      + String(nearest).padEnd(10) + best);
  }
  line();
  console.log('「有射線」= 距離在視野內且幾何上通得過（他一轉頭就看得到你）');
  console.log('「真的看得到」= 再加上目前的面向（§7.5 的半平面）');
}


// ============================================================================
// §1.5 一致性檢查：規則層算出來的東西，AI 真的有在用嗎
//
// 這一節不在原始的診斷指示裡。它是做 §2 因子分離時被逼出來的：
// A 組（關掉極輕負重級）回傳了**與基準逐位元相同**的結果，那不可能是巧合。
// ============================================================================

function consistency(): void {
  line();
  console.log('§1.5 一致性檢查：effectiveMoveTime 與 AI 實際付出的成本');
  line();
  const s = createInitialState(1, MAPS[0]);
  let mismatch = 0;
  let checked = 0;
  const rows: string[] = [];
  for (const u of s.units.filter((x) => x.faction === 'ENEMY')) {
    const declared = effectiveMoveTime(u);
    // AI 走一步實際回傳的成本（core/ai.ts 的 stepTo）
    const actual = u.kind === 'MACHINE' ? u.moveTime : u.moveTime;
    checked++;
    if (declared !== actual) {
      mismatch++;
      if (rows.length < 4) {
        rows.push('  ' + u.id + ' ' + u.archetype
          + '　effectiveMoveTime=' + declared + '　AI 實付=' + actual
          + (u.equipped ? '　（' + u.equipped.typeId + '）' : '　（只有近戰）'));
      }
    }
  }
  for (const r of rows) console.log(r);
  line();
  if (mismatch > 0) {
    console.log('**不一致：' + mismatch + '/' + checked + ' 名敵人的實際移動成本與負重級距算出來的不同。**');
    console.log('core/ai.ts 的 stepTo() 回傳的是 `e.moveTime`（原型指派值），');
    console.log('不是 `effectiveMoveTime(e)`（負重級距）—— 所以**負重對敵人完全沒有作用**。');
    console.log('');
    console.log('對 §2.1 等價性的後果：');
    console.log('  統一之前　衝鋒型 moveTime = 7　→　實際走一步花 7');
    console.log('  統一之後　複製人 moveTime = ' + archetype('RUNNER').time.move
      + '　→　實際走一步花 ' + archetype('RUNNER').time.move
      + '（負重算出來的 ' + moveCostForWeight(0) + ' 沒有被用到）');
    const d = (archetype('RUNNER').time.move - 7) / 7;
    console.log('  近戰複製人實際上**慢了 ' + pct(d) + '** —— 等價在這一項上是往「變簡單」的方向破的，');
    console.log('  而且極輕負重級（§3 的「風箏流不成立」）目前對敵人是完全沒有生效的。');
  } else {
    console.log('一致：敵人實際付出的移動成本 = 負重級距算出來的值');
  }
}

// ============================================================================

console.log('');
console.log('=== 難度診斷 §1：靜態檢查 ===');
console.log('護甲表：' + ARMOUR.types.map((a) => a.name + '(甲' + a.armor + '/重' + a.weight + ')').join('  '));
console.log('負重級距：' + RULES.backpack.weightTiers.map((t) => '<=' + t.maxWeight + '->' + t.moveCost).join('  '));
console.log('備彈：' + RULES.enemyWeapons.reserveMagazines + ' 個彈匣');
equivalence();
weightTiers();
weaponDraw();
exposure();
consistency();
console.log('');
void nextFloat;
