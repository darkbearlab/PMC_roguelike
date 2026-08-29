import './style.css';
import { Game } from './ui/game';
import { BUILD_ID } from './ui/build';
import { computeVision } from './render/vision';
import { MAPS, WEAPONS, mapById } from './core/content';
import { createRng } from './core/rng';
import { activatedDropOptions, interactKindAt } from './core/commands';
import { isExplored } from './core/fog';
import { generateContracts } from './core/contracts';
import type { Contract } from './core/contracts';
import type { RawMap } from './core/map';
import type { MetaState } from './core/meta';
import {
  assignWeapon, drawEnemyWeapons, makeDeployment, missionLedger, missionResultOf,
  moveAmmo, newCompany,
  resupplyAll, settleMission,
} from './core/meta';
import type { MissionLedger, MissionResult } from './core/meta';
import { hideContracts, showContracts } from './ui/contracts';
import { hideCompany, showCompany } from './ui/company';
import { clearCompany, loadCompany, saveCompany } from './ui/persist';
import { showVersionMismatch } from './ui/modals';
import { UI } from './ui/config';

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

/**
 * 這一趟的結果（v0.20）。結算畫面在任務一結束就要顯示損益，
 * 但實際入帳要等玩家按「返回合約清單」—— 所以算帳與套用分開。
 */
function resultNow(): MissionResult | null {
  if (!game || !current) return null;
  return missionResultOf(game.state, {
    mapName: game.state.map.name,
    contractCode: current.brief.code,
    rating: current.difficulty.rating,
  });
}

/** 結算畫面用的損益表。**純計算，不動 MetaState。** */
function ledgerNow(): MissionLedger | null {
  const r = resultNow();
  return r ? missionLedger(meta, r) : null;
}

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
  // §2：敵人的武器**從物品池抽出**。抽走一把，補給站就少一把 ——
  // 所以它必須發生在這裡（局外層），不能發生在任務裡。
  plan.enemyWeapons = drawEnemyWeapons(
    meta, c.missionSeed, map.enemies.map((e) => e.archetype),
  );
  saveCompany(meta);
  hideCompany();
  hideContracts();
  if (game) game.loadMission(c.missionSeed, map, plan);
  else game = new Game(c.missionSeed, map, finish, plan, ledgerNow);
  publish(game);
  console.info('[PMC] 出擊 =', c.mapId, '/ 任務種子 =', c.missionSeed, '/ 首發 =', soldierId);
}

/** 任務結束：把結果套用回公司，存檔，回到公司畫面（§4.1）。 */
function finish(): void {
  if (game && current) {
    const r = resultNow()!;
    const settled = settleMission(meta, r);
    meta = settled.meta;
    // v0.18 附錄：撤離帶回來的彈藥併回共用庫存、士兵的攜行量歸零 —— 那個模型是對的，
    // 但副作用是每一場之後都要手動把彈藥一發一發按回去。**要省掉的是那個手工。**
    const topped = UI.autoResupplyOnReturn ? resupplyAll(meta) : 0;
    console.info('[PMC] 結算 =', r.outcome, '陣亡', r.deadIds.length,
      '入帳', settled.ledger.creditsEarned, '損益', settled.ledger.net,
      '餘額', meta.credits, topped ? '／自動補給 ' + topped + ' 件' : '');
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
    /** 驗收腳本用：純規則函式，介面部分由 fog.mjs 另外驗。 */
    __core: { activatedDropOptions, interactKindAt, isExplored },
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
  /** 驗收腳本用：直接動局外層，介面部分由 company.mjs 驗。 */
  __metaApi: { assignWeapon, moveAmmo },
  __openList: openList,
  __company: openCompany,
});
