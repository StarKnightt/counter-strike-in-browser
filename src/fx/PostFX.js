import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { SUN } from '../core/Constants.js';

/**
 * Scene post pipeline: MSAA HDR render -> GTAO (contact/corner occlusion the single sun+hemi rig
 * cannot produce) -> HDR bloom (sun glow/disc, muzzle flash, C4 blast; threshold above lit plaster) -> ACES/sRGB
 * -> grade (S-curve contrast, saturation, depth-driven aerial desaturation off GTAO's depth, cool-shadow / warm-highlight split-tone,
 * vignette, grain). The viewmodel is drawn on top afterwards by Game.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, time: { value: 0 },
    tShafts: { value: null }, shafts: { value: 0 },                 // half-res sun-shaft buffer (SunShaftsPass), pre-weighted
    texel: { value: new THREE.Vector2(1 / 1600, 1 / 900) }, sharpen: { value: 0.16 },   // unsharp mask: textures read crisp at 1080p without ringing
    contrast: { value: 0.32 },                                    // S-curve strength (smoothstep blend: steeper mids, ends pinned => no clipping)
    saturation: { value: 0.98 }, vignette: { value: 0.20 }, grain: { value: 0.014 },   // was 1.16: with the cooler sun + greyer floor albedo the plaza sits at ~half its old chroma; accents (shutters, signs) keep theirs
    lift: { value: new THREE.Vector3(-0.006, 0.002, 0.024) },     // cool (skylight) shadows against the warm sun
    midTint: { value: new THREE.Vector3(1.0, 1.0, 1.0) },         // neutral midtones (the warmth lives in the sun colour + highlights, not in a global tint)
    gainTint: { value: new THREE.Vector3(1.0, 0.99, 0.965) },     // warm highlights (low sun)
    flash: { value: 0 },
    // aerial perspective: depth-driven desaturation (the fog already pulls far colour toward the haze; this removes the
    // remaining chroma so 150 m rooftops sit at ~1/4 of the near chroma). tDepth = GTAO's scene depth (its own G-buffer, or
    // the composer target's DepthTexture with ?ao=depth). Depth 1.0 = sky (the dome does not write depth): untouched.
    tDepth: { value: null }, cameraNear: { value: 0.05 }, cameraFar: { value: 600 },
    desat: { value: SUN.FOG_DESAT }, desatRange: { value: new THREE.Vector2(25, 150) },   // metres: none below 25, full at 150
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tShafts, tDepth; uniform float time, contrast, saturation, vignette, grain, flash, shafts, sharpen, cameraNear, cameraFar, desat; uniform vec3 lift, midTint, gainTint; uniform vec2 texel, desatRange;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + time * 0.37) * 43758.5453); }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // view distance from the (non-linear) depth buffer
      float zb = texture2D(tDepth, vUv).x;
      float dist = (cameraNear * cameraFar) / (cameraFar - zb * (cameraFar - cameraNear));
      float far = smoothstep(desatRange.x, desatRange.y, dist) * step(zb, 0.99999) * desat;
      // unsharp mask (cross kernel): lifts texture micro-contrast lost to MSAA resolve + trilinear filtering
      vec3 blur = 0.25 * (texture2D(tDiffuse, vUv + vec2(texel.x, 0.0)).rgb + texture2D(tDiffuse, vUv - vec2(texel.x, 0.0)).rgb
                        + texture2D(tDiffuse, vUv + vec2(0.0, texel.y)).rgb + texture2D(tDiffuse, vUv - vec2(0.0, texel.y)).rgb);
      c += clamp((c - blur) * sharpen, -0.04, 0.04);
      // sun shafts (screen-space radial blur of the sky around the sun; already masked by geometry depth)
      if (shafts > 0.0) c += texture2D(tShafts, vUv).rgb * shafts;
      c = clamp(c, 0.0, 1.0);                                       // the S-curve below goes negative above 1.5
      // filmic S-curve on top of ACES: pushes mids apart, keeps 0 and 1 where they are
      c = mix(c, c * c * (3.0 - 2.0 * c), contrast);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, saturation * (1.0 - far));              // far: aerial-perspective desaturation (see tDepth)
      float mid = 4.0 * l * (1.0 - l);                              // 1 at 50 % grey, 0 at black/white
      c *= mix(vec3(1.0), midTint, mid);
      c = c * mix(vec3(1.0), gainTint, l) + lift * (1.0 - l) * (1.0 - l);
      float d = distance(vUv, vec2(0.5));
      c *= 1.0 - vignette * smoothstep(0.38, 0.95, d);
      c += (hash(vUv * vec2(1920.0, 1080.0)) - 0.5) * grain * (1.0 - l * 0.6);
      c = mix(c, vec3(1.0, 0.97, 0.9), flash);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

/**
 * Cheap "god rays": mask = sky pixels weighted by proximity to the sun's screen position, then a radial blur toward
 * the sun. Half resolution, two small passes, no swap: the result is sampled by the grade pass. Only visible when the
 * sun is on/near the screen edge; occluded by geometry. "Sky" is read from the HDR target's alpha (the sky dome writes
 * alpha 0, everything else 1 — see Sky.js): MSAA-resolved, so silhouettes give a soft, exact mask. A resolved depth
 * buffer cannot do this: it carries one sample per pixel, and the leaked "sky" edge pixels streak into halos.
 */
class SunShaftsPass extends Pass {
  constructor(camera, sunDir, w, h) {
    super();
    this.camera = camera; this.sunDir = sunDir.clone().normalize(); this.needsSwap = false;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.rtA = new THREE.WebGLRenderTarget(w, h, opts); this.rtB = new THREE.WebGLRenderTarget(w, h, opts);
    this.sunUv = new THREE.Vector2(0.5, 0.5); this.strength = 0;
    this.maskMat = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null }, uSun: { value: this.sunUv }, uAspect: { value: w / h }, uColor: { value: new THREE.Color(1.0, 0.86, 0.66) } },
      vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tColor; uniform vec2 uSun; uniform float uAspect; uniform vec3 uColor; varying vec2 vUv;
        void main(){
          float sky = 1.0 - texture2D(tColor, vUv).a;
          float r = length((vUv - uSun) * vec2(uAspect, 1.0));
          gl_FragColor = vec4(uColor * sky * smoothstep(0.75, 0.0, r), 1.0);
        }`,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tMask: { value: this.rtA.texture }, uSun: { value: this.sunUv } },
      vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tMask; uniform vec2 uSun; varying vec2 vUv;
        const int N = 28;
        void main(){
          vec2 uv = vUv; vec2 step = (uSun - vUv) * (0.85 / float(N));
          vec3 acc = vec3(0.0); float w = 1.0, wsum = 0.0;
          for (int i = 0; i < N; i++) { uv += step; acc += texture2D(tMask, uv).rgb * w; wsum += w; w *= 0.955; }
          gl_FragColor = vec4(acc / wsum, 1.0);
        }`,
    });
    this.quad = new FullScreenQuad(this.maskMat);
    this._v = new THREE.Vector3();
  }

  setSize(w, h) { this.rtA.setSize(w, h); this.rtB.setSize(w, h); this.maskMat.uniforms.uAspect.value = w / h; }

  /** Projects the sun; strength fades to 0 as it leaves the screen (with margin) or goes behind the camera. */
  updateSun() {
    const behind = this.camera.getWorldDirection(this._v).dot(this.sunDir) < 0.05;   // projecting a point behind the eye flips it: gate first
    const v = this._v.copy(this.sunDir).multiplyScalar(100).add(this.camera.position).project(this.camera);
    this.sunUv.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
    const dx = Math.max(0, Math.abs(v.x) - 1), dy = Math.max(0, Math.abs(v.y) - 1);
    this.strength = behind ? 0 : 1 - THREE.MathUtils.smoothstep(Math.max(dx, dy), 0.05, 0.9);
    return this.strength;
  }

  render(renderer, writeBuffer, readBuffer) {
    if (this.strength <= 0) return;                      // PostFX.render calls updateSun() right before the composer
    this.maskMat.uniforms.tColor.value = readBuffer.texture;   // scene colour after GTAO (alpha survives its copy/blend)
    renderer.setRenderTarget(this.rtA); this.quad.material = this.maskMat; this.quad.render(renderer);
    renderer.setRenderTarget(this.rtB); this.quad.material = this.blurMat; this.quad.render(renderer);
  }

  dispose() { this.rtA.dispose(); this.rtB.dispose(); this.maskMat.dispose(); this.blurMat.dispose(); this.quad.dispose(); }
}

/**
 * Pipeline options. Defaults are the shipped look; the URL can override them for A/B work (?aa=msaa|smaa|none, ?ao=depth|normal,
 * ?aoscale=1, ?aosamples=6, ?shaftscale=1).
 *  aa   'msaa'  4x MSAA on the HDR target | 'smaa' post AA after tone mapping | 'none'. SMAA breaks up sub-pixel trim lines
 *               that MSAA resolves (and crawls in motion): not shipped.
 *  ao   'normal' GTAO renders its own normal+depth G-buffer (~200 draws, 0.7 ms) | 'depth' GTAO reads the main pass depth and
 *               derives normals from it. With MSAA the depth must be resolved into the DepthTexture every frame, which on
 *               ANGLE/D3D11 costs more (+0.8 ms net) than the pre-pass it removes; 'depth' only pays off with aa=smaa|none.
 *  aoScale 0.75: GTAO + denoise at 3/4 res (-1.2 ms GPU at 1080p); the Poisson denoise hides the upsample — diff vs 1.0 is
 *               <1% of pixels by >16/255, all on 1-px creases. shaftScale 0.5: mask + radial blur at half res (identical output).
 */
const DEFAULTS = { aa: 'msaa', ao: 'normal', aoScale: 0.75, aoSamples: 10, shaftScale: 0.5 };
function optionsFromUrl() {
  const o = { ...DEFAULTS };
  try {
    const q = new URLSearchParams(location.search);
    if (['msaa', 'smaa', 'none'].includes(q.get('aa'))) o.aa = q.get('aa');
    if (['depth', 'normal'].includes(q.get('ao'))) o.ao = q.get('ao');
    if (q.get('aoscale') > 0) o.aoScale = Math.min(1, +q.get('aoscale'));
    if (q.get('shaftscale') > 0) o.shaftScale = Math.min(1, +q.get('shaftscale'));
    if (q.get('aosamples') > 0) o.aoSamples = Math.round(+q.get('aosamples'));
  } catch { /* no window */ }
  return o;
}

/**
 * GTAO fed by the main pass's depth instead of its own normal+depth G-buffer render. EffectComposer swaps its two
 * targets an odd number of times per frame here, so the scene lands in renderTarget1 and renderTarget2 on alternate
 * frames: the depth to read is always the current readBuffer's (each target owns a DepthTexture; the composer keeps
 * them sized). Normals are reconstructed from depth inside the GTAO shader (NORMAL_VECTOR_TYPE 0).
 */
class DepthGTAOPass extends GTAOPass {
  constructor(scene, camera, w, h) {
    super(scene, camera, w, h);
    // r185 GTAOPass throws when the G-buffer is passed to the constructor (reads normalRenderTarget before it exists): set it after
    this.setGBuffer(new THREE.DepthTexture(1, 1)); this.normalRenderTarget.dispose();
  }
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const d = readBuffer.depthTexture;
    if (d && d !== this.depthTexture) { this.depthTexture = d; this.gtaoMaterial.uniforms.tDepth.value = d; this.pdMaterial.uniforms.tDepth.value = d; this.onDepthTexture?.(d); }
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}

export class PostFX {
  constructor(renderer, scene, camera, options = optionsFromUrl()) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.enabled = true; this.options = options;
    const css = renderer.getSize(new THREE.Vector2()), pr = renderer.getPixelRatio();
    const size = css.clone().multiplyScalar(pr).floor();
    // scene depth as a texture (ao='depth'): GTAO reads it, so no second geometry pass is needed. With MSAA the depth is
    // resolved into it by blit (one sample per pixel: fine for AO, not for a sky mask — the sun shafts use alpha instead).
    // The composer clones the target (and its DepthTexture) for its second buffer.
    const depthTexture = options.ao === 'depth' ? new THREE.DepthTexture(size.x, size.y, THREE.FloatType) : null;
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: options.aa === 'msaa' ? 4 : 0, ...(depthTexture && { depthTexture }) });
    this.composer = new EffectComposer(renderer, target);
    // EffectComposer takes the target's *device* size as its CSS size, so setPixelRatio alone would square the ratio (3000 px wide at 1.25)
    this.composer.setPixelRatio(pr); this.composer.setSize(css.x, css.y);
    this.composer.addPass(new RenderPass(scene, camera));
    this.aoScale = options.aoScale;                       // AO resolution relative to the render target
    this.ao = new (depthTexture ? DepthGTAOPass : GTAOPass)(scene, camera, Math.floor(size.x * this.aoScale), Math.floor(size.y * this.aoScale));
    this.ao.output = GTAOPass.OUTPUT.Default;
    this.ao.blendIntensity = 1.0;
    // tighter radius + higher scale: firm contact darkening at wall bases / under crates (baked-AO look), no wide grey halos
    this.ao.updateGtaoMaterial({ radius: 1.1, distanceExponent: 1.4, thickness: 1.3, scale: 3.0, samples: options.aoSamples, distanceFallOff: 1.0, screenSpaceRadius: false });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 16 });
    this.composer.addPass(this.ao);
    // sun shafts: mask + radial blur off the scene's sky alpha (no extra geometry pass); composited in the grade
    this.shaftScale = options.shaftScale;
    this.shafts = new SunShaftsPass(camera, new THREE.Vector3(...SUN.DIR), Math.floor(size.x * this.shaftScale), Math.floor(size.y * this.shaftScale));
    this.composer.addPass(this.shafts);
    // HDR bloom (pre-tonemap, linear): threshold sits above lit plaster (~1.5-2.5) so only the sun glow / disc,
    // muzzle flashes and the C4 blast bleed — the sky glows near the sun, walls stay crisp
    this.bloom = new UnrealBloomPass(new THREE.Vector2(Math.floor(size.x / 2), Math.floor(size.y / 2)), 0.42, 0.55, 2.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    if (options.aa === 'smaa') { this.smaa = new SMAAPass(); this.composer.addPass(this.smaa); }   // on the tone-mapped image, before the grade's sharpen/grain
    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.tShafts.value = this.shafts.rtB.texture;
    this.grade.uniforms.cameraNear.value = camera.near; this.grade.uniforms.cameraFar.value = camera.far;
    this.grade.uniforms.tDepth.value = this.ao.depthTexture;      // ao='depth': the texture alternates with the composer buffers — DepthGTAOPass re-points it
    this.ao.onDepthTexture = (d) => { this.grade.uniforms.tDepth.value = d; };
    this.shaftStrength = 0.26;
    this.composer.addPass(this.grade);
    this.time = 0;
    this.setSize(css.x, css.y);                           // addPass sized every pass to the full target: apply the AO/bloom/shaft scales
  }

  setSize(w, h) {
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);                    // the render scale can change at runtime (RenderScale)
    this.composer.setSize(w, h);
    this.ao.setSize(Math.floor(w * pr * this.aoScale), Math.floor(h * pr * this.aoScale));
    this.bloom.setSize(Math.floor(w * pr), Math.floor(h * pr));          // UnrealBloomPass halves internally: half-res mip chain (the tuned look)
    this.shafts.setSize(Math.floor(w * pr * this.shaftScale), Math.floor(h * pr * this.shaftScale));
    this.grade.uniforms.texel.value.set(1 / Math.floor(w * pr), 1 / Math.floor(h * pr));
  }

  /** White-out strength (0..1) for the C4 blast; decays in Game. */
  setFlash(v) { this.grade.uniforms.flash.value = v; }

  render(dt = 1 / 60) {
    if (!this.enabled) { this.renderer.render(this.scene, this.camera); return; }
    this.time += dt; this.grade.uniforms.time.value = this.time;
    this.grade.uniforms.shafts.value = this.shaftStrength * this.shafts.updateSun();
    this.composer.render();
  }
}
