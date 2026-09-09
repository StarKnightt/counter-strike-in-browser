import * as THREE from 'three';
import { SUN, RENDER } from '../core/Constants.js';

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = normalize((modelMatrix * vec4(position,1.0)).xyz - cameraPosition);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0);
  gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
}`;

const SKY_FRAG = /* glsl */`
uniform vec3 uZenith, uHorizon, uGround, uSunDir, uSunColor;
uniform float uSunSize, uHaze;
varying vec3 vDir;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + vec2(17.3, 9.1); a *= 0.5; } return v; }
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  float cosA = dot(d, uSunDir);
  float ca = max(cosA, 0.0);
  // desert gradient: blue builds up quickly above the haze band, saturated by the zenith
  float t = 1.0 - exp(-max(h, 0.0) * 3.2);
  vec3 sky = mix(uHorizon, uZenith, t);
  // dust band hugging the horizon (0..14 deg): pale, only faintly warm away from the sun (a saturated cream band made the fog,
  // which takes this colour, match the plaster albedo => no aerial perspective); warmer + brighter toward the sun's side
  float band = 1.0 - smoothstep(0.0, 0.24, h);
  vec3 bandCol = mix(uHorizon * vec3(1.03, 1.0, 0.95), uSunColor * 0.95, 0.35 * pow(ca, 2.0) * uHaze);
  sky = mix(sky, bandCol, band * 0.75);
  vec3 below = mix(uHorizon, uGround, clamp(-h * 6.0, 0.0, 1.0));
  vec3 col = h >= 0.0 ? sky : below;
  // sun: disc + tight corona + wide mie haze (the warm glow that sells "there is a sun")
  float disc = smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.35, cosA);
  float glow = pow(ca, 96.0) * 1.6 + pow(ca, 14.0) * 0.55 + pow(ca, 3.0) * 0.22 * uHaze;
  col += uSunColor * (glow + disc * 8.0);
  // thin stretched cirrus: fbm on the sky plane, streaked along one direction, fading into the horizon haze
  if (h > 0.02) {
    vec2 uv = d.xz / (h + 0.12);
    float c = fbm(uv * vec2(0.9, 2.6) + vec2(3.1, 0.0));
    c = smoothstep(0.46, 0.74, c) * smoothstep(0.02, 0.22, h) * 0.8;
    vec3 cloudCol = mix(uHorizon, vec3(1.0, 0.98, 0.95), 0.6) * (0.9 + 0.35 * max(cosA, 0.0));
    col = mix(col, cloudCol, c);
  }
  col += (hash(gl_FragCoord.xy) - 0.5) * (1.5 / 255.0);   // dither: kills the gradient banding
  // alpha 0 marks "sky" in the HDR target (opaque pass, so it is written, not blended): the sun-shaft mask reads it, MSAA-resolved,
  // instead of a depth buffer. Nothing else looks at the target's alpha; the grade writes 1.0 at the end.
  gl_FragColor = vec4(col, 0.0);
}`;

function makeDome(sunDir, bright = 1.0) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color(0x4f86c6).multiplyScalar(bright) },    // saturated afternoon blue
      uHorizon: { value: new THREE.Color(0xeee5d4).multiplyScalar(bright) },   // bright pale haze (was 0xf0e2c8: too cream — see bandCol)
      uGround: { value: new THREE.Color(0xa8916c).multiplyScalar(bright) },
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: new THREE.Color(0xffdcb0) },
      uSunSize: { value: 0.0028 },
      uHaze: { value: 1.0 },
    },
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: true,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(900, 40, 24), mat);
  dome.frustumCulled = false;
  return dome;
}

/** Desert sky dome + sun + hemisphere fill + PMREM environment (all exposure-consistent). */
export class DesertSky {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.sunDir = new THREE.Vector3(...SUN.DIR).normalize();

    this.sky = makeDome(this.sunDir);
    scene.add(this.sky);

    const sun = new THREE.DirectionalLight(SUN.COLOR, SUN.INTENSITY);
    sun.position.copy(this.sunDir).multiplyScalar(140);
    sun.castShadow = true;
    sun.shadow.mapSize.set(RENDER.SHADOW_MAP, RENDER.SHADOW_MAP);
    const e = RENDER.SHADOW_EXTENT;
    sun.shadow.camera.left = -e; sun.shadow.camera.right = e;
    sun.shadow.camera.top = e; sun.shadow.camera.bottom = -e;
    sun.shadow.camera.near = 40; sun.shadow.camera.far = 260;    // sun sits 140 m out; tight depth range = better precision
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.00008;
    sun.shadow.normalBias = 0.018;   // 2.4 cm texels: enough to kill acne on the grazing-lit floor, small enough that crates stay planted
    sun.shadow.radius = RENDER.SHADOW_RADIUS;
    scene.add(sun, sun.target);
    this.sun = sun;
    // light-space frame for texel snapping in follow() (same lookAt convention the shadow camera uses)
    this._lightQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(this.sunDir, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)));
    this._lightQInv = this._lightQ.clone().invert();
    this._t = new THREE.Vector3();

    this.hemi = new THREE.HemisphereLight(SUN.SKY_COLOR, SUN.GROUND_COLOR, SUN.HEMI_INTENSITY);
    scene.add(this.hemi);

    // Fog colour = the dome's horizon band (azimuth-averaged) pulled a little toward the zenith blue and darkened ~4 %:
    // far rooftops lift toward a pale, slightly cool haze and the hills (260 m+, fully fogged) stay visible as a faint
    // blue-grey silhouette a hair below the sky at the horizon — the real look of distant hills, not a hard seam.
    scene.fog = new THREE.FogExp2(this.fogColor(), SUN.FOG_DENSITY);

    // Environment map from the same dome (no sun disc, so specular comes from the directional light)
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const envDome = makeDome(this.sunDir, 1.0);
    envDome.material.uniforms.uSunSize.value = 0.0;
    envDome.material.uniforms.uHaze.value = 0.5;
    envScene.add(envDome);
    const rt = pmrem.fromScene(envScene, 0.04);
    scene.environment = rt.texture;
    scene.environmentIntensity = SUN.ENV_INTENSITY;
    pmrem.dispose();
  }

  /** Linear-space colour of the dome at the horizon (matches SKY_FRAG), used for fog and the aerial-perspective tint. */
  horizonColor() {
    const u = this.sky.material.uniforms;
    const hz = u.uHorizon.value, sun = u.uSunColor.value;
    const warm = hz.clone().multiply(new THREE.Color(1.03, 1.0, 0.95));
    const band = warm.lerp(sun.clone().multiplyScalar(0.95), 0.05 * u.uHaze.value);
    return hz.clone().lerp(band, 0.75);
  }

  /** Linear-space fog colour: the horizon haze, 14 % toward the zenith blue, 4 % darker (see constructor). */
  fogColor() {
    return this.horizonColor().lerp(this.sky.material.uniforms.uZenith.value, 0.14).multiplyScalar(0.96);
  }

  /**
   * Shadow frustum follows the player; the target is snapped to shadow-map texels in light space so edges don't shimmer as you walk.
   * Returns true when the snapped target actually moved (the shadow map must be re-rendered).
   */
  follow(pos) {
    const s = this.sun, t = this._t, texel = (2 * RENDER.SHADOW_EXTENT) / RENDER.SHADOW_MAP;
    t.set(pos.x, 0, pos.z).applyQuaternion(this._lightQInv);
    t.x = Math.round(t.x / texel) * texel; t.y = Math.round(t.y / texel) * texel;
    t.applyQuaternion(this._lightQ);
    if (s.target.position.equals(t)) return false;
    s.target.position.copy(t);
    s.position.copy(this.sunDir).multiplyScalar(140).add(t);
    return true;
  }
}
