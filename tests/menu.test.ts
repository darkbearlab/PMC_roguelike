/**
 * §12.4 情境選單／射擊預覽面板。純字串組裝，不需要 DOM。
 */
import { describe, it, expect } from 'vitest';
import { tileMenuHtml } from '../src/ui/menus';
import { applyCommand } from '../src/core/commands';
import { testState, player } from './helpers';

const ROOM = [
  '##############',
  '#D..........T#',
  '#............#',
  '#S..........S#',
  '##############',
];

describe('射擊預覽面板', () => {
  const withFoe = () => testState(ROOM, [{ archetype: 'HULK', pos: { x: 5, y: 1 } }]);

  it('點敵人會出現預覽面板，且含命中率／傷害／剩餘 AP 三個固定欄位', () => {
    const html = tileMenuHtml(withFoe(), { x: 5, y: 1 })!;
    expect(html).toContain('射擊預覽');
    expect(html).toContain('命中率');
    expect(html).toContain('傷害');
    expect(html).toContain('剩餘 AP');
  });

  it('MVP 階段命中率欄位顯示 100%', () => {
    const html = tileMenuHtml(withFoe(), { x: 5, y: 1 })!;
    expect(html).toMatch(/命中率<\/span><b>100%<\/b>/);
  });

  it('預期傷害已扣除護甲：AR-9 對裝甲型顯示 1', () => {
    const html = tileMenuHtml(withFoe(), { x: 5, y: 1 })!;
    expect(html).toMatch(/傷害<\/span><b>1<\/b>/);
  });

  it('需要二次點擊才會執行：面板提供「確認射擊」按鈕', () => {
    const html = tileMenuHtml(withFoe(), { x: 5, y: 1 })!;
    expect(html).toContain('data-do="fire"');
    expect(html).toContain('確認射擊');
  });

  it('不合法時按鈕灰化並附上原因，不是點下去才拒絕', () => {
    const s = testState(ROOM, [{ archetype: 'HULK', pos: { x: 11, y: 3 } }]);
    const html = tileMenuHtml(s, { x: 11, y: 3 })!;
    expect(html).toContain('無法射擊');
    expect(html).toContain('超出射程');
    expect(html).not.toContain('data-do="fire"');
  });
});

describe('其他情境選單', () => {
  it('點空格 → 移動至此，並顯示所需 AP', () => {
    const html = tileMenuHtml(testState(ROOM), { x: 3, y: 1 })!;
    expect(html).toContain('移動至此');
    expect(html).toContain('2 AP');
  });

  it('AP 不足的移動選項被禁用', () => {
    const html = tileMenuHtml(testState(ROOM), { x: 8, y: 3 })!;
    expect(html).toContain('移動至此');
    expect(html).toContain('disabled');
    expect(html).toContain('AP 不足');
  });

  it('點自己 → 顯示詳細狀態', () => {
    const html = tileMenuHtml(testState(ROOM), { x: 1, y: 1 })!;
    expect(html).toContain('詳細狀態');
    expect(html).toContain('AR-9 制式步槍');
    expect(html).toContain('RR-4 無後座力砲');
  });

  it('點目標物 → 互動（站上去才會亮）', () => {
    let s = testState(ROOM);
    expect(tileMenuHtml(s, { x: 12, y: 1 })!).toContain('移動至此');
    player(s).pos = { x: 12, y: 1 };
    const html = tileMenuHtml(s, { x: 12, y: 1 })!;
    expect(html).toContain('存取終端');
    expect(html).toContain('data-do="interact"');
    s = applyCommand(s, { type: 'INTERACT' });
    expect(s.objectives.main.done).toBe(true);
  });

  it('點屍體 → 列出可拾取的武器', () => {
    let s = testState(ROOM);
    player(s).hp = 3;
    player(s).pos = { x: 5, y: 2 };
    s = applyCommand(s, { type: 'FIRE', target: { x: 5, y: 2 } });
    s = applyCommand(s, { type: 'DEPLOY_REINFORCEMENT', soldierId: s.roster[0] });
    const html = tileMenuHtml(s, { x: 5, y: 2 })!;
    expect(html).toContain('的遺體');
    expect(html).toContain('AR-9 制式步槍');
    expect(html).toContain('RR-4 無後座力砲');
    expect(html).toContain('需站在該格');
  });
});
