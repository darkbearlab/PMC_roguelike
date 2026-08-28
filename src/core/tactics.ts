/**
 * 敵人的落點評分（§9.2）。
 *
 * v0.10 之前敵人在 ALERT 時貪婪逼近：永遠朝玩家走最短路。結果是戰術層有一整套
 * 詞彙，但只有玩家會用 —— 掩蔽、側翼、姿勢、面向全部是單向的。
 *
 * 這裡把「往哪走」變成一次評分：四個正交鄰格 + 留在原地，共最多五個候選，
 * 依原型的權重算分，取最高。權重全部在 data/actors.json，程式碼裡不寫死。
 *
 * **完全決定性**：分數相同時依固定方向順序（北、東、南、西、原地）決勝，不用亂數。
 */
import type { GameState, Unit, Vec2 } from './state';
import type { DeclKind } from './state';
import { DIR_VEC, manhattan, sameTile } from './grid';
import { coverAgainst, type CoverLevel } from './cover';
import { hasLineOfSight } from './los';
import { occupiedBy, terrainPassable, vaultTarget } from './pathfind';
import { RULES, archetype } from './content';

export interface AiWeights {
  approach: number;
  selfCover: number;
  targetExposure: number;
  canShoot: number;
  crouchInCover: boolean;
}

const NEUTRAL: AiWeights = {
  approach: 1, selfCover: 0, targetExposure: 0, canShoot: 0, crouchInCover: false,
};

export function weightsFor(u: Unit): AiWeights {
  return (archetype(u.archetype).ai as AiWeights | undefined) ?? NEUTRAL;
}

/** 掩蔽等級轉成 0..1 的分數。三級列舉（§7.2b），不是累加。 */
const COVER_SCORE: Record<CoverLevel, number> = { NONE: 0, PARTIAL: 0.5, GOOD: 1 };

/** 一個候選落點的完整評分明細。理由碼由這裡推導，不是事後猜的（§9.5）。 */
export interface Candidate {
  pos: Vec2;
  /** 各項的原始分數（0..1 或 −1..1），還沒乘權重。 */
  raw: { approach: number; selfCover: number; targetExposure: number; canShoot: number };
  score: number;
  /**
   * 只算「位置好不好」的分數：掩蔽、對方的暴露、有沒有射線 —— **不含 approach**。
   *
   * 這一項是給「我已經打得到了，要不要換個更好的位置」用的。
   * 用完整分數比會震盪（approach 對兩格來說符號相反），只比位置項則不會：
   * 要從 A 移到 B 得 pos(B) > pos(A)，那麼在 B 就不可能再想回 A。
   */
  posScore: number;
  /** 這一格是不是「留在原地」。 */
  stay: boolean;
  /** 要翻越掩體才到得了（v0.19 §1.3）。花的時間是兩倍，落地強制站姿。 */
  vault: boolean;
}

/**
 * 對候選落點評分。
 *
 * - `approach`      與目標的曼哈頓距離變化，接近為正（−1 / 0 / +1）
 * - `selfCover`     **這一格相對於玩家**的掩蔽等級，越高越好
 * - `targetExposure` **從這一格看過去**玩家的掩蔽等級，越低越好
 * - `canShoot`      從這一格對玩家有沒有視線且在射程內
 *
 * `targetExposure` 是本次最重要的一項：它只是把既有的掩蔽函式射手與目標對調，
 * 成本極低，但它會讓敵人**主動繞開玩家的掩體**。
 */
export function scoreCandidate(
  state: GameState, u: Unit, at: Vec2, target: Vec2, w: AiWeights, vault = false,
): Candidate {
  const here = manhattan(u.pos, target);
  const there = manhattan(at, target);
  const approach = Math.sign(here - there);          // 走近 → +1

  const selfCover = COVER_SCORE[coverAgainst(state.map, at, target).level];
  // 目標的掩蔽越低越好，所以取 1 − 分數
  const targetExposure = 1 - COVER_SCORE[coverAgainst(state.map, target, at).level];

  const range = u.equipped ? u.equipped.range : 0;
  const shootable = there <= range
    && hasLineOfSight(state.map, at, u.stance, target, 'STAND');
  const canShoot = shootable ? 1 : 0;

  const raw = { approach, selfCover, targetExposure, canShoot };
  const posScore = w.selfCover * selfCover
    + w.targetExposure * targetExposure
    + w.canShoot * canShoot;
  // 評分裡沒有時間項，用一個懲罰值代表翻越比走一步貴。
  //
  // **懲罰要跟著實際時間走**，不能寫死：§4 說「若成排掩體不再構成屏障，
  // 先調高翻越時間」—— 若懲罰與時間脫鉤，那個旋鈕對敵人就完全沒有作用。
  // 所以係數乘上「多花了幾倍的時間」。
  const extra = Math.max(0, (RULES.time.vault - u.moveTime) / Math.max(1, u.moveTime));
  const penalty = vault ? RULES.ai.vaultPenalty * extra : 0;
  // **原型差異不必另外寫**：翻過去之後掩體在你身後，`selfCover` 自然歸零，
  // 所以射手型（selfCover 權重高）本來就不會想翻，衝鋒型（只看 approach）會。
  const score = w.approach * approach + posScore - penalty;
  return {
    pos: { x: at.x, y: at.y }, raw, score, posScore,
    stay: sameTile(at, u.pos), vault,
  };
}

/** 固定的決勝順序（§9.2）。北、東、南、西，最後才是原地。 */
const ORDER = ['N', 'E', 'S', 'W'] as const;

export function candidates(state: GameState, u: Unit, target: Vec2): Candidate[] {
  const w = weightsFor(u);
  const out: Candidate[] = [];
  for (const d of ORDER) {
    const p = { x: u.pos.x + DIR_VEC[d].x, y: u.pos.y + DIR_VEC[d].y };
    if (terrainPassable(state, p) && !occupiedBy(state, p, [u.id])) {
      out.push(scoreCandidate(state, u, p, target, w));
      continue;
    }
    // 走不過去就看能不能翻過去（§1.3）—— 不然掩體列對敵人是單向膜
    const land = vaultTarget(state, u.pos, d, { ignoreUnitIds: [u.id] });
    if (land) out.push(scoreCandidate(state, u, land, target, w, true));
  }
  out.push(scoreCandidate(state, u, u.pos, target, w));   // 原地永遠是候選
  return out;
}

/** 取分數最高的候選。同分時取先出現的 —— 順序即決勝規則。 */
export function bestCandidate(state: GameState, u: Unit, target: Vec2): Candidate {
  const list = candidates(state, u, target);
  let best = list[0];
  for (const c of list) if (c.score > best.score) best = c;
  return best;
}

/**
 * 這個原型會不會「為了更好的位置而放棄這一槍的即刻性」（§9.2）。
 *
 * 由權重推導而不是另開一個旗標 —— 權重是唯一的事實來源，
 * 調 actors.json 就會跟著改，不會出現「權重說要繞、旗標說不要」的矛盾。
 */
export function repositionsUnderFire(w: AiWeights): boolean {
  return w.selfCover + w.targetExposure > w.approach;
}

/**
 * 已經打得到了，但值不值得先換個位置再打？
 *
 * 只比位置項（不含 approach），而且必須**換過去也還打得到** ——
 * 敵人永遠不會為了找掩體而放棄射線，只會在能打的前提下挑更好的地方打。
 * 這就是「保持距離、找掩體、繞側翼」在規則上的樣子。
 */
export function betterFiringPosition(
  state: GameState, u: Unit, target: Vec2,
): Candidate | null {
  const w = weightsFor(u);
  if (!repositionsUnderFire(w)) return null;
  const list = candidates(state, u, target);
  const stay = list.find((c) => c.stay);
  if (!stay) return null;
  let best: Candidate | null = null;
  for (const c of list) {
    if (c.stay || c.raw.canShoot < 1) continue;      // 換過去要還打得到
    if (c.posScore <= stay.posScore) continue;       // 而且要真的更好
    if (!best || c.posScore > best.posScore) best = c;
  }
  return best;
}

/**
 * 這一步「為什麼」要走 —— 取相對於原地、加權後貢獻最大的那一項（§9.5）。
 *
 * 口令必須由這裡產生。事後推測的話，調整權重之後口令就會開始說謊。
 */
export function moveReason(chosen: Candidate, stay: Candidate, w: AiWeights): DeclKind {
  const delta = {
    ADVANCE: w.approach * (chosen.raw.approach - stay.raw.approach),
    TAKE_COVER: w.selfCover * (chosen.raw.selfCover - stay.raw.selfCover),
    // 取得射線與繞開對方的掩體是同一件事：都是在調整角度
    FLANK: w.targetExposure * (chosen.raw.targetExposure - stay.raw.targetExposure)
      + w.canShoot * (chosen.raw.canShoot - stay.raw.canShoot),
  };
  let best: DeclKind = 'ADVANCE';
  let bestVal = -Infinity;
  // 順序固定，同分時取先出現的
  for (const k of ['FLANK', 'TAKE_COVER', 'ADVANCE'] as const) {
    if (delta[k] > bestVal) { bestVal = delta[k]; best = k; }
  }
  return bestVal > 0 ? best : 'ADVANCE';
}

/**
 * 繞的是畫面的左邊還是右邊（§9.5）。
 *
 * 以**畫面**為準，不是以誰的正面為準 —— 口令是喊給玩家聽的，
 * 玩家看的是地圖，所以「右邊」要對得上他螢幕上的右邊。
 */
export function flankSide(target: Vec2, from: Vec2, to: Vec2): 'LEFT' | 'RIGHT' {
  const ax = from.x - target.x;
  const ay = from.y - target.y;
  const bx = to.x - target.x;
  const by = to.y - target.y;
  return ax * by - ay * bx > 0 ? 'RIGHT' : 'LEFT';
}
