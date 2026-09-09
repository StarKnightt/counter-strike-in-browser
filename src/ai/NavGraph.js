import * as THREE from 'three';

/** Hand-authored connectivity between the NAV_* markers exported from Blender. */
const EDGES = [
  ['long_t', 'long_1'], ['long_1', 'long_2'], ['long_2', 'long_3'], ['long_3', 'long_4'], ['long_4', 'long_corner'],
  ['long_4', 'car'], ['car', 'long_corner'], ['car', 'barrels'],
  ['long_corner', 'elbow'], ['long_corner', 'site_nw'], ['elbow', 'site_sw'], ['elbow', 'pit'], ['elbow', 'site_nw'],
  ['barrels', 'site_nw'], ['barrels', 'site_n'],
  ['site_nw', 'site_center'], ['site_nw', 'site_n'], ['site_n', 'default'], ['site_n', 'goose'], ['default', 'site_center'],
  ['default', 'site_e'], ['site_e', 'goose'], ['site_e', 'triple'], ['site_e', 'ramp_top'], ['goose', 'ramp_top'],
  ['site_center', 'site_s'], ['site_center', 'site_sw'], ['site_s', 'ninja'], ['ninja', 'triple'], ['triple', 'ramp_top'],
  ['ramp_top', 'ramp_mid'], ['ramp_mid', 'ramp_bot'], ['ramp_bot', 'ct_spawn'],
  ['site_sw', 'stairs_bot'], ['stairs_bot', 'stairs_top'], ['stairs_top', 'short_plat'], ['short_plat', 'short_2'],
  ['short_2', 'short_1'], ['short_1', 'short_t'], ['stairs_bot', 'site_s'], ['site_sw', 'site_s'], ['default', 'site_s'],
];

export class NavGraph {
  constructor(markers) {
    this.nodes = markers.nav;                       // name -> Vector3
    this.adj = {};
    for (const n of Object.keys(this.nodes)) this.adj[n] = [];
    for (const [a, b] of EDGES) {
      if (!this.nodes[a] || !this.nodes[b]) { console.warn('nav edge missing node', a, b); continue; }
      const d = this.nodes[a].distanceTo(this.nodes[b]);
      this.adj[a].push({ n: b, d }); this.adj[b].push({ n: a, d });
    }
    // cover points attached to their nearest nav node
    this.cover = markers.cover;                     // name -> {pos, dir}
    this.coverAt = {};
    for (const [cn, c] of Object.entries(this.cover)) {
      const nn = this.nearest(c.pos);
      (this.coverAt[nn] ||= []).push({ name: cn, ...c });
    }
  }

  nearest(p) {
    let best = null, bd = Infinity;
    for (const [n, q] of Object.entries(this.nodes)) { const d = p.distanceToSquared(q); if (d < bd) { bd = d; best = n; } }
    return best;
  }

  /** Dijkstra shortest path (list of node names). `avoid` = set of nodes to skip. */
  path(from, to, avoid = null) {
    const dist = { [from]: 0 }, prev = {}, open = new Set([from]), done = new Set();
    while (open.size) {
      let u = null, ud = Infinity;
      for (const n of open) if (dist[n] < ud) { ud = dist[n]; u = n; }
      open.delete(u); done.add(u);
      if (u === to) break;
      for (const { n, d } of this.adj[u]) {
        if (done.has(n) || (avoid && avoid.has(n) && n !== to)) continue;
        const nd = ud + d;
        if (nd < (dist[n] ?? Infinity)) { dist[n] = nd; prev[n] = u; open.add(n); }
      }
    }
    if (!(to in dist)) return null;
    const out = [to]; let c = to; while (c !== from) { c = prev[c]; out.unshift(c); }
    return out;
  }

  pos(n) { return this.nodes[n]; }
}
