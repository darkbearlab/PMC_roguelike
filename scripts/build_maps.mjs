/**
 * 手工地圖作者工具（§13.5）。
 *
 * 產生四張地圖的 JSON、驗證每一張、並寫出 docs/map-stats.md 的統計摘要。
 * **任一張驗證失敗即以非零碼結束**，CI 會因此變紅。
 *
 * 這不是程序化生成 —— 每一段牆、每一個敵人座標都是手填的，
 * 這支腳本只是不讓作者數錯，順便把「什麼叫好地圖」的判準寫成可檢查的條件。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, toRawMap } from './maps/lib.mjs';
import m1 from './maps/mission_01.mjs';
import m2 from './maps/mission_02.mjs';
import m3 from './maps/mission_03.mjs';
import m4 from './maps/mission_04.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAPS = [m1, m2, m3, m4];

let failed = false;
const allStats = [];

for (const def of MAPS) {
  const { errors, stats } = validate(def);
  allStats.push({ ...stats, brief: def.brief, limits: def.limits });

  console.log('\n=== ' + def.id + '「' + def.name + '」===');
  console.log('   ' + [...Array(def.m.w).keys()].map((i) => i % 10).join(''));
  def.m.g.forEach((r, y) => console.log(String(y).padStart(2, ' ') + ' ' + r.join('')));
  console.log(`可通行 ${stats.walkable}　掩體 ${stats.covers}（${(stats.density * 100).toFixed(1)}%）`
    + `　空投點 ${stats.drops}（間距 ${stats.dropGap}）`
    + `　主目標距離 ${stats.mainDist}（走 ${stats.routeLen} 步）`
    + `　暴露：直線 ${stats.directRun} / 必經 ${stats.forcedRun}`
    + `　預估耗時 ${stats.estRun}`
    + `　方向性掩蔽 東西 ${(stats.dirCover.ew * 100).toFixed(0)}% / 南北 ${(stats.dirCover.ns * 100).toFixed(0)}%`);
  console.log(`敵人 ${stats.enemies} ` + JSON.stringify(stats.kinds) + `　搜刮點 ${stats.caches}`);

  if (errors.length) {
    failed = true;
    console.error('❌ 驗證失敗:');
    errors.forEach((e) => console.error('  - ' + e));
  } else {
    console.log('✅ 驗證通過');
  }

  const out = HERE + '/../src/data/maps/' + def.id + '.json';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(toRawMap(def, stats), null, 2) + '\n', 'utf8');
}

// ---- 統計摘要（§13.5.4）：比較四張圖、歸納「什麼叫好地圖」的依據 ----
const rows = allStats.map((s) => [
  s.id, s.name, s.size, String(s.walkable),
  `${s.covers}（${(s.density * 100).toFixed(1)}%）`,
  `${s.drops}／${s.dropGap}`,
  `${s.mainDist}／${s.routeLen}`,
  `${s.directRun} / ${s.forcedRun}`,
  String(s.estRun),
  `${(s.dirCover.ew * 100).toFixed(0)}% / ${(s.dirCover.ns * 100).toFixed(0)}%`,
  `${s.enemies}　R${s.kinds.RUNNER ?? 0} S${s.kinds.SHOOTER ?? 0} H${s.kinds.HULK ?? 0}`,
  String(s.caches),
]);
const head = ['id', '名稱', '尺寸', '可通行', '掩體（密度）', '空投點／間距',
  '主目標距離／步數', '暴露 直線／必經', '預估耗時', '方向性掩蔽 東西／南北', '敵人組成', '搜刮點'];
const md = [
  '# 地圖統計摘要',
  '',
  '> 這份檔案由 `npm run map:build` 自動產生，**不要手動編輯**。',
  '> CI 會重跑並比對，內容與 `src/data/maps/*.json` 不一致就會失敗。',
  '',
  '四張圖不是為了內容變多，是**三個對照實驗加一個基準**（§13.1）。',
  '下面這張表就是「同一組數值在四種幾何下長什麼樣」的依據。',
  '',
  '| ' + head.join(' | ') + ' |',
  '|' + head.map(() => '---').join('|') + '|',
  ...rows.map((r) => '| ' + r.join(' | ') + ' |'),
  '',
  '## 各圖的設計意圖',
  '',
  ...allStats.flatMap((s) => [
    `### ${s.id}「${s.name}」`,
    '',
    s.brief,
    '',
    s.limits ? '> 這張圖覆寫了驗證門檻：`' + JSON.stringify(s.limits) + '`——那是一句寫下來的設計宣告，不是漏檢。\n' : '',
  ]),
  '## 欄位說明',
  '',
  '- **掩體密度** = 半身掩體格數 ÷ 可通行格數。門檻刻意寬，抓的是結構性錯誤而不是設計。',
  '- **主目標距離／步數** = 起點到主目標的曼哈頓距離／四方向最短路徑長度。兩者差距越大代表繞路越多。',
  '- **暴露 直線／必經** = 連續幾格的四鄰完全沒有阻擋物。',
  '  「直線」是走最短路徑要暴露多久，「必經」是**在所有走法之中最好的那一條**還是得暴露多久。',
  '  驗證檢查的是後者 —— 能繞開就不算問題。兩者差距大＝這張圖給了「繞路換安全」的選擇。',
  '- **預估耗時** = 走完所有目標再回撤離點的最短路徑 × 基礎移動時間。這是**下限估計**，',
  '  實際耗時一定更高（交火、繞路、搜刮、裝填）。它是靜態的，所以進得了 CI（§13.5）。',
  '- **方向性掩蔽 東西／南北** = 對該軸向射手提供得出掩蔽的可通行格比例。',
  '  掩體列的走向等於在決定哪個軸向的交火是安全的，所以兩者的**差距**有上限（v0.13）。',
  '',
];
mkdirSync(HERE + '/../docs', { recursive: true });
writeFileSync(HERE + '/../docs/map-stats.md', md.join('\n'), 'utf8');

console.log('\n已寫入 src/data/maps/*.json 與 docs/map-stats.md');
if (failed) { console.error('\n❌ 有地圖驗證失敗'); process.exit(1); }
console.log('✅ 四張地圖全部通過驗證');
