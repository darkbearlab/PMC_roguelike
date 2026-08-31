/** 跑幾場笨機器人，看看難度落點大概在哪（僅供調參參考，不是測試）。 */
import { MAPS, RULES } from '../src/core/content';
import type { RawMap } from '../src/core/map';
import { SEEDS, runOne } from './botlib';

function report(label: string, map?: RawMap): void {
  console.log('');
  console.log('=== ' + label + ' ===');
  const rows = SEEDS.map((seed) => runOne(seed, map));
  for (const r of rows) {
    console.log(
      `seed ${String(r.seed).padStart(9)} → ${r.result.padEnd(8)}`,
      `時刻 ${String(r.clock).padStart(5)}`,
      `投入 ${r.deployed}`, `陣亡 ${r.casualties}`,
      `主目標 ${r.main ? '✓' : '✗'}`,
      `殘敵 ${String(r.foes).padStart(2)}/10`,
      `耗彈 ${String(r.ammoUsed).padStart(3)}`,
      `帶出 ${r.carried}`,
    );
  }
  const n = rows.length;
  const avg = (f: (r: typeof rows[number]) => number): string => (rows.reduce((a, r) => a + f(r), 0) / n).toFixed(1);
  console.log(
    `平均：時刻 ${avg((r) => r.clock)}`,
    `投入 ${avg((r) => r.deployed)}`,
    `陣亡 ${avg((r) => r.casualties)}`,
    `殘敵 ${avg((r) => r.foes)}`,
    `耗彈 ${avg((r) => r.ammoUsed)}`,
    `｜成功 ${rows.filter((r) => r.result === 'SUCCESS').length}/${n}`,
    `主目標 ${rows.filter((r) => r.main).length}/${n}`,
  );
}

// v0.11：四張圖各跑一次（§13.3）。
// 這是本次最實際的收穫 —— 第一次拿到「同一組數值在四種幾何下的表現」。
for (const m of MAPS) report(m.id + '「' + m.name + '」', m);

// v0.10 的 A/B 仍然保留：戰術 AI 的效果只能靠對照判斷。
// 拿掩體最密的那張圖來比，才看得出 targetExposure 有沒有東西可用。
const arena = MAPS[MAPS.length - 1];
RULES.ai.tacticalBehaviour = false;
report('A/B：' + arena.name + '・tacticalBehaviour 關（= v0.9）', arena);
RULES.ai.tacticalBehaviour = true;
report('A/B：' + arena.name + '・tacticalBehaviour 開（= v0.10）', arena);
