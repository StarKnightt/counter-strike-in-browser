/** Keyboard + pointer-locked mouse input with per-frame consumption of mouse deltas. */
export class Input {
  constructor(dom) {
    this.dom = dom;
    this.keys = new Set();
    this.pressed = new Set();     // keys that went down this frame
    this.mouseDX = 0; this.mouseDY = 0;
    this.mouseDown = new Set();   // 0 left, 2 right
    this.mousePressed = new Set();
    this.wheel = 0;
    // CS2 formula: degrees = counts * sensitivity * m_yaw (0.022). Pointer-lock movementX is ~1 px per mouse count (Windows
    // pointer speed 6/11, no "enhance pointer precision"), so sens 2.0 @ 800 dpi (eDPI 1600) = 0.044°/px = 7.7e-4 rad/px.
    // (The previous 0.0022 was ~5.7 @ 800 dpi.) Raw, unsmoothed; Game scales `sensitivity` by Weapons.sensScale while scoped,
    // from `baseSensitivity`. Default 2.0; `?sens=1.2` overrides it (and is remembered in localStorage['cs2.sens']),
    // otherwise the stored value applies. `__game.cheats.sens(v)` sets + persists it at runtime.
    this.setSensitivity(Input.initialSensitivity());
    this.enabled = false;
    // Automation (`navigator.webdriver` / `?nolock=1`): main.js never requests the real pointer lock — on Windows Chromium
    // implements it by hiding + confining + re-centring the OS cursor, so a headless test run would yank the user's real
    // mouse. Instead it sets this, and `locked` reports true so synthetic events drive the game exactly as a real lock would.
    this.forceLocked = false;

    addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      // Swallow the browser's default for every game key while we own the input (pointer-locked), and for ANY key that
      // arrives with a modifier held: Ctrl is the walk key, so Ctrl+W / Ctrl+S / Ctrl+D / Ctrl+1 are normal gameplay, not
      // "close tab / save page / bookmark / switch tab". Chromium still reserves Ctrl+W, Ctrl+T, Ctrl+N and Ctrl+1..8 unless
      // the page is fullscreen with `navigator.keyboard.lock()` (main.js goes fullscreen on start; _syncKeyboardLock issues
      // the lock on fullscreenchange); everything else this does block.
      if (Input.GAME_KEYS.has(e.code) || e.ctrlKey || e.altKey || e.metaKey) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    // Keyboard lock (Chromium; only takes effect while the page is fullscreen — main.js requests that on start): keeps
    // Ctrl+W & co. in the game instead of the browser. `fullscreenchange` is the reliable moment; `pointerlockchange` is
    // the fallback for a lock acquired while already fullscreen. Escape is deliberately NOT locked, so one Esc still exits.
    document.addEventListener('fullscreenchange', () => this._syncKeyboardLock());
    document.addEventListener('pointerlockchange', () => this._syncKeyboardLock());
    addEventListener('blur', () => { this.keys.clear(); this.mouseDown.clear(); });
    dom.addEventListener('mousemove', (e) => {
      if (!this.enabled || !this.locked) return;
      this.mouseDX += e.movementX; this.mouseDY += e.movementY;
    });
    dom.addEventListener('mousedown', (e) => { if (!this.enabled) return; this.mouseDown.add(e.button); this.mousePressed.add(e.button); e.preventDefault(); });
    addEventListener('mouseup', (e) => this.mouseDown.delete(e.button));
    dom.addEventListener('wheel', (e) => { if (this.enabled) this.wheel += Math.sign(e.deltaY); }, { passive: true });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** CS2 sensitivity number -> rad/px for both the base (unscoped) value and the live one; persists when `store` is set. */
  setSensitivity(cs2, store = false) {
    const v = Number(cs2);
    if (!Number.isFinite(v) || v <= 0) return this.cs2Sensitivity;
    this.cs2Sensitivity = v;
    this.baseSensitivity = this.sensitivity = v * 0.022 * Math.PI / 180;
    if (store) { try { localStorage.setItem(Input.SENS_KEY, String(v)); } catch { /* storage blocked: session only */ } }
    return v;
  }

  /** Start-up value: URL `?sens=` (also written to storage) > localStorage > 2.0. */
  static initialSensitivity(search = location.search) {
    const parse = (s) => { const v = parseFloat(s); return Number.isFinite(v) && v > 0 ? Math.min(20, v) : null; };
    const url = parse(new URLSearchParams(search).get('sens'));
    if (url !== null) { try { localStorage.setItem(Input.SENS_KEY, String(url)); } catch { /* ignore */ } return url; }
    try { const stored = parse(localStorage.getItem(Input.SENS_KEY)); if (stored !== null) return stored; } catch { /* ignore */ }
    return 2.0;
  }

  get locked() { return this.forceLocked || document.pointerLockElement === this.dom; }
  /**
   * Hold the browser's reserved shortcuts (Ctrl+W, Ctrl+1..) while fullscreen or pointer-locked; release otherwise. No-op
   * without navigator.keyboard (Firefox) and under automation (webdriver / forceLocked): keyboard lock is an OS-level grab too.
   */
  _syncKeyboardLock() {
    if (navigator.webdriver || this.forceLocked) return;
    const kb = navigator.keyboard;
    if (!kb || typeof kb.lock !== 'function') return;
    if (document.fullscreenElement || this.locked) {
      const p = kb.lock([...Input.GAME_KEYS]);
      if (p && typeof p.catch === 'function') p.catch(() => { /* unsupported here: the preventDefault above still applies */ });
    } else if (typeof kb.unlock === 'function') kb.unlock();
  }
  down(code) { return this.keys.has(code); }
  justPressed(code) { return this.pressed.has(code); }
  /** Is any key bound to this action (see Input.BINDS) held? Consumers read actions, not key codes, so a rebind is one edit here. */
  action(name) {
    const codes = Input.BINDS[name];
    for (let i = 0; i < codes.length; i++) if (this.keys.has(codes[i])) return true;
    return false;
  }
  mouse(b) { return this.mouseDown.has(b); }
  mouseJustPressed(b) { return this.mousePressed.has(b); }

  /** Read and clear accumulated mouse deltas. */
  consumeMouse() {
    const dx = this.mouseDX, dy = this.mouseDY;
    this.mouseDX = 0; this.mouseDY = 0;
    return { dx, dy };
  }
  /** Call at the END of each frame. */
  endFrame() { this.pressed.clear(); this.mousePressed.clear(); this.wheel = 0; }
}
Input.SENS_KEY = 'cs2.sens';
/**
 * Action -> key codes. This is the ONE place a binding lives; Player / Cheats ask `input.action('crouch')` etc.
 * Shift = crouch and Ctrl = slow walk (the reverse of the CS2 default), both left and right variants. Noclip fly keeps
 * Space / Ctrl = up / down and Shift = 3x speed (Player._fly ignores the stance, so crouch never fights it).
 */
Input.BINDS = Object.freeze({
  crouch: ['ShiftLeft', 'ShiftRight', 'KeyC'],
  walk: ['ControlLeft', 'ControlRight'],
  flyUp: ['Space'],
  flyDown: ['ControlLeft', 'ControlRight'],
  flyFast: ['ShiftLeft', 'ShiftRight'],
});
/** Every key the game reads (movement + the raw codes Weapons / Bomb check); their browser defaults are suppressed while locked. */
Input.GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'Tab', 'KeyC', 'KeyE', 'KeyR', 'KeyQ', 'Digit1', 'Digit2', 'Digit3',
  ...Object.values(Input.BINDS).flat(),
]);
