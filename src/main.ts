import './style.css';
import { Game } from './ui/game';
import { BUILD_ID } from './ui/build';
import { computeVision } from './render/vision';
import { MAPS, WEAPONS, mapById } from './core/content';

/**
 * §14：rngSeed 可從網址參數覆寫（?seed=12345），方便重現 bug。
 * 沒指定時以當下時間當種子；亂數本身仍然只經過 core/rng 的可播種產生器。
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
 * 沒指定就交給種子去挑 —— 選圖是規則的一部分，走的是 core/rng。
 */
function readMap(): ReturnType<typeof mapById> {
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
const game = new Game(seed, forcedMap);

// 方便在手機遠端除錯時查看／重現
Object.assign(window as unknown as Record<string, unknown>, {
  __game: game,
  __seed: seed,
  __build: BUILD_ID,
  __computeVision: computeVision,
  __weapons: WEAPONS,
  __maps: MAPS,
});
console.info(
  '[PMC] build =', BUILD_ID, '/ seed =', seed,
  '/ map =', game.state.map.id,
  '（用 ?seed=' + seed + ' 重現這一場，?map=<id> 指定地圖）',
);
