/** Single source of truth for round/gameplay state shared by systems + HUD. */
export const state = {
  phase: 'loading',       // loading | freeze | live | planted | over
  side: 'ct',             // the player's team this round: 'ct' (bots are Ts attacking A) | 't' (player carries the C4, bots defend as CTs)
  roundTime: 115,         // seconds left in 1:55 round
  bombTime: 40,           // C4 timer
  winner: null,           // 'CT' | 'T' | null
  winReason: '',
  player: { hp: 100, armor: 100, alive: true, weapon: 'ak47', crouching: false, walking: false, defusing: false, defuseProgress: 0, hasBomb: false, planting: false, plantProgress: 0 },
  bots: [],               // filled by BotManager: {id, name, alive, hp}
  kills: 0,
  killfeed: [],           // [{killer, victim, weapon, headshot, t}]
  bomb: { state: 'carried', carrier: null, position: null, plantProgress: 0 },   // state: carried | dropped | planted | defused | exploded; carrier: bot name | 'player' | null
  score: { ct: 0, t: 0 },  // round wins (persist across restarts)
  round: 1,
  playerName: 'prase',
  mvp: null,              // { name, text } filled at round end
};

/**
 * Display name for anything an event calls a killer / attacker / victim: a string as-is, an object's .name (Bot),
 * otherwise 'Unknown'. Everything that writes text (killfeed, death panel, MVP line) goes through this, so a harness
 * that passes a Bot or Player object instead of a label can never print "[object Object]".
 */
export const nameOf = (x) => (typeof x === 'string' ? x : x?.name) || 'Unknown';

export function resetRound() {
  state.phase = 'freeze';
  state.roundTime = 115; state.bombTime = 40; state.winner = null; state.winReason = '';
  Object.assign(state.player, { hp: 100, armor: 100, alive: true, weapon: 'ak47', crouching: false, walking: false, defusing: false, defuseProgress: 0, hasBomb: false, planting: false, plantProgress: 0 });
  state.kills = 0; state.killfeed.length = 0; state.mvp = null;
  Object.assign(state.bomb, { state: 'carried', carrier: null, position: null, plantProgress: 0, canPlant: false, canDefuse: false, defuser: null });
}
