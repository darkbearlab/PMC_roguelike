/**
 * mission_02「輸送管廊」—— 走廊密集（§13.1 的對照實驗 A）。
 *
 * **要驗證的假設**：正交直線對射是否真的致命；在窄空間中側翼繞行是否仍然可行。
 *
 * 做法是「全部填滿再挖走廊」，不是「畫牆」。一格寬的東西向走廊，
 * 站在裡面的人南北都是牆 —— 但掩蔽只看**朝向射手那一側**的鄰格，
 * 所以沿著走廊對射時兩邊都沒有掩蔽（§7.2b 的推論 1）。這正是要測的東西。
 *
 * 掩體只放在房間裡，而且刻意多為單側，不容易形成良好掩蔽。
 *
 * **預期會暴露的問題**：交火極快結束；若繞側翼的路徑太長，
 * `targetExposure` 權重會失效，AI 只會硬推。
 */
import { grid, border, hline, vline, set, rect } from './lib.mjs';

const W = 32, H = 24;
const m = grid(W, H, '#');          // 先全部填滿，再挖

const room = (x1, y1, x2, y2) => rect(m, x1, y1, x2, y2, '.');
const corrH = (y, x1, x2) => hline(m, y, x1, x2, '.');
const corrV = (x, y1, y2) => vline(m, x, y1, y2, '.');

// ---- 北側主幹：一條貫穿全圖的東西向走廊 ----
corrH(2, 1, 30);

// ---- 四條南向支線，長度不一 ----
corrV(4, 2, 21);
corrV(11, 2, 14);
corrV(18, 2, 21);
corrV(25, 2, 8);

// ---- 橫向連通（刻意不全連，製造分歧與死路的差異）----
corrH(8, 11, 27);
corrH(14, 4, 18);
corrH(21, 4, 18);

// ---- 房間：走廊的端點與轉折處 ----
room(1, 1, 3, 4);        // A 起始室
room(8, 4, 13, 6);       // B 北中室
room(21, 4, 24, 6);      // C 東北室
room(26, 9, 30, 13);     // D 東側室（由 x=25 的支線往下）
corrV(27, 8, 9);
room(1, 16, 6, 19);      // E 西南室
corrH(19, 1, 4);
room(20, 16, 30, 22);    // F 終端室
corrH(19, 18, 22);
corrV(22, 19, 21);
room(8, 17, 15, 20);     // G 南中室
corrV(11, 15, 17);

// ---- 掩體：只在房間裡，且多為單側 ----
set(m, 9, 5, '+'); set(m, 12, 5, '+');            // B
set(m, 22, 5, '+');                                // C
set(m, 27, 11, '+'); set(m, 29, 10, '+');          // D
set(m, 3, 17, '+'); set(m, 5, 18, '+');            // E
set(m, 10, 18, '+'); set(m, 13, 19, '+');          // G
set(m, 23, 18, '+'); set(m, 27, 20, '+');
set(m, 25, 17, '+');                               // F 終端室：三面單側掩體

// ---- 目標與空投點：各在不同的分支上 ----
set(m, 1, 1, 'D');       // 起始空投點（撤離點）
set(m, 4, 21, 'D');      // 南向長支線的底
set(m, 30, 9, 'D');      // 東側室
set(m, 29, 22, 'T');     // 主目標：F 終端室最深處
set(m, 24, 4, 'S');      // 次要目標 1：C 東北室
set(m, 1, 19, 'S');      // 次要目標 2：E 西南室
set(m, 12, 6, 'L');      // 搜刮點：B 北中室
set(m, 14, 18, 'L');     // 搜刮點：G 南中室

const caches = [
  { pos: { x: 12, y: 6 }, label: '管線工具箱', items: [{ defId: 'AMMO_RIFLE', qty: 10 }] },
  { pos: { x: 14, y: 18 }, label: '維修備品櫃', items: [{ defId: 'OPTICS', qty: 1 }, { defId: 'AMMO_RIFLE', qty: 6 }] },
];

// 一格寬的走廊裡，**一隻敵人就是一道牆** —— 所以守衛全部擺在房間裡，
// 不擋住唯一的通路（驗證器會擋下這件事）。它們面向走廊的來向：
// 窄通道裡沒有側翼可繞，唯一的破口是從另一條支線包過去。
const enemies = [
  { archetype: 'SHOOTER', pos: { x: 10, y: 5 },  facing: 'W' },  // B 北中室，正對走廊來向
  { archetype: 'RUNNER',  pos: { x: 13, y: 5 },  facing: 'W' },
  { archetype: 'SHOOTER', pos: { x: 23, y: 5 },  facing: 'W' },  // C 東北室
  { archetype: 'SHOOTER', pos: { x: 28, y: 11 }, facing: 'W' },  // D 東側室
  { archetype: 'RUNNER',  pos: { x: 29, y: 12 }, facing: 'N' },
  { archetype: 'RUNNER',  pos: { x: 3, y: 18 },  facing: 'E' },  // E 西南室，背對走廊
  { archetype: 'HULK',    pos: { x: 10, y: 19 }, facing: 'N' },  // G 南中室
  { archetype: 'SHOOTER', pos: { x: 12, y: 19 }, facing: 'N' },
  { archetype: 'HULK',    pos: { x: 24, y: 21 }, facing: 'W' },  // F 終端室門口
  { archetype: 'RUNNER',  pos: { x: 28, y: 17 }, facing: 'S' },  // 終端室內，背對北門
];


export default {
  id: 'mission_02',
  name: '輸送管廊',
  brief: '**走廊密集。**要驗證的假設：正交直線對射是否真的致命；窄空間中側翼繞行是否仍然可行。'
    + '一格寬的走廊裡兩邊都沒有掩蔽，唯一的破口是從另一條支線包過去。',
  m,
  start: { x: 1, y: 1 },
  enemies,
  caches,
};
