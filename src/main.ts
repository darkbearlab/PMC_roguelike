import './style.css';
import { Game } from './ui/game';
import { BUILD_ID } from './ui/build';
import { computeVision } from './render/vision';

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

const seed = readSeed();
const game = new Game(seed);

// 方便在手機遠端除錯時查看／重現
Object.assign(window as unknown as Record<string, unknown>, {
  __game: game,
  __seed: seed,
  __build: BUILD_ID,
  __computeVision: computeVision,
});
console.info('[PMC] build =', BUILD_ID, '/ seed =', seed, '（用 ?seed=' + seed + ' 可重現這一場）');
