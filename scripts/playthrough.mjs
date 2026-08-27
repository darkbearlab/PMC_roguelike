// 在真實瀏覽器裡走一段實戰流程，驗證射擊預覽、視線繪製與蹲掩體。
// v0.11 起會隨機選圖，但這支腳本的座標全部是 mission_01 的，
// 所以網址釘死 map=mission_01 —— 它測的是介面與流程，不是地圖。
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.URL || 'http://localhost:4188/?seed=12345&map=mission_01';
const OUT = process.env.OUT || 'C:/Users/user/AppData/Local/Temp/claude/c--claude-project-PMC-roguelike/32862969-7ed8-48d9-b72a-983b846d6e1c/scratchpad/shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

async function walk(dirs) {
  for (const dir of dirs) {
    await page.evaluate((d) => window.__game.dispatch({ type: 'MOVE', dir: d }), dir);
    await page.waitForFunction(
      () => window.__game.test.isPlayerTurn() || window.__game.state.result !== 'ONGOING',
      null, { timeout: 15000 },
    );
    await page.waitForTimeout(60);
  }
}

const S6 = ['S','S','S','S','S','S'];
await walk([...S6, 'E','E','E','E', 'S', 'S', 'E', 'E']);

let st = await page.evaluate(() => ({
  pos: window.__game.state.units.find(u => u.faction === 'PLAYER').pos,
  hp: window.__game.state.units.find(u => u.faction === 'PLAYER').hp,
  clock: window.__game.state.clock,
  foes: window.__game.state.units.filter(u => u.faction === 'ENEMY')
    .map(u => ({ id: u.id, a: u.archetype, p: u.pos, ai: u.aiState, hp: u.hp })),
}));
console.log('after walk:', JSON.stringify(st.pos), 'hp', st.hp, '時刻', st.clock);
console.log('alerted:', st.foes.filter(f => f.ai !== 'IDLE').map(f => f.id + '/' + f.a + '/' + f.ai).join(', ') || 'none');

// 找一個目前合法的射擊目標，用「點地圖」的方式開預覽面板
const target = await page.evaluate(() => {
  const g = window.__game;
  const me = g.state.units.find(u => u.faction === 'PLAYER');
  const foes = g.state.units.filter(u => u.faction === 'ENEMY');
  const cam = g.cam;
  for (const f of foes) {
    const d = Math.abs(f.pos.x - me.pos.x) + Math.abs(f.pos.y - me.pos.y);
    if (d <= 8) return { pos: f.pos, id: f.id, sx: cam.ox + (f.pos.x + 0.5) * cam.tile, sy: cam.oy + (f.pos.y + 0.5) * cam.tile };
  }
  return null;
});

if (target) {
  const box = await page.locator('#map').boundingBox();
  // 第一下：鎖定（不得消耗任何資源）
  const before = await page.evaluate(() => JSON.stringify(window.__game.state));
  await page.mouse.click(box.x + target.sx, box.y + target.sy);
  await page.waitForTimeout(250);
  const sel = await page.evaluate(() => window.__game.test.selection());
  const after = await page.evaluate(() => JSON.stringify(window.__game.state));
  console.log('第一下 → 鎖定', sel, '｜狀態未變:', before === after);
  await page.screenshot({ path: OUT + '/10-lock.png' });

  // 第二下：開火，鎖定保留
  const hpBefore = await page.evaluate((id) => window.__game.state.units.find(u => u.id === id)?.hp, target.id);
  await page.mouse.click(box.x + target.sx, box.y + target.sy);
  await page.waitForTimeout(250);
  const hpAfter = await page.evaluate((id) => {
    const u = window.__game.state.units.find(x => x.id === id);
    return u ? u.hp : 'dead';
  }, target.id);
  console.log('第二下 → 開火，目標 HP', hpBefore, '->', hpAfter,
    '｜鎖定保留:', await page.evaluate(() => window.__game.test.selection()));
  await page.screenshot({ path: OUT + '/11-after-fire.png' });
} else {
  console.log('沒有敵人在射程內');
  await page.screenshot({ path: OUT + '/10-no-target.png' });
}

// 陣亡就投入增援，戰場總得有人站著
if (await page.evaluate(() => !!window.__game.state.pendingReinforcement)) {
  console.log('士兵陣亡 → 投入增援');
  await page.locator('#modal-root button[data-pick]').first().click();
  await page.waitForTimeout(300);
}
const alive = await page.evaluate(() => !!window.__game.state.units.find(u => u.faction === 'PLAYER'));
console.log('場上有玩家單位:', alive);

if (alive) {
  // 蹲下，看視野是否收縮
  await page.evaluate(() => window.__game.dispatch({ type: 'TOGGLE_STANCE' }));
  await page.waitForTimeout(250);
  await page.screenshot({ path: OUT + '/12-crouch.png' });
  console.log('stance:', await page.evaluate(() =>
    window.__game.state.units.find(u => u.faction === 'PLAYER').stance));

  // ---- v0.7：RR-4 兩步裝填序列 ----
  await page.evaluate(() => {
    const g = window.__game;
    const me = g.state.units.find(u => u.faction === 'PLAYER');
    // 直接用資料檔那把（v0.9 之後武器欄位多了 ammoType / modes / weight，
    // 手捏一把會漏欄位），只把彈藥清空
    me.equipped = { ...window.__weapons.find((w) => w.id === 'rr4'), ammo: 0 };
    // v0.9：裝填要從背包扣彈藥。增援只配步槍彈，所以得先塞兩發火箭彈進去，
    // 否則裝填鍵是灰的 —— 那本身就是規則生效的證據。
    me.backpack.items.push({
      id: 'TEST_ROCKET', kind: 'AMMO', defId: 'AMMO_ROCKET',
      name: '火箭彈', weight: 3, qty: 2, ammoType: 'ROCKET',
    });
    g.test.refresh();
  });
  await page.waitForTimeout(150);
  await page.locator('#controls button[data-act="RELOAD"]').click();
  await page.waitForTimeout(250);
  const seq1 = await page.evaluate(() => {
    const u = window.__game.state.units.find(x => x.faction === 'PLAYER');
    const btns = [...document.querySelectorAll('#controls button')]
      .filter(b => !b.disabled).map(b => b.textContent.trim().replace(/\s+/g, ' '));
    return { seq: u.pendingSequence, ammo: u.equipped.ammo, enabled: btns };
  });
  console.log('序列第 1 步:', JSON.stringify(seq1.seq), '彈藥', seq1.ammo);
  console.log('  承諾期間還能按的鈕:', seq1.enabled.join(' | ') || '（無）');
  await page.screenshot({ path: OUT + '/13-sequence-step1.png' });

  // 繼續走完
  let guard = 0;
  while (guard++ < 12) {
    const done = await page.evaluate(() => {
      const u = window.__game.state.units.find(x => x.faction === 'PLAYER');
      return !u || u.pendingSequence === null;
    });
    if (done) break;
    if (await page.evaluate(() => window.__game.test.isPlayerTurn())) {
      await page.locator('#controls button[data-act="RELOAD"]').click();
    }
    await page.waitForTimeout(220);
  }
  const after = await page.evaluate(() => {
    const u = window.__game.state.units.find(x => x.faction === 'PLAYER');
    return u ? { ammo: u.equipped?.ammo, seq: u.pendingSequence, clock: window.__game.state.clock } : null;
  });
  console.log('序列走完:', JSON.stringify(after));
  await page.screenshot({ path: OUT + '/14-sequence-done.png' });
}

  // v0.9：射擊模式按鈕
  const modeBtn = await page.evaluate(() => {
    const b = document.querySelector('#controls button[data-act="MODE"]');
    return { text: b.textContent.trim().replace(/\s+/g, ' '), disabled: b.disabled };
  });
  console.log('模式鍵（持 RR-4）:', JSON.stringify(modeBtn), '← 重武器沒有模式，應為灰');

console.log(errors.length ? 'ERRORS:' + String.fromCharCode(10) + errors.join(String.fromCharCode(10)) : 'no console errors');
await browser.close();
