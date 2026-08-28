import './style.css';
import { Game } from './ui/game';
import { BUILD_ID } from './ui/build';
import { computeVision } from './render/vision';
import { MAPS, WEAPONS, mapById } from './core/content';
import { createRng } from './core/rng';
import { generateContracts } from './core/contracts';
import type { Contract } from './core/contracts';
import type { RawMap } from './core/map';
import type { MetaState } from './core/meta';
import { applyMissionResult, makeDeployment, missionResultOf, newCompany } from './core/meta';
import { hideContracts, showContracts } from './ui/contracts';
import { hideCompany, showCompany } from './ui/company';
import { clearCompany, loadCompany, saveCompany } from './ui/persist';
import { showVersionMismatch } from './ui/modals';

/**
 * §14：rngSeed 可從網址參數覆寫（?seed=12345），方便重現 bug。
 * v0.14 起種子控制的是合約清單；v0.16 的局外層狀態不受它影響（那是存檔的事）。
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
 * `?map=<id>` 指定地圖（§13.2）。**它同時略過公司、合約與派遣畫面**，
 * 用一份測試用的派遣快照直接開打 —— 除錯與機器人基準都走這條路。
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
if (new URLSearchParams(location.search).get('reset') === '1') clearCompany();

const listRng = createRng(seed);

let game: Game | null = null;
let meta: MetaState = newCompany();
let versionProblem: { found: number; expected: number } | null = null;
/** 目前正在接的那一份合約。結算之後要把它寫進服役紀錄。 */
let current: Contract | null = null;

function save(): void {
  saveCompany(meta);
}

function openCompany(pick = false): void {
  hideContracts();
  save();
  showCompany(meta, {
    save,
    toContracts: () => openList(),
    deploy: (soldierId) => launch(soldierId),
    reset: () => {
      clearCompany();
      meta = newCompany();
      save();
      openCompany();
    },
  }, pick);
}

function openList(): void {
  hideCompany();
  const list = generateContracts(listRng);
  console.info('[PMC] 合約清單 =', list.map((c: Contract) => c.mapId).join(', '));
  showContracts(list, (c) => {
    current = c;
    hideContracts();
    openCompany(true);          // 派遣：挑首發
  });
}

function launch(soldierId: string): void {
  const c = current;
  if (!c) return;
  const map = mapById(c.mapId);
  if (!map) throw new Error('合約指向不存在的地圖 ' + c.mapId);
  const plan = makeDeployment(meta, soldierId);
  hideCompany();
  hideContracts();
  if (game) game.loadMission(c.missionSeed, map, plan);
  else game = new Game(c.missionSeed, map, finish, plan);
  publish(game);
  console.info('[PMC] 出擊 =', c.mapId, '/ 任務種子 =', c.missionSeed, '/ 首發 =', soldierId);
}

/** 任務結束：把結果套用回公司，存檔，回到公司畫面（§4.1）。 */
function finish(): void {
  if (game && current) {
    const r = missionResultOf(game.state, {
      mapName: game.state.map.name,
      contractCode: current.brief.code,
    });
    meta = applyMissionResult(meta, r);
    console.info('[PMC] 結算 =', r.outcome, '陣亡', r.deadIds.length, '帶出', r.extracted.length);
  }
  current = null;
  openCompany();
}

function publish(g: Game): void {
  Object.assign(window as unknown as Record<string, unknown>, {
    __game: g,
    __seed: seed,
    __build: BUILD_ID,
    __computeVision: computeVision,
    __weapons: WEAPONS,
    __maps: MAPS,
  });
  console.info('[PMC] build =', BUILD_ID, '/ seed =', seed, '/ map =', g.state.map.id);
}

// ---------------------------------------------------------------- 開機

if (forcedMap) {
  // 除錯／機器人：略過整個局外層，用測試用的派遣快照。
  game = new Game(seed, forcedMap, null);
  publish(game);
} else {
  const outcome = loadCompany();
  if (outcome.kind === 'VERSION_MISMATCH') {
    versionProblem = { found: outcome.found, expected: outcome.expected };
    showVersionMismatch(versionProblem, () => {
      clearCompany();
      meta = newCompany();
      openCompany();
    });
  } else {
    meta = outcome.meta;
    openCompany();
  }
}

Object.assign(window as unknown as Record<string, unknown>, {
  __seed: seed,
  __build: BUILD_ID,
  __maps: MAPS,
  __meta: (): MetaState => meta,
  __openList: openList,
  __company: openCompany,
});
