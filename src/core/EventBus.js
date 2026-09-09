class EventBus {
  constructor() { this.listeners = new Map(); }
  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  once(evt, fn) {
    const off = this.on(evt, (...a) => { off(); fn(...a); });
    return off;
  }
  off(evt, fn) { this.listeners.get(evt)?.delete(fn); }
  emit(evt, payload) {
    const set = this.listeners.get(evt);
    if (!set) return;
    for (const fn of [...set]) fn(payload);
  }
  clear() { this.listeners.clear(); }
}

export const bus = new EventBus();

export const Events = {
  MAP_LOADED: 'map:loaded',
  ROUND_START: 'round:start',
  ROUND_END: 'round:end',
  PLAYER_DAMAGE: 'player:damage',
  PLAYER_DEATH: 'player:death',
  PLAYER_FOOTSTEP: 'player:footstep',
  PLAYER_SPOT: 'player:spot',          // { bot, distance, count } — a T came into the player's clear line of sight after being unseen for a while (Spotter.js)
  WEAPON_FIRE: 'weapon:fire',
  WEAPON_RELOAD: 'weapon:reload',
  WEAPON_SWITCH: 'weapon:switch',
  HIT: 'hit',
  KILL: 'kill',
  BOT_CALLOUT: 'bot:callout',
  BOT_SHOOT: 'bot:shoot',
  BOT_RELOAD: 'bot:reload',
  BOT_DEATH: 'bot:death',
  BOT_FOOTSTEP: 'bot:footstep',
  BOMB_PLANT_START: 'bomb:plantStart',
  BOMB_PLANTED: 'bomb:planted',
  BOMB_DEFUSE_START: 'bomb:defuseStart',
  BOMB_DEFUSE_STOP: 'bomb:defuseStop',
  BOMB_DEFUSED: 'bomb:defused',
  BOMB_EXPLODED: 'bomb:exploded',
  SOUND: 'sound',
};
