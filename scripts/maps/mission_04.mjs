/**
 * mission_04「舊倉儲區」—— 掩體密集、多路線（§13.1 的對照實驗 C）。
 *
 * **這張圖是 v0.10 最重要的驗收場地。**
 *
 * 要驗證的假設：AI 的 `targetExposure` 繞側翼是否真的會發生；
 * 玩家固守單一掩體是否會被懲罰；掩體對射僵局是否成立。
 *
 * 關鍵在於掩體排的**方向**：v0.10 的實測發現 mission_01 的半身掩體是
 * 水平成排的，提供的是對南北向射手的掩蔽，而那張圖的動線是東西向 ——
 * 於是 AI 幾乎沒有掩體可用。
 *
 * 這裡改成**縱向的貨架列**：走道是南北向的平行推進路線，
 * 而掩蔽對**東西向**的交火生效。列與列之間留了橫向缺口，
 * 繞側翼在幾步之內可達 —— 這才測得到 `targetExposure`。
 */
import { grid, border, hline, vline, set, rect } from './lib.mjs';

const W = 32, H = 24;
const m = grid(W, H);
border(m);

/**
 * 一列縱向貨架：從 y1 到 y2 的半身掩體，但在 gaps 指定的 y 留缺口。
 * 缺口就是橫向連通，也是繞側翼的通道。
 */
function rack(x, y1, y2, gaps) {
  for (let y = y1; y <= y2; y++) {
    if (gaps.includes(y)) continue;
    set(m, x, y, '+');
  }
}

// ---- 六列貨架，缺口刻意錯開，讓橫向移動要走 Z 字 ----
rack(5,  3, 20, [7, 14]);
rack(9,  3, 20, [4, 11, 18]);
rack(13, 3, 20, [7, 14]);
rack(17, 3, 20, [4, 11, 18]);
rack(21, 3, 20, [7, 14]);
rack(25, 3, 20, [4, 11, 18]);

// ---- 少數實牆：辦公室與裝卸區，讓地形不是純粹的柵欄 ----
rect(m, 27, 3, 30, 7, '#');  rect(m, 28, 4, 30, 6, '.');  set(m, 27, 5, '.');
rect(m, 2, 16, 3, 20, '#');  set(m, 3, 18, '.');
hline(m, 22, 5, 25, '#');    set(m, 11, 22, '.'); set(m, 19, 22, '.');

// ---- 目標與空投點：分散在不同的走道上，逼玩家橫向移動 ----
set(m, 1, 1, 'D');       // 起始空投點（撤離點）：西北
set(m, 15, 1, 'D');      // 北緣正中
set(m, 3, 22, 'D');      // 西南
set(m, 29, 22, 'T');     // 主目標：東南，最遠的走道底
set(m, 29, 12, 'S');     // 次要目標 1：東側走道中段
set(m, 1, 12, 'S');      // 次要目標 2：西側走道中段
set(m, 7, 11, 'L');      // 搜刮點：貨架之間
set(m, 19, 18, 'L');
set(m, 29, 5, 'L');      // 辦公室裡

const caches = [
  { pos: { x: 7, y: 11 }, label: '棧板上的補給', items: [{ defId: 'AMMO_RIFLE', qty: 10 }] },
  { pos: { x: 19, y: 18 }, label: '翻倒的板條箱', items: [{ defId: 'SCRAP', qty: 2 }, { defId: 'AMMO_RIFLE', qty: 6 }] },
  { pos: { x: 29, y: 5 }, label: '主管辦公室', items: [{ defId: 'CORE', qty: 1 }, { defId: 'OPTICS', qty: 1 }] },
];

// 面向沿著走道（南北）或跨走道（東西）：兩種都有，才看得出繞側翼有沒有用。
// 東西向的守衛正是 targetExposure 該去解決的對象。
const enemies = [
  { archetype: 'SHOOTER', pos: { x: 7, y: 6 },   facing: 'S' },   // 西走道
  { archetype: 'SHOOTER', pos: { x: 11, y: 16 }, facing: 'N' },
  { archetype: 'RUNNER',  pos: { x: 15, y: 8 },  facing: 'S' },
  { archetype: 'SHOOTER', pos: { x: 19, y: 5 },  facing: 'S' },
  { archetype: 'RUNNER',  pos: { x: 23, y: 12 }, facing: 'N' },
  { archetype: 'HULK',    pos: { x: 15, y: 19 }, facing: 'N' },   // 南側橫向通路的塞子
  { archetype: 'RUNNER',  pos: { x: 3, y: 8 },   facing: 'S' },
  { archetype: 'SHOOTER', pos: { x: 29, y: 15 }, facing: 'N' },
  { archetype: 'HULK',    pos: { x: 27, y: 21 }, facing: 'W' },   // 終端守衛
  { archetype: 'RUNNER',  pos: { x: 11, y: 3 },  facing: 'E' },   // 背對西側走道
];

export default {
  id: 'mission_04',
  name: '舊倉儲區',
  brief: '**掩體密集、多路線。v0.10 最重要的驗收場地。**要驗證的假設：AI 的 `targetExposure` '
    + '繞側翼是否真的會發生；玩家固守單一掩體是否會被懲罰；掩體對射僵局是否成立。'
    + '掩體是**縱向**的貨架列（不是 mission_01 那種水平排），所以掩蔽對東西向的交火生效 —— '
    + 'v0.10 在 mission_01 上量到「敵人幾乎沒有掩體可用」，就是被那個方向問題卡住的。',
  m,
  start: { x: 1, y: 1 },
  enemies,
  caches,
};
