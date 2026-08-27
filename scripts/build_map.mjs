// 手工地圖作者工具：以明確的牆段／門／掩體列描述 mission_01，
// 產生 src/data/maps/mission_01.json 並驗證連通性。
// 這不是程序化生成 —— 每一段牆、每一個門、每一個敵人座標都是手填的。
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = HERE + '/../src/data/maps/mission_01.json';

const W = 32, H = 24;
const g = Array.from({ length: H }, () => Array(W).fill('.'));

const set = (x, y, c) => { g[y][x] = c; };
const hline = (y, x1, x2, c = '#') => { for (let x = x1; x <= x2; x++) set(x, y, c); };
const vline = (x, y1, y2, c = '#') => { for (let y = y1; y <= y2; y++) set(x, y, c); };
const door = (x, y) => set(x, y, '.');

// ---- 外牆 ----
hline(0, 0, W - 1); hline(H - 1, 0, W - 1);
vline(0, 0, H - 1); vline(W - 1, 0, H - 1);

// ---- 主結構牆 ----
vline(9, 1, 7);        // A 起始室 / B 北中室
hline(8, 1, 20);       // 北段 / 中央大廳
vline(21, 1, 22);      // 東側縱牆（貫穿全圖）
hline(7, 22, 30);      // E 東北室 / F 開闊地
hline(13, 1, 20);      // 中央大廳 / 南段
vline(9, 14, 22);      // D 西南室 / G 南中室
hline(18, 22, 30);     // F 開闊地 / H 終端室

// ---- 門（刻意稀少，讓路線可預測）----
door(5, 8);    // A -> C 中央大廳
door(14, 8);   // C -> B（起始室唯一出口是 (5,8) 南門，B/E 側翼必須先進中央大廳）
door(21, 3);   // B -> E
door(26, 7);   // E -> F
door(21, 11);  // C -> F   （主路線咽喉）
door(3, 13);   // C -> D
door(17, 13);  // C -> G
door(9, 18);   // D -> G
door(25, 18);  // F -> H   （終端室入口 1）
door(21, 21);  // G -> H   （終端室入口 2）

// ---- 半身掩體：成排配置，形成可連續蹲行推進的路線 ----
hline(5, 2, 6, '+');       // A 起始室
hline(5, 11, 18, '+');     // B 北中室
hline(10, 5, 12, '+');     // C 中央大廳 北排
hline(12, 8, 15, '+');     // C 中央大廳 南排（與北排交錯）
hline(11, 17, 19, '+');    // C 咽喉前的最後一排
hline(14, 23, 27, '+');    // F 開闊地 中央唯一掩體
hline(16, 2, 7, '+');      // D 西南室
hline(16, 11, 18, '+');    // G 南中室 北排
hline(20, 12, 19, '+');    // G 南中室 南排
hline(20, 23, 27, '+');    // H 終端室前

// ---- F 開闊地的少數柱子（其餘刻意留空，給射手型發揮）----
set(24, 9, '#'); set(28, 12, '#');

// ---- 目標與空投點 ----
set(1, 1, 'D');    // 起始空投點（撤離點）
set(2, 11, 'D');   // 約路線 1/3
set(23, 16, 'D');  // 約路線 2/3（在開闊地裡，回程要付代價）
set(29, 21, 'T');  // 主目標：距離起點最遠的一端
set(29, 2, 'S');   // 次要目標 1：東北側翼
set(2, 21, 'S');   // 次要目標 2：西南側翼

// v0.8：facing 是初始面向（§13.2）。敵人一律只看得見面向的前方半平面，
// 所以這一欄等於在畫「每個守衛在看哪邊」——沒有面向的守衛不是守衛，是靶。
// 刻意留了幾個背對主要進路的：那是背刺（§8.8）該被學會的地方。
const enemies = [
  { archetype: 'RUNNER',  pos: { x: 11, y: 9 },  facing: 'W' },  // C 中央大廳 北側，盯著西邊進路
  { archetype: 'HULK',    pos: { x: 12, y: 11 }, facing: 'W' },  // C 正中路障，正面朝走廊
  { archetype: 'RUNNER',  pos: { x: 18, y: 12 }, facing: 'W' },  // C 東側
  { archetype: 'SHOOTER', pos: { x: 19, y: 9 },  facing: 'W' },  // C 覆蓋通往咽喉的通路
  { archetype: 'SHOOTER', pos: { x: 29, y: 3 },  facing: 'S' },  // E 看守次要目標 1，背對通道
  { archetype: 'SHOOTER', pos: { x: 26, y: 10 }, facing: 'S' },  // F 開闊地 北，盯著開闊地
  { archetype: 'SHOOTER', pos: { x: 28, y: 16 }, facing: 'N' },  // F 開闊地 南
  { archetype: 'RUNNER',  pos: { x: 28, y: 13 }, facing: 'W' },  // F
  { archetype: 'RUNNER',  pos: { x: 13, y: 18 }, facing: 'E' },  // G 南側翼，背對西邊
  { archetype: 'HULK',    pos: { x: 26, y: 21 }, facing: 'N' },  // H 終端守衛：守北入口，南入口可繞背
];
// ================= 驗證 =================
const rows = g.map((r) => r.join(''));
const BLOCK = new Set(['#', '+']);
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? '#' : rows[y][x]);
const passable = (x, y) => !BLOCK.has(at(x, y));

const DIRS = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
// STRICT 切角規則（與 core/pathfind.ts 一致）
function canStep(x, y, dx, dy) {
  if (!passable(x + dx, y + dy)) return false;
  if (dx !== 0 && dy !== 0) {
    if (!passable(x + dx, y)) return false;
    if (!passable(x, y + dy)) return false;
  }
  return true;
}

function reachable(from) {
  const seen = new Set([`${from.x},${from.y}`]);
  const q = [from];
  while (q.length) {
    const c = q.shift();
    for (const [dx, dy] of DIRS) {
      if (!canStep(c.x, c.y, dx, dy)) continue;
      const n = { x: c.x + dx, y: c.y + dy };
      const k = `${n.x},${n.y}`;
      if (seen.has(k)) continue;
      seen.add(k); q.push(n);
    }
  }
  return seen;
}

const errors = [];
rows.forEach((r, y) => { if (r.length !== W) errors.push(`row ${y} 寬度 ${r.length} != ${W}`); });

const start = { x: 1, y: 1 };
const seen = reachable(start);
const need = [];
rows.forEach((r, y) => [...r].forEach((c, x) => { if ('DTS'.includes(c)) need.push({ c, x, y }); }));
for (const n of need) if (!seen.has(`${n.x},${n.y}`)) errors.push(`${n.c} @ (${n.x},${n.y}) 從起點不可達`);
for (const e of enemies) {
  const c = at(e.pos.x, e.pos.y);
  if (BLOCK.has(c)) errors.push(`敵人 ${e.archetype} @ (${e.pos.x},${e.pos.y}) 站在阻擋物 '${c}' 上`);
  if (!seen.has(`${e.pos.x},${e.pos.y}`)) errors.push(`敵人 ${e.archetype} @ (${e.pos.x},${e.pos.y}) 不可達`);
}
const dup = new Set();
for (const e of enemies) { const k = `${e.pos.x},${e.pos.y}`; if (dup.has(k)) errors.push(`敵人座標重複 ${k}`); dup.add(k); }
if (dup.has('1,1')) errors.push('敵人站在起始空投點上');

const counts = {};
for (const r of rows) for (const c of r) counts[c] = (counts[c] || 0) + 1;
if ((counts['D'] || 0) < 3) errors.push('DROP_POINT 少於 3 個');
if ((counts['S'] || 0) !== 2) errors.push('SUPPLY 必須剛好 2 個');
if ((counts['T'] || 0) !== 1) errors.push('TERMINAL 必須剛好 1 個');

console.log('   ' + [...Array(W).keys()].map((i) => i % 10).join(''));
rows.forEach((r, y) => console.log(String(y).padStart(2, ' ') + ' ' + r));
console.log('\n地形統計:', counts);
console.log('可達格數:', seen.size);
console.log('敵人:', enemies.length, JSON.stringify(enemies.reduce((a, e) => (a[e.archetype] = (a[e.archetype]||0)+1, a), {})));

if (errors.length) { console.error('\n❌ 驗證失敗:'); errors.forEach((e) => console.error('  - ' + e)); process.exit(1); }
console.log('\n✅ 地圖驗證通過');

const json = {
  id: 'mission_01',
  name: '廢棄水處理廠',
  width: W,
  height: H,
  legend: { '.': 'FLOOR', '#': 'WALL', '+': 'HALF_COVER', D: 'DROP_POINT', T: 'TERMINAL', S: 'SUPPLY' },
  tiles: rows,
  startDropPoint: { x: 1, y: 1 },
  enemies,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(json, null, 2) + '\n', 'utf8');
console.log('已寫入', OUT);
