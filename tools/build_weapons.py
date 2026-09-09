"""Procedural first-person weapons for the CS2-style FPS: AK-47, AWP, knife + gloved hands.
Run inside Blender. Blender +Y = barrel forward (exports to glTF -Z), +Z up, +X right.
Origin = grip anchor (roughly where the trigger hand is). Named nodes the game drives (ViewModel.js):
Muzzle, Eject, Mag, HandL, HandR, ArmL, ArmR, ScopeLens, bolt_knob (AWP bolt cycle). Material names are dressed in JS
(ViewModel._dress + WeaponTextures.js): gun_wood / gun_bakelite / gun_steel / gun_steel_light / gun_black / awp_green /
gun_rubber / scope_glass (lens discs, own 0..1 UVs) / knife_blade / knife_edge / knife_handle / glove (knuckle fabric) /
glove_palm (leather) / sleeve (rip-stop).
Every non-wood face gets box-projected UVs at a fixed texel density (box_uv) so the tiling JS textures line up, and the
gun meshes carry an edge-wear mask in COLOR_0.r (bevel strips, see mark_bevel/bake_wear).
Exports one GLB per weapon to public/models/ (each < 1 MB)."""
import bpy, bmesh, math, os
from mathutils import Vector, Matrix, Euler

OUT = r'C:\Code\cs2-dust2\public\models'
os.makedirs(OUT, exist_ok=True)

# ------------------------------------------------------------ utils
def reset():
    if bpy.context.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete()
    for x in list(bpy.data.meshes):
        if x.users == 0: bpy.data.meshes.remove(x)

def mat(name, rgb, rough=0.5, metallic=0.0, emissive=None):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metallic
    if emissive:
        b.inputs['Emission Color'].default_value = (*emissive, 1); b.inputs['Emission Strength'].default_value = 2.0
    return m

M_STEEL  = mat('gun_steel',  (0.040, 0.040, 0.046), rough=0.45, metallic=0.85)   # blued receiver / barrel
M_STEEL_L= mat('gun_steel_light', (0.16, 0.16, 0.17), rough=0.50, metallic=0.85) # stamped dust cover (lighter, greyer)
M_BLACK  = mat('gun_black',  (0.012, 0.012, 0.014), rough=0.6, metallic=0.5)     # phosphate/parkerized parts
M_WOOD   = mat('gun_wood',   (0.19, 0.070, 0.026), rough=0.42)                   # AK laminate (grain texture added in JS)
M_BAKE   = mat('gun_bakelite',(0.30, 0.10, 0.035), rough=0.30)                   # orange-brown bakelite grip
M_GREEN  = mat('awp_green',  (0.085, 0.115, 0.060), rough=0.62)
M_RUBBER = mat('gun_rubber', (0.010, 0.010, 0.010), rough=0.9)
M_GLASS  = mat('scope_glass',(0.05, 0.09, 0.14), rough=0.05, metallic=0.9)
M_BRASS  = mat('brass',      (0.72, 0.55, 0.22), rough=0.35, metallic=1.0)
M_BLADE  = mat('knife_blade',(0.42, 0.43, 0.45), rough=0.25, metallic=1.0)   # satin flats + fuller
M_EDGE   = mat('knife_edge', (0.70, 0.71, 0.73), rough=0.08, metallic=1.0)   # polished chamfer strip along the cutting edge
M_HANDLE = mat('knife_handle',(0.020, 0.020, 0.022), rough=0.70)             # G10 / rubber handle (speckle normal in JS)
M_GLOVE  = mat('glove',      (0.026, 0.024, 0.022), rough=0.85)                 # back of hand / fingers: knuckle fabric (textured in JS)
M_GLOVE_P= mat('glove_palm', (0.018, 0.016, 0.015), rough=0.55)                 # palm side: leather (assigned by hand-local normal in hand())
M_SLEEVE = mat('sleeve',     (0.075, 0.085, 0.060), rough=0.9)
M_SKIN   = mat('skin',       (0.62, 0.45, 0.34), rough=0.7)

M_WEARMARK = mat('_wearmark', (1, 0, 1))   # temporary: tags bevel faces so join() can bake them into the edge-wear mask

def _finish(o, m, bevel=0.0, seg=2):
    o.data.materials.append(m)
    if bevel > 0:
        o.data.materials.append(M_WEARMARK)
        b = o.modifiers.new('bevel', 'BEVEL'); b.width = bevel; b.segments = seg; b.limit_method = 'ANGLE'; b.material = 1
    return o

def box(name, cx, cy, cz, sx, sy, sz, m, bevel=0.0, rot=(0, 0, 0), seg=2, smooth=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(cx, cy, cz))
    o = bpy.context.active_object; o.name = name
    o.scale = (sx, sy, sz)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)   # bevel width is in local units: bake the size first
    o.rotation_euler = Euler([math.radians(a) for a in rot])
    return _finish(o, m, bevel, seg)

def cyl(name, cx, cy, cz, r, length, m, axis='Y', verts=16, r2=None, bevel=0.0, seg=2):
    """Cylinder along axis, centred at (cx,cy,cz). r2 -> cone/taper (r at the -axis end, r2 at the +axis end)."""
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=length, vertices=verts, location=(cx, cy, cz))
    else:
        bpy.ops.mesh.primitive_cone_add(radius1=r, radius2=r2, depth=length, vertices=verts, location=(cx, cy, cz))
    o = bpy.context.active_object; o.name = name
    if axis == 'Y': o.rotation_euler = Euler((math.radians(-90), 0, 0))
    elif axis == 'X': o.rotation_euler = Euler((0, math.radians(90), 0))
    return _finish(o, m, bevel, seg)

def seg_cyl(name, a, b, r, m, verts=12, r2=None):
    """Cylinder (or taper) between two world points."""
    a, b = Vector(a), Vector(b); d = b - a; L = d.length
    if r2 is None: bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=L, vertices=verts, location=(a + b) / 2)
    else: bpy.ops.mesh.primitive_cone_add(radius1=r, radius2=r2, depth=L, vertices=verts, location=(a + b) / 2)
    o = bpy.context.active_object; o.name = name
    o.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    return _finish(o, m)

def sphere(name, cx, cy, cz, r, m, sx=1, sy=1, sz=1, segs=12, rings=8):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, segments=segs, ring_count=rings, location=(cx, cy, cz))
    o = bpy.context.active_object; o.name = name; o.scale = (sx, sy, sz)
    return _finish(o, m)

def rprof(w, h, radii, n=3):
    """Rounded rectangle in (u,v): half sizes w,h; radii for corners (+,+),(-,+),(-,-),(+,-). CCW, n segments per corner."""
    if isinstance(radii, (int, float)): radii = (radii,) * 4
    pts = []
    for k, (su, sv) in enumerate(((1, 1), (-1, 1), (-1, -1), (1, -1))):
        r = max(0.0008, min(radii[k], w * 0.98, h * 0.98))
        cu, cv = su * (w - r), sv * (h - r)
        a0 = math.atan2(sv, su) - math.pi / 4
        for i in range(n + 1):
            a = a0 + (math.pi / 2) * i / n
            pts.append((cu + r * math.cos(a), cv + r * math.sin(a)))
    return pts

def ring(center, U, V, prof):
    c, U, V = Vector(center), Vector(U), Vector(V)
    return [c + U * u + V * v for (u, v) in prof]

def ring_xz(y, hw, zt, zb, rt=0.004, rb=0.010, n=3):
    """Cross-section in the XZ plane at station y: half-width hw, top z, bottom z, top/bottom corner radii."""
    return ring((0, y, (zt + zb) / 2), (1, 0, 0), (0, 0, 1), rprof(hw, (zt - zb) / 2, (rt, rt, rb, rb), n))

def ring_xy(cy, cz, w, d, r=0.006, n=3):
    """Horizontal cross-section (grips): half-width w (x), half-depth d (y) at height cz, centred on y=cy."""
    return ring((0, cy, cz), (1, 0, 0), (0, 1, 0), rprof(w, d, r, n))

def loft(name, sections, m, caps=True):
    """Skin a list of equal-length rings into one mesh (quads between rings + n-gon caps)."""
    bm = bmesh.new()
    rings = [[bm.verts.new(p) for p in sec] for sec in sections]
    for a, b in zip(rings, rings[1:]):
        n = len(a)
        for i in range(n):
            bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    if caps:
        bm.faces.new(rings[0][::-1]); bm.faces.new(rings[-1])
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o)
    return _finish(o, m)

def empty(name, x, y, z):
    e = bpy.data.objects.new(name, None); e.location = (x, y, z); e.empty_display_size = 0.02
    bpy.context.collection.objects.link(e); return e

HARD_MATS = ('knife_edge',)   # material boundaries kept as hard edges (crisp chamfer line on the blade)
def smooth_by_angle(o, angle=math.radians(40)):
    me = o.data
    hard = {i for i, m in enumerate(me.materials) if m and m.name in HARD_MATS}
    for p in me.polygons: p.use_smooth = True
    bm = bmesh.new(); bm.from_mesh(me)
    for e in bm.edges:
        lf = e.link_faces
        e.smooth = len(lf) == 2 and e.calc_face_angle(0) < angle and not (lf[0].material_index != lf[1].material_index and (lf[0].material_index in hard or lf[1].material_index in hard))
    bm.to_mesh(me); bm.free()

def wood_uv(o, scale=3.0):
    """Planar UVs for wood/bakelite faces so the JS grain texture runs along the barrel axis (Y)."""
    me = o.data
    wood_idx = {i for i, m in enumerate(me.materials) if m and m.name in ('gun_wood', 'gun_bakelite')}
    bm = bmesh.new(); bm.from_mesh(me); uv = bm.loops.layers.uv.verify()
    for f in bm.faces:
        if f.material_index in wood_idx or len(me.materials) == 1:
            for l in f.loops:
                p = l.vert.co; l[uv].uv = (p.y * scale, (p.z + 0.35 * p.x) * scale)
    bm.to_mesh(me); bm.free()

def box_uv(o, scale=8.0, skip=('gun_wood', 'gun_bakelite', 'scope_glass')):
    """Per-face box projection (dominant normal axis) for every non-wood face, so the tiling JS textures
    (glove fabric, ripstop, steel scratches, polymer speckle) get a uniform texel density instead of the
    primitives' default 0..1 UVs. scale = UV units per metre. Lens discs keep their own 0..1 UVs (lens_uv)."""
    me = o.data
    skip_idx = {i for i, m in enumerate(me.materials) if m and m.name in skip}
    bm = bmesh.new(); bm.from_mesh(me); uv = bm.loops.layers.uv.verify()
    for f in bm.faces:
        if f.material_index in skip_idx: continue
        n = f.normal; ax = max(range(3), key=lambda i: abs(n[i]))
        for l in f.loops:
            p = l.vert.co
            u, v = ((p.y, p.z), (p.x, p.z), (p.x, p.y))[ax]
            l[uv].uv = (u * scale, v * scale)
    bm.to_mesh(me); bm.free()

def lens_uv(o):
    """scope_glass faces: each lens disc (connected island) gets 0..1 UVs across its own XZ extent so the JS lens
    texture (radial tint + specular highlight decal) maps once per lens whichever way it faces."""
    me = o.data
    idx = {i for i, m in enumerate(me.materials) if m and m.name == 'scope_glass'}
    if not idx: return
    bm = bmesh.new(); bm.from_mesh(me); uv = bm.loops.layers.uv.verify()
    faces = [f for f in bm.faces if f.material_index in idx]
    seen = set()
    for f0 in faces:
        if f0.index in seen: continue
        island, stack = [], [f0]
        while stack:
            f = stack.pop()
            if f.index in seen or f.material_index not in idx: continue
            seen.add(f.index); island.append(f)
            for e in f.edges:
                for g in e.link_faces: stack.append(g)
        xs = [v.co.x for f in island for v in f.verts]; zs = [v.co.z for f in island for v in f.verts]
        x0, x1, z0, z1 = min(xs), max(xs), min(zs), max(zs)
        for f in island:
            for l in f.loops:
                p = l.vert.co
                l[uv].uv = ((p.x - x0) / max(1e-6, x1 - x0), (p.z - z0) / max(1e-6, z1 - z0))
    bm.to_mesh(me); bm.free()

def mark_bevel(o, wear=True):
    """Per part, after its Bevel modifier is applied: bevel faces (tagged with the _wearmark material by the modifier)
    -> per-corner colour R = 1, everything else 0; then the marker slot is stripped. Per-corner (not per-vertex) so
    the wear stays on the bevel strip instead of bleeding across the big flat faces it borders."""
    me = o.data
    idx = next((i for i, m in enumerate(me.materials) if m and m.name == '_wearmark'), None)
    if wear:
        col = me.color_attributes.get('Col') or me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
        data = col.data
        for p in me.polygons:
            w = 1.0 if p.material_index == idx else 0.0
            for li in p.loop_indices: data[li].color = (w, 1.0 - w, 0.0, 1.0)
    if idx is not None:
        for p in me.polygons:
            if p.material_index == idx: p.material_index = 0
        me.materials.pop(index=idx)

def bake_wear(o):
    """Edge-wear mask (COLOR_0.r), read by the steel shaders in ViewModel.js to lift bare metal along edges.
    Bevel strips were tagged per part (mark_bevel) before the join; this just makes the merged 'Col' layer the
    active/exported colour. (Unbevelled hard edges are deliberately NOT included: a cylinder's side quads run its
    whole length, so tagging their rim corners would smear wear over the entire barrel / scope tube.)"""
    me = o.data
    ca = me.color_attributes.get('Col')
    if ca: me.color_attributes.active_color = ca; me.color_attributes.render_color_index = me.color_attributes.active_color_index

def join(objs, name, origin_zero=False, uv_scale=8.0, wear=True):
    objs = [o for o in objs if o and o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    for o in objs:
        bpy.context.view_layer.objects.active = o
        for md in list(o.modifiers): bpy.ops.object.modifier_apply(modifier=md.name)
        mark_bevel(o, wear)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1: bpy.ops.object.join()
    o = bpy.context.active_object; o.name = name
    bpy.ops.object.transform_apply(location=origin_zero, rotation=True, scale=True)
    smooth_by_angle(o); wood_uv(o); box_uv(o, uv_scale); lens_uv(o)
    if wear: bake_wear(o)
    return o

def export(name):
    bpy.ops.object.select_all(action='SELECT')
    path = os.path.join(OUT, f'{name}.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True,
        export_apply=True, export_yup=True, export_lights=False, export_cameras=False, export_animations=False,
        export_extras=True, export_image_format='NONE', export_vertex_color='ACTIVE')
    tris = {o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in bpy.context.selected_objects if o.type == 'MESH'}
    print(name, 'kB', os.path.getsize(path) // 1024, 'tris', sum(tris.values()), tris)

# ------------------------------------------------------------ hands (gloved) + sleeved forearms
THUMB_OPEN = ((0.70, 0.62, -0.34), (0.22, 0.86, -0.46))      # relaxed: out of the thenar, curling across (grip hand)
THUMB_SIDE = ((0.32, -0.12, -0.94), (0.85, 0.10, -0.52))     # opposed: up the far side of a rod, then along it (support hand)
THUMB_LOCK = ((0.08, 0.30, -0.95), (-0.42, 0.78, -0.46))     # hammer grip: down the near side of the handle, then across over the index finger
def oval(w, h, n=14, flat=0.0):
    """Ellipse profile in (u,v) with half sizes w,h; flat > 0 squashes the -v side (finger pads / palm side)."""
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        u, v = w * math.cos(a), h * math.sin(a)
        if v < 0: v *= (1.0 - flat)
        pts.append((u, v))
    return pts

def tube(name, stations, m, n=14, V0=(0, 0, 1), caps=True):
    """Loft of oval rings along a path. Station = (pos, tangent, w, h[, flat[, V]]): the ring lies in the plane
    perpendicular to the tangent, its V axis (the 'back'; flat squashes the opposite side) is V (or V0) projected
    into that plane, U = V x T. Consecutive stations must keep V roughly continuous (no twist)."""
    V0 = Vector(V0); secs = []
    for st in stations:
        p, t, w, h = Vector(st[0]), Vector(st[1]).normalized(), st[2], st[3]
        flat = st[4] if len(st) > 4 else 0.0
        V = Vector(st[5]) if len(st) > 5 else V0
        V = (V - t * V.dot(t)).normalized(); U = V.cross(t)
        secs.append(ring(p, U, V, oval(w, h, n, flat)))
    return loft(name, secs, m, caps)

# palm loft stations (hand-local): y, half-width, back z, palm z, back corner radius, palm corner radius.
# Wider at the knuckles than the wrist, well-rounded back, flatter palm; runs from inside the cuff to just past the
# knuckle line (the finger roots start inside the last stations).
PALM_STATIONS = ((-0.078, 0.0280, 0.0135, -0.0125, 0.010, 0.009), (-0.060, 0.0290, 0.0140, -0.0135, 0.010, 0.009),
                 (-0.044, 0.0320, 0.0155, -0.0155, 0.012, 0.010), (-0.026, 0.0350, 0.0165, -0.0170, 0.013, 0.010),
                 (-0.008, 0.0370, 0.0170, -0.0165, 0.013, 0.009), (0.012, 0.0380, 0.0170, -0.0145, 0.013, 0.008),
                 (0.028, 0.0380, 0.0150, -0.0125, 0.012, 0.007), (0.040, 0.0375, 0.0120, -0.0105, 0.010, 0.006),
                 (0.047, 0.0340, 0.0080, -0.0075, 0.007, 0.005), (0.051, 0.0260, 0.0035, -0.0030, 0.003, 0.003))
# fingers (index, middle, ring, pinky): root x (thumb side +), root y/z (knuckle arc: middle furthest forward, pinky
# well back and a little lower; roots sit high so the MCP knuckles stand proud of the sloping back), phalanx lengths,
# base radius, splay (deg, + toward the thumb), curl multiplier.
FINGERS = ((0.0270, 0.044, 0.0030, (0.041, 0.026, 0.020), 0.0079, 3.0, 0.97),
           (0.0090, 0.047, 0.0050, (0.045, 0.028, 0.021), 0.0081, 0.5, 1.00),
           (-0.0090, 0.043, 0.0030, (0.042, 0.026, 0.020), 0.0076, -2.0, 1.03),
           (-0.0270, 0.036, -0.0010, (0.033, 0.021, 0.017), 0.0067, -4.5, 1.06))
CURL_DEG = (62, 55, 40)                      # per-joint flexion at curl = 1 (MCP > PIP > DIP)
HAND_TIPS = {}                               # name -> world fingertip positions (index, thumb), for pose debugging

def finger(name, k, dirs, Ls, r, m, back, n=14):
    """One finger: three tapered phalanges as a single loft along the curled path starting at the knuckle k (MCP).
    dirs = unit direction of each phalanx, back = matching 'back of the finger' vectors, Ls = lengths, r = base radius.
    Knuckle bulges (a little proud on the back) at every joint, flattened pads underneath, rounded flattened tip."""
    st = []
    d0 = dirs[0]
    st.append((k - d0 * 0.014, d0, r * 0.92, r * 0.92, 0.0, back[0]))       # root, buried in the palm
    st.append((k - d0 * 0.006, d0, r * 0.98, r * 0.98, 0.0, back[0]))
    p = Vector(k)
    for j, (d, L) in enumerate(zip(dirs, Ls)):
        rj = r * (1.0, 0.92, 0.84)[j]
        bis = d if j == 0 else (dirs[j - 1] + d).normalized()
        bk = back[j] if j == 0 else (back[j - 1] + back[j]).normalized()
        bulge = (1.14, 1.10, 1.06)[j]; lift = (0.0018, 0.0012, 0.0007)[j]
        st.append((p + bk * lift, bis, rj * bulge, rj * bulge * 0.95, 0.0, bk))                  # knuckle
        if j < 2:
            st.append((p + d * L * 0.30, d, rj * 0.97, rj * 0.97, 0.15, back[j]))
            st.append((p + d * L * 0.66, d, rj * 0.95, rj * 0.95, 0.15, back[j]))
        else:
            st.append((p + d * L * 0.30, d, rj * 0.96, rj * 0.96, 0.15, back[j]))
            st.append((p + d * L * 0.60, d, rj * 0.92, rj * 0.90, 0.22, back[j]))
            st.append((p + d * (L - rj * 0.45), d, rj * 0.80, rj * 0.72, 0.25, back[j]))       # pad
            st.append((p + d * (L + rj * 0.05), d, rj * 0.45, rj * 0.38, 0.20, back[j]))       # rounded tip
        p = p + d * L
    return tube(name, st, m, n=n), p

def hand(name, pos, F, B, right=True, curl=1.0, thumb=THUMB_OPEN, scale=1.0, index=None):
    """Gloved hand. Hand-local frame: palm slab in XY (thin in Z), palm side -Z, back of hand +Z, fingers +Y,
    thumb on -X for a right hand (+X for a left hand). F = world direction the fingers leave the palm,
    B = world direction of the back of the hand (must be roughly perpendicular). pos = world palm centre.
    scale: uniform size factor applied about the palm centre (knife hand is 0.85).
    index: optional (mcp, pip, dip, splay) degrees for the index finger alone (trigger finger), else it follows curl.
    Geometry: lofted palm (tapered, rounded back, cupped by curl, knuckle arc), thenar + hypothenar pads, four lofted
    fingers with knuckle bulges and flattened pads, thumb with a metacarpal out of the palm plane, knuckle pad plate,
    wrist cuff with a strap band + free tab. Materials: glove (back / fingers), glove_palm (assigned by -Z normal),
    gun_rubber (strap)."""
    s = -1 if right else 1
    G = M_GLOVE; parts = []
    # --- palm: lofted, then deformed (transverse arch, pinky side lower, knuckle line follows the finger roots)
    secs = []
    for (y, hw, zt, zb, rt, rb) in PALM_STATIONS:
        pts = ring((0, y, (zt + zb) / 2), (1, 0, 0), (0, 0, 1), rprof(hw, (zt - zb) / 2, (rt, rt, rb, rb), 3))
        t = max(0.0, min(1.0, (y + 0.010) / 0.050))              # 0 at the wrist .. 1 at the knuckles
        dome = 0.0035 * max(0.0, min(1.0, (y + 0.050) / 0.040)) * (1.0 - max(0.0, (y - 0.036) / 0.015))
        for p in pts:
            u = s * p.x / 0.038                                   # +1 thumb/index side .. -1 pinky side
            p.z -= 0.0035 * curl * t * u * u                      # cupped toward the palm
            p.z += 0.0020 * t * u                                 # pinky side sits lower
            if p.z > 0.004: p.z += dome * (1.0 - u * u) * min(1.0, p.z / 0.012)   # domed back (metacarpal ridge), flat palm
            p.y += t * (0.004 * u - 0.007 * u * u)                # knuckle arc
        secs.append(pts)
    parts.append(loft(name + '_palm', secs, G))
    parts.append(sphere(name + '_thenar', s * 0.023, -0.012, -0.011, 0.020, G, sx=1.0, sy=1.40, sz=0.55, segs=14, rings=8))
    parts.append(sphere(name + '_heel', -s * 0.019, -0.031, -0.010, 0.017, G, sx=0.95, sy=1.55, sz=0.50, segs=14, rings=8))
    # --- fingers
    A = Vector((1, 0, 0))                                         # curl axis (hand X); back of a finger = A x dir
    for i, (fx, ky, kz, Ls, r, sp, cm) in enumerate(FINGERS):
        angs = [math.radians(a) for a in index[:3]] if (i == 0 and index) else [math.radians(a * curl * cm) for a in CURL_DEG]
        sp = math.radians(index[3] if (i == 0 and index) else sp)
        dirs, backs, ang = [], [], 0.0
        for a in angs:
            ang += a
            d = Vector((s * math.sin(sp) * math.cos(ang), math.cos(sp) * math.cos(ang), -math.sin(ang))).normalized()
            dirs.append(d); backs.append(A.cross(d).normalized())
        o, tip = finger(name + '_f%d' % i, Vector((s * fx, ky, kz)), dirs, Ls, r, G, backs)
        parts.append(o)
        if i == 0: index_tip = tip
    # --- thumb: metacarpal from the wrist (CMC) out of the palm plane to the MCP, then the two phalanges along `thumb`
    cmc = Vector((s * 0.022, -0.038, -0.007)); mcp = Vector((s * 0.037, -0.006, -0.009))
    dm = (mcp - cmc).normalized()
    d1 = Vector((s * thumb[0][0], thumb[0][1], thumb[0][2])).normalized()
    d2 = Vector((s * thumb[1][0], thumb[1][1], thumb[1][2])).normalized()
    L1, L2, r = 0.038, 0.030, 0.0105
    ip = mcp + d1 * L1; tip = ip + d2 * L2
    nail = (s * 0.5, 0.0, 0.87)
    parts.append(tube(name + '_thumb', [
        (cmc - dm * 0.008, dm, 0.0110, 0.0100), (cmc + dm * 0.012, dm, 0.0135, 0.0115),
        (mcp, (dm + d1).normalized(), r * 1.12, r * 1.05),
        (mcp + d1 * 0.30 * L1, d1, r * 0.98, r * 0.95, 0.10), (mcp + d1 * 0.70 * L1, d1, r * 0.95, r * 0.92, 0.10),
        (ip, (d1 + d2).normalized(), r * 1.02, r * 0.98),
        (ip + d2 * 0.30 * L2, d2, r * 0.88, r * 0.86, 0.15), (ip + d2 * 0.62 * L2, d2, r * 0.82, r * 0.78, 0.22),
        (tip - d2 * r * 0.40, d2, r * 0.70, r * 0.62, 0.25), (tip + d2 * r * 0.05, d2, r * 0.40, r * 0.34, 0.20)], G, n=14, V0=nail))
    # --- glove details: one padded knuckle segment per finger (riding the MCP bulge, tilted with the first phalanx),
    # a low back-of-hand pad behind them, slim elastic cuff, strap band + free tab
    for i, (fx, ky, kz, Ls, r, sp, cm) in enumerate(FINGERS):
        a0 = (index[0] if (i == 0 and index) else CURL_DEG[0] * curl * cm) * 0.45          # pad tilts part-way with the knuckle
        parts.append(box(name + '_kn%d' % i, s * fx, ky - 0.006, kz + 0.0105, 0.0148, 0.016, 0.0065, G, bevel=0.0028, seg=3, rot=(-a0, 0, -s * sp)))
    parts.append(box(name + '_kpad', 0, 0.021, 0.0185, 0.054, 0.014, 0.005, G, bevel=0.0024, seg=3, rot=(-6, 0, 0)))
    parts.append(loft(name + '_cuff', [ring((0, y, 0.0005), (1, 0, 0), (0, 0, 1), rprof(hw, hh, 0.011, 3)) for (y, hw, hh) in
                                       ((-0.062, 0.0285, 0.0140), (-0.065, 0.0310, 0.0165), (-0.091, 0.0310, 0.0165), (-0.094, 0.0285, 0.0140))], G))
    parts.append(loft(name + '_strap', [ring((0, y, 0.0005), (1, 0, 0), (0, 0, 1), rprof(hw, hh, 0.012, 3)) for (y, hw, hh) in
                                        ((-0.072, 0.0312, 0.0167), (-0.0735, 0.0325, 0.0180), (-0.0855, 0.0325, 0.0180), (-0.087, 0.0312, 0.0167))], M_RUBBER))
    parts.append(box(name + '_strap_tab', s * 0.018, -0.0795, 0.0190, 0.020, 0.013, 0.0040, M_RUBBER, bevel=0.0015, rot=(0, s * 6, 0)))
    o = join(parts, name, uv_scale=26.0, wear=False)          # finer fabric tile than the old 20: reads as knit, not quilt
    # palm side (hand-local -Z, incl. finger undersides and the inside of the thumb) -> leather; back/knuckles -> fabric
    me = o.data; me.materials.append(M_GLOVE_P); pi = len(me.materials) - 1
    gi = [i for i, m in enumerate(me.materials) if m and m.name == 'glove'][0]
    for f in me.polygons:
        if f.material_index == gi and f.normal.z < -0.25: f.material_index = pi
    F = Vector(F).normalized(); B = Vector(B); B = (B - F * B.dot(F)).normalized(); X = F.cross(B)
    M = Matrix((X, F, B)).transposed().to_4x4()
    W = Matrix.Translation(Vector(pos)) @ M @ Matrix.Scale(scale, 4)
    HAND_TIPS[name] = {'index': W @ index_tip, 'thumb': W @ tip, 'X': X}
    o.matrix_world = W
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return o

def arm(name, p0, p1, r0=0.031, r1=0.041, major=None):
    """Straight sleeved forearm from wrist p0 to elbow p1 (kept for callers; same mesh as arm_bent)."""
    p0, p1 = Vector(p0), Vector(p1); n = (p1 - p0).normalized()
    return arm_bent(name, p0, p0 + n * 0.03, p1, r0, r1, major)

GRIP_F, GRIP_B = (-0.15, 0.89, -0.37), (0.99, 0.11, -0.08)   # fingers leave the palm forward (down the rake) and wrap left round the front strap; back of the hand to the right/eye
def GRIP_R(pos):
    """Grip-hand palm centre: the callers' positions were tuned for the old slab palm; the new palm sits 1 cm higher up
    the grip (along hand -X, the thumb side) so the web of the thumb meets the tang and the index finger reaches the trigger."""
    F = Vector(GRIP_F).normalized(); B = Vector(GRIP_B); B = (B - F * B.dot(F)).normalized(); X = F.cross(B)
    return tuple(Vector(pos) - X * 0.010)

def grip_hand_r(pos):
    """Right hand on a raked pistol grip: three fingers wrap forward-left around the front strap, back of the hand to
    the eye, index finger extended forward-up along the trigger guard with its pad on the trigger."""
    return hand('HandR', pos, F=GRIP_F, B=GRIP_B, right=True, index=(0, 75, 85, 20))

F_SUPPORT, SUPPORT_B = (0.97, 0.05, 0.24), (0.24, -0.10, -0.97)
def support_hand_l(pos):
    """Left hand cupping the handguard from below: palm flat under the wood (facing up), knuckles at the lower-right
    corner, fingers climb the right side and lie over the top, thumb up the left side then forward along it.
    pos = palm centre: (-0.016, y, -0.062) puts the palm top face flush with a handguard whose bottom is at z=-0.043."""
    return hand('HandL', pos, F=F_SUPPORT, B=SUPPORT_B, right=False, curl=1.1, thumb=THUMB_SIDE)

SLEEVE_START = 0.095                          # hand-local distance from the palm centre to the sleeve hem (past the glove cuff)
def arm_from(hand_pos, F, elbow, r0=0.029, r1=0.040, B=None):
    """Sleeve for a hand posed with hand(pos, F, B): hem just past the glove cuff, a short wrist run continuing the glove
    axis, then the rounded bend toward the elbow. B (back of hand) orients the flattened wrist section."""
    F = Vector(F).normalized(); p0 = Vector(hand_pos) - F * SLEEVE_START
    major = None
    if B is not None:
        B = Vector(B); B = (B - F * B.dot(F)).normalized(); major = F.cross(B)
    return arm_bent('Arm', p0, p0 - F * 0.022, elbow, r0, r1, major)

def _sleeve_path(p0, via, p1):
    """Polyline p0 -> via -> p1 with the corner rounded (quadratic Bezier). Returns (at(u) -> (pos, tangent), total)."""
    d1, d2 = via - p0, p1 - via; L1, L2 = d1.length, d2.length; n1, n2 = d1 / L1, d2 / L2
    k = min(0.035, L1 * 0.75, L2 * 0.35)
    a, b = via - n1 * k, via + n2 * k
    Lb = (2 * k + (a - b).length) / 2                              # ~arc length of the corner
    total = (L1 - k) + Lb + (L2 - k)
    def at(u):
        if u <= L1 - k: return p0 + n1 * u, n1
        if u >= L1 - k + Lb: return b + n2 * (u - (L1 - k + Lb)), n2
        t = (u - (L1 - k)) / Lb
        return (1 - t) ** 2 * a + 2 * (1 - t) * t * via + t * t * b, ((1 - t) * (via - a) + t * (b - via)).normalized()
    return at, total, L1

def arm_bent(name, p0, via, p1, r0=0.028, r1=0.038, major=None):
    """Sleeved forearm with a bent wrist: one loft along p0 -> via -> p1 (elbow) with the corner at via rounded.
    Elliptical cross-section (major axis = `major`, default the bend-plane normal): flattened at the wrist, rounder
    and wider toward the elbow. A rolled hem over the glove cuff at p0, four soft ring folds along the wrist run,
    two more just before the elbow."""
    p0, via, p1 = Vector(p0), Vector(via), Vector(p1)
    at, total, L1 = _sleeve_path(p0, via, p1)
    n1 = (via - p0).normalized(); n2 = (p1 - via).normalized()
    if major is None:
        N = n1.cross(n2)
        major = N.normalized() if N.length > 0.15 else n1.orthogonal()
    major = Vector(major).normalized()
    st = [(-0.003, 1.03), (0.002, 1.15), (0.009, 1.15), (0.014, 1.04), (0.018, 1.00)]          # rolled hem
    for i in range(4): st += [(0.024 + i * 0.012, 1.065), (0.030 + i * 0.012, 0.99)]           # wrist folds
    u = 0.066
    while u + 0.03 < total - 0.05: u += 0.03; st.append((u, 1.0))
    st += [(total - 0.046, 1.0), (total - 0.038, 1.045), (total - 0.030, 0.995), (total - 0.022, 1.04), (total - 0.014, 1.0), (total, 1.0)]
    st += [(L1 + du, 1.0) for du in (-0.02, -0.01, 0.0, 0.01, 0.02)]                             # resolve the bend
    st.sort(); stations = []; last = -1
    for (u, m) in st:
        if u > total or u - last < 0.0025: continue
        last = u
        pos, tan = at(u)
        f = min(1.0, max(0.0, (u - 0.02) / max(0.05, total - 0.02))); f = f * f * (3 - 2 * f)
        r = (r0 + (r1 - r0) * f) * m; ratio = 1.22 - 0.14 * f
        stations.append((pos, tan, r / ratio, r * ratio, 0.0, major))
    o = tube(name, stations, M_SLEEVE, n=20)
    return join([o], name, uv_scale=14.0, wear=False)

# ------------------------------------------------------------ AK-47
def build_ak47():
    reset(); P = []
    RY0, RY1 = -0.09, 0.19                       # receiver rear / front; barrel axis z = 0
    # --- stamped receiver (blued) + rounded dust cover (lighter) + rear tang
    P.append(box('recv', 0, (RY0 + RY1) / 2, -0.010, 0.038, RY1 - RY0, 0.044, M_STEEL, bevel=0.003, seg=2))     # z -0.032..0.012
    P.append(box('dustcover', 0, (RY0 + 0.012 + RY1) / 2, 0.023, 0.036, RY1 - RY0 - 0.012, 0.024, M_STEEL_L, bevel=0.009, seg=3))
    P.append(box('recv_tang', 0, RY0 - 0.010, -0.012, 0.040, 0.024, 0.050, M_BLACK, bevel=0.004, seg=2))
    P.append(box('spring_btn', 0, RY0 - 0.006, 0.024, 0.016, 0.010, 0.012, M_BLACK, bevel=0.003, seg=2))
    # rivets (both sides), ejection port, bolt-carrier rail + charging handle, selector lever
    for (ry, rz) in ((-0.072, -0.004), (-0.072, -0.026), (-0.010, -0.027), (0.040, -0.027), (0.096, -0.027), (0.150, -0.027), (0.172, -0.004), (0.082, -0.002), (0.020, -0.002)):
        for sx in (-1, 1): P.append(cyl('rivet', sx * 0.0195, ry, rz, 0.0032, 0.0028, M_BLACK, axis='X', verts=8))
    P.append(box('eject_port', 0.0185, 0.078, 0.014, 0.003, 0.046, 0.016, M_BLACK))
    P.append(box('carrier_rail', 0.0215, -0.004, 0.004, 0.005, 0.062, 0.010, M_BLACK, bevel=0.0015))
    P.append(box('charging', 0.031, -0.012, 0.005, 0.017, 0.020, 0.012, M_BLACK, bevel=0.003, seg=2))
    P.append(box('selector_bar', 0.0215, 0.052, -0.001, 0.004, 0.128, 0.007, M_BLACK, bevel=0.0015))
    P.append(box('selector_tab', 0.0245, -0.012, -0.012, 0.005, 0.020, 0.030, M_BLACK, bevel=0.002, rot=(-35, 0, 0)))
    P.append(cyl('selector_pivot', 0.0225, 0.114, -0.006, 0.010, 0.004, M_BLACK, axis='X', verts=12))
    # rear sight block + tangent leaf on the front of the dust cover
    P.append(box('rearsight_base', 0, 0.166, 0.041, 0.032, 0.048, 0.016, M_BLACK, bevel=0.003, seg=2))
    P.append(box('rearsight_ramp', 0, 0.140, 0.050, 0.024, 0.032, 0.006, M_BLACK, bevel=0.002, rot=(12, 0, 0)))
    P.append(box('rearsight_leaf', 0, 0.180, 0.056, 0.022, 0.006, 0.012, M_BLACK, bevel=0.001))
    P.append(box('rearsight_slider', 0, 0.152, 0.057, 0.015, 0.012, 0.007, M_BLACK, bevel=0.001))
    # magwell lip, mag catch paddle, trigger guard, trigger
    P.append(box('magwell', 0, 0.075, -0.037, 0.034, 0.080, 0.012, M_STEEL, bevel=0.002))
    P.append(box('mag_catch', 0, 0.026, -0.044, 0.014, 0.022, 0.024, M_BLACK, bevel=0.003, rot=(15, 0, 0)))
    P.append(box('tguard_bar', 0, 0.010, -0.058, 0.010, 0.076, 0.004, M_BLACK, bevel=0.001))
    P.append(box('tguard_front', 0, 0.046, -0.047, 0.010, 0.006, 0.026, M_BLACK, bevel=0.001))
    P.append(box('tguard_rear', 0, -0.026, -0.045, 0.012, 0.010, 0.026, M_BLACK, bevel=0.002))
    P.append(box('trigger', 0, 0.006, -0.043, 0.006, 0.005, 0.020, M_BLACK, rot=(15, 0, 0)))
    P.append(box('trigger_tip', 0, 0.010, -0.052, 0.006, 0.005, 0.010, M_BLACK, rot=(40, 0, 0)))
    # --- pistol grip: swept-back bakelite loft with a palm swell and flared base
    P.append(loft('grip', [ring_xy(cy, cz, w, d, r=0.007) for (cy, cz, w, d) in
                           ((-0.037, -0.030, 0.0145, 0.020), (-0.052, -0.066, 0.0158, 0.0225), (-0.070, -0.102, 0.0168, 0.0240), (-0.088, -0.132, 0.0175, 0.0265))], M_BAKE))
    P.append(box('grip_cap', 0, -0.089, -0.137, 0.037, 0.055, 0.008, M_BLACK, bevel=0.003, rot=(-22, 0, 0)))
    # --- wooden handguards: lower (palm swell, wider) + upper (hugs the gas tube), retaining ferrules
    P.append(loft('hg_lower', [ring_xz(y, hw, zt, zb, rt=0.004, rb=0.011) for (y, hw, zt, zb) in
                               ((0.192, 0.0200, -0.006, -0.034), (0.225, 0.0238, -0.004, -0.041), (0.265, 0.0248, -0.004, -0.043), (0.305, 0.0228, -0.004, -0.039), (0.338, 0.0200, -0.006, -0.033))], M_WOOD))
    P.append(loft('hg_upper', [ring_xz(y, hw, zt, zb, rt=0.013, rb=0.003) for (y, hw, zt, zb) in
                               ((0.203, 0.0160, 0.044, 0.014), (0.240, 0.0172, 0.047, 0.014), (0.290, 0.0172, 0.047, 0.014), (0.325, 0.0160, 0.044, 0.014))], M_WOOD))
    P.append(cyl('gastube', 0, 0.270, 0.030, 0.0100, 0.190, M_BLACK, verts=14))
    P.append(box('hg_ferrule_r', 0, 0.190, -0.014, 0.048, 0.014, 0.052, M_BLACK, bevel=0.002))
    P.append(box('hg_ferrule_ru', 0, 0.199, 0.029, 0.036, 0.010, 0.032, M_BLACK, bevel=0.002))
    P.append(box('hg_retainer', 0, 0.345, -0.013, 0.046, 0.016, 0.046, M_BLACK, bevel=0.003, seg=2))
    P.append(box('hg_retainer_u', 0, 0.333, 0.029, 0.036, 0.010, 0.032, M_BLACK, bevel=0.002))
    P.append(box('hg_lever', 0.027, 0.350, -0.020, 0.006, 0.024, 0.010, M_BLACK, bevel=0.002, rot=(20, 0, 0)))
    # --- barrel group: barrel, cleaning rod, gas block, hooded front sight, slant brake
    P.append(cyl('barrel', 0, 0.4275, 0.0, 0.0085, 0.475, M_BLACK, verts=16))
    P.append(cyl('cleaning_rod', 0, 0.500, -0.0145, 0.0028, 0.330, M_STEEL_L, verts=8))
    P.append(box('gasblock', 0, 0.381, 0.002, 0.026, 0.038, 0.030, M_BLACK, bevel=0.003, seg=2))
    P.append(box('gasblock_top', 0, 0.381, 0.030, 0.024, 0.036, 0.028, M_BLACK, bevel=0.006, seg=3))
    P.append(box('bayonet_lug', 0, 0.368, -0.020, 0.012, 0.016, 0.014, M_BLACK, bevel=0.002))
    P.append(cyl('sling_loop_f', -0.019, 0.386, -0.004, 0.0065, 0.010, M_BLACK, axis='X', verts=10))
    P.append(cyl('frontsight_collar', 0, 0.632, 0.0, 0.0125, 0.036, M_BLACK, verts=16))
    P.append(box('frontsight_base', 0, 0.632, 0.012, 0.024, 0.034, 0.014, M_BLACK, bevel=0.003, seg=2))
    for sx in (-1, 1): P.append(box('frontsight_ear', sx * 0.0108, 0.632, 0.035, 0.0035, 0.020, 0.036, M_BLACK, bevel=0.001, rot=(0, -sx * 9, 0)))
    P.append(cyl('frontsight_post', 0, 0.632, 0.034, 0.0018, 0.032, M_BLACK, axis='Z', verts=8))
    P.append(cyl('muzzle_thread', 0, 0.678, 0.0, 0.0105, 0.026, M_BLACK, verts=16))
    brake = cyl('muzzle_brake', 0, 0.712, 0.0, 0.0118, 0.044, M_BLACK, verts=16)
    bm = bmesh.new(); bm.from_mesh(brake.data)                       # slant the front face (AKM compensator: opens up-right)
    for v in bm.verts:
        if v.co.z > 0: v.co.z += 0.010 * (v.co.y / 0.0118) + 0.006 * (v.co.x / 0.0118)   # local: cylinder axis is Z before rotation
    bm.to_mesh(brake.data); bm.free(); P.append(brake)
    P.append(cyl('bore', 0, 0.716, 0.0, 0.0086, 0.004, M_RUBBER, verts=12))
    # --- laminate stock: tapered loft dropping toward the toe, steel butt plate, sling swivel, cross bolt
    P.append(loft('stock', [ring_xz(y, hw, zt, zb, rt=0.009, rb=0.009) for (y, hw, zt, zb) in
                            ((-0.096, 0.0190, 0.011, -0.033), (-0.160, 0.0190, 0.000, -0.052), (-0.240, 0.0195, -0.012, -0.075), (-0.310, 0.0210, -0.020, -0.099), (-0.345, 0.0210, -0.022, -0.108))], M_WOOD))
    P.append(box('stock_collar', 0, -0.100, -0.011, 0.041, 0.012, 0.048, M_BLACK, bevel=0.002))
    P.append(box('buttplate', 0, -0.349, -0.065, 0.0445, 0.009, 0.092, M_BLACK, bevel=0.002, rot=(-6, 0, 0)))
    P.append(cyl('sling_swivel', -0.023, -0.270, -0.078, 0.0065, 0.010, M_BLACK, axis='X', verts=10))
    P.append(cyl('cross_bolt', 0.0205, -0.200, -0.028, 0.004, 0.003, M_BLACK, axis='X', verts=8))
    join(P, 'AK47')

    # --- curved 30-round magazine (own node: reload animation): arc loft with side ribs and a floor plate
    mp = []
    prof = []                                                        # profile in (x, n): n = local front-back axis
    w, h = 0.0155, 0.0350
    side = [(w, -0.0175), (w + 0.0022, -0.0150), (w + 0.0022, -0.0105), (w, -0.0080), (w, 0.0080), (w + 0.0022, 0.0105), (w + 0.0022, 0.0150), (w, 0.0175)]
    prof = [(w - 0.003, h), (w, h - 0.004)] + side[::-1] + [(w, -h + 0.004), (w - 0.003, -h), (-w + 0.003, -h), (-w, -h + 0.004)] + [(-x, n) for (x, n) in side] + [(-w, h - 0.004), (-w + 0.003, h)]
    secs = []
    p = Vector((0, 0.062, -0.026)); th0, th1, N, L = math.radians(9), math.radians(62), 9, 0.205
    for i in range(N + 1):
        th = th0 + (th1 - th0) * i / N
        nvec = Vector((0, math.cos(th), math.sin(th)))                # local front axis of the mag at this station
        secs.append(ring(p, (1, 0, 0), nvec, prof))
        if i < N:
            thm = th0 + (th1 - th0) * (i + 0.5) / N
            p = p + Vector((0, math.sin(thm), -math.cos(thm))) * (L / N)
    body = loft('mag_body', secs, M_STEEL_L); mp.append(body)             # lighter than the receiver so it reads from behind
    # floor plate: slightly larger slab along the end frame
    tvec = Vector((0, math.sin(th1), -math.cos(th1))); nvec = Vector((0, math.cos(th1), math.sin(th1)))
    fp_prof = rprof(w + 0.0022, h + 0.0025, 0.003, 2)
    mp.append(loft('mag_floor', [ring(p - tvec * 0.002, (1, 0, 0), nvec, fp_prof), ring(p + tvec * 0.009, (1, 0, 0), nvec, fp_prof)], M_BLACK))
    join(mp, 'Mag')
    # --- hands + sleeves
    HR = GRIP_R((0.028, -0.078, -0.080))
    grip_hand_r(HR); arm_from(HR, GRIP_F, (0.12, -0.34, -0.30), B=GRIP_B).name = 'ArmR'
    print('AK index tip', tuple(round(v, 3) for v in HAND_TIPS['HandR']['index']), 'trigger ~ (0.004, 0.010, -0.050)')
    HL = (-0.016, 0.265, -0.062)                                                                                   # palm under the lower handguard
    support_hand_l(HL); arm_from(HL, F_SUPPORT, (-0.20, 0.15, -0.30), B=SUPPORT_B).name = 'ArmL'   # forearm from the lower-left (bent wrist), clear of the mag
    empty('Muzzle', 0, 0.736, 0.004); empty('Eject', 0.03, 0.09, 0.02)
    export('ak47')

# ------------------------------------------------------------ AWP
def build_awp():
    reset(); P = []
    ZB, ZS = 0.030, 0.088                        # barrel axis, scope axis
    # --- green polymer chassis: tapered forend, action body, raked grip, thumbhole stock (two bars + butt block)
    P.append(loft('forend', [ring_xz(y, hw, zt, zb, rt=0.007, rb=0.013) for (y, hw, zt, zb) in
                             ((0.10, 0.0245, 0.018, -0.047), (0.24, 0.0238, 0.016, -0.045), (0.38, 0.0215, 0.012, -0.040), (0.47, 0.0195, 0.008, -0.034), (0.52, 0.0180, 0.004, -0.028))], M_GREEN))
    P.append(box('body', 0, -0.010, -0.012, 0.050, 0.235, 0.070, M_GREEN, bevel=0.011, seg=3))                   # y -0.127..0.107
    P.append(loft('grip', [ring_xy(cy, cz, w, d, r=0.008) for (cy, cz, w, d) in
                           ((-0.036, -0.045, 0.0170, 0.0240), (-0.052, -0.085, 0.0180, 0.0265), (-0.068, -0.125, 0.0188, 0.0300), (-0.080, -0.150, 0.0192, 0.0340))], M_GREEN))
    P.append(box('grip_cap', 0, -0.082, -0.154, 0.040, 0.070, 0.008, M_GREEN, bevel=0.003, rot=(-22, 0, 0)))
    P.append(box('stock_upper', 0, -0.250, 0.004, 0.040, 0.285, 0.040, M_GREEN, bevel=0.011, seg=3, rot=(-3, 0, 0)))   # comb bar
    P.append(box('stock_lower', 0, -0.250, -0.130, 0.040, 0.300, 0.040, M_GREEN, bevel=0.011, seg=3, rot=(5, 0, 0)))   # toe bar
    P.append(box('stock_butt', 0, -0.378, -0.062, 0.042, 0.036, 0.180, M_GREEN, bevel=0.011, seg=3))                    # joins the bars -> thumbhole between
    P.append(box('stock_web', 0, -0.128, -0.070, 0.036, 0.030, 0.10, M_GREEN, bevel=0.008, seg=3))                      # behind the grip
    P.append(box('cheek', 0, -0.250, 0.046, 0.036, 0.150, 0.030, M_GREEN, bevel=0.010, seg=3))
    for y in (-0.205, -0.295): P.append(cyl('cheek_post', 0, y, 0.030, 0.006, 0.030, M_BLACK, axis='Z', verts=10))
    for i in range(3): P.append(box('spacer', 0, -0.399 - i * 0.006, -0.062, 0.043, 0.005, 0.182, M_BLACK if i % 2 == 0 else M_GREEN, bevel=0.001))
    P.append(box('buttpad', 0, -0.426, -0.062, 0.045, 0.022, 0.186, M_RUBBER, bevel=0.007, seg=3))
    # trigger group + magazine well
    P.append(box('tguard_bar', 0, 0.000, -0.062, 0.012, 0.084, 0.004, M_BLACK, bevel=0.001))
    P.append(box('tguard_front', 0, 0.040, -0.052, 0.012, 0.006, 0.022, M_BLACK, bevel=0.001))
    P.append(box('tguard_rear', 0, -0.040, -0.052, 0.012, 0.006, 0.022, M_BLACK, bevel=0.001))
    P.append(box('trigger', 0, 0.004, -0.050, 0.006, 0.005, 0.018, M_BLACK, rot=(14, 0, 0)))
    P.append(box('magwell', 0, 0.100, -0.050, 0.036, 0.096, 0.010, M_BLACK, bevel=0.002))
    # --- steel action: receiver tube with a flat rail top, ejection port, heavy tapered barrel, muzzle brake
    P.append(cyl('receiver', 0, 0.020, ZB, 0.018, 0.300, M_STEEL, verts=20))                                 # y -0.13..0.17
    P.append(box('recv_flat', 0, 0.020, ZB + 0.012, 0.030, 0.300, 0.012, M_STEEL, bevel=0.003))
    P.append(box('rail', 0, 0.040, ZB + 0.022, 0.021, 0.200, 0.008, M_BLACK, bevel=0.002))
    for i in range(9): P.append(box('rail_slot', 0, -0.040 + i * 0.020, ZB + 0.0265, 0.022, 0.006, 0.002, M_STEEL))
    P.append(box('eject', 0.0175, 0.045, ZB + 0.002, 0.004, 0.060, 0.016, M_BLACK))
    P.append(cyl('barrel', 0, 0.590, ZB, 0.0148, 0.860, M_BLACK, verts=20, r2=0.0125))                      # y 0.16..1.02
    P.append(cyl('barrel_collar', 0, 0.175, ZB, 0.0165, 0.030, M_BLACK, verts=20))
    P.append(cyl('brake', 0, 1.055, ZB, 0.0175, 0.075, M_BLACK, verts=20))
    P.append(cyl('brake_cone', 0, 1.098, ZB, 0.0175, 0.012, M_BLACK, verts=20, r2=0.013))
    for i in range(3):
        y = 1.036 + i * 0.019
        for sx in (-1, 1): P.append(box('brake_port', sx * 0.0165, y, ZB + 0.002, 0.004, 0.009, 0.014, M_RUBBER))
        P.append(box('brake_port_t', 0, y, ZB + 0.0165, 0.010, 0.009, 0.004, M_RUBBER))
    P.append(cyl('bore', 0, 1.103, ZB, 0.009, 0.004, M_RUBBER, verts=12))
    # --- scope: tube, objective + ocular bells, zoom ring, turret saddle with three turrets, rings on the rail
    P.append(cyl('scope_tube', 0, 0.050, ZS, 0.0155, 0.200, M_BLACK, verts=24))
    P.append(cyl('scope_obj', 0, 0.200, ZS, 0.0160, 0.100, M_BLACK, verts=24, r2=0.0280))
    P.append(cyl('scope_obj_body', 0, 0.275, ZS, 0.0280, 0.050, M_BLACK, verts=24))
    P.append(cyl('scope_eye_bell', 0, -0.080, ZS, 0.0210, 0.060, M_BLACK, verts=24, r2=0.0155))
    P.append(cyl('scope_eye', 0, -0.135, ZS, 0.0210, 0.050, M_BLACK, verts=24))
    P.append(cyl('scope_eye_rubber', 0, -0.163, ZS, 0.0228, 0.008, M_RUBBER, verts=24))
    P.append(cyl('eye_bezel', 0, -0.151, ZS, 0.0222, 0.010, M_STEEL, verts=24, bevel=0.002))              # bright eyepiece ring
    P.append(cyl('ScopeOcularMesh', 0, -0.1675, ZS, 0.0180, 0.003, M_GLASS, verts=24))                  # ocular lens (seen from behind)
    P.append(cyl('obj_bezel', 0, 0.2965, ZS, 0.0287, 0.007, M_STEEL, verts=24, bevel=0.0015))            # objective bezel
    P.append(cyl('zoom_ring', 0, -0.045, ZS, 0.0195, 0.024, M_BLACK, verts=24))
    P.append(cyl('saddle', 0, 0.050, ZS, 0.0200, 0.038, M_BLACK, verts=24))
    P.append(cyl('turret_elev', 0, 0.050, ZS + 0.022, 0.0125, 0.024, M_BLACK, axis='Z', verts=16))
    P.append(cyl('turret_elev_cap', 0, 0.050, ZS + 0.036, 0.0105, 0.006, M_STEEL, axis='Z', verts=16))
    for sx in (-1, 1):
        P.append(cyl('turret_side', sx * 0.022, 0.050, ZS, 0.0125, 0.024, M_BLACK, axis='X', verts=16))
        P.append(cyl('turret_side_cap', sx * 0.036, 0.050, ZS, 0.0105, 0.006, M_STEEL, axis='X', verts=16))
    for y in (-0.010, 0.120):
        P.append(cyl('ring', 0, y, ZS, 0.0195, 0.016, M_BLACK, verts=24))
        P.append(box('ringbase', 0, y, (ZS + ZB + 0.030) / 2, 0.024, 0.016, ZS - (ZB + 0.030) + 0.004, M_BLACK, bevel=0.002))
        for sx in (-1, 1): P.append(cyl('ring_screw', sx * 0.021, y, ZS - 0.012, 0.003, 0.010, M_STEEL, axis='Z', verts=8))
    P.append(cyl('ScopeLensMesh', 0, 0.301, ZS, 0.0262, 0.003, M_GLASS, verts=24))
    join(P, 'AWP')
    # --- bolt (own node: 'bolt_knob' is pulled back by the bolt-cycle animation): shroud, shaft, bent handle, ball
    a = Vector((0.016, -0.075, ZB)); b = Vector((0.056, -0.098, ZB - 0.030))
    bolt = join([cyl('bolt_shroud', 0, -0.165, ZB, 0.0120, 0.070, M_STEEL, verts=16),
                 cyl('bolt_shaft', 0, -0.100, ZB, 0.0095, 0.070, M_STEEL, verts=12),
                 seg_cyl('bolt_handle', a, b, 0.0055, M_STEEL, verts=12),
                 sphere('bolt_ball', b.x, b.y, b.z, 0.0125, M_BLACK, segs=14, rings=8)], 'bolt_knob', origin_zero=True)
    # --- magazine
    join([box('magb', 0, 0.100, -0.064, 0.031, 0.086, 0.052, M_BLACK, bevel=0.003),
          box('mag_floor', 0, 0.100, -0.092, 0.034, 0.090, 0.006, M_RUBBER, bevel=0.002)], 'Mag')
    # --- hands + sleeves
    HR = GRIP_R((0.031, -0.082, -0.096))
    grip_hand_r(HR); arm_from(HR, GRIP_F, (0.12, -0.36, -0.32), B=GRIP_B).name = 'ArmR'
    print('AWP index tip', tuple(round(v, 3) for v in HAND_TIPS['HandR']['index']), 'trigger ~ (0.004, 0.006, -0.050)')
    HL = (-0.016, 0.330, -0.062)
    support_hand_l(HL); arm_from(HL, F_SUPPORT, (-0.20, 0.21, -0.30), B=SUPPORT_B).name = 'ArmL'
    empty('Muzzle', 0, 1.106, ZB); empty('Eject', 0.03, 0.045, 0.05); empty('ScopeLens', 0, 0.303, ZS)
    export('awp')

# ------------------------------------------------------------ knife
def blade(name, L=0.165, h=0.0165, t=0.0050):
    """Clip-point blade lofted along +Y from the guard (y=0) to the tip (y=L). Cross-section: flat-ground faces with a
    shallow fuller on each side (knife_blade), a two-plane chamfer along the cutting edge (knife_edge, kept as hard edges
    so the polished strip reads as a line), flat spine. Edge at -Z, spine at +Z."""
    def profile(y):
        f = min(y / L, 1.0)
        ze = -h if f < 0.55 else -h + (h + 0.0085) * ((f - 0.55) / 0.45) ** 1.7      # belly sweeps up to the point
        zs = h if f < 0.66 else h - (h - 0.0085) * ((f - 0.66) / 0.34) ** 1.3        # clip drops to the point
        th = t * (1 - 0.7 * f ** 2)
        H = max(zs - ze, 0.0008)
        c = min(0.0058, H * 0.42)                                                    # chamfer height
        df = 0.0011 * (1.0 if f < 0.58 else max(0.0, 1 - (f - 0.58) / 0.18))          # fuller depth, fades before the tip
        zf0, zf1 = ze + c + 0.0035, zs - 0.0040
        if zf1 - zf0 < 0.004: zf0 = zf1 = (ze + c + zs) / 2; df = 0.0
        x = th / 2; g = min(0.0012, (zf1 - zf0) * 0.4)
        # (x, z, material of the segment that starts here): 1 = knife_edge chamfer, 0 = knife_blade
        pts = [(0, ze, 1), (x, ze + c, 0), (x, zf0, 0), (x - df, zf0 + g, 0), (x - df, zf1 - g, 0), (x, zf1, 0), (x * 0.75, zs, 0),
               (-x * 0.75, zs, 0), (-x, zf1, 0), (-x + df, zf1 - g, 0), (-x + df, zf0 + g, 0), (-x, zf0, 0), (-x, ze + c, 1)]
        return [(Vector((px, y, pz)), mi) for (px, pz, mi) in pts]
    bm = bmesh.new()
    ys = (0.0, 0.025, 0.055, 0.085, 0.105, 0.120, 0.135, 0.147, 0.156, 0.162)
    rings = [[(bm.verts.new(p), mi) for (p, mi) in profile(y)] for y in ys]
    for a, b in zip(rings, rings[1:]):
        n = len(a)
        for i in range(n):
            fc = bm.faces.new((a[i][0], a[(i + 1) % n][0], b[(i + 1) % n][0], b[i][0])); fc.material_index = a[i][1]
    tip = bm.verts.new(Vector((0, L, 0.0085)))
    last = rings[-1]; n = len(last)
    for i in range(n):
        fc = bm.faces.new((last[i][0], last[(i + 1) % n][0], tip)); fc.material_index = last[i][1]
    bm.faces.new([v for (v, _) in rings[0]][::-1])                                    # ricasso end (hidden in the guard)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o)
    o.data.materials.append(M_BLADE); o.data.materials.append(M_EDGE)
    return o

def view_to_model(v, rot):
    """three.js camera-space direction -> Blender model direction for a weapon group posed with rotation.set(*rot) (Euler XYZ).
    glTF export maps Blender (x, y, z) -> (x, z, -y)."""
    rx, ry, rz = rot
    R = Matrix.Rotation(rx, 3, 'X') @ Matrix.Rotation(ry, 3, 'Y') @ Matrix.Rotation(rz, 3, 'Z')   # three Euler 'XYZ' = Rx Ry Rz
    g = R.transposed() @ Vector(v)                                                     # camera -> glTF model
    return Vector((g.x, -g.z, g.y)).normalized()                                       # glTF -> Blender

def three_rot(blade_v, B_v):
    """three.js Euler 'XYZ' (rx, ry, rz) that poses the knife group so its blade (Blender +Y) points along camera-space
    blade_v and the knuckles (Blender +X) along B_v (made perpendicular to blade_v). Group matrix R = Rx Ry Rz has the
    view images of the glTF axes as columns: X -> B_v, Y (Blender Z, spine) -> B_v x blade_v, Z (Blender -Y) -> -blade_v.
    mathutils to_euler('XYZ') factors M = Rz Ry Rx, so factor R^T and negate."""
    blade_v = Vector(blade_v).normalized(); B_v = Vector(B_v); B_v = (B_v - blade_v * B_v.dot(blade_v)).normalized()
    R = Matrix((B_v, B_v.cross(blade_v), -blade_v)).transposed()
    e = R.transposed().to_euler('XYZ')
    return (round(-e.x, 3), round(-e.y, 3), round(-e.z, 3))

# CS2-style knife idle, designed in camera space (x right, y up, z toward the viewer): blade up-left and a little away,
# knuckles toward the camera-right so the flat of the blade and the back of the hand show. -> WeaponDefs knife.view.rot
KNIFE_BLADE_V = (-0.55, 0.75, -0.37)
KNIFE_KNUCKLE_V = (0.65, 0.15, 0.70)
KNIFE_ROT = three_rot(KNIFE_BLADE_V, KNIFE_KNUCKLE_V)
KNIFE_ELBOW_V = (0.45, -0.85, 0.22)            # forearm leaves the bent wrist toward the lower-right corner of the screen

def build_knife():
    reset(); P = []
    # --- knife: blade forward (+Y) with the edge down (-Z); the handle runs back along -Y and lives inside the fist
    HY0, HY1 = -0.080, -0.004                      # handle span: ~1.2 cm shows below the little finger, guard sits above the index
    P.append(loft('handle', [ring((0, y, 0), (1, 0, 0), (0, 0, 1), rprof(w, d, 0.0065, 3)) for (y, w, d) in
                             ((HY0, 0.0098, 0.0135), (-0.060, 0.0110, 0.0152), (-0.030, 0.0110, 0.0152), (HY1, 0.0095, 0.0130))], M_HANDLE))
    P.append(box('pommel', 0, HY0 - 0.0055, 0, 0.024, 0.011, 0.032, M_STEEL, bevel=0.003, seg=2))
    P.append(cyl('lanyard', 0, HY0 - 0.0055, 0, 0.0028, 0.026, M_RUBBER, axis='X', verts=8))
    P.append(box('guard', 0, 0.0005, 0, 0.011, 0.007, 0.050, M_STEEL, bevel=0.0018, seg=2))
    P.append(blade('blade'))
    join(P, 'Knife')
    # --- hammer grip: handle across the palm (hand-local X), fingers leave the palm toward the edge (-Z) and curl round
    # the handle, knuckles +X. The group rotation KNIFE_ROT (WeaponDefs) then gives the CS2 idle framing; the forearm
    # continues the glove cuff for a few cm and bends at the wrist toward the lower-right corner of the screen.
    print('knife view.rot =', KNIFE_ROT)
    S = 0.85
    F = Vector((0, 0, -1)); B = Vector((1, 0, 0))
    handle_c = Vector((0, -0.046, 0))              # handle axis point under the palm centre (thumb knuckle stays behind the guard)
    ly, lz = 0.038 * S, -0.031 * S                 # hand-local centre of the space the curled fingers enclose
    hp = handle_c - F * ly - B * lz
    hand('HandR', hp, F=F, B=B, right=True, curl=1.12, thumb=THUMB_LOCK, scale=S)
    print('knife thumb tip', tuple(round(v, 3) for v in HAND_TIPS['HandR']['thumb']), 'guard y=0 (must stay < -0.006)')
    wrist = hp - F * (SLEEVE_START * S); via = wrist - F * 0.016   # bend sits just past the glove cuff, under the sleeve hem
    elbow = via + view_to_model(KNIFE_ELBOW_V, KNIFE_ROT) * 0.32
    arm_bent('ArmR', wrist, via, elbow, r0=0.027, r1=0.036, major=F.cross(B))
    empty('Muzzle', 0, 0.165, 0.0085)
    export('knife')

if __name__ == '__main__':
    build_ak47(); build_awp(); build_knife()
    print('weapons exported')
