import * as THREE from 'three';
import { SUN } from '../core/Constants.js';

/**
 * Sun-lit dust motes: GPU points in a box that follows the camera (positions wrap in world space, so they
 * stay put as you walk), drifting on a slow wind. Each mote tests the sun's shadow map in the vertex shader
 * (one hardware compare per point) so motes only glitter where the sun actually reaches — the classic
 * "dust in a light shaft" read — and brighten when back-lit (forward scattering). Additive, one draw call.
 */
export class Dust {
  constructor(scene, sky, camera, count = 1000) {           // 1000 in a 28 x 4.5 x 28 m box ≈ the old 1500 in 28 x 7 x 28: same density, fewer motes seen against the sky
    this.sky = sky; this.camera = camera;
    const base = new Float32Array(count * 3), seed = new Float32Array(count);
    for (let i = 0; i < count; i++) { base[i * 3] = Math.random(); base[i * 3 + 1] = Math.random(); base[i * 3 + 2] = Math.random(); seed[i] = Math.random() * 100; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(base, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      // additive on colour only (same setup as the tracer material in fx/Impacts.js): the HDR target's alpha is the sky mask
      // for the sun shafts (Sky.js / PostFX), so the motes must leave alpha alone (plain AdditiveBlending pushes it above 1
      // -> a dark halo around each mote when the sun is on screen)
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      uniforms: {
        uTime: { value: 0 }, uColor: { value: new THREE.Color(0xffe2b8) },   // sunlit dust: warm, not white (a 1 px white dot reads as a dead pixel)
        uCam: { value: new THREE.Vector3() }, uPR: { value: 1 },
        uExt: { value: new THREE.Vector3(28, 4.5, 28) },               // box around the camera (m); low ceiling: motes live between the walls, few project on the sky
        uYOff: { value: 2.2 },                                        // box sits from cam.y-2.2 to cam.y+2.3
        uWind: { value: new THREE.Vector3(-0.32, 0.02, 0.18) },       // m/s, gentle westerly drift
        uSunDir: { value: new THREE.Vector3(...SUN.DIR).normalize() },
        uShadow: { value: null }, uShadowMat: { value: new THREE.Matrix4() }, uHasShadow: { value: 0 },
      },
      vertexShader: /* glsl */`
        attribute float seed;
        uniform float uTime, uYOff, uHasShadow, uPR; uniform vec3 uCam, uExt, uWind, uSunDir; uniform mat4 uShadowMat;
        uniform sampler2DShadow uShadow;
        varying float vA;
        void main(){
          // world-space wrap: motes are fixed in the world, the box picks which copy of each mote is near the camera
          vec3 q = position * uExt + uWind * uTime;
          q += vec3(sin(uTime * 0.23 + seed) * 0.6, sin(uTime * 0.31 + seed * 1.7) * 0.25, cos(uTime * 0.19 + seed * 0.7) * 0.5);
          vec3 origin = uCam - vec3(uExt.x * 0.5, uYOff, uExt.z * 0.5);
          vec3 wp = origin + fract((q - origin) / uExt) * uExt;
          // lit test against the sun's shadow map (hardware compare; outside the frustum = lit)
          float lit = 1.0;
          if (uHasShadow > 0.5) {
            vec4 sc = uShadowMat * vec4(wp, 1.0); sc.xyz /= sc.w;
            bool inside = all(greaterThan(sc.xy, vec2(0.0))) && all(lessThan(sc.xy, vec2(1.0)));
            lit = inside ? texture(uShadow, vec3(sc.xy, sc.z - 0.0015)) : 1.0;
          }
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          float d = -mv.z;
          // size in device pixels (render scale aware); a point can't shrink below 1 px, so sub-pixel motes fade by size² instead
          // of clamping to a full-intensity single pixel
          float ps = 52.0 * uPR / d;
          gl_PointSize = clamp(ps, 1.0, 3.6 * uPR);
          float sub = clamp(ps / 1.5, 0.0, 1.0); sub *= sub;
          sub *= 2.0 / max(gl_PointSize, 2.0);                        // bigger (near) motes: soft and dimmer per pixel, same energy
          // forward scatter: motes between the eye and the sun flare up
          vec3 vdir = normalize(wp - cameraPosition);
          float fs = pow(max(dot(vdir, uSunDir), 0.0), 6.0);
          float twinkle = 0.55 + 0.45 * sin(uTime * (1.3 + fract(seed * 0.37)) + seed * 7.0);
          vA = sub * lit * smoothstep(26.0, 5.0, d) * smoothstep(0.6, 2.2, d) * (0.35 + 0.65 * fract(sin(seed) * 43758.5)) * (0.7 + 0.3 * twinkle) * (1.0 + 1.5 * fs);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; varying float vA;
        void main(){
          vec2 c = gl_PointCoord - 0.5; float r = dot(c, c);
          float a = exp(-r * 9.0) * smoothstep(0.25, 0.16, r) * vA * 0.20;   // soft gaussian glint, no hard pixel core
          gl_FragColor = vec4(uColor, a);
        }`,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
  }

  update(t) {
    const u = this.material.uniforms;
    u.uTime.value = t;
    u.uCam.value.copy(this.camera.position);
    u.uPR.value = this.sky?.renderer?.getPixelRatio?.() ?? 1;
    const sh = this.sky?.sun?.shadow, tex = sh?.map?.depthTexture;
    u.uHasShadow.value = tex ? 1 : 0;
    if (tex) { u.uShadow.value = tex; u.uShadowMat.value.copy(sh.matrix); }
    this.points.visible = !!tex;
  }
}
