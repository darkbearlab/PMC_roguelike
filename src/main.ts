import './style.css';
import { Game } from './ui/game';
import { BUILD_ID } from './ui/build';
import { computeVision } from './render/vision';
import { MAPS, WEAPONS, mapById } from './core/content';
import { createRng } from './core/rng';
import { generateContracts } from './core/contracts';
import type { Contract } from './core/contracts';
import type { RawMap } from './core/map';
import { hideContracts, showContracts } from './ui/contracts';

/**
 * §14：rngSeed 可從網址參數覆寫（?seed=12345），方便重現 bug。
 * 沒指定時以當下時間當種子；亂數本身仍然只經過 core/rng 的可播種產生器。
 *
 * v0.14 起種子控制的是**合約清單**，每份合約的任務種子在產生清單時就抽好。
 * 相同的 `?seed=` 仍然得到完全相同的一連串局面，只是入口往前挪了一格。
 */
function readSeed(): number {
  const p = new URLSearchParams(location.search);
  const raw = p.get('seed');
  if (raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return Number(raw) >>> 0;
  }
  return Date.now() >>> 0;
}

/**
 * `?map=<id>` 指定地圖，方便針對單張圖除錯（§13.2）。
 * **它同時略過合約清單**（§18.1）—— 除錯與機器人基準都走這條路。
 */
function readMap(): RawMap | null {
  const raw = new URLSearchParams(location.search).get('map');
  if (!raw) return null;
  const found = mapById(raw);
  if (!found) {
    console.warn('[PMC] 沒有這張地圖：' + raw + '　可用的有 ' + MAPS.map((m) => m.id).join(', '));
  }
  return found;
}

const seed = readSeed();
const forcedMap = readMap();

/**
 * 清單專用的產生器，與任務的亂數完全分開。
 *
 * 「返回合約清單」時**繼續**從這個產生器抽，所以每次都是新的一批，
 * 而整條序列仍然由最初那個種子決定 —— 同一個 `?seed=` 重玩，
 * 第一批、第二批、第三批合約都會一模一樣。
 */
const listRng = createRng(seed);

let game: Game | null = null;

function backToList(): void {
  openList();
}

function startMission(mapId: string, missionSeed: number): void {
  const map = mapById(mapId);
  if (!map) throw new Error('合約指向不存在的地圖 ' + mapId);
  hideContracts();
  if (game) game.loadMission(missionSeed, map);
  else game = new Game(missionSeed, map, backToList);
  publish(game);
  console.info('[PMC] 出擊 =', mapId, '/ 任務種子 =', missionSeed,
    '（用 ?seed=' + missionSeed + '&map=' + mapId + ' 直接重現這一場）');
}

function openList(): void {
  const list = generateContracts(listRng);
  console.info('[PMC] 合約清單 =', list.map((c: Contract) => c.mapId).join(', '));
  showContracts(list, (c) => startMission(c.mapId, c.missionSeed));
}

function publish(g: Game): void {
  // 方便在手機遠端除錯時查看／重現
  Object.assign(window as unknown as Record<string, unknown>, {
    __game: g,
    __seed: seed,
    __build: BUILD_ID,
    __computeVision: computeVision,
    __weapons: WEAPONS,
    __maps: MAPS,
  });
  console.info(
    '[PMC] build =', BUILD_ID, '/ seed =', seed,
    '/ map =', g.state.map.id,
  );
}

if (forcedMap) {
  // 除錯／機器人：略過清單，行為與 v0.13 完全相同。
  game = new Game(seed, forcedMap);
  publish(game);
} else {
  openList();
}

Object.assign(window as unknown as Record<string, unknown>, {
  __seed: seed,
  __build: BUILD_ID,
  __maps: MAPS,
  /** 測試與除錯用：直接開一份合約，不必點畫面。 */
  __openList: openList,
  __start: startMission,
});
