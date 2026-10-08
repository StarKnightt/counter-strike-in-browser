import { Game } from './core/Game.js';
import { wavedash, wireWavedash } from './wavedash.js';
import { BRAND } from './brand.js';

const canvas = document.getElementById('game');
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('start');
const loading = document.getElementById('loading');

startBtn.disabled = true;
const game = new Game(canvas);
window.__game = game; // debug / screenshot hooks
if (BRAND.title) {
  document.title = BRAND.title;
  startBtn.querySelector('.map').innerHTML = BRAND.mapLine;
}

wireWavedash();
wavedash.ready();
game.init((p) => { loading.textContent = `loading map… ${Math.round(p * 100)}%`; }).then(() => {
  loading.textContent = 'ready';
  startBtn.disabled = false;
}).catch((e) => { loading.textContent = 'failed: ' + e.message; console.error(e); });

/**
 * Raw mouse input: unadjustedMovement skips the OS pointer acceleration/ballistics (CS "raw input"). Chromium returns a
 * promise that rejects when the platform can't do it (then lock plainly); Firefox throws on the options argument.
 */
function lockPointer() {
  const plain = () => {
    const q = canvas.requestPointerLock();
    // e.g. Chromium's "too many pointer lock requests" right after an Esc: bring the overlay back instead of a dead screen
    if (q && typeof q.catch === 'function') q.catch((e) => { console.warn('pointer lock refused:', e?.message || e); overlay.classList.remove('hidden'); });
  };
  try {
    const p = canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && typeof p.catch === 'function') p.catch(plain);
  } catch { plain(); }
}
/**
 * Play = fullscreen + pointer lock. Fullscreen matters beyond immersion: Ctrl is the walk key, and Chromium only lets the
 * page keep Ctrl+W / Ctrl+1..8 (close tab / switch tab) when it is fullscreen with `navigator.keyboard.lock()` — Input
 * issues that lock on `fullscreenchange`. Order: request fullscreen, then lock the pointer once it resolves (or at once if
 * it rejects — headless Playwright, iframes, browsers that refuse — the game must still start). Already fullscreen
 * (re-click after Esc released only the pointer, or after a round): just re-lock. Firefox has no keyboard lock; it gets
 * fullscreen + pointer lock + Input's preventDefault.
 *
 * Automation (`navigator.webdriver` — set by Playwright / CDP — or `?nolock=1`): NO fullscreen, pointer lock or keyboard
 * lock. Headless Chromium grants all three, and on Windows pointer lock hides/confines/re-centres the real OS cursor
 * (SetCursorPos / ClipCursor on the hidden window), so every headless test run yanked the user's mouse. Instead the overlay
 * hides and Input reports itself locked (`forceLocked`), so synthetic key / mouse events drive the game as before.
 */
const NO_LOCK = navigator.webdriver === true || new URLSearchParams(location.search).get('nolock') === '1';
function enterGame() {
  overlay.classList.add('hidden');
  if (NO_LOCK) { game.input.forceLocked = true; return; }
  if (document.fullscreenElement) { lockPointer(); return; }
  let fs;
  try { fs = document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); } catch { fs = null; }
  if (fs && typeof fs.then === 'function') fs.then(lockPointer, lockPointer);
  else lockPointer();
}
startBtn.addEventListener('click', enterGame);
// Esc drops fullscreen and the pointer lock together; the overlay comes back and a click re-enters both.
document.addEventListener('pointerlockchange', () => {
  if (game.input?.forceLocked) return;   // automation never holds a real lock; the overlay stays hidden
  if (document.pointerLockElement !== canvas) overlay.classList.remove('hidden');
});
// Firefox reports a refused lock only through this event (no promise); the delay skips Chromium's transient
// unadjustedMovement rejection, which the plain retry above resolves a few ms later.
document.addEventListener('pointerlockerror', () => {
  setTimeout(() => { if (document.pointerLockElement !== canvas) overlay.classList.remove('hidden'); }, 300);
});
// round over: after the result has been up for a moment, a click starts a fresh round
canvas.addEventListener('mousedown', () => { if (game.round?.canRestart) game.round.restart(); });

// Debug view helper for review screenshots: ?view=x,y,z,yaw,pitch  (or window.__view(...))
window.__view = (x, y, z, yaw = 0, pitch = 0) => { overlay.classList.add('hidden'); game.mode = 'fly'; game.fly?.setView(x, y, z, yaw, pitch); };
window.__play = () => { game.mode = 'play'; };
const q = new URLSearchParams(location.search).get('view');
if (q) { const [x, y, z, yaw, pitch] = q.split(',').map(Number); addEventListener('load', () => setTimeout(() => window.__view(x, y, z, yaw, pitch), 1500)); }
