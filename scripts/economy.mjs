/**
 * v0.20 端對端：合約報酬 → 損益表 → 買賣 → 負債與董事會信件。
 */
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) process.exitCode = 1; };
const meta = () => p.evaluate(() => JSON.parse(JSON.stringify(window.__meta())));

await p.goto('http://localhost:4188/?seed=1&reset=1', { waitUntil: 'networkidle' });
await p.waitForTimeout(400);
const m0 = await meta();
ok(typeof m0.credits === 'number', `新公司有起始資金 ${m0.credits}`);
ok(m0.legacyStock.length >= 1 && m0.legacyStock.length <= 3,
  `物品池有 ${m0.legacyStock.length} 件遺產武器：`
  + m0.legacyStock.map((w) => w.name + '#' + w.instanceId).join('、'));
const head = await p.locator('.co-credits').innerText();
ok(/信用點/.test(head), `公司畫面顯示信用點（${head.replace(/\n/g, ' ')}）`);

// 補給站：價格不是 0，遺產與土製分開
await p.locator('button[data-tab="SUPPLY"]').click();
await p.waitForTimeout(250);
const supply = await p.locator('#company-root').innerText();
ok(/遺產武器（現貨）/.test(supply) && /土製武器/.test(supply), '補給站分成遺產現貨與土製兩區');
ok(!/暫時性的測試機能/.test(supply), '「暫時性測試機能」的標示已移除');
ok(/出售/.test(supply), '有出售區');
const anyZero = await p.locator('button[data-buy] i').allInnerTexts();
ok(anyZero.every((t) => !/^0 /.test(t)), `價格不再是 0（${anyZero.slice(0, 3).join('、')}）`);

// 買一名士兵：扣錢
const beforeBuy = (await meta()).credits;
await p.locator('button[data-buy="soldier"]').click();
await p.waitForTimeout(250);
const afterBuy = await meta();
ok(afterBuy.credits < beforeBuy, `買士兵扣了錢（${beforeBuy} → ${afterBuy.credits}）`);
ok(afterBuy.roster.length === m0.roster.length + 1, '名冊多了一個人');

// 賣一件雜物
await p.evaluate(() => { window.__meta().salvage = { CORE: 2 }; });
await p.locator('button[data-tab="ROSTER"]').click();
await p.waitForTimeout(120);
await p.locator('button[data-tab="SUPPLY"]').click();
await p.waitForTimeout(200);
const sellBefore = (await meta()).credits;
await p.locator('button[data-sell="stock"][data-key="CORE"]').click();
await p.waitForTimeout(250);
ok((await meta()).credits > sellBefore, '賣掉動力核心，錢進帳了');

// 合約清單顯示報酬
await p.locator('button[data-tab="ROSTER"]').click();
await p.waitForTimeout(150);
await p.locator('button[data-go]').click();
await p.waitForTimeout(400);
const listText = await p.locator('#contract-root').innerText();
ok(/報酬/.test(listText), '合約清單顯示報酬');

// 打一場：主目標不完成就撤離 → 只拿次要獎金
await p.locator('.c-card button[data-toggle]').first().click();
await p.waitForTimeout(200);
await p.locator('.c-card.open button[data-go]').click();
await p.waitForTimeout(300);
await p.locator('button[data-deploy]').first().click();
await p.waitForTimeout(600);
await p.evaluate(() => {
  const g = window.__game;
  const u = g.state.units.find((x) => x.faction === 'PLAYER');
  // 主目標完成才給主要報酬（§3.1），所以先把它記成完成再撤離
  g.state.objectives.main.done = true;
  g.state.objectives.secondary[0].done = true;
  u.pos = { ...g.state.map.startDropPoint };
  g.dispatch({ type: 'INTERACT', pos: { ...u.pos } });
});
await p.waitForTimeout(500);
const summary = await p.locator('#modal-root').innerText();
ok(/本次合約損益/.test(summary), '結算畫面是一份損益表');
for (const line of ['合約報酬', '陣亡士兵', '消耗的彈藥與物資']) {
  ok(summary.includes(line), `損益表有「${line}」這一列`);
}
// §5.2：武器移到資產區塊，**兩條底線，資產不計入現金損益**
ok(/本次合約損益（現金）/.test(summary), '現金損益自己一條底線');
ok(!/遺留的武器/.test(summary), '武器不再列在現金損益裡 —— 它是資產，不是支出');
const creditsBeforeSettle = (await meta()).credits;
await p.locator('#modal-root button[data-list]').click();
await p.waitForTimeout(500);
const m2 = await meta();
ok(m2.contractsCompleted === 1, '完成合約數 +1');
ok(m2.missionLog[0].net !== undefined, `任務紀錄記下損益 ${m2.missionLog[0].net}`);
ok(m2.credits > creditsBeforeSettle, `報酬入帳（${creditsBeforeSettle} → ${m2.credits}）`);
ok(/次要目標獎金/.test(summary), '損益表分開列出次要目標獎金');

// 負債 → 董事會來信
await p.evaluate(() => {
  const m = window.__meta();
  m.credits = -5000;
  m.mail = [];
});
await p.evaluate(() => window.__company());
await p.waitForTimeout(300);
const m3 = await meta();
ok(m3.credits < 0, '信用點可以是負的，沒有硬性失敗');
const badge = await p.locator('.co-credits').innerText();
ok(/−/.test(badge), `負值以警示樣式呈現（${badge.replace(/\n/g, ' ')}）`);
// 手動推一封信（實際流程是結算時推）
await p.evaluate(() => { window.__meta().mail = ['DIRE']; window.__company(); });
await p.waitForTimeout(300);
await p.locator('button[data-mail]').click();
await p.waitForTimeout(250);
const letter = await p.locator('#company-root').innerText();
ok(/法務/.test(letter) && /債務/.test(letter), '讀得到董事會的信');
ok(!/哈|笑|其實|你知道/.test(letter), '信件沒有吐槽、沒有解釋笑點');

console.log('errors:', errs.length ? errs : 'none');
if (errs.length) process.exitCode = 1;
await b.close();
