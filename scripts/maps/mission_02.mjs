/**
 * mission_02「輸送管廊」—— 狹窄空間（§13.1 的對照實驗 A）。
 *
 * **要驗證的假設（v0.13 修正版）**：
 * 在狹窄空間中，正交直線對射是否致命；側翼繞行是否仍然可行。
 *
 * v0.11 的初版是一格寬的走廊。實測結果是**空轉**：機器人 3/5 成功、
 * 平均只開九槍、耗時是基準的六倍。原因是幾何 ——
 * 一格寬 + 曼哈頓距離 + 蹲姿 180 度視野，有效視距被壓到趨近於零，
 * 玩家常常走完全程沒遇到人。一格寬同時也讓「側翼繞行」根本無法成立，
 * 而那正是這張圖原本要驗的東西。
 *
 * v0.13 保留性格（狹窄、正交直線對射致命、掩體稀少），改掉幾何：
 *  - **主幹管廊兩格寬**，遭遇戰才有發生的空間，側翼繞行才做得到
 *  - 一格寬只留給**檢修爬道**，那是繞側翼的路而不是主要動線
 *  - 每隔一段就有**檢修室或路口**，長通道不再毫無變化
 */
import { grid, border, hline, vline, set, rect } from './lib.mjs';

const W = 32, H = 24;
const m = grid(W, H, '#');          // 先全部填滿，再挖

const room = (x1, y1, x2, y2) => rect(m, x1, y1, x2, y2, '.');
/** 主幹管廊：兩格寬。 */
const mainH = (y, x1, x2) => { hline(m, y, x1, x2, '.'); hline(m, y + 1, x1, x2, '.'); };
const mainV = (x, y1, y2) => { vline(m, x, y1, y2, '.'); vline(m, x + 1, y1, y2, '.'); };
/** 檢修爬道：一格寬，只用來繞側翼。 */
const crawlH = (y, x1, x2) => hline(m, y, x1, x2, '.');
const crawlV = (x, y1, y2) => vline(m, x, y1, y2, '.');

// ---- 主幹：北管廊 + 三條縱管 + 兩條橫管 ----
mainH(2, 1, 30);
mainV(3, 2, 19);
mainV(15, 4, 19);
mainV(26, 4, 19);
mainH(10, 3, 27);
mainH(18, 3, 27);

// ---- 檢修室與路口：長通道之間的變化，也是遭遇戰的場地 ----
room(1, 1, 7, 5);        // A 起始室
room(11, 5, 19, 8);      // B 中央檢修室
room(23, 5, 30, 8);      // C 東北泵室
room(1, 13, 8, 17);      // D 西側閥室
room(11, 13, 19, 16);    // E 中央閥室
room(21, 13, 30, 21);    // F 終端機房

// ---- 檢修爬道：一格寬的側翼路線。走得慢，但繞得過去 ----
crawlV(9, 3, 19);
crawlH(7, 8, 11);
crawlH(15, 8, 11);
crawlV(20, 6, 12);
crawlH(6, 20, 23);
crawlV(12, 17, 19);

// ---- 掩體：稀少，且多為單側 ----
set(m, 5, 4, '+'); set(m, 6, 3, '+');           // A
set(m, 13, 6, '+'); set(m, 17, 7, '+');         // B
set(m, 25, 6, '+'); set(m, 28, 7, '+');         // C
set(m, 3, 15, '+'); set(m, 6, 14, '+');         // D
set(m, 13, 14, '+'); set(m, 17, 15, '+');       // E
set(m, 23, 16, '+'); set(m, 27, 18, '+');
set(m, 25, 20, '+'); set(m, 29, 15, '+');       // F
set(m, 11, 11, '+'); set(m, 19, 10, '+');       // 橫管上的單側掩體
set(m, 7, 19, '+'); set(m, 22, 11, '+');

// ---- 目標與空投點：各在不同的分支上 ----
set(m, 1, 1, 'D');       // 起始空投點（撤離點）
set(m, 4, 19, 'D');      // 西縱管底
set(m, 30, 5, 'D');      // C 東北泵室
set(m, 29, 21, 'T');     // 主目標：F 終端機房最深處
set(m, 23, 5, 'S');      // 次要目標 1：C 泵室西口
set(m, 1, 16, 'S');      // 次要目標 2：D 西側閥室
set(m, 18, 5, 'L');      // 搜刮點：B 中央檢修室
set(m, 6, 16, 'L');      // 搜刮點：D 閥室

const caches = [
  { pos: { x: 18, y: 5 }, label: '管線工具箱', items: [{ defId: 'AMMO_556', qty: 10 }, { defId: 'AMMO_12GA', qty: 10 }] },
  { pos: { x: 6, y: 16 }, label: '維修備品櫃', items: [{ defId: 'OPTICS', qty: 1 }, { defId: 'SEALANT', qty: 1 }, { defId: 'AMMO_9MM', qty: 20 }] },
];

// 兩格寬的主幹讓一隻敵人塞不死通路，所以守衛可以站在管廊裡而不只是房間。
// 面向沿著管廊 —— 窄空間裡的正面對射沒有掩蔽，唯一的破口是走檢修爬道包過去。
const enemies = [
  { archetype: 'SHOOTER', pos: { x: 12, y: 2 },  facing: 'W' },  // 北管廊
  { archetype: 'RUNNER',  pos: { x: 3, y: 8 },   facing: 'N' },  // 西縱管
  { archetype: 'SHOOTER', pos: { x: 15, y: 6 },  facing: 'W' },  // B 檢修室
  { archetype: 'HULK',    pos: { x: 16, y: 11 }, facing: 'W' },  // 中橫管的塞子（兩格寬，繞得過）
  { archetype: 'RUNNER',  pos: { x: 21, y: 10 }, facing: 'W' },
  { archetype: 'SHOOTER', pos: { x: 27, y: 6 },  facing: 'S' },  // C 泵室，背對北管廊
  { archetype: 'RUNNER',  pos: { x: 5, y: 15 },  facing: 'E' },  // D 閥室，背對西側
  { archetype: 'SHOOTER', pos: { x: 15, y: 18 }, facing: 'W' },  // 南橫管
  { archetype: 'HULK',    pos: { x: 24, y: 19 }, facing: 'W' },  // F 機房門口
  { archetype: 'RUNNER',  pos: { x: 28, y: 14 }, facing: 'N' },  // 機房內，背對南門
];

export default {
  id: 'mission_02',
  name: '輸送管廊',
  brief: '**狹窄空間。**要驗證的假設：正交直線對射是否致命；側翼繞行在窄空間中是否仍然可行。'
    + '主幹管廊兩格寬，一格寬只留給檢修爬道 —— v0.11 的一格寬版本讓有效視距趨近於零，'
    + '玩家走完全程只開九槍，那是空轉不是節奏。',
  m,
  start: { x: 1, y: 1 },
  enemies,
  caches,
};
