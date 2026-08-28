/**
 * 合約清單（§18）。**局外層的第一塊，刻意不含持久化與經濟。**
 *
 * 這一層是純規則：給一個種子，產生一份清單。沒有瀏覽器 API、
 * 沒有直接的 `Math.random()`，同一個種子必然得到同一份清單。
 *
 * 最重要的一條規則寫在 §18.2：
 *
 * > **地形標籤與難度評級由地圖統計值推導，不得手寫。**
 *
 * 手寫的標籤會在地圖被修改之後開始說謊，而地圖一定會被修改 ——
 * v0.13 才剛把 mission_02 與 mission_03 整張換掉。統計值不會說謊，
 * 它跟著 `npm run map:build` 一起重算，CI 會比對。
 */
import type { MapStats, RawMap } from './map';
import type { RngState } from './rng';
import { createRng, nextFloat, nextInt } from './rng';
import { CONTRACTS, CONTRACT_RULES, MAPS } from './content';

export interface ContractTag {
  id: string;
  label: string;
}

export interface ContractDifficulty {
  /** 推導出來的原始分數。UI 不顯示，但除錯與調權重時要看得到。 */
  score: number;
  rating: string;
  label: string;
}

export interface ContractBrief {
  code: string;
  title: string;
  client: string;
  purpose: string;
  notes: string[];
  methods: string[];
  attachment: string;
  flavour: string;
}

export interface Contract {
  mapId: string;
  mapName: string;
  brief: ContractBrief;
  tags: ContractTag[];
  difficulty: ContractDifficulty;
  /** 主目標與次要目標的數量，直接數地圖地形，不另外維護一份資料。 */
  objectives: { main: number; secondary: number; caches: number };
  /**
   * 這份合約對應的任務種子。**在清單產生時就抽好** ——
   * 玩家看到的那張卡片與他按下去會玩到的那一場，是同一件事。
   */
  missionSeed: number;
}

// ---------------------------------------------------------------- 標籤

interface TagRule {
  id: string;
  label: string;
  priority: number;
  stat: keyof MapStats;
  op: 'gte' | 'lte';
  value: number;
}

function tagRules(): TagRule[] {
  return CONTRACT_RULES.tags;
}

/**
 * §18.2：標籤全部由統計值推導。
 *
 * 排序用 priority 而不是「觸發了幾條」：有些標籤（例如「存在重裝目標」）
 * 目前四張圖都會觸發，那種標籤放在最後，只在卡片還有空位時才擠得進去。
 */
export function deriveTags(stats: MapStats): ContractTag[] {
  const hit = tagRules().filter((r) => {
    const v = stats[r.stat];
    if (typeof v !== 'number') return false;
    return r.op === 'gte' ? v >= r.value : v <= r.value;
  });
  // 穩定排序：priority 相同時保持資料檔中的順序
  const ordered = hit
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.priority - b.r.priority) || (a.i - b.i))
    .map((x) => x.r);
  return ordered.slice(0, CONTRACT_RULES.maxTags).map((r) => ({ id: r.id, label: r.label }));
}

// ---------------------------------------------------------------- 難度

/**
 * §18.3：難度評級同樣由統計值推導，公式在 `contract-rules.json`。
 *
 * 這個分數讀的是**地形說了什麼**，不是機器人跑出什麼結果 —— 那是兩件事。
 * 舉例：mission_02 的掩體密度只有 4%，地形上這叫危險；但它的走廊窄到
 * 雙方多半根本看不到對方，機器人反而 5/5 全通。評級照實反映前者，
 * 因為那是玩家在接合約時**唯一能知道的東西**。
 */
export function deriveDifficulty(stats: MapStats): ContractDifficulty {
  const d = CONTRACT_RULES.difficulty;
  let score = 0;
  for (const t of d.terms) {
    const v = stats[t.stat];
    if (typeof v !== 'number') continue;
    score += (v - t.base) * t.weight;
  }
  score = Math.round(score * 100) / 100;
  const band = d.bands.find((b) => score <= b.max) ?? d.bands[d.bands.length - 1];
  return { score, rating: band.rating, label: band.label };
}

// ---------------------------------------------------------------- 產生清單

function countTiles(raw: RawMap, ch: string): number {
  let n = 0;
  for (const row of raw.tiles) for (const c of row) if (c === ch) n++;
  return n;
}

/** 地圖的統計值是 `npm run map:build` 寫進去的。缺了就是資料沒重建，不猜。 */
export function statsOf(raw: RawMap): MapStats {
  if (!raw.stats) {
    throw new Error('地圖 ' + raw.id + ' 沒有統計值 —— 請跑 npm run map:build');
  }
  return raw.stats;
}

export function briefOf(mapId: string): ContractBrief {
  const b = CONTRACTS[mapId];
  if (!b) throw new Error('地圖 ' + mapId + ' 沒有對應的合約簡報');
  return b;
}

export function makeContract(raw: RawMap, missionSeed: number): Contract {
  const stats = statsOf(raw);
  return {
    mapId: raw.id,
    mapName: raw.name,
    brief: briefOf(raw.id),
    tags: deriveTags(stats),
    difficulty: deriveDifficulty(stats),
    objectives: {
      main: countTiles(raw, 'T'),
      secondary: countTiles(raw, 'S'),
      caches: countTiles(raw, 'L'),
    },
    missionSeed,
  };
}

/**
 * 從既有地圖中**不重複**抽出 n 份合約（§18.1）。
 *
 * 抽法是部分洗牌：抽出來的順序也是亂數決定的，否則清單永遠照
 * mission_01…04 的順序排，玩家會學會「第一張最簡單」。
 *
 * `rng` 會被就地推進 —— 呼叫端持有同一個產生器，
 * 「返回合約清單」時再抽一次就會得到不同的清單，而整條序列仍由初始種子決定。
 */
export function generateContracts(rng: RngState, count = CONTRACT_RULES.listSize): Contract[] {
  const pool = MAPS.filter((m) => m.stats && CONTRACTS[m.id]);
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(nextFloat(rng) * (pool.length - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  // 任務種子在這裡就抽好：卡片與它背後那一場是同一件事。
  return pool.slice(0, n).map((m) => makeContract(m, nextInt(rng, 0x7fffffff)));
}

/** 給測試與工具用：不必自己組 Rng。 */
export function contractsFromSeed(seed: number, count?: number): Contract[] {
  return generateContracts(createRng(seed >>> 0), count);
}
