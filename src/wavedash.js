// Wavedash platform hooks. Every call is a no-op when window.Wavedash is absent
// (GitHub Pages, local dev), so the same build runs everywhere.
import { bus, Events } from './core/EventBus.js';
import { state } from './core/GameState.js';

const sdk = () => window.Wavedash;
const boards = new Map();
let initialized = false;

export const wavedash = {
  progress(p) {
    try { sdk()?.updateLoadProgressZeroToOne(Math.min(1, Math.max(0, p))); } catch {}
  },
  ready() {
    const s = sdk();
    if (!s || initialized) return;
    initialized = true;
    try {
      s.updateLoadProgressZeroToOne(1);
      s.init({ debug: false });
      s.requestStats().catch(() => {});
    } catch {}
  },
  /** Stats load asynchronously after init; retry until the unlock sticks. */
  achieve(id) {
    const s = sdk();
    if (!s) return;
    let tries = 0;
    const attempt = () => {
      let ok = false;
      try { ok = s.getAchievement(id) || s.setAchievement(id, true); } catch {}
      if (!ok && ++tries < 20) setTimeout(attempt, 1500);
    };
    attempt();
  },
  /** sort 0 = lower is better, 1 = higher is better; display 0 = number, 2 = milliseconds */
  submitScore(name, score, sort, display) {
    const s = sdk();
    if (!s) return;
    if (!boards.has(name)) {
      boards.set(name, s.getOrCreateLeaderboard(name, sort, display).then((r) => (r.success ? r.data.id : null)).catch(() => null));
    }
    boards.get(name).then((id) => id && s.uploadLeaderboardScore(id, Math.round(score), true)).catch(() => {});
  },
};

const WINS_KEY = 'cs2-dust2.roundsWon';

/** Round results -> leaderboard and achievements. */
export function wireWavedash() {
  if (!sdk()) return;
  bus.on(Events.KILL, ({ killer, headshot }) => {
    if (killer !== 'player') return;
    wavedash.achieve('FIRST_KILL');
    if (headshot) wavedash.achieve('HEADSHOT');
    if (state.kills >= 5) wavedash.achieve('ACE');
  });
  bus.on(Events.BOMB_PLANTED, (e) => { if (e?.player) wavedash.achieve('PLANT'); });
  bus.on(Events.BOMB_DEFUSED, () => { if (state.side === 'ct') wavedash.achieve('DEFUSE'); });
  bus.on(Events.ROUND_END, ({ winner }) => {
    if (winner !== (state.side === 't' ? 'T' : 'CT')) return;
    wavedash.achieve('ROUND_WIN');
    const won = (Number(localStorage.getItem(WINS_KEY)) || 0) + 1;
    localStorage.setItem(WINS_KEY, String(won));
    wavedash.submitScore('rounds-won', won, 1, 0);
    if (won >= 10) wavedash.achieve('TEN_ROUNDS');
  });
}
