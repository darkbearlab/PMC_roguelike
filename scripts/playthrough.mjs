// 在真實瀏覽器裡走一段實戰流程，驗證射擊預覽、視線繪製與蹲掩體。
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.URL || 'http://localhost:4188/?seed=12345';
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
      () => window.__game.state.phase === 'PLAYER' || window.__game.state.result !== 'ONGOING',
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
  turn: window.__game.state.turn,
  foes: window.__game.state.units.filter(u => u.faction === 'ENEMY')
    .map(u => ({ id: u.id, a: u.archetype, p: u.pos, ai: u.aiState, hp: u.hp })),
}));
console.log('after walk:', JSON.stringify(st.pos), 'hp', st.hp, 'turn', st.turn);
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

// 蹲下，看視野是否收縮
await page.evaluate(() => window.__game.dispatch({ type: 'TOGGLE_STANCE' }));
await page.waitForTimeout(250);
await page.screenshot({ path: OUT + '/12-crouch.png' });
const stance = await page.evaluate(() => window.__game.state.units.find(u => u.faction === 'PLAYER').stance);
console.log('stance:', stance);

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close();
