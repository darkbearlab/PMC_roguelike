/**
 * 產生數值規模的基準檔。
 *
 * **這支只該在「改動數值規模之前」跑一次。** 基準檔是 scale.test.ts 的黃金樣本，
 * 放大之後再跑一次等於拿新資料覆蓋黃金樣本，那條等價測試就變成永遠會過的廢測試。
 * 真的要重建（例如刻意調整平衡、接受新的基準）才加 FORCE=1。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { runMission } from '../tests/bot';

const OUT = 'tests/fixtures/scale-baseline.json';
if (existsSync(OUT) && process.env.FORCE !== '1') {
  console.error('基準檔已存在：' + OUT);
  console.error('覆蓋它會讓 scale.test.ts 的等價測試失去意義。確定要重建請用 FORCE=1。');
  process.exit(1);
}

const trace = runMission(20260826);
writeFileSync('tests/fixtures/scale-baseline.json', JSON.stringify(trace, null, 1) + '\n', 'utf8');
console.log('事件數', trace.events.length, '| 結果', trace.result, '| 回合', trace.turn,
  '| 陣亡', trace.casualties);
const kinds: Record<string, number> = {};
for (const e of trace.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
console.log('事件種類', JSON.stringify(kinds));
