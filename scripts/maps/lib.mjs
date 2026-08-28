/**
 * 手刻地圖的共用工具與驗證器（§13.5）。
 *
 * **這不是程序化生成。** 每一段牆、每一個門、每一個敵人座標都是手填的；
 * 這裡只提供畫格子的筆，以及一組不讓作者數錯的檢查。
 *
 * 驗證項現在的用途是「防止手刻地圖出現結構性錯誤」，
 * 將來的用途是**程序化區塊拼接的約束條件** —— 沿用專案一路以來的作法：
 * 現在建立鉤子，將來直接使用。
 */
import rules from '../../src/data/rules.json' with { type: 'json' };

export const LEGEND = {
  '.': 'FLOOR', '#': 'WALL', '+': 'HALF_COVER',
  D: 'DROP_POINT', T: 'TERMINAL', S: 'SUPPLY', L: 'LOOT',
};

const BLOCK = new Set(['#', '+']);
const MR = rules.mapRules;

/** 一張空白地圖（四周先不畫牆，由 border() 補）。 */
export function grid(w, h, fill = '.') {
  return { w, h, g: Array.from({ length: h }, () => Array(w).fill(fill)) };
}

export const set = (m, x, y, c) => { if (m.g[y] && m.g[y][x] !== undefined) m.g[y][x] = c; };
export const at = (m, x, y) => (x < 0 || y < 0 || x >= m.w || y >= m.h ? '#' : m.g[y][x]);

export function hline(m, y, x1, x2, c = '#') { for (let x = x1; x <= x2; x++) set(m, x, y, c); }
export function vline(m, x, y1, y2, c = '#') { for (let y = y1; y <= y2; y++) set(m, x, y, c); }
export function rect(m, x1, y1, x2, y2, c) {
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) set(m, x, y, c);
}
export function border(m) {
  hline(m, 0, 0, m.w - 1); hline(m, m.h - 1, 0, m.w - 1);
  vline(m, 0, 0, m.h - 1); vline(m, m.w - 1, 0, m.h - 1);
}

// ---------------------------------------------------------------------------
// 連通性（四方向，與 core/pathfind.ts 一致）
// ---------------------------------------------------------------------------

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const passable = (m, x, y) => !BLOCK.has(at(m, x, y));

/**
 * @param blocked 額外視為不可通行的格（傳敵人起始位置進來，就是「不殺人能不能過」）。
 */
export function reachable(m, from, blocked = new Set()) {
  const seen = new Set([`${from.x},${from.y}`]);
  const q = [from];
  while (q.length) {
    const c = q.shift();
    for (const [dx, dy] of DIRS) {
      const n = { x: c.x + dx, y: c.y + dy };
      if (!passable(m, n.x, n.y)) continue;
      if (blocked.has(`${n.x},${n.y}`)) continue;
      const k = `${n.x},${n.y}`;
      if (seen.has(k)) continue;
      seen.add(k); q.push(n);
    }
  }
  return seen;
}

/** 四方向最短路徑（含頭尾）。走不到回傳 null。 */
export function shortestPath(m, from, to) {
  const prev = new Map([[`${from.x},${from.y}`, null]]);
  const q = [from];
  while (q.length) {
    const c = q.shift();
    if (c.x === to.x && c.y === to.y) break;
    for (const [dx, dy] of DIRS) {
      const n = { x: c.x + dx, y: c.y + dy };
      if (!passable(m, n.x, n.y)) continue;
      const k = `${n.x},${n.y}`;
      if (prev.has(k)) continue;
      prev.set(k, c); q.push(n);
    }
  }
  if (!prev.has(`${to.x},${to.y}`)) return null;
  const path = [];
  for (let c = to; c; c = prev.get(`${c.x},${c.y}`)) path.push(c);
  return path.reverse();
}

/** 這一格的四鄰有沒有阻擋物（也就是「站在這裡有沒有掩蔽可用」）。 */
export const hasCoverBeside = (m, x, y) =>
  DIRS.some(([dx, dy]) => BLOCK.has(at(m, x + dx, y + dy)));

/** 一條路徑上最長的連續無掩蔽段。 */
export function exposedRun(m, path) {
  let run = 0;
  let worst = 0;
  for (const p of path) {
    run = hasCoverBeside(m, p.x, p.y) ? 0 : run + 1;
    worst = Math.max(worst, run);
  }
  return worst;
}

/**
 * **必經**的暴露長度：在所有 from → to 的走法之中，最長無掩蔽段最短的那一條。
 *
 * §13.5.2 要的是「不存在完全無掩體的長距離**必經**路段」——
 * 最短路徑上的暴露不算必經（玩家可以繞），所以這裡對 k 做二分搜尋，
 * 每次用「不允許讓連續暴露超過 k」的 BFS 檢查走不走得到。
 *
 * 狀態是 (格子, 目前連續暴露長度)，所以規模仍然只有 w×h×(k+1)。
 * 走不到回傳 Infinity。
 */
export function unavoidableExposure(m, from, to) {
  const feasible = (k) => {
    const seen = new Set();
    const q = [{ p: from, run: hasCoverBeside(m, from.x, from.y) ? 0 : 1 }];
    if (q[0].run > k) return false;
    seen.add(`${from.x},${from.y}|${q[0].run}`);
    while (q.length) {
      const c = q.shift();
      if (c.p.x === to.x && c.p.y === to.y) return true;
      for (const [dx, dy] of DIRS) {
        const n = { x: c.p.x + dx, y: c.p.y + dy };
        if (!passable(m, n.x, n.y)) continue;
        const run = hasCoverBeside(m, n.x, n.y) ? 0 : c.run + 1;
        if (run > k) continue;
        const key = `${n.x},${n.y}|${run}`;
        if (seen.has(key)) continue;
        seen.add(key);
        q.push({ p: n, run });
      }
    }
    return false;
  };
  let lo = 0;
  let hi = m.w * m.h;
  if (!feasible(hi)) return Infinity;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (feasible(mid)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

export const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * **方向性掩蔽覆蓋率** —— v0.11 加的，因為 v0.10 就是被這個數字卡住的。
 *
 * 掩蔽只看目標**朝向射手那一側**的正交鄰格（§7.2b），所以一排水平的半身掩體
 * 提供的是對**南北向**射手的掩蔽，對東西向的交火完全沒用。
 * mission_01 的掩體是水平成排的、動線卻是東西向，於是 AI 幾乎沒有掩體可用。
 *
 * 這兩個數字把那件事變成可以一眼比較的東西：
 * 有多少比例的可通行格，對東西向／南北向的射手提供得出掩蔽。
 */
export function directionalCover(m) {
  let n = 0;
  let ew = 0;
  let ns = 0;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (!passable(m, x, y)) continue;
      n++;
      if (BLOCK.has(at(m, x - 1, y)) || BLOCK.has(at(m, x + 1, y))) ew++;
      if (BLOCK.has(at(m, x, y - 1)) || BLOCK.has(at(m, x, y + 1))) ns++;
    }
  }
  return { ew: ew / n, ns: ns / n };
}

export function findAll(m, ch) {
  const out = [];
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.g[y][x] === ch) out.push({ x, y });
  return out;
}

// ---------------------------------------------------------------------------
// 驗證（§13.5.2）。門檻全部來自 rules.json → mapRules。
// ---------------------------------------------------------------------------

/**
 * @param def 地圖定義：{ id, name, m, start, enemies, caches, limits? }
 * @returns { errors, stats }
 */
export function validate(def) {
  const { m, start, enemies, caches } = def;
  const errors = [];
  const limits = { ...MR, ...(def.limits ?? {}) };

  const drops = findAll(m, 'D');
  const terminals = findAll(m, 'T');
  const supplies = findAll(m, 'S');
  const loots = findAll(m, 'L');

  // ---- 連通性 ----
  const seen = reachable(m, start);
  const mustReach = [...drops, ...terminals, ...supplies, ...loots];
  for (const p of mustReach) {
    if (!seen.has(`${p.x},${p.y}`)) errors.push(`(${p.x},${p.y}) '${at(m, p.x, p.y)}' 從起始空投點不可達`);
  }
  let walkable = 0;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (passable(m, x, y)) walkable++;
  const orphans = walkable - seen.size;
  if (orphans > limits.maxOrphanTiles) {
    errors.push(`有 ${orphans} 格可通行但走不到（上限 ${limits.maxOrphanTiles}）`);
  }

  // ---- 空投點 ----
  if (drops.length < limits.minDropPoints) errors.push(`空投點 ${drops.length} 個，少於 ${limits.minDropPoints}`);
  let minGap = Infinity;
  let maxGap = 0;
  for (let i = 0; i < drops.length; i++) {
    for (let j = i + 1; j < drops.length; j++) {
      const d = manhattan(drops[i], drops[j]);
      minGap = Math.min(minGap, d);
      maxGap = Math.max(maxGap, d);
    }
  }
  if (drops.length >= 2) {
    if (minGap < limits.dropSpacing.min) errors.push(`空投點最近間距 ${minGap} < ${limits.dropSpacing.min}`);
    if (maxGap > limits.dropSpacing.max) errors.push(`空投點最遠間距 ${maxGap} > ${limits.dropSpacing.max}`);
  }
  const enemyAt = new Set(enemies.map((e) => `${e.pos.x},${e.pos.y}`));
  for (const d of drops) {
    if (enemyAt.has(`${d.x},${d.y}`)) errors.push(`空投點 (${d.x},${d.y}) 被敵人佔據`);
  }

  // ---- 不殺人也走得到（§13.5.2）----
  //
  // 單位不能互相穿越，所以在一格寬的走廊裡，**一隻敵人就是一道牆**。
  // 真人玩家可以把它打掉再過，但「唯一路線被一個人塞死」是脆弱的設計，
  // 而且自動機器人的 findPath 會直接回傳 null、原地卡到天荒地老。
  // 這一項要求每個目標都還有第二條路 —— 也就是 §13.1 的「路線分歧多」。
  const unkilled = reachable(m, start, enemyAt);
  for (const p of [...drops, ...terminals, ...supplies, ...loots]) {
    if (!unkilled.has(`${p.x},${p.y}`)) {
      errors.push(`(${p.x},${p.y}) '${at(m, p.x, p.y)}' 在不移除敵人的情況下走不到 —— `
        + '有敵人塞死了唯一路線');
    }
  }

  // ---- 掩體 ----
  const covers = findAll(m, '+').length;
  const density = covers / walkable;
  if (density < limits.coverDensity.min || density > limits.coverDensity.max) {
    errors.push(`掩體密度 ${(density * 100).toFixed(1)}% 不在 `
      + `${(limits.coverDensity.min * 100).toFixed(0)}–${(limits.coverDensity.max * 100).toFixed(0)}% 之間`);
  }
  // 主要推進路線（起點 → 主目標）上不得有過長的完全無掩蔽路段
  const route = terminals[0] ? shortestPath(m, start, terminals[0]) : null;
  const directRun = route ? exposedRun(m, route) : 0;
  // 檢查的是**必經**的暴露：能繞開就不算問題（§13.5.2）
  const forcedRun = terminals[0] ? unavoidableExposure(m, start, terminals[0]) : 0;
  if (forcedRun > limits.maxForcedExposure) {
    errors.push(`不管怎麼走都得連續暴露 ${forcedRun} 格（上限 ${limits.maxForcedExposure}）`);
  }
  if (directRun > limits.maxExposedRun) {
    errors.push(`最短路徑上有連續 ${directRun} 格完全無掩蔽（上限 ${limits.maxExposedRun}）`);
  }

  // ---- 任務長度與掩蔽方向（v0.13 的兩條新約束）----
  //
  // 局外層會把任務串起來。一場任務長度失控只是煩人，一場接一場就是災難。
  const estRun = estimatedRunTime(m, start, rules.time.move);
  if (estRun < limits.estRunTime.min || estRun > limits.estRunTime.max) {
    errors.push(`預估完成路徑 ${estRun}（下限估計），不在 `
      + `${limits.estRunTime.min}–${limits.estRunTime.max} 之間`);
  }
  // 掩體列的走向等於在決定哪個軸向的交火是安全的。差距太大的話，
  // 「這張圖對玩家是 19% 還是 51% 的掩蔽」完全是作者無意間決定的。
  const dc = directionalCover(m);
  const gap = Math.abs(dc.ew - dc.ns) * 100;
  if (gap > limits.dirCoverGap) {
    errors.push(`方向性掩蔽差距 ${gap.toFixed(0)}（東西 ${(dc.ew * 100).toFixed(0)}%／`
      + `南北 ${(dc.ns * 100).toFixed(0)}%）超過門檻 ${limits.dirCoverGap}`);
  }

  // ---- 敵人 ----
  if (enemies.length < limits.enemies.min || enemies.length > limits.enemies.max) {
    errors.push(`敵人 ${enemies.length} 隻，不在 ${limits.enemies.min}–${limits.enemies.max} 之間`);
  }
  const dup = new Set();
  const kinds = {};
  for (const e of enemies) {
    const k = `${e.pos.x},${e.pos.y}`;
    if (!e.facing) errors.push(`敵人 ${e.archetype} @ ${k} 未指定初始面向`);
    if (BLOCK.has(at(m, e.pos.x, e.pos.y))) errors.push(`敵人 ${e.archetype} @ ${k} 站在阻擋物上`);
    if (!seen.has(k)) errors.push(`敵人 ${e.archetype} @ ${k} 不可達`);
    if (dup.has(k)) errors.push(`敵人座標重複 ${k}`);
    dup.add(k);
    kinds[e.archetype] = (kinds[e.archetype] ?? 0) + 1;
  }
  for (const need of ['RUNNER', 'SHOOTER', 'HULK']) {
    if (!kinds[need]) errors.push(`缺少原型 ${need}`);
  }
  if (dup.has(`${start.x},${start.y}`)) errors.push('敵人站在起始空投點上');

  // ---- 目標 ----
  if (terminals.length !== 1) errors.push(`主目標必須剛好 1 個，現在有 ${terminals.length}`);
  if (supplies.length !== limits.secondaryObjectives) {
    errors.push(`次要目標必須 ${limits.secondaryObjectives} 個，現在有 ${supplies.length}`);
  }
  const mainDist = terminals[0] ? manhattan(start, terminals[0]) : 0;
  if (mainDist < limits.minMainDistance) {
    errors.push(`主目標離起點只有 ${mainDist}，少於 ${limits.minMainDistance}`);
  }

  // ---- 搜刮點 ----
  if (loots.length < limits.minCaches) errors.push(`搜刮點 ${loots.length} 個，少於 ${limits.minCaches}`);
  if (loots.length !== caches.length) errors.push(`LOOT 地形 ${loots.length} 個，但 caches 有 ${caches.length} 筆`);
  for (const c of caches) {
    if (at(m, c.pos.x, c.pos.y) !== 'L') errors.push(`cache @ (${c.pos.x},${c.pos.y}) 不在 LOOT 地形上`);
  }

  return {
    errors,
    stats: {
      id: def.id, name: def.name, size: `${m.w}×${m.h}`,
      walkable, covers, density, drops: drops.length,
      dropGap: drops.length >= 2 ? `${minGap}–${maxGap}` : '—',
      mainDist, routeLen: route ? route.length - 1 : 0, directRun, forcedRun, estRun,
      dirCover: directionalCover(m),
      enemies: enemies.length, kinds, caches: caches.length,
    },
  };
}

/**
 * 把定義轉成 core/map.ts 吃的 RawMap。
 *
 * **統計值一併寫進 JSON**（v0.14）：合約清單的地形標籤與難度評級都由它推導，
 * 不得手寫（§14.2）。手寫的標籤會在地圖被修改後開始說謊，而地圖一定會被修改；
 * 統計值不會 —— 它跟著 `npm run map:build` 一起重算，CI 會比對。
 */
export function toRawMap(def, stats) {
  const kinds = stats.kinds;
  const enemyCount = stats.enemies;
  return {
    id: def.id,
    name: def.name,
    width: def.m.w,
    height: def.m.h,
    legend: LEGEND,
    tiles: def.m.g.map((r) => r.join('')),
    startDropPoint: def.start,
    enemies: def.enemies,
    caches: def.caches,
    stats: {
      walkable: stats.walkable,
      coverDensity: round3(stats.density),
      dirCoverEW: round3(stats.dirCover.ew),
      dirCoverNS: round3(stats.dirCover.ns),
      mainDist: stats.mainDist,
      routeLen: stats.routeLen,
      directRun: stats.directRun,
      forcedRun: stats.forcedRun,
      estRun: stats.estRun,
      enemyCount,
      shooterRatio: round3((kinds.SHOOTER ?? 0) / enemyCount),
      hulks: kinds.HULK ?? 0,
      caches: stats.caches,
    },
  };
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * 預估完成路徑長度（§13.5，v0.13）。
 *
 * 從起始空投點出發、依序抵達所有必要目標、再返回撤離點（＝起始空投點）的
 * 最短四方向路徑總長，乘以基礎移動時間。
 *
 * 這是**下限估計**：實際耗時一定更高，因為有交火、繞路、搜刮、裝填。
 * 但它是靜態的，不必跑機器人就能算，所以進得了 CI。
 *
 * 目標數量很少（主目標 + 兩個次要），所以直接窮舉全部順序取最短。
 */
export function estimatedRunTime(m, start, moveTime) {
  const stops = [...findAll(m, 'T'), ...findAll(m, 'S')];
  const nodes = [start, ...stops];
  const dist = nodes.map((a) => nodes.map((b) => {
    const p = shortestPath(m, a, b);
    return p ? p.length - 1 : Infinity;
  }));

  let best = Infinity;
  const idx = stops.map((_, i) => i + 1);
  const permute = (rest, acc, total) => {
    if (total >= best) return;                 // 剪枝
    if (rest.length === 0) {
      best = Math.min(best, total + dist[acc][0]);   // 回到撤離點
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      const next = rest[i];
      permute(rest.filter((_, j) => j !== i), next, total + dist[acc][next]);
    }
  };
  permute(idx, 0, 0);
  return Number.isFinite(best) ? best * moveTime : Infinity;
}
