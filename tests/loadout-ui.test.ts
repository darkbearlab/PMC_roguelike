// @vitest-environment jsdom
/**
 * 出擊前配裝畫面（v0.15 §5）。版面（48×48、320px）由 scripts/a11y.mjs 在真的瀏覽器上量。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { contractsFromSeed } from '../src/core/contracts';
import { defaultLoadout } from '../src/core/loadout';
import type { Loadout } from '../src/core/loadout';
import { hideLoadout, showLoadout } from '../src/ui/loadout';
import { RULES, WEAPONS } from '../src/core/content';

function mount(): void {
  const html = readFileSync('index.html', 'utf8');
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');
}

const q = <T extends HTMLElement>(s: string): T | null => document.querySelector<T>(s);
const txt = (): string => q('#loadout-root')!.textContent ?? '';
const pick = (slot: string, id: string): void =>
  q<HTMLButtonElement>(`button[data-slot="${slot}"][data-id="${id}"]`)!.click();
const step = (kind: string, key: string, d: number): void =>
  q<HTMLButtonElement>(`button[data-step="${kind}"][data-key="${key}"][data-d="${d}"]`)!.click();

describe('配裝畫面（§5）', () => {
  beforeEach(mount);

  it('七把武器都可選，兩欄各有「不帶」', () => {
    showLoadout(null, { primary: null, stowed: null, ammo: {}, consumables: {} }, () => {}, null);
    for (const w of WEAPONS) {
      expect(q(`button[data-slot="primary"][data-id="${w.id}"]`), w.id).toBeTruthy();
    }
    expect(q('button[data-slot="primary"][data-id=""]')).toBeTruthy();
    expect(q('button[data-slot="stowed"][data-id=""]')).toBeTruthy();
  });

  it('同一把槍不能同時放在兩欄', () => {
    showLoadout(null, defaultLoadout(), () => {}, null);
    // 預設 primary=ar9，所以收納欄不應該再列出 ar9
    expect(q('button[data-slot="stowed"][data-id="ar9"]')).toBeNull();
    expect(q('button[data-slot="primary"][data-id="rr4"]')).toBeNull();
  });

  it('即時顯示總重、上限、級距與移動時間（§5.3）', () => {
    showLoadout(null, defaultLoadout(), () => {}, null);
    expect(txt()).toContain('41.6');
    expect(txt()).toContain('／100');
    expect(txt()).toContain('負重級距');
    expect(txt()).toContain('不受影響');
  });

  it('換成更重的組合，重量列跟著變', () => {
    showLoadout(null, defaultLoadout(), () => {}, null);
    const before = txt();
    pick('primary', 'lmg5');
    expect(txt()).not.toBe(before);
    expect(txt()).toContain('49.6');   // LMG-5 15 + RR-4 20 + 彈藥 12.576 + 封合劑 2
  });

  it('彈藥以增量調整，不是逐發（§5.6）', () => {
    let got: Loadout | null = null;
    showLoadout(null, defaultLoadout(), (l) => { got = l; }, null);
    const inc = RULES.loadout.ammoStep['5.56'];
    expect(inc).toBeGreaterThan(1);
    step('ammo', '5.56', 1);
    q<HTMLButtonElement>('button[data-go]')!.click();
    expect(got!.ammo['5.56']).toBe(24 + inc);
  });

  it('數量不會被減成負的', () => {
    let got: Loadout | null = null;
    showLoadout(null, { primary: 'p9', stowed: null, ammo: {}, consumables: {} },
      (l) => { got = l; }, null);
    step('ammo', '9mm', -1);
    step('item', 'SEALANT', -1);
    q<HTMLButtonElement>('button[data-go]')!.click();
    expect(got!.ammo['9mm']).toBe(0);
    expect(got!.consumables.SEALANT).toBe(0);
  });

  it('帶槍不帶彈只警告，出擊鍵仍然可按（§5.4）', () => {
    showLoadout(null, { primary: 'dmr7', stowed: null, ammo: {}, consumables: {} }, () => {}, null);
    expect(q('.l-warn')).toBeTruthy();
    expect(txt()).toContain('DMR-7');
    expect(q<HTMLButtonElement>('button[data-go]')!.disabled).toBe(false);
  });

  it('超重則阻擋出擊（§5.4）', () => {
    showLoadout(null, {
      primary: 'rr4', stowed: 'lmg5', ammo: { '84mm': 12 }, consumables: {},
    }, () => {}, null);
    expect(q<HTMLButtonElement>('button[data-go]')!.disabled).toBe(true);
    expect(txt()).toContain('超過攜行上限');
  });

  it('出擊回傳的是玩家實際調過的那一份', () => {
    let got: Loadout | null = null;
    showLoadout(null, defaultLoadout(), (l) => { got = l; }, null);
    pick('primary', 'sg12s');
    step('ammo', '12ga', 1);
    q<HTMLButtonElement>('button[data-go]')!.click();
    expect(got!.primary).toBe('sg12s');
    expect(got!.ammo['12ga']).toBe(RULES.loadout.ammoStep['12ga']);
  });

  it('「回到預設配裝」真的回到預設', () => {
    let got: Loadout | null = null;
    showLoadout(null, defaultLoadout(), (l) => { got = l; }, null);
    pick('primary', 'sg12p');
    q<HTMLButtonElement>('button[data-reset]')!.click();
    q<HTMLButtonElement>('button[data-go]')!.click();
    expect(got).toEqual(defaultLoadout());
  });

  it('合約的標籤與評級留在畫面上 —— 這是這個畫面存在的理由', () => {
    const c = contractsFromSeed(7)[0];
    showLoadout(c, defaultLoadout(), () => {}, () => {});
    expect(txt()).toContain(c.mapName);
    expect(txt()).toContain(c.brief.code);
    expect(txt()).toContain(c.difficulty.label);
    for (const t of c.tags) expect(txt()).toContain(t.label);
  });

  it('可以退回合約清單；沒有清單可回時就不長那顆鍵', () => {
    let back = 0;
    showLoadout(contractsFromSeed(7)[0], defaultLoadout(), () => {}, () => { back++; });
    q<HTMLButtonElement>('button[data-back]')!.click();
    expect(back).toBe(1);
    showLoadout(null, defaultLoadout(), () => {}, null);
    expect(q('button[data-back]')).toBeNull();
  });

  it('關掉之後不留殘骸', () => {
    showLoadout(null, defaultLoadout(), () => {}, null);
    hideLoadout();
    expect(q('#loadout-root')!.classList.contains('hidden')).toBe(true);
    expect(q('.l-pick')).toBeNull();
  });
});
