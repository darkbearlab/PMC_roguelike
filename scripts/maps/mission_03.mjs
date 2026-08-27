/**
 * mission_03「乾涸沉澱池」—— 開闊地為主（§13.1 的對照實驗 B）。
 *
 * **要驗證的假設**：射程數值是否正確；掩體稀缺時的手感；SHOOTER 的威脅程度。
 *
 * 掩體是孤立的點，彼此相隔數個移動回合。橫越開闊地要暴露很久 ——
 * 但沉澱池的池壁與外牆讓「貼著邊繞」永遠可行，所以**必經**的暴露仍然很短。
 * 這正是這張圖的題目：直走很快但很痛，繞路很安全但很慢。
 *
 * 敵人以 SHOOTER 為主。曼哈頓射程在斜向砍半的效果會在這裡最明顯。
 */
import { grid, border, hline, vline, set, rect } from './lib.mjs';

const W = 32, H = 24;
const m = grid(W, H);
border(m);

// ---- 三個沉澱池的池壁：唯一的大型結構，其餘全是開闊地 ----
// 池壁是牆，但都留了缺口，繞路的代價是時間而不是走不到。
hline(m, 6, 3, 14); set(m, 9, 6, '.');
vline(m, 3, 6, 11); set(m, 3, 9, '.');
vline(m, 14, 6, 11);
hline(m, 11, 3, 14); set(m, 11, 11, '.');

hline(m, 6, 20, 29); set(m, 25, 6, '.');
vline(m, 20, 6, 12);
vline(m, 29, 6, 12); set(m, 29, 9, '.');
hline(m, 12, 20, 29); set(m, 23, 12, '.');

hline(m, 17, 8, 22); set(m, 12, 17, '.'); set(m, 19, 17, '.');
vline(m, 8, 17, 21);
vline(m, 22, 17, 21);

// ---- 孤立的點狀掩體。刻意讓它們彼此相隔 6～10 格 ----
const pip = (x, y) => set(m, x, y, '+');
pip(17, 3);
pip(6, 14); pip(7, 14);
pip(17, 9);
pip(26, 15); pip(26, 16);
pip(4, 20);
pip(15, 22);
pip(30, 20);
pip(11, 8);

// ---- 目標與空投點：全部在開闊地邊緣 ----
set(m, 1, 1, 'D');       // 起始空投點（撤離點）：西北角
set(m, 1, 22, 'D');      // 西南角
set(m, 30, 3, 'D');      // 東北角
set(m, 30, 22, 'T');     // 主目標：對角線最遠端
set(m, 16, 1, 'S');      // 次要目標 1：北緣正中，橫越無掩護
set(m, 1, 12, 'S');      // 次要目標 2：西緣
set(m, 18, 9, 'L');      // 搜刮點：中央池內，進去要暴露
set(m, 27, 16, 'L');     // 搜刮點：東側掩體旁

const caches = [
  { pos: { x: 18, y: 9 }, label: '沉澱池底沉積物', items: [{ defId: 'CORE', qty: 1 }, { defId: 'SCRAP', qty: 2 }] },
  { pos: { x: 27, y: 16 }, label: '棄置的彈藥箱', items: [{ defId: 'AMMO_RIFLE', qty: 12 }, { defId: 'AMMO_ROCKET', qty: 1 }] },
];

// SHOOTER 為主（射程 7、視野 12）：開闊地讓它們可以在玩家還打不到的距離外開火。
// 面向全部朝向開闊地的中央，因為那是玩家非過不可的地方。
const enemies = [
  { archetype: 'SHOOTER', pos: { x: 12, y: 4 },  facing: 'S' },
  { archetype: 'SHOOTER', pos: { x: 24, y: 4 },  facing: 'W' },
  { archetype: 'SHOOTER', pos: { x: 17, y: 14 }, facing: 'N' },
  { archetype: 'SHOOTER', pos: { x: 27, y: 15 }, facing: 'W' },
  { archetype: 'SHOOTER', pos: { x: 5, y: 15 },  facing: 'E' },
  { archetype: 'RUNNER',  pos: { x: 9, y: 20 },  facing: 'N' },
  { archetype: 'RUNNER',  pos: { x: 21, y: 20 }, facing: 'W' },
  { archetype: 'RUNNER',  pos: { x: 15, y: 12 }, facing: 'N' },
  { archetype: 'HULK',    pos: { x: 28, y: 21 }, facing: 'W' },   // 終端守衛
  { archetype: 'HULK',    pos: { x: 3, y: 4 },   facing: 'S' },
];

export default {
  id: 'mission_03',
  name: '乾涸沉澱池',
  brief: '**開闊地為主。**要驗證的假設：射程數值是否正確；掩體稀缺時的手感；SHOOTER 的威脅程度。'
    + '掩體是孤立的點，彼此相隔數個移動回合；橫越開闊地要暴露很久，'
    + '曼哈頓射程在斜向砍半的效果在這裡最明顯。',
  m,
  start: { x: 1, y: 1 },
  enemies,
  caches,
};
