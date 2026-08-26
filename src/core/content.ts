/**
 * 資料檔載入（§17：所有可調數值都在 data/ 的 JSON，不寫死在程式碼裡）。
 * import JSON 不涉及任何瀏覽器 API，core/ 的純粹性不受影響。
 */
import rulesJson from '../data/rules.json';
import weaponsJson from '../data/weapons.json';
import actorsJson from '../data/actors.json';
import mission01Json from '../data/maps/mission_01.json';

import type { Weapon, WeaponClass } from './state';
import type { RawMap } from './map';

export interface Rules {
  roster: { size: number; idPrefix: string };
  ap: {
    moveCost: number;
    pickupCost: number;
    dropCost: number;
    interactCost: number;
    stanceCost: number;
    facingCost: number;
    swapCost: Record<WeaponClass, number>;
  };
  ai: { searchTimer: number };
  combat: {
    enableToHitRoll: boolean;
    hitFloor: number;
    hitCeil: number;
    minDamage: number;
    stance: { shooterCrouchBonus: number; targetCrouchPenalty: number; crouchSightFactor: number };
    cover: { partial: number; good: number };
  };
  movement: { _comment: string };
  log: { maxEntries: number };
}

export interface ActorArchetype {
  name: string;
  faction: 'PLAYER' | 'ENEMY';
  hp: number;
  armor: number;
  armorSpread: number;
  maxAp: number;
  sightRange: number;
  aim: number;
  evasion: number;
  attacksPerTurn: number;
  attack?: Weapon;
}

export const RULES: Rules = rulesJson as unknown as Rules;
export const WEAPONS: Weapon[] = weaponsJson as unknown as Weapon[];
export const ACTORS: Record<string, ActorArchetype> = actorsJson as unknown as Record<string, ActorArchetype>;
export const MISSION_01: RawMap = mission01Json as unknown as RawMap;

export function weaponById(id: string): Weapon {
  const w = WEAPONS.find((x) => x.id === id);
  if (!w) throw new Error(`未知的武器 id: ${id}`);
  return cloneWeapon(w);
}

export function archetype(id: string): ActorArchetype {
  const a = ACTORS[id];
  if (!a) throw new Error(`未知的單位原型: ${id}`);
  return a;
}

/** 武器是可變狀態（ammo），每個實例都必須是獨立複本。 */
export function cloneWeapon(w: Weapon): Weapon {
  return { ...w };
}
