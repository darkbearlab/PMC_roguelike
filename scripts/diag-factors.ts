/**
 * 難度診斷 §2：機器人因子分離。
 *
 * 一次關閉一個功能重跑，看哪一個把數字拉回去。每組四張圖 x 五個種子。
 *
 * **開關全部是這支腳本在執行期改資料物件做出來的** —— `core/` 一行都沒動。
 * 那些資料是 import 進來的純 JSON，既有測試也是這樣切 `tacticalBehaviour` 的。
 *
 *   npx tsx scripts/diag-factors.ts
 *
 * 已知偏差（§2.3）：機器人不太會用掩體與姿勢，所以它**高估**殺傷力類改動的影響、
 * **完全測不到**資訊類改動的影響。E 組（迷霧）的結果尤其要保守解讀。
 */
import { ACTORS, MAPS, RULES, WEAPONS } from '../src/core/content';
import { SEEDS, runOne } from './botlib';
import type { RawMap } from '../src/core/map';

interface Agg {
  success: number; main: number; n: number;
  clock: number; casualties: number; ammo: number; foes: number;
}

function runGroup(map: RawMap): Agg {
  const rows = SEEDS.map((seed) => runOne(seed, map));
  const n = rows.length;
  const sum = (f: (r: typeof rows[number]) => number): number => rows.reduce((a, r) => a + f(r), 0);
  return {
    n,
    success: rows.filter((r) => r.result === 'SUCCESS').length,
    main: rows.filter((r) => r.main).length,
    clock: sum((r) => r.clock) / n,
    casualties: sum((r) => r.casualties) / n,
    ammo: sum((r) => r.ammoUsed) / n,
    foes: sum((r) => r.foes) / n,
  };
}

/** 一組設定：套用 → 跑四張圖 → 還原。**還原必須確實**，否則後面每一組都被污染。 */
interface Factor {
  id: string;
  label: string;
  apply: () => () => void;      // 回傳還原函式
}

const deepCopy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const FACTORS: Factor[] = [
  {
    id: '基準', label: '現況，全部開啟',
    apply: () => () => undefined,
  },
  {
    id: 'A', label: '關掉極輕負重級（敵人最低移動時間回到 10）',
    apply: () => {
      const before = deepCopy(RULES.backpack.weightTiers);
      // 把極輕級的門檻壓到誰都進不去。**不刪掉那一級** ——
      // 刪掉會讓級距索引位移，那是另一種改動。
      RULES.backpack.weightTiers[0].maxWeight = -1;
      return () => { RULES.backpack.weightTiers.splice(0, RULES.backpack.weightTiers.length, ...before); };
    },
  },
  {
    id: 'B', label: '關掉敵人武器抽取（回到統一前的內嵌攻擊「制壓槍」）',
    apply: () => {
      const beforeTable = deepCopy(RULES.enemyWeapons.localTypes);
      // 造一把與統一前內嵌攻擊等值的槍，塞進土製表當唯一選項
      const stand = WEAPONS.find((w) => w.id === 'rb7');
      const clone = deepCopy(stand!);
      clone.id = '__diag_suppressor';
      clone.name = '制壓槍（診斷用）';
      clone.damage = 20; clone.damageSpread = 4; clone.accuracy = 0.5;
      clone.range = 7; clone.optimalRange = 5; clone.fireTime = 12;
      clone.magazine = 99; clone.ammo = 99; clone.weight = 0;
      WEAPONS.push(clone);
      RULES.enemyWeapons.localTypes.splice(0, RULES.enemyWeapons.localTypes.length,
        { id: clone.id, weight: 1 });
      return () => {
        RULES.enemyWeapons.localTypes.splice(0, RULES.enemyWeapons.localTypes.length, ...beforeTable);
        const i = WEAPONS.findIndex((w) => w.id === '__diag_suppressor');
        if (i >= 0) WEAPONS.splice(i, 1);
      };
    },
  },
  {
    id: 'C', label: '關掉敵人彈藥管理（無限彈藥、不裝填）',
    apply: () => {
      // 把土製表那幾把的彈匣灌大 → 永遠打不空 → 永遠不會裝填。
      // 這正好是統一之前「彈匣 99、不裝填」的形狀。
      const before = RULES.enemyWeapons.localTypes.map((t) => {
        const w = WEAPONS.find((x) => x.id === t.id)!;
        return { id: t.id, magazine: w.magazine, ammo: w.ammo };
      });
      for (const t of RULES.enemyWeapons.localTypes) {
        const w = WEAPONS.find((x) => x.id === t.id)!;
        w.magazine = 999; w.ammo = 999;
      }
      return () => {
        for (const b of before) {
          const w = WEAPONS.find((x) => x.id === b.id)!;
          w.magazine = b.magazine; w.ammo = b.ammo;
        }
      };
    },
  },
  {
    id: 'D', label: '玩家經驗維持基礎值（機器人本來就是 Lv.1，見下方註）',
    apply: () => () => undefined,
  },
  {
    id: "D'", label: '反向量測：玩家全員滿級（經驗的補償上限）',
    apply: () => {
      const before = deepCopy(RULES.experience.levels);
      const top = RULES.experience.levels[RULES.experience.levels.length - 1];
      // 讓 levelOf(0) 直接回傳最高級 —— 機器人用的 testDeployment 是 xp 0
      RULES.experience.levels.splice(0, RULES.experience.levels.length,
        { ...top, xp: 0 });
      return () => {
        RULES.experience.levels.splice(0, RULES.experience.levels.length, ...before);
      };
    },
  },
  {
    id: 'E', label: '關掉迷霧',
    apply: () => {
      const before = RULES.fog.enabled;
      RULES.fog.enabled = false;
      return () => { RULES.fog.enabled = before; };
    },
  },
];

// ============================================================================

const pad = (s: string, n: number): string => {
  // 中文字寬度算兩格，欄位才對得齊
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2000 ? 2 : 1;
  return s + ' '.repeat(Math.max(1, n - w));
};

console.log('');
console.log('=== 難度診斷 §2：機器人因子分離（' + SEEDS.length + ' 個種子 x 四張圖）===');
console.log('');

const results: Record<string, Agg[]> = {};
for (const f of FACTORS) {
  const restore = f.apply();
  try {
    results[f.id] = MAPS.map((m) => runGroup(m));
  } finally {
    restore();
  }
  const r = results[f.id];
  const tot = r.reduce((a, x) => a + x.success, 0);
  const n = r.reduce((a, x) => a + x.n, 0);
  console.log(pad(f.id, 6) + pad('成功 ' + tot + '/' + n, 14) + f.label);
}

console.log('');
console.log('逐圖明細（耗時 ｜ 成功 ｜ 平均陣亡 ｜ 平均耗彈 ｜ 平均殘敵）');
console.log('');
const header = pad('組別', 6) + MAPS.map((m) => pad(m.name, 22)).join('');
console.log(header);
for (const f of FACTORS) {
  const r = results[f.id];
  console.log(pad(f.id, 6) + r.map((a) => pad(
    a.clock.toFixed(0) + ' ' + a.success + '/' + a.n
    + ' 亡' + a.casualties.toFixed(1)
    + ' 彈' + a.ammo.toFixed(0)
    + ' 殘' + a.foes.toFixed(1), 22)).join(''));
}

console.log('');
console.log('相對基準的成功數變化：');
const base = results['基準'].reduce((a, x) => a + x.success, 0);
for (const f of FACTORS) {
  if (f.id === '基準') continue;
  const tot = results[f.id].reduce((a, x) => a + x.success, 0);
  const d = tot - base;
  console.log(pad(f.id, 6) + (d >= 0 ? '+' : '') + d + '　' + f.label);
}

console.log('');
console.log('註（§2.3 已知偏差）：');
console.log('  - 機器人不太會用掩體與姿勢，所以它**高估**殺傷力類改動的影響。');
console.log('  - 它讀的是規則狀態不是畫面，**完全測不到**資訊類改動（迷霧、識別、口令）。');
console.log('    E 組的結果尤其要保守解讀 —— 那一組量到的只是「尋路能不能走進未探索區」。');
console.log('  - D 組與基準必然相同：機器人走的是無局外層路徑，士兵永遠是 Lv.1。');
console.log("    真正回答「經驗的補償夠不夠」的是 D' 組（全員滿級）。");
console.log('  - 機器人跑的是無局外層路徑，**物品池不存在**，所以敵人永遠只抽得到土製槍。');
console.log('');
void ACTORS;
