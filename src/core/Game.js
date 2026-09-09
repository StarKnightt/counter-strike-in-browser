import * as THREE from 'three';
import { RENDER } from './Constants.js';
import { RenderScale } from './RenderScale.js';
import { assignDepthMaterials } from '../level/ShadowDepth.js';
import { installStablePCF } from '../level/ShadowFilter.js';
import { bus, Events } from './EventBus.js';
import { MapLoader } from '../level/MapLoader.js';
import { DesertSky } from '../level/Sky.js';
import { Dust } from '../level/Dust.js';
import { Atmosphere } from '../level/Atmosphere.js';
import { Decals } from '../level/Decals.js';
import { FlyCamera } from '../systems/FlyCamera.js';
import { Input } from '../systems/Input.js';
import { Player } from '../gameplay/Player.js';
import { ViewModel } from '../gameplay/ViewModel.js';
import { Weapons } from '../gameplay/Weapons.js';
import { Shells } from '../fx/Shells.js';
import { Particles } from '../fx/Particles.js';
import { Impacts } from '../fx/Impacts.js';
import { Combat } from '../gameplay/Combat.js';
import { Spotter } from '../gameplay/Spotter.js';
import { BotManager } from '../ai/BotManager.js';
import { PostFX } from '../fx/PostFX.js';
import { Bomb } from '../gameplay/Bomb.js';
import { Round } from '../gameplay/Round.js';
import { state } from './GameState.js';
import { HUD } from '../ui/HUD.js';
import { Audio } from '../systems/Audio.js';
import { Sfx } from '../systems/Sfx.js';

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.bus = bus; this.Events = Events; this.state = state;   // same instances for debug/test scripts
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    // adaptive render scale (independent of DPR): 1.25 to start, 1.0..1.5 by GPU frame time (see RenderScale); ?scale= pins it
    this.scale = new RenderScale(this.renderer, { min: RENDER.MIN_PIXEL_RATIO, max: RENDER.MAX_PIXEL_RATIO, start: RENDER.START_PIXEL_RATIO, override: RenderScale.fromUrl(), onChange: () => this._resize() });
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = RENDER.EXPOSURE;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;   // PCFSoftShadowMap is deprecated and falls back to this anyway
    // three r185's PCF rotates its taps per screen pixel (a TAA-style noise we cannot average out): every penumbra and every
    // grazing-lit wall shimmered while moving. Fixed disk + receiver-plane bias instead; must precede the first material compile.
    installStablePCF();
    // The 4096² sun map is re-rendered only when a caster or the snapped sun frustum changed (see _shadowDirty in _frame). With
    // autoUpdate, three rendered it on every scene render: twice per frame here (RenderPass + GTAO's normal pre-pass).
    this.renderer.shadowMap.autoUpdate = false;
    this._bombVisible = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this._vfov(), innerWidth / innerHeight, 0.05, 600);
    this.scene.add(this.camera);

    this.timer = new THREE.Timer();
    this.time = 0;
    this.stats = { frames: 0, t0: performance.now(), fps: 0 };

    addEventListener('resize', () => this._resize());
  }

  _vfov() {
    // keep a CS2-like horizontal FOV (~106° at 16:9 => vertical 90 gives 106 horizontal)
    return RENDER.FOV;
  }

  _resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.post?.setSize(innerWidth, innerHeight);
  }

  async init(onProgress) {
    this.sky = new DesertSky(this.scene, this.renderer);
    this.audio = new Audio(this);
    const audioLoad = this.audio.load();                     // decode the sound bank while the map streams in
    this.map = await new MapLoader(this.scene, this.renderer).load(onProgress);
    const texUpload = this._uploadTextures(this.map.root);   // ~690 MB of map textures go to the GPU in slices while the rest of the assets stream in
    this.dust = new Dust(this.scene, this.sky, this.camera);
    this.decals = await new Decals(this.scene).load(this.map.markers.decals);

    this.input = new Input(this.canvas);
    this.player = new Player(this.camera, this.map, this.input);
    this.player.spawn(this.map.markers.spawnCT || new THREE.Vector3(6, -3.5, 36), 0);

    this.vm = await new ViewModel(this.renderer, this.scene, this.camera).load();
    this.shells = new Shells(this.scene);
    this.weapons = new Weapons(this);
    this.particles = new Particles(this.scene);
    this.impacts = new Impacts(this.scene, this.particles, this.map);
    this.atmo = new Atmosphere(this);                        // birds, wire sway, litter, foot dust
    this.combat = new Combat(this);
    this.bomb = await new Bomb(this).load();
    this.bots = await new BotManager(this).load();
    this.spotter = new Spotter(this);                        // player-side "enemy spotted" perception (radio lines via Sfx)
    this.round = new Round(this);
    this.hud = new HUD(this);
    await audioLoad;
    this.sfx = new Sfx(this, this.audio);
    this.round.start();
    this.round.spawnPlayer();
    this.bots.spawnTeam();
    this.scopeEl = document.getElementById('scope');

    // debug fly camera for review screenshots (window.__view). Disabled during play.
    this.fly = new FlyCamera(this.camera, this.canvas);
    this.mode = 'play';
    assignDepthMaterials(this.scene);                        // stable per-caster shadow depth materials (see ShadowDepth.js); bots re-run it per spawn
    this.post = new PostFX(this.renderer, this.scene, this.camera);
    await texUpload;
    await this._warmShaders();

    bus.emit(Events.MAP_LOADED, this.map);
    this.timer.reset();                                      // first frame's dt starts here, not at construction
    // An exception escaping the callback ends setAnimationLoop for good (the game "freezes" on a black/first frame), so a
    // per-frame fault is logged (once per second per message) and the next frame still runs.
    this._frameErr = { last: '', t: 0 };
    this.renderer.setAnimationLoop(() => {
      try { this._frame(); } catch (e) {
        const now = performance.now(), key = String(e?.message ?? e);
        if (key !== this._frameErr.last || now - this._frameErr.t > 1000) { this._frameErr.last = key; this._frameErr.t = now; console.error('Game._frame:', e); }
      }
    });
    setTimeout(() => this.hud.radar.scan(), 0);              // 0.8 s height scan, sliced into idle time after the first frame
    return this;
  }

  /**
   * Upload (texImage2D + mipmaps) every texture under `root` in ~12 ms slices between tasks, so the upload overlaps the
   * remaining asset fetches/decodes instead of landing inside the first rendered frame (~0.2 s CPU; first post frame
   * 0.8 s -> 0.4 s). stats.upload = { n, busyMs, wallMs } for the perf scripts.
   */
  async _uploadTextures(root) {
    const seen = new Set();
    root.traverse((o) => {
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) for (const k in m) { const t = m[k]; if (t && t.isTexture) seen.add(t); }
    });
    const list = [...seen]; let t0 = performance.now(), busy = 0; const tStart = t0;
    for (const t of list) {
      if (performance.now() - t0 > 12) { busy += performance.now() - t0; await new Promise((r) => setTimeout(r, 0)); t0 = performance.now(); }
      this.renderer.initTexture(t);
    }
    busy += performance.now() - t0;
    this.stats.upload = { n: list.length, busyMs: Math.round(busy), wallMs: Math.round(performance.now() - tStart) };
    return list.length;
  }

  /**
   * Compile every program the round can need while the loading overlay is still up, so nothing stalls mid-round:
   * pooled/hidden renderables (muzzle flashes, C4, the two holstered viewmodel weapons) are shown for one offscreen frame,
   * the scene is compiled (compileAsync = parallel shader compile), then a full post frame is rendered so the shadow-depth
   * variants, GTAO override and the composer passes compile too. The canvas is cleared in the same task, so nothing shows.
   *
   * Two details matter, both learned from a 100-460 ms stall on the first hit / the death cam (ANGLE/D3D11 compiles a
   * PBR program in ~140 ms, synchronously at first use — it showed up as gl.getProgramInfoLog inside post.render):
   *  - three compiles the variant for the *currently bound* render target (tone mapping / output colour space are part of
   *    the program key). The main scene is only ever drawn by the composer into the HDR target, so compile it with that
   *    target bound; with none bound the call produced ACES+sRGB canvas variants that nothing used. The viewmodel does
   *    draw to the canvas, so its compile stays as it was.
   *  - the post frames only draw what is inside the view/shadow frustum. Everything is un-culled for them, so the GTAO
   *    normal-override and shadow-depth variants of objects that are behind the player at spawn (the killer's rifle, the
   *    car, a multiply decal...) exist before the death cam swings round to them.
   */
  async _warmShaders() {
    const r = this.renderer, shown = [];
    const show = (o) => { if (o && !o.visible) { o.visible = true; shown.push(o); } };
    for (const f of this.bots.flashes) show(f.s);
    show(this.bomb.model); show(this.vm.flash);
    for (const w of Object.values(this.vm.weapons)) show(w.group);
    const culled = [];                                        // draw everything regardless of the frustum for these frames (see above)
    const uncull = (m) => { if ((m.isMesh || m.isPoints || m.isLine || m.isSprite) && m.frustumCulled) { m.frustumCulled = false; culled.push(m); } };
    this.scene.traverse(uncull); for (const o of shown) o.traverse(uncull);
    this.camera.updateMatrixWorld(); this.scene.updateMatrixWorld(true);
    this.dust.update(0);                                      // motes sample the sun shadow map: hidden until it exists (else sampler2DShadow binds a colour texture)
    this.vm.update(0, { player: this.player, mouseDX: 0, mouseDY: 0, scoped: false, holster: false });   // gives the viewmodel scene its environment map first: envMap is part of the program key, so without this every viewmodel material compiled twice (once here, again in the first frame)
    const t = [performance.now()], lap = () => t.push(performance.now());
    const progs = () => r.info.programs.length;
    try {
      r.setRenderTarget(this.post.composer.renderTarget1);    // main scene: the HDR-target variants are the ones the RenderPass uses
      await r.compileAsync(this.scene, this.camera); lap();
      r.setRenderTarget(null);
      await r.compileAsync(this.vm.scene, this.vm.camera); lap();
      const n0 = progs();
      r.autoClear = true; r.shadowMap.needsUpdate = true; this.post.render(0); lap();   // textures upload + shadow/GTAO variants compile; creates the shadow map
      this.dust.update(0); r.shadowMap.needsUpdate = true; this.post.render(0); lap();  // second frame: dust motes (now the shadow map exists) — cheap, everything is resident
      // third frame looking into the sun: SunShaftsPass only draws (so only compiles its mask + blur programs) while the sun is on
      // screen, which otherwise happened mid-round the first time the player turned toward it (65 -> 67 programs, a hitch)
      const camQ = this.camera.quaternion.clone();
      this.camera.lookAt(this.sky.sunDir.clone().add(this.camera.position)); this.camera.updateMatrixWorld();
      this.post.render(0); this.camera.quaternion.copy(camQ); this.camera.updateMatrixWorld(); lap();
      r.autoClear = false; this.vm.render(); r.autoClear = true; lap();
      this.stats.warmSync = progs() - n0;                     // programs that still compiled synchronously inside the warm frames (perf scripts; 0 = fully parallel)
    } catch (e) { console.warn('shader warm-up', e); }
    this.stats.warm = t.slice(1).map((x, i) => Math.round(x - t[i])); this.stats.warmProgs = progs();
    r.setRenderTarget(null); r.clear();
    for (const o of shown) o.visible = false;
    for (const m of culled) m.frustumCulled = true;
    this.vm.setActive(this.weapons.current);
  }

  /**
   * Does the sun shadow map need re-rendering this frame? Casters are the static map, the bots (+ rifles, dropped rifles) and
   * the planted C4; everything else that moves (shells, particles, litter, wires) casts no shadow. So: the snapped sun frustum
   * moved, a bot animated / is still falling, a dropped rifle is still in the air, or the C4 appeared/disappeared.
   * Anything else (freeze time with no bots in view, explore mode standing still) reuses last frame's map exactly.
   */
  _shadowDirty(sunMoved) {
    let dirty = sunMoved || this.time < 0.2;
    if (this.bots.shadowDirty) dirty = true;
    const bv = !!(this.bomb.model && this.bomb.model.visible);
    if (bv !== this._bombVisible) { this._bombVisible = bv; dirty = true; }
    return dirty;
  }

  _frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.scale.begin();
    this.time += dt;
    if (this.mode === 'fly') {
      this.fly.enabled = true; this.player.enabled = false; this.fly.update(dt);
    } else {
      this.fly.enabled = false;
      this.player.enabled = this.input.locked;
      this.input.enabled = this.input.locked;
      this.input.sensitivity = this.input.baseSensitivity * this.weapons.sensScale;   // base = ?sens / stored / cheats.sens(); Weapons scales it while scoped
      this.player.update(dt);
      this.weapons.update(dt);
      // scope FOV (snappy like CS2) + overlay; the ADS blend is already eased by Weapons, so it is applied as is (keeps the
      // viewmodel pose and the camera in lock-step). A FOV change only rebuilds the projection matrix: no shader recompile.
      const fovT = this.weapons.fovTarget;
      if (Math.abs(this.camera.fov - fovT) > 0.01) { this.camera.fov = this.weapons.fovSnap ? fovT : this.camera.fov + (fovT - this.camera.fov) * (1 - Math.exp(-dt * 22)); this.camera.updateProjectionMatrix(); }
      this.scopeEl.classList.toggle('hidden', !this.weapons.scope);
    }
    this.input.endFrame();
    this.round.update(dt);
    if (this.mode === 'play' || this.botsInFly) this.bots.update(dt);
    else this.bots.updateDropped(dt);                          // fly cam freezes the AI, not a rifle that is still falling
    if (this.mode === 'play') this.spotter.update(dt);
    this.bomb.update(dt);
    this.hud.update(dt);
    const sunMoved = this.sky.follow(this.camera.position);
    this.renderer.shadowMap.needsUpdate = this._shadowDirty(sunMoved);
    this.dust.update(this.time);
    this.atmo.update(dt);
    this.shells.update(dt);
    this.particles.update(dt);
    this.impacts.update(dt);
    this.camera.updateMatrixWorld();
    this.sfx.update(dt);
    const wp = this.weapons;
    this.vm.update(dt, { player: this.player, mouseDX: this.player.lastMouse.x, mouseDY: this.player.lastMouse.y, scoped: wp.scope > 0, ads: wp.ads, punch: wp.aimPunch, punchTrack: wp.viewTrack, holster: state.player.defusing || state.player.planting || state.phase === 'over' });

    this.renderer.autoClear = true;
    this.post.render(dt);
    if (this.mode === 'play') {
      this.renderer.autoClear = false;
      this.vm.render();
      this.renderer.autoClear = true;
    }
    this.scale.end(dt);

    const st = this.stats; st.frames++;
    const now = performance.now();
    if (!st.firstFrame) st.firstFrame = now;                   // time-to-first-frame (perf scripts)
    if (now - st.t0 > 1000) { st.fps = st.frames * 1000 / (now - st.t0); st.frames = 0; st.t0 = now; }
  }
}
