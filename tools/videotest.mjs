// Final "video test": records a full scripted CT round (advance, hold an angle, fight, defuse/end)
// with Playwright's video recorder, then converts to mp4 and dumps a contact sheet of frames for review.
// usage: node tools/videotest.mjs [outdir]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const out = process.argv[2] || 'C:/Code/cs2-dust2/_shots/video';
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); else if (m.text().startsWith('[demo]')) console.log(m.text()); });
await page.goto('http://localhost:5188/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.bots && window.__game.round, null, { timeout: 120000 });
await page.waitForTimeout(800);

// ---- install the scripted CT ("demo player") in-page
await page.evaluate(() => {
  const g = window.__game; const st = g.state;
  document.getElementById('overlay')?.classList.add('hidden');
  g.mode = 'play'; g.input.enabled = true;
  Object.defineProperty(g.input, 'locked', { get: () => true });
  g.audio?.ctx?.resume?.();
  g.round.noAutoRestart = true;

  const nav = g.bots.nav; const pl = g.player; const inp = g.input;
  const V = (x, y, z) => pl.position.clone().set(x, y, z);
  const D2R = Math.PI / 180;
  const yawTo = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z));
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

  const demo = {
    t: 0, route: ['ramp_bot', 'ramp_mid', 'ramp_top', 'goose'], ri: 0, phase: 'freeze',
    holdPos: (nav.cover.goose_peek ? nav.cover.goose_peek.pos.clone().add(V(-nav.cover.goose_peek.dir.z, 0, nav.cover.goose_peek.dir.x).multiplyScalar(-1.5)) : V(12.4, 0, -9.2)), sweep: [86, 139], sweepT: 0, sweepDir: 1,
    target: null, seenT: 0, lostT: 0, burst: 0, burstGap: 0, shots: 0, kills: 0, reactT: 0,
    noiseSeed: Math.random() * 100, defuseWalk: false, log: (m) => console.log('[demo] ' + (demo.t | 0) + 's ' + m),
  };
  window.__demo = demo;
  const bus = g.bus, Ev = g.Events;
  bus.on(Ev.PLAYER_DAMAGE, (e) => { if (e.attacker && e.attacker.alive) { demo.suspect = e.attacker; demo.suspectT = 1.6; if (!demo.target) demo.log('shot by ' + e.attacker.name + ', turning'); } });
  bus.on(Ev.KILL, (e) => { if (e.killer === 'player' || e.killer === g.state.playerName) demo.kills++; demo.log('kill ' + e.killer + ' -> ' + e.victim + (e.headshot ? ' (HS)' : '')); });

  const eye = () => pl.getEye(pl.position.clone());
  const dir = pl.position.clone(); const tmp = pl.position.clone();
  const lastPos = new Map();
  function botVel(b) {   // per-frame finite-difference velocity, smoothed
    let r = lastPos.get(b); if (!r) { r = { p: b.position.clone(), v: b.position.clone().set(0, 0, 0), t: performance.now() }; lastPos.set(b, r); }
    const now = performance.now(); const dtv = (now - r.t) / 1000;
    if (dtv > 0.03) { const v = b.position.clone().sub(r.p).multiplyScalar(1 / dtv); r.v.lerp(v, 0.5); r.p.copy(b.position); r.t = now; }
    return r.v;
  }
  function visibleBot(prefer) {
    const from = eye(); let best = null, bd = Infinity;
    const order = prefer && prefer.alive ? [prefer, ...g.bots.bots.filter((b) => b !== prefer)] : g.bots.bots;
    for (const b of order) {
      if (!b.alive) continue;
      if (best && b !== prefer) break;   // current target still visible: keep it
      // test chest, then head, then hips: a peeking bot may only show its head/shoulder
      let found = null;
      for (const hy of [1.02 - (b.crouch || 0) * 0.3, 1.62 - (b.crouch || 0) * 0.42, 0.7]) {
        tmp.copy(b.position); tmp.y += hy;
        dir.copy(tmp).sub(from); const L = dir.length(); dir.normalize();
        const f = pl.getForward(pl.position.clone()); if (f.dot(dir) < Math.cos(72 * D2R)) break;   // ~145 deg peripheral
        const h = g.weapons.raycast(from, dir, L + 0.5);
        if (h && h.entity === b) { found = { bot: b, pos: tmp.clone(), dist: L, vel: botVel(b) }; break; }
      }
      if (found && found.dist < bd) { bd = found.dist; best = found; if (b === prefer) break; }
    }
    return best;
  }
  const setKey = (k, on) => { if (on) inp.keys.add(k); else inp.keys.delete(k); };
  const press = (k) => { inp.pressed.add(k); };
  const KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];
  const stop = () => { for (const k of KEYS) inp.keys.delete(k); };
  /** Move toward a world point using WASD relative to the current view (lets us aim one way and run another). */
  function moveToward(to) {
    const f = pl.getForward(pl.position.clone()), r = pl.getRight(pl.position.clone());
    const d = to.clone().sub(pl.position).setY(0); if (d.lengthSq() < 1e-4) { stop(); return; } d.normalize();
    const fw = f.dot(d), rt = r.dot(d);
    setKey('KeyW', fw > 0.35); setKey('KeyS', fw < -0.35); setKey('KeyD', rt > 0.35); setKey('KeyA', rt < -0.35);
  }
  const aimAt = (p, rate, noise = 0) => {
    const from = eye(); const dy = yawTo(from, p); const dp = Math.atan2(p.y - from.y, Math.hypot(p.x - from.x, p.z - from.z));
    const n = demo.noiseSeed + demo.t * 7; const nz = (Math.sin(n) * 0.25 + Math.sin(n * 2.3) * 0.15) * noise;
    const k = 1 - Math.exp(-dt_ * rate);
    pl.yaw += wrap(dy + nz * D2R - pl.yaw) * k; pl.pitch += (dp + nz * 0.6 * D2R - pl.pitch) * k;
    return Math.hypot(wrap(dy - pl.yaw), dp - pl.pitch);
  };
  const aimYawPitch = (yaw, pitch, rate) => { const k = 1 - Math.exp(-dt_ * rate); pl.yaw += wrap(yaw - pl.yaw) * k; pl.pitch += (pitch - pl.pitch) * k; };

  let last = performance.now(); let dt_ = 0.016;
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now; demo.t += dt; dt_ = dt;
    requestAnimationFrame(tick);
    if (!st.player.alive || st.phase === 'over') { stop(); inp.mouseDown.delete(0); setKey('KeyE', false); return; }
    const wpn = g.weapons; const ammo = wpn.ammo;

    // ---------- perception (sticky target)
    const vis = visibleBot(demo.target?.bot);
    if (vis) {
      if (!demo.target) { demo.reactT = 0.16 + Math.random() * 0.12; demo.log('spotted ' + vis.bot.name + ' at ' + vis.dist.toFixed(0) + 'm'); }
      else if (demo.target.bot !== vis.bot) demo.log('switch to ' + vis.bot.name + ' at ' + vis.dist.toFixed(0) + 'm');
      demo.target = vis; demo.lostT = 0;
    } else if (demo.target) { demo.lostT += dt; if (demo.lostT > 0.5) { demo.target = null; inp.mouseDown.delete(0); demo.burst = 0; } }
    demo.reactT -= dt; demo.suspectT = (demo.suspectT || 0) - dt;
    // damage bookkeeping -> brief retreat when getting traded hard while holding
    demo.hpPrev ??= st.player.hp; demo.hpWin = (demo.hpWin || 0) * Math.exp(-dt / 1.5) + Math.max(0, demo.hpPrev - st.player.hp); demo.hpPrev = st.player.hp;
    demo.retreatT = (demo.retreatT || 0) - dt;
    if (demo.phase === 'hold' && demo.retreatT <= 0 && demo.hpWin > 30 && g.bots.alive.length > 1) { demo.retreatT = 1.6; demo.hpWin = 0; demo.log('taking damage, backing off'); }
    if (!demo.fallback && demo.phase === 'hold' && st.player.hp < 60 && g.bots.alive.length > 1 && !demo.target) { demo.fallback = true; demo.retreatT = 0; demo.log('hp ' + st.player.hp + ', rotating to triple'); }

    // ---------- where do we want to be?
    let moveTo = null, moveKind = 'route';
    const bombDown = st.bomb?.state === 'planted';
    if (st.phase === 'freeze') moveTo = null;
    else if (bombDown && (g.bots.alive.length === 0 || st.bombTime < 25)) { moveTo = V(st.bomb.position.x, st.bomb.position.y, st.bomb.position.z); moveKind = 'defuse'; if (!demo.defuseWalk) { demo.defuseWalk = true; demo.log('moving to defuse'); } }
    else if (demo.retreatT > 0) { const c = nav.cover.goose_peek; moveTo = c ? c.pos.clone().addScaledVector(c.dir, -2.2) : null; moveKind = 'retreat'; }
    else if (demo.fallback) {
      const fb = nav.cover.triple_peek; const fp = fb ? fb.pos.clone().addScaledVector(V(-fb.dir.z, 0, fb.dir.x), 0.6) : demo.holdPos;
      if (Math.hypot(fp.x - pl.position.x, fp.z - pl.position.z) > 0.5) { moveTo = fp; moveKind = 'fallback_walk'; }
      else if (demo.phase !== 'fallback') { demo.phase = 'fallback'; demo.log('set up at triple, watching site'); }
    }
    else if (demo.ri < demo.route.length) {
      const to = nav.pos(demo.route[demo.ri]);
      if (Math.hypot(to.x - pl.position.x, to.z - pl.position.z) < 1.4) { demo.ri++; demo.log('reached ' + demo.route[demo.ri - 1]); }
      if (demo.ri < demo.route.length) moveTo = nav.pos(demo.route[demo.ri]);
    }
    if (!moveTo && moveKind === 'route' && st.phase !== 'freeze') {
      const d = Math.hypot(demo.holdPos.x - pl.position.x, demo.holdPos.z - pl.position.z);
      if (d > 0.5) { moveTo = demo.holdPos; moveKind = 'hold_walk'; }
      else if (demo.phase !== 'hold') { demo.phase = 'hold'; demo.sweepT = 0; demo.log('holding goose'); }
    }

    // ---------- aim + fire
    let firing = false;
    if (demo.target && demo.reactT <= 0) {
      const far = demo.target.dist > 30;
      const lead = demo.target.pos.clone().addScaledVector(demo.target.vel, 0.09);   // lead a moving target by ~1 frame of lag + reaction
      const err = aimAt(lead, 16, 0.8);
      // weapon choice: AWP for long-range holds when we're set; AK otherwise
      if (far && wpn.current !== 'awp' && (wpn.inv.awp.mag + wpn.inv.awp.reserve) > 0 && demo.burst <= 0 && !moveTo && Math.random() < 0.03 && demo.phase === 'fallback') { press('Digit2'); demo.log('swap to AWP'); }
      if (!far && wpn.current === 'awp' && demo.target.dist < 18 && wpn.state === 'idle') { press('Digit1'); }
      const canShoot = !moveTo || demo.target.dist < 12;   // don't spray while running to cover unless it's close
      if (canShoot) {
        firing = true;
        if (wpn.current === 'awp') {
          if (!wpn.scope && err < 3 * D2R && wpn.state === 'idle') inp.mousePressed.add(2);
          if (wpn.scope && err < 0.7 * D2R && wpn.cooldown <= 0 && wpn.state === 'idle') { inp.mousePressed.add(0); demo.shots++; }
        } else {
          demo.burstGap -= dt;
          if (demo.burst > 0) { inp.mouseDown.add(0); demo.burst -= dt; if (demo.burst <= 0) { inp.mouseDown.delete(0); demo.burstGap = 0.26 + Math.random() * 0.2; } }
          else if (demo.burstGap <= 0 && err < (demo.target.dist > 20 ? 0.75 : 1.4) * D2R && ammo && ammo.mag > 0 && wpn.state === 'idle') { demo.burst = (demo.target.dist > 20 ? 0.14 : 0.24) + Math.random() * 0.16; demo.shots++; }
          if (ammo && ammo.mag === 0) { inp.mouseDown.delete(0); press('KeyR'); demo.burst = 0; }
        }
      } else { inp.mouseDown.delete(0); demo.burst = 0; }
    } else {
      inp.mouseDown.delete(0); demo.burst = 0;
      if (wpn.current === 'awp' && wpn.scope) inp.mousePressed.add(2), inp.mousePressed.add(2);
      if (ammo && ammo.mag < 12 && wpn.state === 'idle') press('KeyR');
      if (demo.suspect && demo.suspectT > 0 && demo.suspect.alive && st.phase !== 'freeze') {
        const sp = demo.suspect.position.clone(); sp.y += 1.2; aimAt(sp, 9, 0);
      } else if (st.phase === 'freeze') { pl.yaw += Math.sin(demo.t * 0.9) * dt * 0.35; pl.pitch += (0 - pl.pitch) * dt * 3; }
      else if (moveKind === 'defuse' && moveTo) {
        const d = Math.hypot(moveTo.x - pl.position.x, moveTo.z - pl.position.z);
        aimYawPitch(yawTo(pl.position, moveTo), (d > 1.3 ? -8 : -42) * D2R, 6);
      } else if (moveKind === 'retreat') { aimYawPitch(150 * D2R, -2 * D2R, 6); }
      else if (moveKind === 'fallback_walk' && moveTo) { aimYawPitch(yawTo(pl.position, moveTo), 0, 6); }
      else if (demo.phase === 'fallback') { aimYawPitch((95 + Math.sin(demo.t * 0.6) * 22) * D2R, (-3 + Math.sin(demo.t * 0.9)) * D2R, 4); }
      else if (moveTo) { aimYawPitch(yawTo(pl.position, moveTo), Math.sin(demo.t * 1.3) * 2 * D2R, 6); }
      else {
        // holding: slow sweep across long corner <-> stairs, small idle breathing, occasional crouch
        demo.sweepT += dt * 0.35 * demo.sweepDir; if (demo.sweepT > 1) { demo.sweepT = 1; demo.sweepDir = -1; } if (demo.sweepT < 0) { demo.sweepT = 0; demo.sweepDir = 1; }
        const sm = 0.5 - 0.5 * Math.cos(demo.sweepT * Math.PI);
        aimYawPitch((demo.sweep[0] + (demo.sweep[1] - demo.sweep[0]) * sm) * D2R, (Math.sin(demo.t * 0.7) * 1.5 - 1) * D2R, 4);
      }
    }

    // ---------- movement
    if (moveTo && !(firing && demo.target && demo.target.dist < 12)) {
      if (moveKind === 'defuse') {
        const d = Math.hypot(moveTo.x - pl.position.x, moveTo.z - pl.position.z);
        if (d > 1.3) { moveToward(moveTo); setKey('KeyE', false); } else { stop(); if (st.bomb.canDefuse || st.player.defusing) setKey('KeyE', true); }
      } else moveToward(moveTo);
      setKey('ControlLeft', false);
    } else {
      stop();
      setKey('ControlLeft', (demo.phase === 'hold' && !demo.target && Math.sin(demo.t * 0.5) > 0.85) || (demo.phase === 'fallback' && !demo.target));
    }
  }
  requestAnimationFrame(tick);
});

// ---- run the round
const t0 = Date.now();
let lastPhase = ''; let rounds = 1;
while (Date.now() - t0 < 170000) {
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => { const st = window.__game.state; return { phase: st.phase, alive: st.player.alive, hp: st.player.hp, bots: window.__game.bots.alive.length, t: st.roundTime | 0, bomb: st.bomb?.state, kills: window.__demo.kills, shots: window.__demo.shots, winner: st.winner }; });
  if (s.phase !== lastPhase) { console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] phase ${s.phase}`, JSON.stringify(s)); lastPhase = s.phase; }
  if (s.phase === 'over') {
    await page.waitForTimeout(6500);
    if (rounds >= 2 || Date.now() - t0 > 80000) break;
    rounds++;
    await page.evaluate(() => { const d = window.__demo; Object.assign(d, { ri: 0, phase: 'freeze', target: null, fallback: false, retreatT: 0, suspect: null, hpPrev: 100, hpWin: 0, defuseWalk: false, burst: 0, burstGap: 0 }); window.__game.round.restart(); d.log('--- round ' + window.__game.state.round); });
    lastPhase = '';
  }
}
const fin = await page.evaluate(() => { const st = window.__game.state; return { winner: st.winner, reason: st.winReason, score: st.score, hp: st.player.hp, shots: window.__demo.shots, botsAlive: window.__game.bots.alive.length }; });
console.log('final', JSON.stringify(fin));
if (errors.length) console.log('ERRORS', errors.slice(0, 8));
await ctx.close(); await browser.close();

// ---- convert + contact sheet
const webm = fs.readdirSync(out).find((f) => f.endsWith('.webm'));
if (webm) {
  const src = path.join(out, webm);
  try {
    execSync(`ffmpeg -y -loglevel error -i "${src}" -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p "${path.join(out, 'round.mp4')}"`);
    execSync(`ffmpeg -y -loglevel error -i "${src}" -vf "fps=1/4,scale=640:-1" "${path.join(out, 'f_%03d.jpg')}"`);
    execSync(`ffmpeg -y -loglevel error -i "${src}" -vf "fps=1/6,scale=426:-1,tile=4x5" "${path.join(out, 'sheet_%02d.jpg')}"`);
    console.log('video:', path.join(out, 'round.mp4'), 'frames:', fs.readdirSync(out).filter((f) => f.startsWith('f_')).length);
  } catch (e) { console.log('ffmpeg failed', e.message); }
}
