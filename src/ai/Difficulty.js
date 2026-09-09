/**
 * Bot gunfight difficulty. One table, three presets; everything else about the bots (routes, planting, peeking, cover,
 * callouts) is untouched -- only how fast and how accurately they shoot changes.
 *
 * Selection, in order of precedence:  ?bots=easy|normal|hard  >  localStorage['cs2.botdiff']  >  DEFAULT ('easy').
 * Live: `__game.cheats.difficulty('hard')` switches (and persists) mid-round; bots read the table every time they use it.
 *
 * `normal` is the tuning the bots shipped with (every field below is the literal value Bot.js used before the table
 * existed). `hard` tightens reaction and error to ~0.7x. `easy`:
 *   - reaction 0.55-0.8 s before the first shot (profiles were 0.26-0.50)
 *   - first-shot aim error x2.5, and the fresh hand error at the start of every burst x1.6
 *   - aim turn speed x0.6 (the aim-lerp time constant 0.13 -> 0.22 s) and the error decays slower (0.35 -> 0.55 s)
 *   - bursts of 2-4 (3-5 inside 10 m, was 6-10) with 0.7-1.1 s pauses (was 0.35-0.5)
 *   - headshot probability x0.3
 *   - 20 % of contacts: the bot stands in the open ~0.5 s longer before firing, and peeks out 0.5 s longer
 *   - being hit knocks the aim off by ~1.2 deg and the flinch slows tracking up to 3.5x while it wears off
 */
export const BOT_DIFFICULTY = {
  normal: {
    reaction: null,          // [min, max] s override; null = the profile's own range
    reactionMul: 1,          // applied to the profile range when `reaction` is null
    aimErr0Mul: 1,           // initial aim error on contact (Bot._perceive)
    burstErrMul: 1,          // fresh hand error at the start of each burst (Bot._engage)
    aimTau: 0.13,            // aim lerp time constant (s); bigger = slower turn onto the target
    errTau: 0.35,            // aim-error decay time constant (s)
    burst: null,             // [min, max] shots override; null = the profile's own
    burstClose: [6, 10],     // shots per burst inside 10 m
    burstPause: [0.35, 0.5], // s between bursts
    coneMul: 1,              // spread cone multiplier (Bot._shoot)
    headMul: 1,              // headshot probability multiplier
    overPeek: 0,             // chance a contact / peek is held ~0.5 s longer in the open before firing
    overPeekT: 0.5,
    flinchKick: 0,           // deg of aim error added when hit
    flinchSlow: 0,           // aimTau *= 1 + flinch * flinchSlow while the flinch wears off
  },
  easy: {
    reaction: [0.55, 0.80], reactionMul: 1,
    aimErr0Mul: 2.5, burstErrMul: 1.6,
    aimTau: 0.13 / 0.6, errTau: 0.55,
    burst: [2, 4], burstClose: [3, 5], burstPause: [0.7, 1.1],
    coneMul: 1.4, headMul: 0.3,
    overPeek: 0.2, overPeekT: 0.5,
    flinchKick: 1.2, flinchSlow: 2.5,
  },
  hard: {
    reaction: null, reactionMul: 0.7,
    aimErr0Mul: 0.7, burstErrMul: 0.7,
    aimTau: 0.11, errTau: 0.30,
    burst: null, burstClose: [6, 10], burstPause: [0.3, 0.42],
    coneMul: 0.85, headMul: 1.15,
    overPeek: 0, overPeekT: 0.5,
    flinchKick: 0, flinchSlow: 0,
  },
};

export const DEFAULT_DIFFICULTY = 'easy';
const KEY = 'cs2.botdiff';

function fromStorage() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

function initial() {
  const q = new URLSearchParams(location.search).get('bots');
  if (q && BOT_DIFFICULTY[q]) return q;
  const s = fromStorage();
  if (s && BOT_DIFFICULTY[s]) return s;
  return DEFAULT_DIFFICULTY;
}

let current = initial();

/** Name of the active preset. */
export const difficultyName = () => current;
/** The active table (read it each time; it can change mid-round). */
export const difficulty = () => BOT_DIFFICULTY[current];

/** Switch presets. Unknown names are ignored (returns the active name). `persist` writes localStorage['cs2.botdiff']. */
export function setDifficulty(name, persist = true) {
  if (!BOT_DIFFICULTY[name]) { console.warn(`bot difficulty: unknown '${name}' (easy | normal | hard)`); return current; }
  current = name;
  if (persist) { try { localStorage.setItem(KEY, name); } catch { /* private mode */ } }
  return current;
}
