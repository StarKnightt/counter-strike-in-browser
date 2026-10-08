// Player-facing names. `vite build --mode wavedash` (see vite.config.js) swaps in original names for the
// Wavedash release; every other build keeps these defaults.
const WD = import.meta.env.VITE_WAVEDASH === '1';

export const BRAND = WD
  ? {
      wavedash: true,
      title: 'Site Hold',
      playerName: 'You',
      mapLine: 'Dune Yard <span>A site</span> · Defender · Hold A',
      ct: 'Defender',
      t: 'Attacker',
      ctWin: 'DEFENDERS WIN',
      tWin: 'ATTACKERS WIN',
      ctEliminated: 'Defenders eliminated',
      tEliminated: 'Attackers eliminated',
      planted: 'Charge planted.',
      defused: 'Charge defused.',
      botNames: ['Kade', 'Ross', 'Milo', 'Dane', 'Ivo'],
      announcerDir: 'voice-wd',
    }
  : {
      wavedash: false,
      title: null,
      playerName: 'prase',
      mapLine: null,
      ct: 'Counter-Terrorist',
      t: 'Terrorist',
      ctWin: 'COUNTER-TERRORISTS WIN',
      tWin: 'TERRORISTS WIN',
      ctEliminated: 'Counter-Terrorists eliminated',
      tEliminated: 'Terrorists eliminated',
      planted: 'The bomb has been planted.',
      defused: 'The bomb has been defused.',
      botNames: ['Cliffe', 'Ryan', 'Chet', 'Wolf', 'Vitaliy'],
      announcerDir: 'voice',
    };
