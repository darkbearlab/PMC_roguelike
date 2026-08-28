/**
 * mission_03「乾涸沉澱池」—— 開闊地（§13.1 的對照實驗 B）。
 *
 * **要驗證的假設（v0.13 修正版）**：
 * 當穿越開闊地有安全但繞遠的選項時，玩家會不會選它；射程數值在長距離下是否正確。
 *
 * v0.11 的初版是「大面積開闊 + 孤立的點狀掩體」。實測結果是屠宰場：
 * 機器人 1/5 成功、四人名冊平均死 3.4 個。原因不是難度而是算術 ——
 * **開闊地上雙方都沒有掩蔽修正，交火退化成純粹的傷害競賽，而玩家是一個人打八個。**
 *
 * v0.13 重新定義「開闊」：
 *
 *   **有趣的開闊不是「沒有掩體」，是「有掩體，但穿過去的路很長」。**
 *
 * 所以池區裡加了三條掩體構成的穿越路線，彼此角度不同、都明顯比直線遠。
 * 玩家的決策因此變成**繞遠路安全通過，還是抄近路暴露一段** ——
 * 初版沒有這個決策，只有一條死路。
 */
import { grid, border, hline, vline, set, rect } from './lib.mjs';

const W = 32, H = 24;
const m = grid(W, H);
border(m);

const cov = (x, y) => set(m, x, y, '+');
const covH = (y, x1, x2) => hline(m, y, x1, x2, '+');
const covV = (x, y1, y2) => vline(m, x, y1, y2, '+');

// ---- 池壁：唯一的實牆結構，把開闊地切成幾塊但都留了缺口 ----
hline(m, 7, 4, 13); set(m, 8, 7, '.');
vline(m, 13, 7, 12);
hline(m, 12, 4, 13); set(m, 10, 12, '.');
hline(m, 6, 19, 28); set(m, 24, 6, '.');
vline(m, 19, 6, 11);
hline(m, 16, 9, 24); set(m, 14, 16, '.'); set(m, 21, 16, '.');
vline(m, 24, 16, 20);

// ---- 穿越路線一：北緣—東側（最長，但幾乎全程有掩護）----
covH(3, 5, 11);
covH(3, 14, 20);
covV(27, 4, 10);
covV(27, 12, 18);

// ---- 穿越路線二：中央階梯（中等長度，角度與路線一不同）----
covH(10, 5, 9);
covV(10, 13, 15);
covH(14, 11, 15);
covV(17, 17, 20);
covH(20, 18, 22);

// ---- 穿越路線三：南緣—西側（與另外兩條交錯）----
covV(4, 14, 19);
covH(21, 6, 12);
covH(19, 26, 30);

// 直線對角（西北 → 東南）刻意留空：抄近路就是整段暴露。
// 那一段的長度由驗證器的「直線暴露」量出來，跟繞路的代價一起記在 map-stats。

// ---- 目標與空投點 ----
set(m, 1, 1, 'D');       // 起始空投點（撤離點）：西北角
set(m, 1, 21, 'D');      // 西南
set(m, 30, 2, 'D');      // 東北
set(m, 29, 21, 'T');     // 主目標：對角線最遠端
set(m, 16, 1, 'S');      // 次要目標 1：北緣正中
set(m, 1, 12, 'S');      // 次要目標 2：西緣
set(m, 16, 11, 'L');     // 搜刮點：中央池底，進去要暴露
set(m, 29, 11, 'L');     // 搜刮點：東側掩體線旁

const caches = [
  { pos: { x: 16, y: 11 }, label: '沉澱池底沉積物', items: [{ defId: 'CORE', qty: 1 }, { defId: 'SCRAP', qty: 2 }, { defId: 'heat_84mm', qty: 1 }] },
  { pos: { x: 29, y: 11 }, label: '棄置的彈藥箱', items: [{ defId: 'standard_5.56', qty: 12 }, { defId: 'standard_7.62', qty: 10 }, { defId: 'SEALANT', qty: 1 }] },
];

// SHOOTER 為主（射程 7、視野 12）：開闊地讓它們在玩家還打不到的距離外開火。
// 面向朝著開闊地中央 —— 那是抄近路的人非過不可的地方。
const enemies = [
  { archetype: 'SHOOTER', pos: { x: 11, y: 5 },  facing: 'S' },
  { archetype: 'SHOOTER', pos: { x: 22, y: 4 },  facing: 'W' },
  { archetype: 'SHOOTER', pos: { x: 16, y: 14 }, facing: 'N' },
  { archetype: 'SHOOTER', pos: { x: 26, y: 14 }, facing: 'W' },
  { archetype: 'SHOOTER', pos: { x: 7, y: 15 },  facing: 'E' },
  { archetype: 'RUNNER',  pos: { x: 9, y: 19 },  facing: 'N' },
  { archetype: 'RUNNER',  pos: { x: 20, y: 18 }, facing: 'W' },
  { archetype: 'RUNNER',  pos: { x: 15, y: 9 },  facing: 'N' },
  { archetype: 'HULK',    pos: { x: 27, y: 21 }, facing: 'W' },   // 終端守衛
  { archetype: 'HULK',    pos: { x: 3, y: 5 },   facing: 'S' },
];

export default {
  id: 'mission_03',
  name: '乾涸沉澱池',
  brief: '**開闊地。**要驗證的假設：當穿越開闊地有安全但繞遠的選項時，玩家會不會選它。'
    + '有趣的開闊不是「沒有掩體」，是「有掩體，但穿過去的路很長」——'
    + '池區裡有三條角度不同的掩體路線，抄對角線最短但整段暴露。',
  m,
  start: { x: 1, y: 1 },
  enemies,
  caches,
};
