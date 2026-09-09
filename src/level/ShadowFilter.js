import * as THREE from 'three';
import { RENDER } from '../core/Constants.js';

/**
 * Stable PCF for the sun shadow: replaces the directional/spot `getShadow()` of three r185's PCFShadowMap.
 *
 * Why. three's PCF rotates its 5-tap Vogel disk per *screen pixel* (`interleavedGradientNoise( gl_FragCoord.xy )`) — a pattern
 * meant to be averaged away by TAA, which this renderer does not have. Without it the rotation is a screen-fixed noise field
 * that the world slides under, so as soon as the camera moves every penumbra shimmers, and so does every sunlit surface the sun
 * hits at a grazing angle: there the taps 1.8 texels away land on receiver depths that differ by more than the bias covers, and
 * which of the 5 taps "self-shadow" depends on the per-pixel rotation. Measured on the short-corridor plaster wall (sun 61° off
 * the normal) with an exact 1-px strafe: the shadow term alone changed the luminance by 5.8/255 per frame over the whole wall
 * (0.75 with shadows off, 0.75 again with shadow.radius = 0), i.e. the "flicker while moving" report.
 *
 * Fix, in the same function:
 *  - fixed-orientation 8-tap Vogel disk (× the 4-tap hardware bilinear compare = 32 effective taps): the same world point gets the
 *    same taps on every frame, so the shadow is as stable as the (texel-snapped) map itself. 3 more compares per fragment than stock.
 *  - receiver-plane depth bias (Isidoro 2006): each tap compares against the depth the *receiver itself* has at that offset
 *    (its depth gradient in shadow-map space from dFdx/dFdy of the shadow coord), plus half a texel of that slope for the bilinear
 *    footprint. A flat lit surface never self-shadows however grazing the sun, without the big normalBias that would detach contact
 *    shadows. The gradient is clamped (see maxGrad) so the garbage derivatives of a silhouette quad cannot lift a shadow.
 * Must run before any lit material compiles (Game constructor). Assumes the default (non-reversed) depth buffer. ?pcf=stock = three's.
 */
export function installStablePCF({ taps = 8, maxSlope = 3.0, depthRange = RENDER.SHADOW_DEPTH_RANGE } = {}) {
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  if (!chunk || chunk.includes('vogelDiskFixed')) return false;
  try { if (new URLSearchParams(location.search).get('pcf') === 'stock') return false; } catch { /* no window */ }   // A/B: ?pcf=stock keeps three's filter
  // dz/duv of a receiver plane at angle θ to the light, in the shadow map's normalised units: tan θ × (frustum width / depth range)
  const maxGrad = (maxSlope * 2 * RENDER.SHADOW_EXTENT / depthRange).toFixed(4);
  const re = /float getShadow\( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord \) \{[\s\S]*?return mix\( 1\.0, shadow, shadowIntensity \);\s*\}/;
  if (!re.test(chunk)) { console.warn('ShadowFilter: three PCF getShadow() not found — stock shadow filtering kept'); return false; }
  // fixed-orientation Vogel disk as literals (unit radius); folding sin/cos in the shader made the D3D compiler warn about 1e-17 terms
  const disk = Array.from({ length: taps }, (_, i) => { const r = Math.sqrt((i + 0.5) / taps), th = i * 2.399963229728653 + 0.7; return `vec2( ${(Math.cos(th) * r).toFixed(5)}, ${(Math.sin(th) * r).toFixed(5)} )`; });
  THREE.ShaderChunk.shadowmap_pars_fragment = chunk.replace(re, /* glsl */`
		// fixed-orientation Vogel disk (see ShadowFilter.js): no per-pixel rotation
		const vec2 vogelDiskFixed[ ${taps} ] = vec2[ ${taps} ]( ${disk.join(', ')} );
		float getShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
			float shadow = 1.0;
			shadowCoord.xyz /= shadowCoord.w;
			shadowCoord.z += shadowBias;
			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
			if ( frustumTest ) {
				vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
				float radius = shadowRadius * texelSize.x;
				// receiver-plane depth bias: solve dz = a du + b dv from the screen-space derivatives of the shadow coord
				vec3 dx = dFdx( shadowCoord.xyz ), dy = dFdy( shadowCoord.xyz );
				float det = dx.x * dy.y - dx.y * dy.x;
				vec2 dzduv = abs( det ) > 1e-14 ? vec2( dx.z * dy.y - dx.y * dy.z, dx.x * dy.z - dx.z * dy.x ) / det : vec2( 0.0 );
				dzduv = clamp( dzduv, vec2( -${maxGrad} ), vec2( ${maxGrad} ) );
				float slack = 0.5 * texelSize.x * length( dzduv );          // the hardware 2x2 footprint around each tap
				for ( int i = 0; i < ${taps}; i ++ ) {
					vec2 o = vogelDiskFixed[ i ] * radius;
					shadow += texture( shadowMap, vec3( shadowCoord.xy + o, shadowCoord.z + dot( dzduv, o ) - slack ) );
				}
				shadow = ( shadow - 1.0 ) / ${taps}.0;
			}
			return mix( 1.0, shadow, shadowIntensity );
		}`);
  return true;
}
