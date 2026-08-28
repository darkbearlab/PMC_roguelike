// @vitest-environment jsdom
/**
 * 合約清單畫面（§18.5）：兩段式選擇與返回清單的流程。
 * 版面（48×48、320px 可用、可捲動）由 scripts/a11y.mjs 在真的瀏覽器上量。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { contractsFromSeed } from '../src/core/contracts';
import { hideContracts, showContracts } from '../src/ui/contracts';
import { showSummary } from '../src/ui/modals';
import { createInitialState } from '../src/core/setup';
import { mapById } from '../src/core/content';

function mount(): void {
  const html = readFileSync('index.html', 'utf8');
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');
  // jsdom 沒有 scrollIntoView
  Element.prototype.scrollIntoView = function (): void {};
}

const cards = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.c-card'));
const q = <T extends HTMLElement>(s: string): T | null => document.querySelector<T>(s);

describe('合約清單畫面（§18.5）', () => {
  beforeEach(mount);

  it('開啟時列出三張卡片，全部收合', () => {
    showContracts(contractsFromSeed(7), () => {});
    expect(cards()).toHaveLength(3);
    expect(document.querySelectorAll('.c-card.open')).toHaveLength(0);
    // 收合狀態就要看得到編號、評級、地點、標籤與目標數
    expect(q('.c-code')).toBeTruthy();
    expect(q('.c-rating')).toBeTruthy();
    expect(q('.c-where')).toBeTruthy();
    expect(q('.c-tag')).toBeTruthy();
    expect(q('.c-obj')).toBeTruthy();
  });

  it('兩段式：第一下展開簡報，第二下才出擊', () => {
    const list = contractsFromSeed(7);
    let accepted: string | null = null;
    showContracts(list, (c) => { accepted = c.mapId; });

    // 收合時沒有「確認出擊」可以按
    expect(q('button[data-go]')).toBeNull();

    q<HTMLButtonElement>('button[data-toggle="1"]')!.click();
    expect(document.querySelectorAll('.c-card.open')).toHaveLength(1);
    expect(q('.c-brief')).toBeTruthy();
    expect(accepted).toBeNull();

    q<HTMLButtonElement>('button[data-go="1"]')!.click();
    expect(accepted).toBe(list[1].mapId);
  });

  it('一次只展開一張，再按同一張會收合', () => {
    showContracts(contractsFromSeed(7), () => {});
    q<HTMLButtonElement>('button[data-toggle="0"]')!.click();
    q<HTMLButtonElement>('button[data-toggle="2"]')!.click();
    expect(document.querySelectorAll('.c-card.open')).toHaveLength(1);
    expect(cards()[2].classList.contains('open')).toBe(true);
    q<HTMLButtonElement>('button[data-toggle="2"]')!.click();
    expect(document.querySelectorAll('.c-card.open')).toHaveLength(0);
  });

  it('展開後看得到完整公文：旨、說明、辦法、附件', () => {
    const list = contractsFromSeed(7);
    showContracts(list, () => {});
    q<HTMLButtonElement>('button[data-toggle="0"]')!.click();
    const text = q('.c-brief')!.textContent ?? '';
    for (const k of ['旨', '說明', '辦法', '附件']) expect(text).toContain(k);
    expect(text).toContain(list[0].brief.purpose);
    expect(text).toContain(list[0].brief.methods[0]);
  });

  it('畫面上不出現任何報酬金額（§18 明確不做經濟）', () => {
    showContracts(contractsFromSeed(7), () => {});
    cards().forEach((_, i) => q<HTMLButtonElement>(`button[data-toggle="${i}"]`)!.click());
    const text = q('#contract-root')!.textContent ?? '';
    expect(/(報酬|酬金|價金|新台幣|信用點|\$|元整)/.test(text)).toBe(false);
  });

  it('關掉之後畫面清空，不留殘骸', () => {
    showContracts(contractsFromSeed(7), () => {});
    hideContracts();
    expect(q('#contract-root')!.classList.contains('hidden')).toBe(true);
    expect(cards()).toHaveLength(0);
  });

  it('重新開清單會換掉內容，事件不會疊加', () => {
    let clicks = 0;
    showContracts(contractsFromSeed(1), () => { clicks++; });
    showContracts(contractsFromSeed(2), () => { clicks++; });
    expect(cards()).toHaveLength(3);
    q<HTMLButtonElement>('button[data-toggle="0"]')!.click();
    q<HTMLButtonElement>('button[data-go="0"]')!.click();
    expect(clicks).toBe(1);
  });

  it('HTML 特殊字元會被跳脫', () => {
    const list = contractsFromSeed(1);
    list[0] = { ...list[0], mapName: '<img src=x>' };
    showContracts(list, () => {});
    expect(q('.c-where')!.querySelector('img')).toBeNull();
    expect(q('.c-where')!.textContent).toContain('<img src=x>');
  });
});

describe('結算畫面的返回鍵（§18.1）', () => {
  beforeEach(mount);

  const endedState = (): ReturnType<typeof createInitialState> => {
    const st = createInitialState(1, mapById('mission_01') ?? undefined);
    return { ...st, result: 'ABORTED' as const };
  };

  it('有清單可回時，兩顆鍵並存且各自做各自的事', () => {
    let back = 0;
    let again = 0;
    showSummary(endedState(), () => { again++; }, () => { back++; });
    const list = q<HTMLButtonElement>('button[data-list]');
    const restart = q<HTMLButtonElement>('button[data-restart]');
    expect(list).toBeTruthy();
    expect(restart).toBeTruthy();
    list!.click();
    restart!.click();
    expect(back).toBe(1);
    expect(again).toBe(1);
  });

  it('?map= 的除錯流程沒有清單可回，就不長出那顆鍵', () => {
    showSummary(endedState(), () => {});
    expect(q('button[data-list]')).toBeNull();
    expect(q<HTMLButtonElement>('button[data-restart]')!.className).toContain('primary');
  });
});
