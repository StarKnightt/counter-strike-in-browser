# Blender build script for the CS2-inspired Dust2 A-site.
# Executed inside Blender (via MCP): exec(open(r"C:\Code\cs2-dust2\tools\build_map.py").read())
# Coordinates: X east, Y north, Z up (meters). Exported glTF converts to Y-up.
import bpy, bmesh, math, os, random
from mathutils import Vector, Matrix

ROOT = r"C:\Code\cs2-dust2"
TEX = os.path.join(ROOT, "tools", "texcache")
OUT_GLB = os.path.join(ROOT, "assets_src", "dust2_a.glb")   # source export (80 MB); the runtime loads public/models/dust2_a.webp.glb (gltf-transform webp of this)

# ---------------------------------------------------------------- scene reset
def reset_scene():
    if bpy.context.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.curves, bpy.data.lights, bpy.data.cameras):
        for b in list(coll):
            try: coll.remove(b)
            except Exception: pass

reset_scene()

# ---------------------------------------------------------------- materials
MATS = {}

def load_img(path, srgb):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    return img

def tex_mat(name, tid, scale, surface, metallic=0.0, nor_strength=1.0, cyl=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nodes, links = nt.nodes, nt.links
    for n in list(nodes): nodes.remove(n)
    out = nodes.new('ShaderNodeOutputMaterial'); out.location = (500, 0)
    bsdf = nodes.new('ShaderNodeBsdfPrincipled'); bsdf.location = (200, 0)
    links.new(bsdf.outputs[0], out.inputs[0])
    bsdf.inputs['Metallic'].default_value = metallic
    diff = os.path.join(TEX, f"{tid}_graded.jpg")
    if not os.path.exists(diff): diff = os.path.join(TEX, f"{tid}_diffao.jpg")
    if not os.path.exists(diff): diff = os.path.join(TEX, f"{tid}_diff.jpg")
    nor = os.path.join(TEX, f"{tid}_nor.jpg")
    rough = os.path.join(TEX, f"{tid}_rough.jpg")
    t = nodes.new('ShaderNodeTexImage'); t.image = load_img(diff, True); t.location = (-400, 300)
    links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
    if os.path.exists(rough):
        r = nodes.new('ShaderNodeTexImage'); r.image = load_img(rough, False); r.location = (-400, 0)
        links.new(r.outputs['Color'], bsdf.inputs['Roughness'])
    else:
        bsdf.inputs['Roughness'].default_value = 0.85
    if os.path.exists(nor):
        n = nodes.new('ShaderNodeTexImage'); n.image = load_img(nor, False); n.location = (-400, -300)
        nm = nodes.new('ShaderNodeNormalMap'); nm.location = (-100, -300); nm.inputs['Strength'].default_value = nor_strength
        links.new(n.outputs['Color'], nm.inputs['Color']); links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    m['uv_scale'] = scale
    m['surface'] = surface
    m['cyl'] = 1 if cyl else 0
    MATS[name] = m
    return m

def flat_mat(name, color, rough=0.6, metallic=0.0, surface='concrete'):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metallic
    m['uv_scale'] = 1.0; m['surface'] = surface; m['cyl'] = 0
    MATS[name] = m
    return m

M_WALL   = tex_mat('wall_plaster',   'beige_wall_002',        3.0, 'concrete')
M_WALL2  = tex_mat('wall_worn',      'worn_plaster_wall',     3.0, 'concrete')
M_WALL3  = tex_mat('wall_stoneplaster','plaster_stone_wall_01',3.0, 'concrete')
M_STONE  = tex_mat('stone_base',     'stone_wall_03',         2.2, 'concrete')
M_GROUND = tex_mat('ground_sand',    'sandy_gravel',          3.0, 'sand')
M_GROUND2= tex_mat('ground_dry',     'dry_ground_01',         3.0, 'sand')
M_ROAD   = tex_mat('ground_road',    'worn_asphalt',          3.5, 'concrete')
M_COBBLE = tex_mat('ground_cobble',  'cobblestone_04',        2.6, 'concrete')
M_PAVE   = tex_mat('ground_pave',    'concrete_pavement',     2.2, 'concrete')
M_PLANK  = tex_mat('crate_planks',   'weathered_planks',      1.5, 'wood')
M_PLANK2 = tex_mat('crate_planks2',  'wood_planks_dirt',      1.5, 'wood')
M_WOOD   = tex_mat('wood_beam',      'rough_wood',            1.0, 'wood')
M_BARREL = tex_mat('barrel_white',   'rusty_metal_02',        1.0, 'metal', metallic=0.6, cyl=True)
M_BARREL2= tex_mat('barrel_green',   'green_metal_rust',      1.0, 'metal', metallic=0.5, cyl=True)
M_DOOR   = tex_mat('door_blue',      'blue_painted_planks',   1.2, 'wood')
M_IRON   = tex_mat('iron_sheet',     'corrugated_iron_02',    1.0, 'metal', metallic=0.7)
M_DARK   = flat_mat('dark_interior', (0.045, 0.040, 0.034), rough=0.95)   # window/door interiors: deep shade, not pure black
M_GLASS  = flat_mat('glass_dark',    (0.04, 0.05, 0.06), rough=0.25, metallic=0.6)
M_CAR    = tex_mat('car_paint',      'worn_plaster_wall',     1.2, 'metal', metallic=0.15); M_CAR['tint'] = [0.46, 0.58, 0.66]   # chalky faded pale blue (Dust2 long car)
M_RUBBER = flat_mat('rubber',        (0.03, 0.03, 0.03), rough=0.9, surface='metal')
M_TRIM   = tex_mat('trim_concrete',  'concrete_pavement',     1.5, 'concrete')   # smooth cream trims: caps, sills, ledges, stairs
# painted plaster bands: same plaster texture, tinted at runtime via material extras (baseColor factor)
M_TEAL   = tex_mat('paint_teal',     'beige_wall_002',        3.0, 'concrete'); M_TEAL['tint'] = [0.42, 0.60, 0.52]
M_OCHRE  = tex_mat('paint_ochre',    'beige_wall_002',        3.0, 'concrete'); M_OCHRE['tint'] = [0.86, 0.66, 0.34]
M_SHUT_G = flat_mat('shutter_green', (0.22, 0.40, 0.28), rough=0.75, surface='wood')
M_SHUT_R = flat_mat('shutter_red',   (0.52, 0.20, 0.16), rough=0.75, surface='wood')
M_WHITEMET = flat_mat('metal_white', (0.80, 0.80, 0.78), rough=0.45, metallic=0.35, surface='metal')
M_WIRE   = flat_mat('wire',          (0.02, 0.02, 0.02), rough=0.8, surface='metal')
M_BG     = tex_mat('bg_plaster',     'beige_wall_002',        8.0, 'concrete'); M_BG['nocollide'] = 1
M_HILLS  = tex_mat('hills',          'dry_ground_01',         80.0, 'sand');    M_HILLS['nocollide'] = 1

# sign material (single image, planar uv)
M_SIGN = bpy.data.materials.new('sign_a'); M_SIGN.use_nodes = True
_b = M_SIGN.node_tree.nodes['Principled BSDF']; _b.inputs['Roughness'].default_value = 0.7
_t = M_SIGN.node_tree.nodes.new('ShaderNodeTexImage'); _t.image = load_img(os.path.join(TEX, 'sign_a.jpg'), True)
M_SIGN.node_tree.links.new(_t.outputs['Color'], _b.inputs['Base Color'])
M_SIGN['uv_scale'] = 0; M_SIGN['surface'] = 'metal'; M_SIGN['cyl'] = 0
MATS['sign_a'] = M_SIGN

# ---------------------------------------------------------------- helpers
ALL = []

def assign(o, m):
    o.data.materials.clear(); o.data.materials.append(m)
    o['surface'] = m.get('surface', 'concrete')

# Geometry is created with the data API / bmesh (no bpy.ops primitives): every operator call re-evaluates the whole
# depsgraph, which made the ~5000-object build O(n^2) (an hour in background mode). Object transforms are written through
# matrix_world so reads of matrix_world are never stale (location/scale property writes alone are only reflected after a
# depsgraph update); bounds are computed from mesh vertices for the same reason.
def apply_all(o):
    """Bake rotation + scale into the mesh, keep the location (data-API equivalent of transform_apply)."""
    M = o.rotation_euler.to_matrix().to_4x4() @ Matrix.Diagonal(o.scale).to_4x4()
    if M != Matrix.Identity(4):
        o.data.transform(M); o.data.update()
    o.matrix_world = Matrix.Translation(o.location)

def _new_obj(name, bm, loc, m=None):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); me.update()
    o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o)
    o.matrix_world = Matrix.Translation(loc)
    if m is not None: assign(o, m); ALL.append(o)
    return o

def _bm_box(sx, sy, sz, bevel=0.0, seg=2):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.verts) + list(bm.edges), offset=bevel, offset_type='OFFSET', segments=seg,
                        profile=0.5, affect='EDGES', clamp_overlap=True)
    return bm

def _bm_cyl(r, depth, verts, rot=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=verts, radius1=r, radius2=r, depth=depth,
                          matrix=Matrix.Rotation(rot[2], 4, 'Z') @ Matrix.Rotation(rot[1], 4, 'Y') @ Matrix.Rotation(rot[0], 4, 'X'))
    return bm

def add_box(name, x0, x1, y0, y1, z0, z1, m, bevel=0.0, seg=2):
    return _new_obj(name, _bm_box(abs(x1-x0), abs(y1-y0), abs(z1-z0), bevel, seg), ((x0+x1)/2, (y0+y1)/2, (z0+z1)/2), m)

def add_mesh(name, verts, faces, m):
    me = bpy.data.meshes.new(name); me.from_pydata(verts, [], faces); me.update()
    o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o)
    bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(me); bm.free()
    assign(o, m); ALL.append(o)
    return o

def add_wedge(name, x0, x1, y_lo, z_lo, y_hi, z_hi, base, m):
    """Ramp along Y: at y_lo top is z_lo, at y_hi top is z_hi. base = bottom z."""
    v = [(x0,y_lo,base),(x1,y_lo,base),(x1,y_hi,base),(x0,y_hi,base),
         (x0,y_lo,z_lo),(x1,y_lo,z_lo),(x1,y_hi,z_hi),(x0,y_hi,z_hi)]
    f = [(0,1,2,3),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
    return add_mesh(name, v, f, m)

def add_cyl_axis(name, c, r, depth, m, axis='y', verts=20):
    rot = (math.pi/2, 0, 0) if axis == 'y' else ((0, math.pi/2, 0) if axis == 'x' else (0, 0, 0))
    return _new_obj(name, _bm_cyl(r, depth, verts, rot), c, m)

import time as _time
_CUT_LOG = os.environ.get('BUILD_CUT_LOG')
def cut(target, cutter):
    md = target.modifiers.new('cut', 'BOOLEAN'); md.object = cutter; md.operation = 'DIFFERENCE'; md.solver = 'EXACT'
    bpy.ops.object.select_all(action='DESELECT'); target.select_set(True); bpy.context.view_layer.objects.active = target
    _t = _time.time()
    bpy.ops.object.modifier_apply(modifier=md.name)
    if len(target.data.polygons) == 0:
        print('CUT EMPTIED TARGET:', target.name, 'cutter at', tuple(round(v, 2) for v in cutter.location))
    if _CUT_LOG:
        with open(_CUT_LOG, 'a') as _f: _f.write(f'{_time.time()-_t:7.2f}s {target.name:16s} f={len(target.data.polygons):6d} cutter_f={len(cutter.data.polygons)} at {tuple(round(v,2) for v in cutter.location)}\n')
    if cutter in ALL: ALL.remove(cutter)
    bpy.data.objects.remove(cutter, do_unlink=True)

def cutter_box(x0, x1, y0, y1, z0, z1):
    return _new_obj('cutter', _bm_box(abs(x1-x0), abs(y1-y0), abs(z1-z0)), ((x0+x1)/2, (y0+y1)/2, (z0+z1)/2))

def cutter_cyl_x(cx, cy, cz, r, length):
    return _new_obj('cutter', _bm_cyl(r, length, 24, (0, math.pi/2, 0)), (cx, cy, cz))

def cutter_cyl_y(cx, cy, cz, r, length):
    return _new_obj('cutter', _bm_cyl(r, length, 24, (math.pi/2, 0, 0)), (cx, cy, cz))

def _mesh_bounds(ob):
    """World-space AABB from the mesh vertices (Object.bound_box / dimensions are stale until a depsgraph update)."""
    mw = ob.matrix_world; xs, ys, zs = [], [], []
    for v in ob.data.vertices:
        p = mw @ v.co; xs.append(p.x); ys.append(p.y); zs.append(p.z)
    return (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs))

def arch_cut_y(target, x, y0, y1, w, h, z0=0.0):
    """Arched opening through a wall that runs along Y (opening axis = X)."""
    cut(target, cutter_box(x-4, x+4, y0, y1, z0-0.2, z0 + h - w/2))
    cut(target, cutter_cyl_x(x, (y0+y1)/2, z0 + h - w/2, w/2, 8))

def empty(name, loc, rot=(0,0,0), scale=(1,1,1)):
    e = bpy.data.objects.new(name, None); e.empty_display_type = 'ARROWS'; e.empty_display_size = 0.5
    e.location = loc; e.rotation_euler = rot; e.scale = scale
    bpy.context.collection.objects.link(e); return e

_DECAL_N = [0]
def decal(kind, pos, normal_yaw, w, h, cell=0, alpha=1.0):
    """Decal marker: empty whose local +X is the wall's outward normal. Sheet/cell picked in Three.js by kind.
    kinds: streak/splash/pocks/stain (grime sheet), poster/sign/posters/sign2 (posters), tag/stencil/script/marks (graffiti)"""
    _DECAL_N[0] += 1
    e = empty(f'DECAL_{kind}_{_DECAL_N[0]}', pos, rot=(0, 0, normal_yaw))
    e['kind'] = kind; e['w'] = float(w); e['h'] = float(h); e['cell'] = int(cell); e['alpha'] = float(alpha)
    return e

def face_frame(wall, face):
    """(o, s, horiz, normal_yaw) for a face of a box wall."""
    xmin, xmax, ymin, ymax = _bounds(wall)
    if face == 'S': return ymin, -1, True, math.radians(-90)
    if face == 'N': return ymax, +1, True, math.radians(90)
    if face == 'W': return xmin, -1, False, math.radians(180)
    return xmax, +1, False, 0.0

def face_decal(wall, face, kind, u, z, w, h, cell=0, alpha=1.0, off=0.015):
    o, s, horiz, yaw = face_frame(wall, face)
    pos = (u, o + s*off, z) if horiz else (o + s*off, u, z)
    return decal(kind, pos, yaw, w, h, cell, alpha)

def join(objs, name):
    objs = [o for o in objs if o is not None]
    if not objs: return None
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    with bpy.context.temp_override(active_object=objs[0], selected_editable_objects=objs, selected_objects=objs):
        bpy.ops.object.join()
    j = objs[0]; j.name = name
    return j

# ---------------------------------------------------------------- architecture pieces
def building(name, x0, x1, y0, y1, z0, z1, m=M_WALL, faces='', parapet=True, base=True, beams=True, base_z=None):
    """Solid building block with parapet/cornice, stone base and beam ends on the listed faces (N/S/E/W)."""
    b = add_box(name, x0, x1, y0, y1, z0, z1, m)
    if parapet:
        p = 0.2
        add_box(name+'_cap', x0-p, x1+p, y0-p, y1+p, z1-0.35, z1+0.55, m, bevel=0.04)
        add_box(name+'_capstone', x0-p-0.04, x1+p+0.04, y0-p-0.04, y1+p+0.04, z1+0.5, z1+0.62, M_TRIM, bevel=0.02)
    if isinstance(base, dict):
        # per-face stone skirt at that face's ground level (buildings spanning two floor heights)
        for f, bz in base.items():
            if f == 'N': add_box(name+'_base', x0-0.08, x1+0.08, y1-0.3, y1+0.08, bz-0.6, bz+0.9, M_STONE, bevel=0.02)
            if f == 'S': add_box(name+'_base', x0-0.08, x1+0.08, y0-0.08, y0+0.3, bz-0.6, bz+0.9, M_STONE, bevel=0.02)
            if f == 'W': add_box(name+'_base', x0-0.08, x0+0.3, y0-0.08, y1+0.08, bz-0.6, bz+0.9, M_STONE, bevel=0.02)
            if f == 'E': add_box(name+'_base', x1-0.3, x1+0.08, y0-0.08, y1+0.08, bz-0.6, bz+0.9, M_STONE, bevel=0.02)
    elif base:
        bz = base_z if base_z is not None else z0
        add_box(name+'_base', x0-0.08, x1+0.08, y0-0.08, y1+0.08, bz-0.6, bz+0.9, M_STONE, bevel=0.02)
    if beams:
        zb = z1 - 1.15
        step = 1.35
        if 'S' in faces:
            x = x0 + 0.7
            while x < x1 - 0.4:
                add_box(name+'_bm', x-0.11, x+0.11, y0-0.32, y0+0.2, zb-0.11, zb+0.11, M_WOOD, bevel=0.015); x += step
        if 'N' in faces:
            x = x0 + 0.7
            while x < x1 - 0.4:
                add_box(name+'_bm', x-0.11, x+0.11, y1-0.2, y1+0.32, zb-0.11, zb+0.11, M_WOOD, bevel=0.015); x += step
        if 'W' in faces:
            y = y0 + 0.7
            while y < y1 - 0.4:
                add_box(name+'_bm', x0-0.32, x0+0.2, y-0.11, y+0.11, zb-0.11, zb+0.11, M_WOOD, bevel=0.015); y += step
        if 'E' in faces:
            y = y0 + 0.7
            while y < y1 - 0.4:
                add_box(name+'_bm', x1-0.2, x1+0.32, y-0.11, y+0.11, zb-0.11, zb+0.11, M_WOOD, bevel=0.015); y += step
    return b

def _bounds(wall):
    x0, x1, y0, y1, _, _ = _mesh_bounds(wall)
    return x0, x1, y0, y1

def face_axes(wall, face):
    """(o, s, horiz): wall-plane coordinate along the outward axis, outward sign, and whether the face runs along X."""
    xmin, xmax, ymin, ymax = _bounds(wall)
    if face == 'S':   return ymin, -1, True
    if face == 'N':   return ymax, +1, True
    if face == 'W':   return xmin, -1, False
    return xmax, +1, False

def fbox(name, o, s, horiz, a0, a1, d0, d1, z0, z1, m, bevel=0.0, seg=2):
    """Box in a face frame: a = along-face coordinate, d = depth from the wall plane (positive = outward)."""
    lo, hi = sorted((o + s*d0, o + s*d1))
    if horiz: return add_box(name, min(a0,a1), max(a0,a1), lo, hi, z0, z1, m, bevel=bevel, seg=seg)
    return add_box(name, lo, hi, min(a0,a1), max(a0,a1), z0, z1, m, bevel=bevel, seg=seg)

def fcut(o, s, horiz, a0, a1, d0, d1, z0, z1):
    lo, hi = sorted((o + s*d0, o + s*d1))
    return cutter_box(min(a0,a1), max(a0,a1), lo, hi, z0, z1) if horiz else cutter_box(lo, hi, min(a0,a1), max(a0,a1), z0, z1)

def fpoint(o, s, horiz, a, d, z):
    return (a, o + s*d, z) if horiz else (o + s*d, a, z)

def fcyl(name, o, s, horiz, a, d0, d1, z, r, m, verts=12):
    """Cylinder whose axis is the face normal (pipe stubs, scuppers)."""
    lo, hi = sorted((o + s*d0, o + s*d1))
    c = fpoint(o, s, horiz, a, (d0 + d1) / 2, z)
    return add_cyl_axis(name, c, r, hi - lo, m, axis=('y' if horiz else 'x'), verts=verts)

def rot_objs(objs, pivot, axis, ang):
    """Rotate objects about a world-space pivot (axis 'X'/'Y'/'Z') and bake the transform."""
    P = Vector(pivot); R = Matrix.Rotation(ang, 4, axis)
    for ob in objs:
        ob.matrix_world = Matrix.Translation(P) @ R @ Matrix.Translation(-P) @ ob.matrix_world
        apply_all(ob)

def _hash(*vals):
    import zlib
    return zlib.crc32(repr(tuple(round(v, 3) for v in vals)).encode())

def window(wall, face, u, z, w=1.1, h=1.4, depth=0.22, bars=True, lintel=True, shutters=None, style=None, arch=False, seed=None):
    """Recessed window (15-25 cm reveal) with a stone sill, timber lintel, timber frame + mullions, and one of several
    infills: 'wood' bars, 'grille' (rusted iron bars), 'boarded' (planks nailed across), or shutters (M_SHUT_G / M_SHUT_R)
    that are 'open' flat against the wall, 'ajar' at a random angle, 'closed' over the opening or 'broken' (a slat missing).
    arch=True: small round-headed window (the arch adds w/2 to the height). Deterministic per (u, z)."""
    o, s, horiz = face_axes(wall, face)
    rr = random.Random(seed if seed is not None else _hash(u, z, w, h))
    box = lambda name, a0, a1, d0, d1, z0, z1, m, bevel=0.0: fbox(name, o, s, horiz, a0, a1, d0, d1, z0, z1, m, bevel=bevel)
    cut(wall, fcut(o, s, horiz, u-w/2, u+w/2, 0.3, -depth, z, z+h))
    if arch:
        cyl = cutter_cyl_y(*fpoint(o, s, horiz, u, (0.3 - depth) / 2, z + h), w/2, depth + 0.3) if horiz else cutter_cyl_x(*fpoint(o, s, horiz, u, (0.3 - depth) / 2, z + h), w/2, depth + 0.3)
        cut(wall, cyl)
        fcyl('win_back', o, s, horiz, u, -depth + 0.02, -depth - 0.05, z + h, w/2, M_DARK, verts=16)
        lintel = False
    box('win_back', u-w/2, u+w/2, -depth+0.02, -depth-0.05, z, z+h, M_DARK)
    top = z + h + (w/2 if arch else 0)
    # timber frame set into the reveal (jambs, head, inner sill) + a cross of mullions
    fd0, fd1 = -depth + 0.02, -depth + 0.10
    box('win_jamb', u-w/2, u-w/2+0.06, fd0, fd1, z, top, M_WOOD); box('win_jamb', u+w/2-0.06, u+w/2, fd0, fd1, z, top, M_WOOD)
    if not arch: box('win_head', u-w/2, u+w/2, fd0, fd1, z+h-0.06, z+h, M_WOOD)
    box('win_mull', u-0.025, u+0.025, fd0, fd1 - 0.02, z, top, M_WOOD)
    box('win_mull', u-w/2, u+w/2, fd0, fd1 - 0.02, z + h*0.62 - 0.025, z + h*0.62 + 0.025, M_WOOD)
    if lintel: box('win_lintel', u-w/2-0.16, u+w/2+0.16, 0.08, -depth, z+h, z+h+0.18, M_WOOD, bevel=0.01)
    box('win_sill', u-w/2-0.13, u+w/2+0.13, 0.11, -depth, z-0.10, z+0.02, M_TRIM, bevel=0.01)
    # rain streaks bleeding down from the sill on most windows (deterministic per window)
    k = int(abs(u * 7.3 + z * 3.1)) % 10
    if k < 7:
        sw = w + 0.5 + 0.2 * (k % 3); sh = 1.3 + 0.25 * (k % 4)
        face_decal(wall, face, 'streak', u + 0.05 * (k % 3 - 1), z - 0.12 - sh/2, sw, sh, cell=0, alpha=0.55 + 0.05 * (k % 4))
    if style is None:
        style = rr.choice(('ajar', 'ajar', 'open', 'closed', 'broken')) if shutters else rr.choice(('wood', 'wood', 'grille', 'grille', 'boarded'))
    if style == 'grille':
        n = 4 if w > 0.9 else 3
        for i in range(1, n + 1):
            b = u - w/2 + i * w / (n + 1)
            box('win_grille', b-0.012, b+0.012, -0.09, -0.115, z + 0.02, top - 0.02, M_BRACKET)
        for zz in (z + h*0.3, z + h*0.7):
            box('win_grille', u-w/2+0.02, u+w/2-0.02, -0.088, -0.117, zz-0.012, zz+0.012, M_BRACKET)
    elif style == 'boarded':
        objs = []
        for i, (zz, ang) in enumerate(((z + h*0.25, 0.0), (z + h*0.55, 0.0), (z + h*0.8, rr.uniform(-0.25, 0.25)))):
            p = box('win_board', u-w/2-0.10, u+w/2+0.10, -0.03, -0.07 - 0.01*i, zz-0.09, zz+0.09, M_PLANK2)
            if ang: rot_objs([p], fpoint(o, s, horiz, u, -0.05, zz), 'Y' if horiz else 'X', ang)
    elif style == 'wood' or (bars and style not in ('grille', 'boarded', 'closed')):   # shuttered windows keep wooden bars behind the leaves
        for i in range(1, 3):
            b = u - w/2 + i*w/3
            box('win_bar', b-0.03, b+0.03, -0.10, -0.16, z, top, M_WOOD)
        box('win_bar_h', u-w/2, u+w/2, -0.10, -0.16, z+h/2-0.03, z+h/2+0.03, M_WOOD)
    if shutters:
        sw = w * 0.5
        for side in (-1, 1):
            leaf = []
            if style == 'closed':
                a0 = u + side*0.005; a1 = u + side*sw
                d0, d1 = -0.03, -0.06
            else:
                a0 = u + side*(w/2 + 0.03); a1 = a0 + side*sw
                d0, d1 = 0.03, 0.06
            lo, hi = min(a0, a1), max(a0, a1)
            # louvred leaf: two stiles, top/bottom rails, angled slats (one may be missing)
            leaf.append(box('shutter', lo, lo+0.06, d0, d1, z-0.02, z+h+0.02, shutters))
            leaf.append(box('shutter', hi-0.06, hi, d0, d1, z-0.02, z+h+0.02, shutters))
            leaf.append(box('shutter', lo, hi, d0, d1, z+h-0.04, z+h+0.02, shutters))
            leaf.append(box('shutter', lo, hi, d0, d1, z-0.02, z+0.04, shutters))
            leaf.append(box('shutter', lo, hi, d0, d1, z+h*0.5-0.03, z+h*0.5+0.03, shutters))
            n = 6; skip = rr.randrange(n) if (style == 'broken' and side == rr.choice((-1, 1))) else -1
            for k in range(n):
                if k == skip: continue
                zz = z + 0.06 + (h - 0.12) * (k + 0.5) / n
                sl = box('shutter_slat', lo+0.05, hi-0.05, d0 + 0.005, d1 - 0.005, zz-0.055, zz+0.055, shutters)
                rot_objs([sl], fpoint(o, s, horiz, (lo+hi)/2, (d0+d1)/2, zz), 'X' if horiz else 'Y', math.radians(28))
                leaf.append(sl)
            if style in ('ajar', 'broken') and rr.random() < 0.8:
                ang = math.radians(rr.uniform(18, 62))
                hinge = fpoint(o, s, horiz, u + side*(w/2 + 0.03), 0.045, z)
                free = Vector(fpoint(o, s, horiz, a1, 0.045, z))
                # pick the rotation sense that swings the free edge away from the wall
                P = Vector(hinge)
                out_of = lambda p: s * ((p.y if horiz else p.x) - o)
                q = Matrix.Translation(P) @ Matrix.Rotation(ang, 4, 'Z') @ Matrix.Translation(-P) @ free
                rot_objs(leaf, hinge, 'Z', ang if out_of(q) > out_of(free) else -ang)

def blind_arch(wall, face, u, z0, w=2.2, h=3.0, depth=0.4):
    """Decorative blocked archway (recess with a closed wooden door) in a facade."""
    xmin, xmax, ymin, ymax = _bounds(wall)
    if face == 'S':
        cut(wall, cutter_box(u-w/2, u+w/2, ymin-0.3, ymin+depth, z0-0.1, z0+h-w/2))
        cut(wall, cutter_cyl_y(u, ymin+depth/2-0.15, z0+h-w/2, w/2, depth+0.3))
        add_box('arch_door', u-w/2, u+w/2, ymin+depth-0.06, ymin+depth, z0, z0+h-w/2, M_DOOR)
        add_box('arch_beam', u-w/2-0.2, u+w/2+0.2, ymin-0.05, ymin+depth, z0+h-w/2-0.02, z0+h-w/2+0.16, M_WOOD, bevel=0.01)
    elif face == 'N':
        cut(wall, cutter_box(u-w/2, u+w/2, ymax-depth, ymax+0.3, z0-0.1, z0+h-w/2))
        cut(wall, cutter_cyl_y(u, ymax-depth/2+0.15, z0+h-w/2, w/2, depth+0.3))
        add_box('arch_door', u-w/2, u+w/2, ymax-depth, ymax-depth+0.06, z0, z0+h-w/2, M_DOOR)
        add_box('arch_beam', u-w/2-0.2, u+w/2+0.2, ymax-depth, ymax+0.05, z0+h-w/2-0.02, z0+h-w/2+0.16, M_WOOD, bevel=0.01)
    elif face == 'W':
        cut(wall, cutter_box(xmin-0.3, xmin+depth, u-w/2, u+w/2, z0-0.1, z0+h-w/2))
        cut(wall, cutter_cyl_x(xmin+depth/2-0.15, u, z0+h-w/2, w/2, depth+0.3))
        add_box('arch_door', xmin+depth-0.06, xmin+depth, u-w/2, u+w/2, z0, z0+h-w/2, M_DOOR)
        add_box('arch_beam', xmin-0.05, xmin+depth, u-w/2-0.2, u+w/2+0.2, z0+h-w/2-0.02, z0+h-w/2+0.16, M_WOOD, bevel=0.01)
    elif face == 'E':
        cut(wall, cutter_box(xmax-depth, xmax+0.3, u-w/2, u+w/2, z0-0.1, z0+h-w/2))
        cut(wall, cutter_cyl_x(xmax-depth/2+0.15, u, z0+h-w/2, w/2, depth+0.3))
        add_box('arch_door', xmax-depth, xmax-depth+0.06, u-w/2, u+w/2, z0, z0+h-w/2, M_DOOR)
        add_box('arch_beam', xmax-depth, xmax+0.05, u-w/2-0.2, u+w/2+0.2, z0+h-w/2-0.02, z0+h-w/2+0.16, M_WOOD, bevel=0.01)

def awning(x0, x1, y0, y1, z_hi, z_lo, along='y', poles=True):
    """Sloped corrugated-iron awning with wooden rafters. along='y': high at y0, low at y1. along='x': high at x0, low at x1."""
    f = [(0,1,2,3),(7,6,5,4),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]
    if along == 'y':
        v = [(x0,y0,z_hi),(x1,y0,z_hi),(x1,y1,z_lo),(x0,y1,z_lo),(x0,y0,z_hi-0.05),(x1,y0,z_hi-0.05),(x1,y1,z_lo-0.05),(x0,y1,z_lo-0.05)]
    else:
        v = [(x0,y0,z_hi),(x1,y0,z_lo),(x1,y1,z_lo),(x0,y1,z_hi),(x0,y0,z_hi-0.05),(x1,y0,z_lo-0.05),(x1,y1,z_lo-0.05),(x0,y1,z_hi-0.05)]
    add_mesh('awning', v, f, M_IRON)
    if along == 'y':
        for x in (min(x0,x1)+0.1, (x0+x1)/2, max(x0,x1)-0.1):
            add_mesh('awning_rafter', [(x-0.05,y0,z_hi-0.05),(x+0.05,y0,z_hi-0.05),(x+0.05,y1,z_lo-0.05),(x-0.05,y1,z_lo-0.05),
                                       (x-0.05,y0,z_hi-0.15),(x+0.05,y0,z_hi-0.15),(x+0.05,y1,z_lo-0.15),(x-0.05,y1,z_lo-0.15)], f, M_WOOD)
        if poles:
            for x in (min(x0,x1)+0.1, max(x0,x1)-0.1):
                add_box('awning_pole', x-0.05, x+0.05, y1-0.15, y1-0.05, 0, z_lo-0.1, M_WOOD)
    else:
        for y in (min(y0,y1)+0.1, (y0+y1)/2, max(y0,y1)-0.1):
            add_mesh('awning_rafter', [(x0,y-0.05,z_hi-0.05),(x1,y-0.05,z_lo-0.05),(x1,y+0.05,z_lo-0.05),(x0,y+0.05,z_hi-0.05),
                                       (x0,y-0.05,z_hi-0.15),(x1,y-0.05,z_lo-0.15),(x1,y+0.05,z_lo-0.15),(x0,y+0.05,z_hi-0.15)], f, M_WOOD)
        if poles:
            for y in (min(y0,y1)+0.1, max(y0,y1)-0.1):
                add_box('awning_pole', x1-0.15, x1-0.05, y-0.05, y+0.05, 0, z_lo-0.1, M_WOOD)

# ---------------------------------------------------------------- props
M_BRACKET = flat_mat('crate_iron', (0.085, 0.075, 0.065), rough=0.55, metallic=0.7, surface='metal')   # rusted corner plates

def crate(name, cx, cy, z0, s=1.5, rot=0.0, planks=M_PLANK, sy=None, sz=None):
    """Slatted shipping crate: dark core seen through the plank gaps, individually offset/bevelled planks on the four
    sides and the lid, bevelled frame boards, and iron corner plates. Deterministic per crate name."""
    import zlib
    rr = random.Random(zlib.crc32(name.encode()))
    sy = sy or s; sz = sz or s
    x0, x1, y0, y1, z1 = cx-s/2, cx+s/2, cy-sy/2, cy+sy/2, z0+sz
    objs = [add_box(name+'_core', x0+0.004, x1-0.004, y0+0.004, y1-0.004, z0+0.002, z1-0.004, M_DARK)]
    gap, pb = 0.010, 0.005                          # plank gap, plank bevel
    def run(a0, a1):
        """Split [a0,a1] into planks of ~0.21-0.26 m with a shared gap; returns (lo, hi) pairs."""
        n = max(3, int(round((a1 - a0) / rr.uniform(0.21, 0.26))))
        w = (a1 - a0 - gap * (n - 1)) / n
        return [(a0 + i * (w + gap), a0 + i * (w + gap) + w) for i in range(n)]
    # side planks run vertically (each 2 cm into the core, 0-8 mm proud so neighbours catch the light differently)
    for axis, sgn in (('x', -1), ('x', 1), ('y', -1), ('y', 1)):
        for (lo, hi) in run(y0 if axis == 'x' else x0, y1 if axis == 'x' else x1):
            off = rr.uniform(0.0, 0.008)
            if axis == 'x':
                fx = x1 if sgn > 0 else x0
                objs.append(add_box(name+'_pl', *sorted((fx - sgn*0.02, fx + sgn*off)), lo, hi, z0 + 0.004, z1 - 0.004, planks, bevel=pb, seg=1))
            else:
                fy = y1 if sgn > 0 else y0
                objs.append(add_box(name+'_pl', lo, hi, *sorted((fy - sgn*0.02, fy + sgn*off)), z0 + 0.004, z1 - 0.004, planks, bevel=pb, seg=1))
    for (lo, hi) in run(x0, x1):                    # lid planks across x
        objs.append(add_box(name+'_pl', lo, hi, y0, y1, z1 - 0.02, z1 + rr.uniform(0.0, 0.008), planks, bevel=pb, seg=1))
    t = 0.09; p = 0.030
    X0, X1, Y0, Y1, Z0, Z1 = cx-s/2-p, cx+s/2+p, cy-sy/2-p, cy+sy/2+p, z0-0.001, z0+sz+p
    for (bx0,bx1,by0,by1,zz0,zz1) in [
        (X0,X0+t,Y0,Y1,Z0,Z0+t),(X1-t,X1,Y0,Y1,Z0,Z0+t),(X0,X1,Y0,Y0+t,Z0,Z0+t),(X0,X1,Y1-t,Y1,Z0,Z0+t),
        (X0,X0+t,Y0,Y1,Z1-t,Z1),(X1-t,X1,Y0,Y1,Z1-t,Z1),(X0,X1,Y0,Y0+t,Z1-t,Z1),(X0,X1,Y1-t,Y1,Z1-t,Z1),
        (X0,X0+t,Y0,Y0+t,Z0,Z1),(X1-t,X1,Y0,Y0+t,Z0,Z1),(X0,X0+t,Y1-t,Y1,Z0,Z1),(X1-t,X1,Y1-t,Y1,Z0,Z1),
        (cx-t/2,cx+t/2,Y0,Y0+t,Z0,Z1),(cx-t/2,cx+t/2,Y1-t,Y1,Z0,Z1),(X0,X0+t,cy-t/2,cy+t/2,Z0,Z1),(X1-t,X1,cy-t/2,cy+t/2,Z0,Z1)]:
        objs.append(add_box(name+'_f', bx0,bx1,by0,by1,zz0,zz1, M_WOOD, bevel=0.010, seg=2))
    # iron corner plates: L-brackets wrapped over the frame corners (two side plates per corner + lid plates on top)
    L, th = 0.13, 0.004
    for ex, ey in ((X0, Y0), (X1, Y0), (X0, Y1), (X1, Y1)):
        sx = -1 if ex == X0 else 1; sy_ = -1 if ey == Y0 else 1
        for ez, up in ((Z0 + 0.004, 1), (Z1, -1)):
            zz = sorted((ez, ez + up * L))
            objs.append(add_box(name+'_ir', *sorted((ex, ex + sx*th)), *sorted((ey, ey - sy_*L)), zz[0], zz[1], M_BRACKET))
            objs.append(add_box(name+'_ir', *sorted((ex, ex - sx*L)), *sorted((ey, ey + sy_*th)), zz[0], zz[1], M_BRACKET))
        objs.append(add_box(name+'_ir', *sorted((ex, ex - sx*L)), *sorted((ey, ey - sy_*L)), Z1, Z1 + th, M_BRACKET))
    # lid battens (cross boards flush with the top frame) + iron plate at their crossing
    objs.append(add_box(name+'_f', cx-t/2, cx+t/2, Y0+t, Y1-t, Z1-t, Z1, M_WOOD, bevel=0.010, seg=2))
    objs.append(add_box(name+'_f', X0+t, X1-t, cy-t/2, cy+t/2, Z1-t, Z1, M_WOOD, bevel=0.010, seg=2))
    objs.append(add_box(name+'_ir', cx-0.07, cx+0.07, cy-0.07, cy+0.07, Z1, Z1 + th, M_BRACKET))
    if rot:
        R = Matrix.Rotation(rot, 4, 'Z'); C = Vector((cx, cy, 0))
        for o in objs:
            o.matrix_world = Matrix.Translation(C) @ R @ Matrix.Translation(-C) @ o.matrix_world
            apply_all(o)
    return objs

def barrel(name, cx, cy, z0, m=M_BARREL, r=0.3, h=0.9):
    body = add_cyl_axis(name, (cx, cy, z0+h/2), r, h, m, 'z', verts=28)
    md = body.modifiers.new('bev', 'BEVEL'); md.width = 0.02; md.segments = 2; md.limit_method = 'ANGLE'
    bpy.ops.object.select_all(action='DESELECT'); body.select_set(True); bpy.context.view_layer.objects.active = body
    bpy.ops.object.modifier_apply(modifier=md.name)
    for zz, rr in ((z0+h*0.3, r), (z0+h*0.7, r), (z0+h, r-0.01)):
        bpy.ops.mesh.primitive_torus_add(major_radius=rr, minor_radius=0.022, major_segments=28, minor_segments=8, location=(cx, cy, zz))
        t = bpy.context.object; t.name = name+'_rib'; apply_all(t); assign(t, m); ALL.append(t)

def rubble(cx, cy, z0, n=7, spread=0.8, m=M_STONE, seed=1):
    import random
    random.seed(seed)
    for i in range(n):
        a = random.random()*math.tau; d = random.random()*spread
        r = 0.12 + random.random()*0.22
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=r, location=(cx+math.cos(a)*d, cy+math.sin(a)*d, z0+r*0.45))
        o = bpy.context.object; o.scale = (1+random.random()*0.6, 1+random.random()*0.4, 0.55+random.random()*0.3)
        o.rotation_euler = (random.random()*0.4, random.random()*0.4, random.random()*math.tau)
        apply_all(o); assign(o, m); ALL.append(o); o.name = 'rubble'

M_RUST   = flat_mat('car_rust',      (0.10, 0.05, 0.03), rough=0.95, surface='metal')
M_CHROME = flat_mat('car_chrome',    (0.62, 0.62, 0.60), rough=0.35, metallic=0.8, surface='metal')
M_TAIL   = flat_mat('car_tail',      (0.55, 0.10, 0.08), rough=0.4, surface='metal')

def bevel_obj(o, w, seg=2):
    md = o.modifiers.new('bev', 'BEVEL'); md.width = w; md.segments = seg; md.limit_method = 'ANGLE'
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier=md.name)

def profile_verts_faces(pts, y0, y1):
    n = len(pts)
    v = [(x, y0, z) for x, z in pts] + [(x, y1, z) for x, z in pts]
    f = [tuple(range(n))[::-1], tuple(range(n, 2*n))]
    for i in range(n):
        j = (i + 1) % n
        f.append((i, j, n + j, n + i))
    return v, f

def profile_mesh(name, pts, y0, y1, m, bevel=0.0, seg=2):
    """XZ side-profile polygon (CCW) extruded along Y."""
    v, f = profile_verts_faces(pts, y0, y1)
    o = add_mesh(name, v, f, m)
    if bevel > 0: bevel_obj(o, bevel, seg)
    return o

def profile_cutter(pts, y0, y1):
    v, f = profile_verts_faces(pts, y0, y1)
    me = bpy.data.meshes.new('cutter'); me.from_pydata(v, [], f); me.update()
    o = bpy.data.objects.new('cutter', me); bpy.context.collection.objects.link(o)
    bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(me); bm.free()
    return o

def pickup_truck(cx, cy, z0, yaw=0.0):
    """Beat-up 60s pickup (the Dust2 'car'): profile-extruded body, raked cab, hollow bed, wheel arches, trim."""
    objs = []
    L, W = 4.9, 1.85
    hw = W / 2
    # --- body tub: side silhouette (x,z), CCW
    body_pts = [(-2.42, 0.44), (2.36, 0.44), (2.45, 0.62), (2.45, 1.02), (2.30, 1.08), (1.78, 1.18),
                (1.68, 1.30), (0.50, 1.30), (0.44, 1.16), (-2.42, 1.16)]
    body = profile_mesh('car_body', body_pts, -hw, hw, M_CAR, bevel=0.035, seg=2)
    # wheel arches (through-cut; dark chassis behind hides the hole)
    for wx in (-1.52, 1.62):
        cut(body, cutter_cyl_y(wx, 0, 0.44, 0.47, W + 0.4))
    # hollow bed + cab/bed split gap
    cut(body, cutter_box(-2.34, 0.36, -hw + 0.07, hw - 0.07, 0.78, 1.40))
    cut(body, cutter_box(0.40, 0.46, -hw - 0.2, hw + 0.2, 0.62, 1.40))
    objs.append(body)
    # --- cab greenhouse: raked trapezoid, windows cut out, dark glass inset
    gh_pts = [(0.50, 1.28), (1.70, 1.28), (1.42, 1.94), (0.60, 1.94)]
    gh = profile_mesh('car_cab', gh_pts, -hw + 0.06, hw - 0.06, M_CAR, bevel=0.04)
    cut(gh, profile_cutter([(0.70, 1.38), (1.58, 1.38), (1.36, 1.86), (0.70, 1.86)], -hw - 0.2, hw + 0.2))      # side windows
    cut(gh, cutter_box(1.20, 2.00, -hw + 0.20, hw - 0.20, 1.38, 1.86))                                     # windshield
    cut(gh, cutter_box(0.30, 0.90, -hw + 0.22, hw - 0.22, 1.38, 1.86))                                     # rear glass
    objs.append(gh)
    objs.append(profile_mesh('car_glass', [(0.56, 1.32), (1.62, 1.32), (1.38, 1.90), (0.64, 1.90)], -hw + 0.10, hw - 0.10, M_GLASS))
    objs.append(add_box('car_seat', 0.62, 1.05, -hw + 0.22, hw - 0.22, 1.20, 1.62, M_DARK))
    objs.append(add_box('car_dash', 1.30, 1.60, -hw + 0.20, hw - 0.20, 1.22, 1.36, M_DARK))
    # --- chassis / drivetrain (dark, seen through arches and under the truck)
    objs.append(add_box('car_chassis', -2.30, 2.30, -hw + 0.28, hw - 0.28, 0.30, 0.50, M_DARK))
    objs.append(add_box('car_bedfloor', -2.34, 0.36, -hw + 0.07, hw - 0.07, 0.74, 0.79, M_RUBBER))
    for wx in (-1.52, 1.62):
        objs.append(add_cyl_axis('car_axle', (wx, 0, 0.40), 0.05, W - 0.5, M_DARK, 'y', verts=10))
    # --- wheels: tyre (bevelled), painted steel rim, hub
    for wx in (-1.52, 1.62):
        for s in (-1, 1):
            wy = s * (hw - 0.14)
            t = add_cyl_axis('car_tyre', (wx, wy, 0.40), 0.40, 0.27, M_RUBBER, 'y', verts=28); bevel_obj(t, 0.06, 3); objs.append(t)
            objs.append(add_cyl_axis('car_rim', (wx, wy + s * 0.10, 0.40), 0.25, 0.09, M_CAR, 'y', verts=20))
            objs.append(add_cyl_axis('car_hub', (wx, wy + s * 0.155, 0.40), 0.07, 0.04, M_CHROME, 'y', verts=12))
    # --- front: grille, bars, headlights, bumpers
    objs.append(add_box('car_grille', 2.41, 2.47, -0.55, 0.55, 0.70, 0.98, M_DARK))
    for gz in (0.76, 0.84, 0.92):
        objs.append(add_box('car_gbar', 2.46, 2.485, -0.55, 0.55, gz - 0.012, gz + 0.012, M_CHROME))
    for s in (-1, 1):
        objs.append(add_cyl_axis('car_lampring', (2.455, s * 0.70, 0.88), 0.13, 0.04, M_CHROME, 'x', verts=18))
        objs.append(add_cyl_axis('car_lamp', (2.47, s * 0.70, 0.88), 0.10, 0.03, M_WHITEMET, 'x', verts=18))
        ty = sorted((s * (hw - 0.16), s * (hw - 0.04)))
        objs.append(add_box('car_tail', -2.44, -2.41, ty[0], ty[1], 0.86, 1.04, M_TAIL))
    fb = add_box('car_bumper_f', 2.40, 2.56, -hw - 0.04, hw + 0.04, 0.46, 0.60, M_CHROME, bevel=0.02); objs.append(fb)
    rb = add_box('car_bumper_r', -2.56, -2.40, -hw - 0.04, hw + 0.04, 0.46, 0.60, M_CHROME, bevel=0.02); objs.append(rb)
    objs.append(add_box('car_plate', 2.555, 2.575, -0.18, 0.18, 0.47, 0.59, M_WHITEMET))
    # --- side details: door seams, handles, mirrors, sill rust, fender rust
    for s in (-1, 1):
        ys = s * (hw + 0.004)
        for dx in (0.56, 1.66):
            objs.append(add_box('car_seam', dx - 0.006, dx + 0.006, min(ys, s * hw - 0.002), max(ys, s * hw - 0.002), 0.50, 1.27, M_DARK))
        objs.append(add_box('car_handle', 1.40, 1.56, min(ys, ys + s * 0.02), max(ys, ys + s * 0.02), 1.04, 1.08, M_CHROME))
        objs.append(add_box('car_mirror_arm', 1.64, 1.70, min(ys, ys + s * 0.16), max(ys, ys + s * 0.16), 1.44, 1.48, M_DARK))
        objs.append(add_box('car_mirror', 1.60, 1.66, min(ys + s * 0.12, ys + s * 0.20), max(ys + s * 0.12, ys + s * 0.20), 1.38, 1.54, M_CHROME))
        # rust: thin sill rot between the arches + a fender-lip bloom (kept sparse; texture carries the rest)
        rr = random.Random(11 + s)
        for _ in range(2):
            px = rr.uniform(-0.95, 0.0); pw = rr.uniform(0.25, 0.4); ph = rr.uniform(0.035, 0.06)
            objs.append(add_box('car_rust', px, px + pw, min(ys, ys + s * 0.004), max(ys, ys + s * 0.004), 0.475, 0.475 + ph, M_RUST))
        px = rr.uniform(-2.36, -2.25); objs.append(add_box('car_rust', px, px + rr.uniform(0.12, 0.2), min(ys, ys + s * 0.004), max(ys, ys + s * 0.004), 0.475, 0.475 + rr.uniform(0.04, 0.07), M_RUST))
        objs.append(add_box('car_rust', 1.30, 1.30 + rr.uniform(0.12, 0.22), min(ys, ys + s * 0.004), max(ys, ys + s * 0.004), 0.915, 0.915 + rr.uniform(0.025, 0.045), M_RUST))
    objs.append(add_box('car_tg_seam', -2.446, -2.436, -hw + 0.10, hw - 0.10, 0.905, 0.915, M_DARK))
    def hood_z(x): return 1.18 - (x - 1.78) * (0.10 / 0.52) + 0.005
    objs.append(add_mesh('car_rust_hood', [(1.90, -0.36, hood_z(1.90)), (2.20, -0.36, hood_z(2.20)), (2.20, 0.06, hood_z(2.20)), (1.90, 0.06, hood_z(1.90))], [(0, 1, 2, 3)], M_RUST))
    objs.append(add_box('car_bedrail', 0.36, 0.44, -hw, hw, 1.16, 1.22, M_CAR, bevel=0.01))
    # --- bed junk: spare tyre and a crate lid
    sp = add_cyl_axis('car_spare', (-1.35, 0.25, 0.92), 0.36, 0.24, M_RUBBER, 'z', verts=24); bevel_obj(sp, 0.05, 3); objs.append(sp)
    objs.append(add_box('car_junk', -0.55, 0.25, -0.65, 0.05, 0.79, 1.02, M_PLANK2, bevel=0.01))
    # place: yaw + slight sag (flat rear tyre feel)
    R = Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(math.radians(0.8), 4, 'Y') @ Matrix.Rotation(math.radians(-1.2), 4, 'X')
    for o in objs:
        o.matrix_world = Matrix.Translation((cx, cy, z0 - 0.02)) @ R @ o.matrix_world
        apply_all(o)
    return objs

# ================================================================ LAYOUT
# Levels: site 0.0 | short +2.5 | pit -2.4 | CT -3.5
# ---------------------------------------------------------------- floors
add_box('floor_site', -14, 16, -12, 14, -3.0, 0.0, M_GROUND)
add_box('floor_site_slab', -7, 9, -7, 9, -0.02, 0.04, M_COBBLE, bevel=0.02)          # plant zone stone slab
add_box('floor_long', -66, -14, 6, 14, -3.0, 0.0, M_ROAD)
add_box('floor_long_edge_n', -66, -14, 12.6, 14, -3.0, 0.012, M_GROUND2)
add_box('floor_long_edge_s', -66, -14, 6, 7.2, -3.0, 0.012, M_GROUND2)
add_box('floor_pit', -22, -14, -4, 2, -3.5, -2.4, M_GROUND2)
add_wedge('pit_slope', -22, -14, 2, -2.4, 6, 0.0, -3.5, M_TRIM)
add_box('floor_ct', -4, 16, -42, -28, -5.0, -3.5, M_ROAD)
add_wedge('ramp', 10, 16, -28, -3.5, -12, 0.0, -5.0, M_PAVE)
add_box('floor_short', -46, -8, -11, -6, -3.0, 2.5, M_COBBLE)                          # short corridor + platform (solid)
for i in range(9):                                                                     # stairs short -> site (0.25 m risers)
    add_box(f'stair_{i}', -8 + 0.44*i, -8 + 0.44*(i+1), -11, -6, -1.0, 2.25 - 0.25*i, M_TRIM, bevel=0.01)
add_box('short_parapet', -14, -8, -6.3, -6.0, 2.5, 3.5, M_WALL, bevel=0.02)            # low wall overlooking site
add_box('short_parapet_cap', -14.05, -7.95, -6.35, -5.95, 3.5, 3.6, M_TRIM, bevel=0.02)
add_box('elbow_step', -14, -9, 2, 6, -0.5, 0.30, M_TRIM, bevel=0.02)                  # 'elevator' step at pit/long corner
add_box('pit_ledge', -14.4, -14, -4, 2, 0.0, 0.7, M_TRIM, bevel=0.02)                 # low wall at pit edge

# ---------------------------------------------------------------- buildings
B_N  = building('B_north',  -66, 22,  14, 22,  -0.5, 6.5, M_WALL,  faces='S', base_z=0)
B_E  = building('B_east',    16, 26, -46, 14,  -5.0, 8.5, M_WALL,  faces='W', base=False)
add_box('B_east_base_site', 15.92, 16.3, -12, 14.08, -0.6, 0.9, M_STONE, bevel=0.02)
add_box('B_east_base_ct', 15.92, 16.3, -46.08, -28, -4.1, -2.6, M_STONE, bevel=0.02)
B_S  = building('B_south',   -4, 10, -30, -12, -5.0, 6.5, M_WALL,  faces='N', base={'N': 0, 'S': -3.5})
B_SW = building('B_southwest', -60, -4, -20, -11, -5.0, 6.0, M_WALL2, faces='N', beams=False, base_z=2.5)
B_W  = building('B_west',   -66, -22,  -6,  6,  -3.5, 6.5, M_WALL,  faces='N', beams=False, base_z=0)
B_PITS = building('B_pitwall', -22, -14, -6, -4, -3.5, 6.0, M_WALL, faces='', parapet=True, base=False, beams=False)
B_CTS = building('B_ctsouth', -4, 26, -48, -42, -5.0, 6.0, M_WALL2, faces='N', base_z=-3.5)
B_CTW = building('B_ctwest', -10, -4, -42, -20, -5.0, 6.5, M_WALL, faces='E', beams=False, base={'E': -3.5})
B_TW = building('B_tspawn_w', -70, -66, 6, 22, -0.5, 6.5, M_WALL, faces='', beams=False)
B_SHW = building('B_short_w', -50, -46, -20, -6, -3.0, 6.5, M_WALL, faces='', beams=False, base_z=2.5)
SH_N = add_box('short_wall_n', -46, -14, -6.0, -5.2, 2.5, 6.5, M_WALL2)
add_box('short_wall_n_cap', -46.1, -13.9, -6.1, -5.1, 6.45, 6.6, M_TRIM, bevel=0.02)

# Long doors: wall across long at x=-56 with a big arched double door (open)
LD = add_box('long_doors_wall', -56.8, -56, 6, 14, -0.5, 6.5, M_WALL2)
arch_cut_y(LD, -56.4, 8.2, 11.8, 3.6, 3.6)
add_box('long_doors_cap', -56.95, -55.85, 5.9, 14.1, 6.0, 6.6, M_WALL2, bevel=0.03)
add_box('long_doors_lintel', -57.0, -55.8, 7.9, 12.1, 3.55, 3.85, M_WOOD, bevel=0.01)
add_box('long_door_L', -56.0, -54.3, 8.05, 8.2, 0.0, 3.3, M_DOOR, bevel=0.01)
add_box('long_door_R', -56.0, -54.3, 11.8, 11.95, 0.0, 3.3, M_DOOR, bevel=0.01)

# Short doors: at x=-46 across the short corridor (Z 2.5)
SD = add_box('short_doors_wall', -46.6, -46, -11, -6, 2.5, 7.0, M_WALL)
arch_cut_y(SD, -46.3, -9.8, -7.2, 2.6, 3.2, z0=2.5)
add_box('short_doors_lintel', -46.7, -45.9, -10.1, -6.9, 5.65, 5.9, M_WOOD, bevel=0.01)
add_box('short_door_L', -46.0, -44.9, -9.75, -9.6, 2.5, 5.4, M_DOOR, bevel=0.01)

# Goose nook (NE corner)
add_box('goose_wall', 10.4, 11.1, 9.0, 14.0, -0.2, 3.4, M_WALL)
add_box('goose_wall_cap', 10.3, 11.2, 8.9, 14.05, 3.35, 3.55, M_TRIM, bevel=0.02)

# ---------------------------------------------------------------- facade details
window(B_N, 'S', -8.0, 3.2, shutters=M_SHUT_G); window(B_N, 'S', 6.0, 3.2); window(B_N, 'S', -30, 3.4, shutters=M_SHUT_R); window(B_N, 'S', -44, 3.4); window(B_N, 'S', -20, 3.4, shutters=M_SHUT_G)
window(B_N, 'S', 12.5, 5.2, w=0.8, h=0.9)
blind_arch(B_N, 'S', -1.5, 0.0, w=2.4, h=3.4)
blind_arch(B_N, 'S', -36, 0.0, w=2.2, h=3.2)
window(B_E, 'W', 5.0, 4.2, shutters=M_SHUT_R); window(B_E, 'W', -8.0, 4.2); window(B_E, 'W', -20, 1.8, shutters=M_SHUT_G); window(B_E, 'W', -36, 1.2)
window(B_E, 'W', 10.0, 6.4, w=0.8, h=0.9)
blind_arch(B_E, 'W', 0.5, 0.0, w=2.0, h=3.0)
window(B_S, 'N', 4.0, 3.2, shutters=M_SHUT_G); window(B_S, 'N', -1.0, 3.2)
window(B_SW, 'N', -30, 3.6); window(B_SW, 'N', -20, 3.6)
window(B_W, 'N', -40, 3.2); window(B_W, 'N', -30, 3.2, shutters=M_SHUT_R); window(B_W, 'N', -50, 3.2)
blind_arch(B_W, 'N', -26, 0.0, w=2.0, h=3.0)
window(B_CTS, 'N', 6.0, -1.5, shutters=M_SHUT_G); window(B_CTS, 'N', 14.0, -1.5)
window(B_CTW, 'E', -34, -1.6); window(B_CTW, 'E', -26, -1.6, shutters=M_SHUT_R)

# awnings
awning(-9.2, -6.8, 14.0, 12.4, 5.1, 4.6, along='y', poles=False)   # over north window
awning(11.1, 15.8, 14.0, 11.6, 3.6, 3.1, along='y', poles=True)    # goose
awning(16.0, 13.4, -8.0, -4.0, 4.0, 3.4, along='x', poles=False)   # east wall near triple
awning(-14.0, -11.6, 14.0, 11.8, 4.8, 4.3, along='y', poles=False) # barrels corner

# bombsite sign on north facade
add_box('sign_a', -4.2, -2.6, 13.93, 14.0, 4.6, 6.2, M_SIGN)
add_box('sign_a_frame', -4.28, -2.52, 13.9, 13.94, 4.52, 6.28, M_IRON)

# ---------------------------------------------------------------- decals (posters, signs, graffiti, grime) -> empties
# posters / shop signs (alpha-keyed sheet)
face_decal(B_N, 'S', 'poster', -24, 1.9, 1.0, 1.3, cell=0)
face_decal(B_N, 'S', 'posters', -47, 1.7, 1.6, 1.2, cell=2)
face_decal(B_W, 'N', 'poster', -34, 1.8, 0.9, 1.2, cell=0)
face_decal(B_E, 'W', 'sign', 0.5, 3.5, 1.4, 1.0, cell=1)
face_decal(B_N, 'S', 'sign2', -36, 3.75, 1.5, 1.0, cell=3)
face_decal(B_SW, 'N', 'poster', -28, 4.2, 0.9, 1.2, cell=0)
face_decal(B_S, 'N', 'posters', 7, 1.8, 1.5, 1.1, cell=2)
face_decal(B_CTW, 'E', 'sign', -30, -1.8, 1.3, 0.9, cell=1)
# graffiti (multiply sheet)
decal('tag', (-56.815, 13.0, 1.4), math.radians(180), 1.6, 1.1, cell=0, alpha=0.8)
face_decal(B_W, 'N', 'stencil', -50, 1.3, 1.0, 1.0, cell=1, alpha=0.7)
face_decal(B_N, 'S', 'script', -9, 1.5, 1.5, 1.1, cell=2, alpha=0.75)
face_decal(B_E, 'W', 'marks', -16, 1.3, 1.4, 0.7, cell=3, alpha=0.8)
face_decal(B_PITS, 'N', 'tag', -18, -1.0, 1.4, 1.0, cell=0, alpha=0.7)
decal('stencil', (-20, -6.03, 3.9), math.radians(-90), 0.9, 0.9, cell=1, alpha=0.7)   # on the short-corridor paint band (face y=-6.02)
face_decal(B_SW, 'N', 'script', -40, 3.8, 1.3, 1.0, cell=2, alpha=0.7)
# grime (multiply sheet): splash above the stone skirts, bullet pocks at fight corners, damp stains
for (wall, face, u) in ((B_N, 'S', -40), (B_N, 'S', -12), (B_N, 'S', 8), (B_W, 'N', -45), (B_W, 'N', -28), (B_E, 'W', -4), (B_E, 'W', 8)):
    face_decal(wall, face, 'splash', u, 1.35, 3.2, 1.2, cell=1, alpha=0.6)
face_decal(B_N, 'S', 'pocks', -15, 1.5, 1.2, 1.0, cell=2, alpha=0.85)
face_decal(B_E, 'W', 'pocks', -8, 1.6, 1.1, 0.9, cell=2, alpha=0.85)
decal('pocks', (-55.985, 9.0, 1.6), 0.0, 1.0, 0.9, cell=2, alpha=0.85)
face_decal(B_S, 'N', 'pocks', 2, 1.4, 1.2, 1.0, cell=2, alpha=0.8)
face_decal(B_N, 'S', 'stain', -58, 3.0, 2.0, 2.0, cell=3, alpha=0.45)
face_decal(B_E, 'W', 'stain', -30, -0.5, 2.5, 2.5, cell=3, alpha=0.45)
face_decal(B_SW, 'N', 'stain', -16, 4.6, 2.0, 2.0, cell=3, alpha=0.4)
face_decal(B_CTS, 'N', 'stain', 10, -1.0, 2.0, 2.0, cell=3, alpha=0.45)

# ---------------------------------------------------------------- props
crate('crate_default_1', 0.0, 3.0, 0.04, 1.3)
crate('crate_default_2', 1.35, 3.0, 0.04, 1.3, planks=M_PLANK2)
crate('crate_default_3', 0.65, 3.0, 1.34, 1.3, rot=0.06)
crate('crate_default_4', 0.4, 5.6, 0.0, 1.8, rot=0.12)
crate('crate_big_north', -4.5, 10.5, 0.0, 1.8, rot=-0.05, sz=2.0)
crate('crate_ninja', 6.6, -9.4, 0.0, 1.8)
crate('crate_ninja_2', 3.9, -10.1, 0.0, 1.5, planks=M_PLANK2, rot=0.3)
crate('crate_triple_1', 14.9, -5.0, 0.0, 1.3)
crate('crate_triple_2', 14.9, -3.65, 0.0, 1.3, planks=M_PLANK2)
crate('crate_triple_3', 14.9, -4.3, 1.3, 1.3, rot=0.05)
crate('crate_goose', 13.3, 12.4, 0.0, 1.5, rot=0.4)
crate('crate_long_1', -15.0, 12.2, 0.0, 1.8, rot=0.15)
crate('crate_long_2', -30.0, 13.0, 0.0, 1.5, planks=M_PLANK2, rot=-0.2)
crate('crate_long_3', -48.0, 7.0, 0.0, 1.5, rot=0.5)
crate('crate_short', -13.0, -10.0, 2.5, 1.2, planks=M_PLANK2, rot=0.2)
crate('crate_short_2', -34.0, -10.2, 2.5, 1.5, rot=-0.1)
crate('crate_ct_1', 12.0, -38.0, -3.5, 1.5)
crate('crate_ct_2', -1.0, -39.5, -3.5, 2.0, rot=0.3)
crate('crate_pit', -20.5, -2.8, -2.4, 1.3, planks=M_PLANK2, rot=0.7)

barrel('barrel_1', -12.2, 12.6, 0.0); barrel('barrel_2', -11.4, 13.3, 0.0, m=M_BARREL2); barrel('barrel_3', -12.9, 13.4, 0.0)
barrel('barrel_4', 14.6, 8.2, 0.0, m=M_BARREL2); barrel('barrel_5', 15.3, 7.4, 0.0)
barrel('barrel_6', -18.5, 13.3, 0.0); barrel('barrel_7', -42.0, 13.2, 0.0, m=M_BARREL2)
barrel('barrel_8', 8.6, -11.2, 0.0); barrel('barrel_9', 5.0, -38.9, -3.5, m=M_BARREL2)
barrel('barrel_10', -12.0, -6.9, 2.5, m=M_BARREL2)

pickup_truck(-19.5, 9.6, 0.0, yaw=math.radians(175))

rubble(-12.5, 0.5, 0.0, n=6, spread=0.9, seed=1); rubble(12.5, 2.0, 0.0, n=5, spread=0.7, seed=2)
rubble(-52, 12.5, 0.0, n=7, spread=1.1, seed=3); rubble(6.0, 12.0, 0.0, n=4, spread=0.6, seed=4)
rubble(-16.5, -1.0, -2.4, n=5, spread=0.8, seed=5); rubble(9.0, -36, -3.5, n=5, spread=0.8, seed=6)

# ---------------------------------------------------------------- set dressing (CS2 look: painted bands, roof clutter, wires, skyline)
def band(x0, x1, y0, y1, z0, z1, m):
    return add_box('band', x0, x1, y0, y1, z0, z1, m, bevel=0.01)

# painted lower bands on the facades that face the play area. Each band sits exactly 2 cm PROUD of the wall face it
# decorates (and 2 cm into it) and never shares a plane with it: a coplanar face z-fights (the CT-west band used to be
# -4.06..-4.0 on a wall whose face is x=-4.0 -> shimmering moire when moving). 2 cm also keeps the wall decals
# (1.5 cm off the wall) 5 mm in front of the paint. Wall faces: B_E x=16, B_N y=14, SH_N y=-6 (corridor side), B_CTW x=-4.
BAND_E = band(15.98, 16.02, -12, 13.9, 0.9, 2.1, M_TEAL)         # east wall (site side)
BAND_N = band(-4, 9.9, 13.98, 14.06, 0.9, 1.9, M_OCHRE)          # north wall around the A sign
BAND_L = band(-66, -20, 13.98, 14.06, 0.9, 1.6, M_TEAL)          # long north wall skirt
BAND_S = band(-46, -14.1, -6.02, -5.94, 3.4, 4.3, M_TEAL)        # short corridor wall (corridor side, 0.9-1.8 m above the 2.5 floor)
BAND_C = band(-4.02, -3.98, -42, -20.1, -2.6, -1.5, M_TEAL)      # ct west

def dish(cx, cy, z0, yaw, tilt=math.radians(35), r=0.55):
    _new_obj('dish', _bm_cyl(r, 0.05, 24, (tilt, 0, yaw)), (cx, cy, z0 + 1.1), M_WHITEMET)
    add_box('dish_pole', cx-0.04, cx+0.04, cy-0.04, cy+0.04, z0, z0 + 1.0, M_WHITEMET)
    add_box('dish_arm', cx-0.03, cx+0.03, cy-0.35, cy+0.03, z0 + 0.95, z0 + 1.02, M_WHITEMET)

def antenna(cx, cy, z0, h=2.8):
    add_cyl_axis('ant', (cx, cy, z0 + h/2), 0.025, h, M_WHITEMET, axis='z', verts=8)
    for i, w in enumerate((0.9, 0.7, 0.5)):
        add_box('ant_bar', cx - w/2, cx + w/2, cy-0.015, cy+0.015, z0 + h - 0.35*i - 0.03, z0 + h - 0.35*i, M_WHITEMET)

def roofbox(cx, cy, z0, sx=1.2, sy=1.0, sz=0.9, m=M_WALL2, iron=True):
    add_box('roofbox', cx - sx/2, cx + sx/2, cy - sy/2, cy + sy/2, z0, z0 + sz, m, bevel=0.02)
    if iron: add_box('roofbox_lid', cx - sx/2 - 0.05, cx + sx/2 + 0.05, cy - sy/2 - 0.05, cy + sy/2 + 0.05, z0 + sz, z0 + sz + 0.06, M_IRON)

def water_tank(cx, cy, z0):
    add_cyl_axis('tank', (cx, cy, z0 + 0.9), 0.6, 1.4, M_WHITEMET, axis='z', verts=16)
    for dx, dy in ((-0.4,-0.4),(0.4,-0.4),(-0.4,0.4),(0.4,0.4)):
        add_box('tank_leg', cx+dx-0.04, cx+dx+0.04, cy+dy-0.04, cy+dy+0.04, z0, z0 + 0.25, M_RUBBER)

# north roof (z 7.5), east roof (9.5), west (7.0), southwest (7.0), south (7.0), ct (6.0 / 6.5)
dish(-30, 16.0, 6.5, math.radians(200), r=0.9); dish(4.0, 16.5, 6.5, math.radians(190), r=0.9); antenna(-12, 17, 6.5); dish(-52, 16.2, 6.5, math.radians(210), r=0.8)
roofbox(-45, 18, 6.5, 1.6, 1.3, 1.1); water_tank(12, 18, 6.5); roofbox(-22, 19, 6.5, 2.2, 1.6, 1.4, m=M_WALL)
dish(18.5, -2.0, 8.5, math.radians(260), r=0.9); antenna(18.2, 6, 8.5, 3.2); roofbox(19, -20, 8.5, 1.8, 1.4, 1.2); water_tank(19.5, -34, 8.5); dish(18.3, -30, 8.5, math.radians(250), r=0.8)
dish(-40, -3.0, 6.5, math.radians(30), r=0.9); roofbox(-55, 0, 6.5, 2.0, 1.5, 1.3, m=M_WALL2); antenna(-28, -3.5, 6.5)
dish(-20, -14, 6.0, math.radians(60), r=0.9); roofbox(-40, -16, 6.0, 1.6, 1.2, 1.0); water_tank(-8, -16, 6.0)
roofbox(4, -16, 6.5, 1.4, 1.2, 1.0); antenna(-1, -27, 6.5)
dish(10, -45, 6.0, math.radians(70)); antenna(-7, -30, 6.5)
dish(-60, 15.5, 6.5, math.radians(195), r=1.0); antenna(-40, 15.8, 6.5, 3.2); dish(-18, 15.6, 6.5, math.radians(205), r=1.0); antenna(16, 15.8, 6.5, 3.0)
dish(-58, -1.5, 6.5, math.radians(20), r=1.0); antenna(-48, -2.0, 6.5, 3.0); dish(-30, -1.6, 6.5, math.radians(35), r=0.9)
dish(-50, -12.5, 6.0, math.radians(50), r=1.0); antenna(-32, -12.8, 6.0, 3.0); dish(-10, -12.6, 6.0, math.radians(80), r=1.0)
dish(6, -13.5, 6.5, math.radians(100), r=1.0); antenna(17.2, -10, 8.5, 3.2); dish(17.5, 10, 8.5, math.radians(240), r=1.0)

# power poles + sagging wires over long and the site
def pole(cx, cy, z0, h=7.5):
    add_cyl_axis('pole', (cx, cy, z0 + h/2), 0.13, h, M_WOOD, axis='z', verts=10)
    add_box('pole_bar', cx-0.6, cx+0.6, cy-0.06, cy+0.06, z0 + h - 0.45, z0 + h - 0.33, M_WOOD)
    return (cx, cy, z0 + h - 0.35)

def wire(a, b, sag=0.45):
    from mathutils import Vector
    A, B = Vector(a), Vector(b); M = (A + B) / 2; M.z -= sag
    for p, q in ((A, M), (M, B)):
        d = q - p; L = d.length
        o = _new_obj('wire', _bm_cyl(0.018, L, 5), (p + q) / 2, M_WIRE)
        o.rotation_euler = d.to_track_quat('Z', 'Y').to_euler(); apply_all(o); o['nocollide'] = 1

p1 = pole(-30, 13.2, 0.0); p2 = pole(-14.5, 13.3, 0.0); p3 = pole(-48, 13.3, 0.0)
wire(p1, p2); wire(p1, p3); wire(p2, (-6, 14.0, 6.8)); wire(p3, (-58, 14.0, 6.6))
wire((-9, 14.0, 6.6), (16, 10, 6.9), sag=0.7); wire((-2, 14.0, 6.3), (16, -2, 6.8), sag=0.8)
wire((-14, -5.2, 6.2), (-22, 14, 6.3), sag=0.9)
wire((16, -30, 6.8), (-4, -42, 6.2), sag=0.7)

# ---------------------------------------------------------------- site clutter pass (critic #3: prop density)
M_PALLET = tex_mat('pallet_wood', 'weathered_planks', 1.0, 'wood')
def pipe(x, y, z0, z1, r=0.07, elbow=True):
    """Vertical drain pipe hugging a wall corner/face, with a small elbow + spout at the top."""
    add_cyl_axis('pipe', (x, y, (z0 + z1) / 2), r, z1 - z0, M_IRON, axis='z', verts=10)
    if elbow:
        add_cyl_axis('pipe_elbow', (x, y, z1 + r), r * 1.15, r * 2.4, M_IRON, axis='z', verts=10)
    for bz in (z0 + 1.2, z0 + 3.6):
        add_box('pipe_bracket', x - r - 0.03, x + r + 0.03, y - r - 0.03, y + r + 0.03, bz, bz + 0.06, M_DARK)

def wall_lamp(x, y, z, yaw):
    """Hooded industrial wall lamp: arm + shade + bulb, facing `yaw` (outward normal)."""
    objs = []
    objs.append(add_box('lamp_arm', 0.0, 0.42, -0.025, 0.025, -0.025, 0.025, M_DARK))
    objs.append(add_box('lamp_mount', -0.01, 0.03, -0.09, 0.09, -0.11, 0.11, M_DARK))
    objs.append(add_cyl_axis('lamp_shade', (0.42, 0, -0.06), 0.17, 0.10, M_DARK, axis='z', verts=14))
    objs.append(add_cyl_axis('lamp_bulb', (0.42, 0, -0.13), 0.06, 0.05, M_WHITEMET, axis='z', verts=10))
    R = Matrix.Rotation(yaw, 4, 'Z')
    for o in objs:
        o.matrix_world = Matrix.Translation((x, y, z)) @ R @ o.matrix_world; apply_all(o)

def pallet(cx, cy, z0, yaw, lean=math.radians(12)):
    """Wooden pallet standing on edge, leaning back against a wall (local +Y = toward wall)."""
    objs = []
    for i in range(5):
        u = -0.5 + i * 0.25
        objs.append(add_box('pallet_slat', u - 0.055, u + 0.055, -0.07, -0.05, 0.0, 1.0, M_PALLET, bevel=0.004))
    for v in (0.05, 0.5, 0.95):
        objs.append(add_box('pallet_stringer', -0.6, 0.6, -0.05, 0.03, v - 0.05, v + 0.05, M_PALLET, bevel=0.004))
    R = Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(lean, 4, 'X')
    for o in objs:
        o.matrix_world = Matrix.Translation((cx, cy, z0)) @ R @ o.matrix_world; apply_all(o)

def ac_unit(x, y, z, yaw):
    """Wall air-con box with a dark grille and drip stain below (local +X = outward)."""
    objs = [add_box('ac_body', 0.0, 0.42, -0.42, 0.42, -0.30, 0.30, M_WHITEMET, bevel=0.015),
            add_box('ac_grille', 0.42, 0.44, -0.34, 0.34, -0.22, 0.22, M_DARK),
            add_box('ac_bracket', 0.0, 0.40, -0.40, -0.36, -0.36, -0.30, M_DARK),
            add_box('ac_bracket', 0.0, 0.40, 0.36, 0.40, -0.36, -0.30, M_DARK)]
    for i in range(6):
        objs.append(add_box('ac_fin', 0.445, 0.455, -0.34, 0.34, -0.20 + i * 0.075, -0.20 + i * 0.075 + 0.012, M_WHITEMET))
    R = Matrix.Rotation(yaw, 4, 'Z')
    for o in objs:
        o.matrix_world = Matrix.Translation((x, y, z)) @ R @ o.matrix_world; apply_all(o)

def plank_stack(cx, cy, z0, yaw, n=5):
    objs = []
    for i in range(n):
        objs.append(add_box('plank', -1.1 + rnd.uniform(-0.08, 0.08), 1.1 + rnd.uniform(-0.08, 0.08), -0.14 + i * 0.03, 0.14 + i * 0.03, i * 0.045, i * 0.045 + 0.04, M_PLANK2, bevel=0.003))
    R = Matrix.Rotation(yaw, 4, 'Z')
    for o in objs:
        o.matrix_world = Matrix.Translation((cx, cy, z0)) @ R @ o.matrix_world; apply_all(o)

import random as _random
rnd = _random.Random(7)
# drain pipes on building corners / long faces around A
pipe(15.85, 13.85, 0.0, 6.3); pipe(15.85, -11.85, 0.0, 6.3); pipe(10.1, -11.85, 0.0, 6.3); pipe(-3.9, -11.85, 0.0, 6.3)
pipe(-13.85, 13.85, 0.0, 6.3); pipe(-31.5, 13.9, 0.0, 6.3); pipe(-47.5, 13.9, 0.0, 6.3)
# wall lamps facing into the site / long
wall_lamp(-4.0, 13.95, 3.6, math.radians(-90)); wall_lamp(9.0, 13.95, 3.6, math.radians(-90)); wall_lamp(-26.0, 13.95, 3.6, math.radians(-90)); wall_lamp(-44.0, 13.95, 3.6, math.radians(-90))
wall_lamp(15.95, 2.0, 3.6, math.radians(180)); wall_lamp(15.95, -8.0, 3.6, math.radians(180)); wall_lamp(3.0, -11.95, 3.6, math.radians(90))
# AC units
ac_unit(15.95, 7.0, 3.1, math.radians(180)); ac_unit(1.5, 13.95, 3.3, math.radians(-90)); ac_unit(-38.0, 13.95, 3.4, math.radians(-90))
# pallets leaning on walls, plank stacks
pallet(-9.5, 13.72, 0.0, 0.0); pallet(-8.2, 13.70, 0.0, math.radians(3)); pallet(12.0, -11.72, 0.0, math.radians(180)); pallet(-36.0, 13.72, 0.0, math.radians(-2))
plank_stack(-2.0, 12.9, 0.0, math.radians(2)); plank_stack(15.0, -3.0, 0.0, math.radians(88), n=4)
barrel('barrel_11', 14.9, 11.8, 0.0); barrel('barrel_12', 14.2, 12.6, 0.0, m=M_BARREL2)

# ================================================================ ARCHITECTURAL DETAIL PASS
# Real Dust2 facades are layered: reveals, sills, lintels, shutters, grilles, beam rows, string courses, fallen plaster,
# pilasters, stepped rooflines and street clutter. Everything below is plain geometry in the existing MAP_ materials (one new
# flat material, fabric_canvas, for the awnings). Street-level pieces hug the walls and are checked against the bot nav edges
# at the end of this block (NAV_CLEAR); nothing is placed inside the plant zone or on the classic A-site sight lines.
M_FABRIC = flat_mat('fabric_canvas', (0.64, 0.40, 0.30), rough=0.95, surface='wood')   # sun-faded rust-red canvas
DETAIL = []                   # street-level objects to clearance-check against the nav graph
_alls = len(ALL)

def track(z_top=2.2):
    """Register everything added since the last call as a street-level object (for the nav clearance check)."""
    global _alls
    DETAIL.extend(ALL[_alls:]); _alls = len(ALL)

def untrack():
    global _alls
    _alls = len(ALL)

def _world_bbox(ob):
    return _mesh_bounds(ob)

def cut_through(wall, mk_cutter):
    """Boolean-cut `wall` and every stone skirt ('*base*') / painted 'band' box overlapping the same region."""
    c = mk_cutter(); bb = _world_bbox(c); cut(wall, c)
    for ob in list(ALL):
        if ob is wall or ob.type != 'MESH' or ob.name not in bpy.data.objects: continue
        if not ('base' in ob.name or ob.name.startswith('band')): continue
        ob_bb = _world_bbox(ob)
        if all(ob_bb[2*i] < bb[2*i+1] - 0.01 and ob_bb[2*i+1] > bb[2*i] + 0.01 for i in range(3)):
            cut(ob, mk_cutter())

# ---- doors
def doorway(wall, face, u, z0, w=1.2, h=2.4, kind='blue', depth=0.22, step=False, band_obj=None):
    """Recessed doorway: timber jambs + head, stone threshold (optional extra step), and a leaf:
    'blue' (M_DOOR planks), 'green' (heavy painted door with two raised panels), 'double' (two plank leaves with iron studs and
    strap hinges), 'roller' (corrugated roller shutter in iron guides under its housing). band_obj: painted band to cut through."""
    o, s, horiz = face_axes(wall, face)
    box = lambda name, a0, a1, d0, d1, zz0, zz1, m, bevel=0.0: fbox(name, o, s, horiz, a0, a1, d0, d1, zz0, zz1, m, bevel=bevel)
    # the opening goes through the wall AND through whatever skirt / painted band sits proud of that face
    cut_through(wall, lambda: fcut(o, s, horiz, u-w/2, u+w/2, 0.3, -depth, z0-0.05, z0+h))
    box('door_back', u-w/2, u+w/2, -depth+0.02, -depth-0.05, z0-0.05, z0+h, M_DARK)
    box('door_jamb', u-w/2, u-w/2+0.10, -depth+0.02, 0.0, z0, z0+h, M_WOOD); box('door_jamb', u+w/2-0.10, u+w/2, -depth+0.02, 0.0, z0, z0+h, M_WOOD)
    box('door_head', u-w/2, u+w/2, -depth+0.02, 0.0, z0+h-0.12, z0+h, M_WOOD)
    box('door_lintel', u-w/2-0.18, u+w/2+0.18, 0.07, -depth, z0+h, z0+h+0.20, M_WOOD if kind != 'roller' else M_TRIM, bevel=0.01)
    box('door_sill', u-w/2-0.04, u+w/2+0.04, 0.10, -depth, z0-0.02, z0+0.04, M_TRIM, bevel=0.01)
    if step: box('door_step', u-w/2-0.22, u+w/2+0.22, 0.42, 0.06, z0-0.02, z0+0.15, M_STONE, bevel=0.015)
    ld0, ld1 = -depth + 0.06, -depth + 0.10
    if kind == 'blue':
        box('door_leaf', u-w/2+0.10, u+w/2-0.10, ld0, ld1, z0+0.01, z0+h-0.12, M_DOOR)
        box('door_handle', u+w/2-0.28, u+w/2-0.20, ld1, ld1 + 0.05, z0+1.0, z0+1.04, M_BRACKET)
    elif kind == 'green':
        box('door_leaf', u-w/2+0.10, u+w/2-0.10, ld0, ld1, z0+0.01, z0+h-0.12, M_SHUT_G)
        for zz0, zz1 in ((z0+0.25, z0+0.95), (z0+1.25, z0+h-0.35)):
            box('door_panel', u-w/2+0.24, u+w/2-0.24, ld1, ld1 + 0.02, zz0, zz1, M_SHUT_G)
        box('door_handle', u+w/2-0.30, u+w/2-0.20, ld1 + 0.02, ld1 + 0.07, z0+1.0, z0+1.05, M_BRACKET)
    elif kind == 'double':
        for side in (-1, 1):
            a0, a1 = sorted((u + side*0.008, u + side*(w/2 - 0.10)))
            box('door_leaf', a0, a1, ld0, ld1, z0+0.01, z0+h-0.12, M_PLANK)
            for i in range(3):                                   # strap hinges
                zz = z0 + 0.35 + i * (h - 0.9) / 2
                box('door_strap', min(a0 + 0.02, a1 - 0.02), (a0 + a1)/2 + side*0.05, ld1, ld1 + 0.012, zz-0.035, zz+0.035, M_BRACKET) if side < 0 else \
                box('door_strap', (a0 + a1)/2 - 0.05, a1 - 0.02, ld1, ld1 + 0.012, zz-0.035, zz+0.035, M_BRACKET)
            for i in range(4):                                   # iron studs
                for j in range(2):
                    aa = a0 + (a1 - a0) * (0.25 + 0.5 * j); zz = z0 + 0.25 + i * (h - 0.6) / 3
                    box('door_stud', aa-0.025, aa+0.025, ld1, ld1 + 0.03, zz-0.025, zz+0.025, M_BRACKET)
        box('door_ring', u-0.08, u+0.08, ld1 + 0.01, ld1 + 0.04, z0+1.05, z0+1.10, M_BRACKET)
    elif kind == 'roller':
        box('door_leaf', u-w/2+0.08, u+w/2-0.08, ld0, ld1, z0+0.01, z0+h-0.30, M_IRON)
        n = int((h - 0.4) / 0.16)
        for i in range(n):                                       # slat grooves
            zz = z0 + 0.12 + i * 0.16
            box('door_groove', u-w/2+0.08, u+w/2-0.08, ld1 - 0.002, ld1 + 0.006, zz-0.008, zz+0.008, M_DARK)
        box('door_guide', u-w/2+0.02, u-w/2+0.08, -depth+0.02, ld1 + 0.03, z0, z0+h-0.30, M_BRACKET)
        box('door_guide', u+w/2-0.08, u+w/2-0.02, -depth+0.02, ld1 + 0.03, z0, z0+h-0.30, M_BRACKET)
        box('door_housing', u-w/2+0.02, u+w/2-0.02, -depth+0.02, 0.04, z0+h-0.32, z0+h-0.01, M_IRON, bevel=0.01)
        box('door_lock', u-0.10, u+0.10, ld1, ld1 + 0.03, z0+0.30, z0+0.36, M_BRACKET)

# ---- wall surface
def string_course(wall, face, z, a0=None, a1=None, proud=0.10, h=0.14):
    """Horizontal ledge at storey height, running the length of the face."""
    o, s, horiz = face_axes(wall, face)
    xmin, xmax, ymin, ymax = _bounds(wall)
    lo, hi = (xmin, xmax) if horiz else (ymin, ymax)
    fbox('course', o, s, horiz, a0 if a0 is not None else lo - 0.02, a1 if a1 is not None else hi + 0.02, proud, -0.02, z, z + h, M_TRIM, bevel=0.01)

def plaster_patch(wall, face, u, z, w, h, seed=0, m=None):
    """Fallen plaster: an irregular polygon recessed 3 cm into the wall with the rubble-stone core showing behind."""
    o, s, horiz = face_axes(wall, face)
    rr = random.Random(seed or _hash(u, z))
    n = rr.randint(7, 10)
    pts = []
    for i in range(n):
        a = i / n * math.tau
        ra = (w/2) * rr.uniform(0.55, 1.0); rz = (h/2) * rr.uniform(0.55, 1.0)
        pts.append((u + ra * math.cos(a), z + rz * math.sin(a)))
    # prism along the normal from 0.3 outside to 0.03 inside
    d_out, d_in = 0.3, -0.03
    v = [fpoint(o, s, horiz, a, d_out, zz) for a, zz in pts] + [fpoint(o, s, horiz, a, d_in, zz) for a, zz in pts]
    f = [tuple(range(n)), tuple(range(n, 2*n))[::-1]] + [(i, (i+1) % n, n + (i+1) % n, n + i) for i in range(n)]
    me = bpy.data.meshes.new('cutter'); me.from_pydata(v, [], f); me.update()
    c = bpy.data.objects.new('cutter', me); bpy.context.collection.objects.link(c)
    bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(me); bm.free()
    cut(wall, c)
    fbox('patch', o, s, horiz, u - w/2 - 0.05, u + w/2 + 0.05, -0.03, -0.12, z - h/2 - 0.05, z + h/2 + 0.05, m or M_STONE)

def crack(wall, face, u, z, length=1.6, seed=0, width=0.022, depth=0.02):
    """Thin recessed zigzag groove wandering down the plaster."""
    o, s, horiz = face_axes(wall, face)
    rr = random.Random(seed or _hash(u, z, length))
    a, zz = u, z
    n = rr.randint(4, 6)
    for i in range(n):
        L = length / n * rr.uniform(0.7, 1.3)
        da = L * rr.uniform(-0.6, 0.6); dz = -math.sqrt(max(L*L - da*da, 0.01))          # each segment wanders sideways, always heading down
        amid, zmid = a + da/2, zz + dz/2
        c = fcut(o, s, horiz, amid - L/2 - width, amid + L/2 + width, 0.2, -depth, zmid - width/2, zmid + width/2)
        tilt = math.atan2(dz, da)                                                          # angle of the segment in the (along, z) plane
        rot_objs([c], fpoint(o, s, horiz, amid, (0.2 - depth) / 2, zmid), 'Y' if horiz else 'X', -tilt if horiz else tilt)
        # one boolean per segment: a joined, self-overlapping cutter makes the EXACT solver return an empty mesh
        cut(wall, c)
        a += da; zz += dz

def pilaster(wall, face, u, z0, z1, w=0.7, proud=0.22, m=None):
    """Full-height wall thickening with a small cap; breaks a long facade into bays and marks its ends."""
    o, s, horiz = face_axes(wall, face)
    fbox('pilaster', o, s, horiz, u - w/2, u + w/2, proud, -0.02, z0, z1, m or M_WALL)
    fbox('pilaster_cap', o, s, horiz, u - w/2 - 0.06, u + w/2 + 0.06, proud + 0.06, -0.02, z1, z1 + 0.12, M_TRIM, bevel=0.01)
    fbox('pilaster_base', o, s, horiz, u - w/2 - 0.06, u + w/2 + 0.06, proud + 0.06, -0.02, z0 - 0.6, z0 + 0.9, M_STONE, bevel=0.02)

def chamfer(wall, cx, cy, z0, z1, size=0.28):
    """Chamfer a vertical building corner at (cx, cy) with a 45-degree cutter."""
    c = _new_obj('cutter', _bm_box(size, size, (z1 - z0) + 0.4), (cx, cy, (z0 + z1) / 2))
    c.rotation_euler = (0, 0, math.pi / 4); apply_all(c)
    cut(wall, c)

# ---- roofline
def vigas(wall, face, z, a0=None, a1=None, step=1.25, out=0.36, seed=0, skip=()):
    """Row of exposed roof beams poking out of the wall (unbevelled: 12 tris each). skip = (lo, hi) ranges (windows)."""
    o, s, horiz = face_axes(wall, face)
    xmin, xmax, ymin, ymax = _bounds(wall)
    lo, hi = (xmin, xmax) if horiz else (ymin, ymax)
    a0 = lo + 0.6 if a0 is None else a0; a1 = hi - 0.4 if a1 is None else a1
    rr = random.Random(seed or _hash(z, a0))
    a = a0
    while a < a1:
        if not any(l - 0.12 < a < h + 0.12 for l, h in skip):
            ln = out * rr.uniform(0.8, 1.15); dz = rr.uniform(-0.02, 0.02)
            fbox('viga', o, s, horiz, a - 0.09, a + 0.09, ln, -0.2, z - 0.09 + dz, z + 0.09 + dz, M_WOOD)
        a += step * rr.uniform(0.92, 1.08)

def scupper(wall, face, u, z, streak=True):
    """Roof drainage spout through the parapet with the staining below it."""
    o, s, horiz = face_axes(wall, face)
    fcyl('scupper', o, s, horiz, u, 0.32, -0.2, z, 0.055, M_IRON, verts=10)
    fbox('scupper_plate', o, s, horiz, u - 0.14, u + 0.14, 0.02, -0.01, z - 0.14, z + 0.14, M_IRON)
    if streak: face_decal(wall, face, 'streak', u, z - 1.35, 1.1, 2.4, cell=0, alpha=0.7)

def merlons(x0, x1, y0, y1, z, m=M_WALL2, w=0.5, gap=0.42, h=0.42, t=None):
    """Low mud-brick crenellation ring on top of a parapet (footprint x0..x1 / y0..y1, t = wall thickness)."""
    t = t or min(x1 - x0, y1 - y0)
    def run(a0, a1, place):
        a = a0
        while a + w <= a1 + 1e-6:
            place(a, a + w); a += w + gap
    thin_x, thin_y = (x1 - x0) <= t + 0.01, (y1 - y0) <= t + 0.01
    if thin_y:                                                   # a single wall running along X
        run(x0, x1, lambda a, b: add_box('merlon', a, b, y0, y1, z, z + h, m))
    elif thin_x:                                                 # a single wall running along Y
        run(y0, y1, lambda a, b: add_box('merlon', x0, x1, a, b, z, z + h, m))
    else:                                                        # ring around a roof
        run(x0, x1, lambda a, b: add_box('merlon', a, b, y0, y0 + t, z, z + h, m))
        run(x0, x1, lambda a, b: add_box('merlon', a, b, y1 - t, y1, z, z + h, m))
        run(y0 + w + gap, y1 - w - gap, lambda a, b: add_box('merlon', x0, x0 + t, a, b, z, z + h, m))
        run(y0 + w + gap, y1 - w - gap, lambda a, b: add_box('merlon', x1 - t, x1, a, b, z, z + h, m))

def roof_room(cx, cy, z0, sx, sy, h, m=M_WALL, door_face='S'):
    """Stair-head room on a roof: its own parapet cap, a dark doorway and a slit window -> stepped roofline."""
    add_box('roofroom', cx - sx/2, cx + sx/2, cy - sy/2, cy + sy/2, z0, z0 + h, m)
    add_box('roofroom_cap', cx - sx/2 - 0.12, cx + sx/2 + 0.12, cy - sy/2 - 0.12, cy + sy/2 + 0.12, z0 + h - 0.2, z0 + h + 0.25, m, bevel=0.03)
    add_box('roofroom_capstone', cx - sx/2 - 0.16, cx + sx/2 + 0.16, cy - sy/2 - 0.16, cy + sy/2 + 0.16, z0 + h + 0.22, z0 + h + 0.32, M_TRIM, bevel=0.02)
    dy = -sy/2 if door_face == 'S' else sy/2
    add_box('roofroom_door', cx - 0.45, cx + 0.45, cy + dy - 0.03, cy + dy + 0.03, z0, z0 + 1.9, M_DARK)
    add_box('roofroom_doorhead', cx - 0.55, cx + 0.55, cy + dy - 0.08, cy + dy + 0.08, z0 + 1.9, z0 + 2.05, M_WOOD)
    add_box('roofroom_win', cx - sx/2 - 0.03, cx - sx/2 + 0.03, cy - 0.25, cy + 0.25, z0 + 1.1, z0 + 1.7, M_DARK)

def tarp_roll(cx, cy, z0, length, yaw=0.0, r=0.2):
    objs = [add_cyl_axis('tarp', (0, 0, r), r, length, M_FABRIC, axis='x', verts=12)]
    for x in (-length * 0.3, length * 0.3):
        objs.append(add_cyl_axis('tarp_rope', (x, 0, r), r + 0.012, 0.05, M_WIRE, axis='x', verts=10))
    R = Matrix.Rotation(yaw, 4, 'Z')
    for ob in objs:
        ob.matrix_world = Matrix.Translation((cx, cy, z0)) @ R @ ob.matrix_world; apply_all(ob)

def tv_antenna(cx, cy, z0, h=3.2, yaw=0.0):
    """Yagi-style TV aerial: mast, boom, director elements, plus a guy wire."""
    objs = [add_cyl_axis('tv_mast', (0, 0, h/2), 0.022, h, M_WHITEMET, axis='z', verts=8),
            add_box('tv_boom', -0.7, 0.7, -0.015, 0.015, h - 0.03, h, M_WHITEMET)]
    for i, x in enumerate((-0.6, -0.35, -0.1, 0.15, 0.4, 0.62)):
        L = 0.55 - i * 0.05
        objs.append(add_box('tv_el', x - 0.01, x + 0.01, -L/2, L/2, h - 0.03, h - 0.01, M_WHITEMET))
    objs.append(add_box('tv_ref', -0.68, -0.66, -0.4, 0.4, h - 0.16, h + 0.12, M_WHITEMET))
    R = Matrix.Rotation(yaw, 4, 'Z')
    for ob in objs:
        ob.matrix_world = Matrix.Translation((cx, cy, z0)) @ R @ ob.matrix_world; apply_all(ob)
    wire((cx, cy, z0 + h - 0.4), (cx + 1.4 * math.cos(yaw + 0.7), cy + 1.4 * math.sin(yaw + 0.7), z0 + 0.05), sag=0.05)

# ---- street level
def fabric_awning(wall, face, u, w, z, out=1.35, drop=0.5, ripped=False, poles=True):
    """Canvas shop awning on a timber frame: sloped canvas in strips (one may be torn and hanging), a front rail, wall
    brackets and two poles to the ground. Poles are the only street-level collision (they hug the wall)."""
    o, s, horiz = face_axes(wall, face)
    P = lambda a, d, zz: fpoint(o, s, horiz, a, d, zz)
    f = [(0,1,2,3),(7,6,5,4),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]
    n = 4; sw = w / n
    rr = random.Random(_hash(u, z, w))
    for i in range(n):
        a0, a1 = u - w/2 + i*sw, u - w/2 + (i+1)*sw
        sag = rr.uniform(0.0, 0.07)
        if ripped and i == 1:
            # torn strip: outer half missing, inner half sags and a flap hangs down from the tear (kept >= 2.2 m: head clearance)
            v = [P(a0, 0.02, z), P(a1, 0.02, z), P(a1, out*0.55, z - drop*0.55 - 0.1), P(a0, out*0.55, z - drop*0.5 - 0.08),
                 P(a0, 0.02, z - 0.02), P(a1, 0.02, z - 0.02), P(a1, out*0.55, z - drop*0.55 - 0.12), P(a0, out*0.55, z - drop*0.5 - 0.10)]
            add_mesh('awning_canvas', v, f, M_FABRIC)
            fl = max(z - drop - 0.3, 2.25)
            v = [P(a0 + 0.05, out*0.55, z - drop*0.5 - 0.1), P(a1 - 0.1, out*0.55, z - drop*0.55 - 0.12), P(a1 - 0.25, out*0.5, fl), P(a0 + 0.12, out*0.48, fl + 0.05),
                 P(a0 + 0.05, out*0.55 - 0.02, z - drop*0.5 - 0.1), P(a1 - 0.1, out*0.55 - 0.02, z - drop*0.55 - 0.12), P(a1 - 0.25, out*0.5 - 0.02, fl), P(a0 + 0.12, out*0.48 - 0.02, fl + 0.05)]
            add_mesh('awning_flap', v, f, M_FABRIC)
            continue
        v = [P(a0, 0.02, z), P(a1, 0.02, z), P(a1, out, z - drop - sag), P(a0, out, z - drop - sag),
             P(a0, 0.02, z - 0.02), P(a1, 0.02, z - 0.02), P(a1, out, z - drop - sag - 0.02), P(a0, out, z - drop - sag - 0.02)]
        add_mesh('awning_canvas', v, f, M_FABRIC)
    # frame: wall batten, front rail, two rafters, poles
    fbox('awning_batten', o, s, horiz, u - w/2 - 0.05, u + w/2 + 0.05, 0.0, 0.06, z - 0.06, z + 0.02, M_WOOD)
    fbox('awning_rail', o, s, horiz, u - w/2 - 0.05, u + w/2 + 0.05, out - 0.03, out + 0.03, z - drop - 0.08, z - drop - 0.02, M_WOOD)
    for a in (u - w/2 + 0.04, u + w/2 - 0.04):
        v = [P(a - 0.03, 0.05, z - 0.02), P(a + 0.03, 0.05, z - 0.02), P(a + 0.03, out, z - drop - 0.02), P(a - 0.03, out, z - drop - 0.02),
             P(a - 0.03, 0.05, z - 0.08), P(a + 0.03, 0.05, z - 0.08), P(a + 0.03, out, z - drop - 0.08), P(a - 0.03, out, z - drop - 0.08)]
        add_mesh('awning_rafter', v, f, M_WOOD)
        if poles:
            untrack()
            fbox('awning_pole', o, s, horiz, a - 0.04, a + 0.04, out - 0.04, out + 0.04, z - drop - 2.9, z - drop - 0.05, M_WOOD)
            track()

def bench(cx, cy, z0, yaw=0.0, L=1.6):
    objs = [add_box('bench_top', -L/2, L/2, -0.24, 0.24, 0.36, 0.46, M_TRIM, bevel=0.012),
            add_box('bench_leg', -L/2 + 0.12, -L/2 + 0.36, -0.18, 0.18, 0.0, 0.36, M_STONE),
            add_box('bench_leg', L/2 - 0.36, L/2 - 0.12, -0.18, 0.18, 0.0, 0.36, M_STONE)]
    R = Matrix.Rotation(yaw, 4, 'Z')
    for ob in objs:
        ob.matrix_world = Matrix.Translation((cx, cy, z0)) @ R @ ob.matrix_world; apply_all(ob)

def sandbags(cx, cy, z0, yaw=0.0, rows=2, per=3, seed=0):
    rr = random.Random(seed or _hash(cx, cy))
    objs = []
    for r in range(rows):
        for i in range(per - (r % 2)):
            x = (i - (per - 1 - (r % 2)) / 2) * 0.58 + rr.uniform(-0.02, 0.02)
            y = rr.uniform(-0.03, 0.03) + (0.0 if r % 2 == 0 else 0.0)
            b = add_box('sandbag', x - 0.28, x + 0.28, y - 0.19, y + 0.19, r * 0.2, r * 0.2 + 0.21, M_GROUND, bevel=0.07, seg=2)
            b.rotation_euler = (0, 0, rr.uniform(-0.08, 0.08)); apply_all(b); objs.append(b)
    R = Matrix.Rotation(yaw, 4, 'Z')
    for ob in objs:
        ob.matrix_world = Matrix.Translation((cx, cy, z0)) @ R @ ob.matrix_world; apply_all(ob)

def ladder(wall, face, u, z0, h=3.4, lean=math.radians(13)):
    """Timber ladder leaning against the face at u (feet on the ground, top resting on the wall)."""
    o, s, horiz = face_axes(wall, face)
    objs = []
    for a in (u - 0.2, u + 0.2):
        objs.append(fbox('ladder_rail', o, s, horiz, a - 0.025, a + 0.025, 0.06, 0.11, z0, z0 + h, M_WOOD))
    for i in range(1, int(h / 0.32)):
        objs.append(fbox('ladder_rung', o, s, horiz, u - 0.2, u + 0.2, 0.07, 0.10, z0 + i * 0.32 - 0.015, z0 + i * 0.32 + 0.015, M_WOOD))
    # lean: rotate about the foot line so the feet move away from the wall
    foot = fpoint(o, s, horiz, u, 0.085, z0 + h)
    ang = lean
    q = Matrix.Translation(Vector(foot)) @ Matrix.Rotation(ang, 4, 'X' if horiz else 'Y') @ Matrix.Translation(-Vector(foot)) @ Vector(fpoint(o, s, horiz, u, 0.085, z0))
    out_of = lambda p: s * ((p.y if horiz else p.x) - o)
    if out_of(q) < 0.085: ang = -ang
    rot_objs(objs, foot, 'X' if horiz else 'Y', ang)

def handcart(cx, cy, z0, yaw=0.0):
    """Two-wheeled wooden hand-cart resting on its handles."""
    objs = [add_box('cart_bed', -0.75, 0.75, -0.42, 0.42, 0.42, 0.47, M_PLANK2, bevel=0.005),
            add_box('cart_side', -0.75, 0.75, -0.44, -0.40, 0.47, 0.78, M_PLANK2), add_box('cart_side', -0.75, 0.75, 0.40, 0.44, 0.47, 0.78, M_PLANK2),
            add_box('cart_end', 0.71, 0.75, -0.40, 0.40, 0.47, 0.72, M_PLANK2),
            add_cyl_axis('cart_axle', (0.0, 0, 0.36), 0.03, 1.12, M_DARK, axis='y', verts=8),
            add_box('cart_handle', -1.55, -0.6, -0.36, -0.31, 0.42, 0.47, M_WOOD), add_box('cart_handle', -1.55, -0.6, 0.31, 0.36, 0.42, 0.47, M_WOOD),
            add_box('cart_leg', -1.5, -1.42, -0.34, -0.30, 0.0, 0.44, M_WOOD)]
    for sgn in (-1, 1):
        w = add_cyl_axis('cart_wheel', (0.0, sgn * 0.52, 0.36), 0.36, 0.07, M_WOOD, axis='y', verts=16); bevel_obj(w, 0.02, 1); objs.append(w)
        objs.append(add_cyl_axis('cart_hub', (0.0, sgn * 0.56, 0.36), 0.08, 0.04, M_DARK, axis='y', verts=10))
    objs.append(add_box('cart_load', -0.4, 0.4, -0.3, 0.3, 0.47, 0.9, M_GROUND2, bevel=0.06))   # sacks
    R = Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(math.radians(-1.5), 4, 'Y')
    for ob in objs:
        ob.matrix_world = Matrix.Translation((cx, cy, z0)) @ R @ ob.matrix_world; apply_all(ob)

def lantern(wall, face, u, z):
    """Wall lantern on a wrought bracket: scroll arm, glazed box with a little pyramid roof."""
    o, s, horiz = face_axes(wall, face)
    fbox('lantern_plate', o, s, horiz, u - 0.05, u + 0.05, 0.0, 0.02, z + 0.25, z + 0.55, M_BRACKET)
    fbox('lantern_arm', o, s, horiz, u - 0.015, u + 0.015, 0.0, 0.42, z + 0.5, z + 0.53, M_BRACKET)
    fbox('lantern_brace', o, s, horiz, u - 0.012, u + 0.012, 0.0, 0.30, z + 0.30, z + 0.33, M_BRACKET)
    fbox('lantern_hook', o, s, horiz, u - 0.012, u + 0.012, 0.38, 0.41, z + 0.36, z + 0.5, M_BRACKET)
    fbox('lantern_box', o, s, horiz, u - 0.11, u + 0.11, 0.285, 0.505, z + 0.0, z + 0.32, M_WHITEMET)
    fbox('lantern_top', o, s, horiz, u - 0.14, u + 0.14, 0.255, 0.535, z + 0.32, z + 0.37, M_BRACKET)
    fbox('lantern_bot', o, s, horiz, u - 0.13, u + 0.13, 0.265, 0.525, z - 0.03, z + 0.0, M_BRACKET)
    for a in (u - 0.11, u + 0.11):
        fbox('lantern_bar', o, s, horiz, a - 0.012, a + 0.012, 0.28, 0.51, z, z + 0.32, M_BRACKET)

def kerb_line(a0, a1, y, skip=(), z0=0.0, along='x', L=0.9, w=0.22, h=0.07, seed=5):
    """Row of edging stones where the asphalt meets the sand; `skip` = (lo, hi) ranges to leave out (props)."""
    rr = random.Random(seed)
    a = a0
    while a + L <= a1:
        b = a + L
        if not any(lo < b and hi > a for lo, hi in skip):
            dz = rr.uniform(-0.012, 0.008)
            if along == 'x': add_box('kerb', a, b - 0.03, y - w/2, y + w/2, z0 - 0.15, z0 + h + dz, M_TRIM)
            else: add_box('kerb', y - w/2, y + w/2, a, b - 0.03, z0 - 0.15, z0 + h + dz, M_TRIM)
        a = b

def manhole(cx, cy, z0):
    d = add_cyl_axis('manhole', (cx, cy, z0 + 0.006), 0.42, 0.012, M_BRACKET, axis='z', verts=20)
    add_cyl_axis('manhole_ring', (cx, cy, z0 + 0.008), 0.47, 0.016, M_TRIM, axis='z', verts=20)
    d.location.z += 0.012; apply_all(d)

def drain_grate(cx, cy, z0, yaw=0.0):
    objs = [add_box('grate_base', -0.32, 0.32, -0.22, 0.22, -0.02, 0.01, M_DARK),
            add_box('grate_frame', -0.34, 0.34, -0.24, -0.20, 0.0, 0.03, M_BRACKET), add_box('grate_frame', -0.34, 0.34, 0.20, 0.24, 0.0, 0.03, M_BRACKET),
            add_box('grate_frame', -0.34, -0.30, -0.24, 0.24, 0.0, 0.03, M_BRACKET), add_box('grate_frame', 0.30, 0.34, -0.24, 0.24, 0.0, 0.03, M_BRACKET)]
    for i in range(5):
        x = -0.24 + i * 0.12
        objs.append(add_box('grate_bar', x - 0.015, x + 0.015, -0.22, 0.22, 0.012, 0.03, M_BRACKET))
    R = Matrix.Rotation(yaw, 4, 'Z')
    for ob in objs:
        ob.matrix_world = Matrix.Translation((cx, cy, z0)) @ R @ ob.matrix_world; apply_all(ob)

def balcony(wall, face, u, z, w=2.2, out=0.95):
    """Small first-floor balcony: stone slab on timber joists with a wrought-iron balustrade."""
    o, s, horiz = face_axes(wall, face)
    fbox('balcony_slab', o, s, horiz, u - w/2, u + w/2, -0.02, out, z - 0.14, z, M_TRIM, bevel=0.012)
    for a in (u - w/2 + 0.15, u, u + w/2 - 0.15):
        fbox('balcony_joist', o, s, horiz, a - 0.07, a + 0.07, -0.1, out - 0.08, z - 0.30, z - 0.14, M_WOOD)
    fbox('balcony_rail', o, s, horiz, u - w/2, u + w/2, out - 0.06, out - 0.02, z + 0.86, z + 0.90, M_BRACKET)
    for side in (-1, 1):
        fbox('balcony_rail', o, s, horiz, u + side*(w/2) - 0.02, u + side*(w/2) + 0.02, 0.0, out - 0.02, z + 0.86, z + 0.90, M_BRACKET)
        n = int(out / 0.16)
        for i in range(1, n):
            d = i * out / n
            fbox('balcony_bar', o, s, horiz, u + side*(w/2) - 0.012, u + side*(w/2) + 0.012, d - 0.012, d + 0.012, z, z + 0.86, M_BRACKET)
    n = int(w / 0.16)
    for i in range(n + 1):
        a = u - w/2 + i * w / n
        fbox('balcony_bar', o, s, horiz, a - 0.012, a + 0.012, out - 0.052, out - 0.028, z, z + 0.86, M_BRACKET)

def insulated_wire(a, b, sag=0.5):
    wire(a, b, sag=sag)
    for p in (a, b):
        i = add_cyl_axis('insulator', (p[0], p[1], p[2] - 0.05), 0.045, 0.12, M_WHITEMET, axis='z', verts=8); i['nocollide'] = 1

# ---------------------------------------------------------------- apply: facades around the play area
# Sills sit at window z - 0.10, so the string courses run just under the first-floor sills and are split around the blind
# arches / tall doors; small arched windows sit between the course and the existing beam row (beams at z 5.35 on the 6.5 m
# buildings -> arch tops stay below 5.1). Every window's rain-streak decal (window() drops one when k < 7) was checked against
# the doorways / posters underneath so no decal floats over a recess. Ground-level pilasters start at 0.05 so their stone
# bases end 5 cm above the building skirts (no coplanar top faces).
untrack()
# -- north / long wall (B_N south face, y=14): the A backboard and the whole long-A run
for u in (-64.5, -52.5, -25.5, -13.2, 9.9):
    pilaster(B_N, 'S', u, 0.05, 6.15)
for a0, a1 in ((-65.9, -51.2), (-48.8, -37.3), (-34.7, -14.2), (-12.5, -2.9), (-0.1, 21.9)):
    string_course(B_N, 'S', 2.72, a0=a0, a1=a1)
window(B_N, 'S', -61.5, 3.3, w=1.0, h=1.3, shutters=M_SHUT_G, style='ajar')
window(B_N, 'S', -39.5, 3.4, w=1.1, h=1.4, style='grille')
window(B_N, 'S', -21.8, 3.5, w=0.9, h=1.2, style='boarded')
window(B_N, 'S', -16.2, 3.3, w=1.0, h=1.3, shutters=M_SHUT_R, style='closed')
window(B_N, 'S', 3.6, 3.3, w=1.1, h=1.4, shutters=M_SHUT_G, style='broken')
window(B_N, 'S', -54, 3.9, w=0.7, h=0.8, arch=True, style='grille')
window(B_N, 'S', -33, 3.9, w=0.7, h=0.8, arch=True, style='grille')
window(B_N, 'S', 8.3, 3.9, w=0.7, h=0.8, arch=True, style='grille')
balcony(B_N, 'S', 6.0, 3.05, w=2.0)
doorway(B_N, 'S', -17.5, 0.0, kind='blue', step=True)
doorway(B_N, 'S', -42.2, 0.0, kind='double', w=1.7, h=2.5)
doorway(B_N, 'S', -28.0, 0.0, kind='roller', w=2.3, h=2.5)
blind_arch(B_N, 'S', -50.0, 0.0, w=2.0, h=3.0)
# the painted bands run across the blind-arch recesses (new one and the two older ones): cut them open too
cut(BAND_L, cutter_box(-51.0, -49.0, 13.9, 14.1, -0.1, 3.0)); cut(BAND_L, cutter_box(-37.1, -34.9, 13.9, 14.1, -0.1, 3.2))
cut(BAND_N, cutter_box(-2.7, -0.3, 13.9, 14.1, -0.1, 3.4)); cut(BAND_E, cutter_box(15.9, 16.1, -0.5, 1.5, -0.1, 3.0))
track()
plaster_patch(B_N, 'S', -10.6, 4.6, 1.6, 1.1); plaster_patch(B_N, 'S', -60.0, 2.2, 1.3, 0.9); plaster_patch(B_N, 'S', -63.0, 4.6, 1.2, 1.0)
plaster_patch(B_N, 'S', -5.9, 4.7, 1.4, 0.8)
crack(B_N, 'S', -34.5, 6.0, 1.8); crack(B_N, 'S', 4.2, 5.9, 1.5); crack(B_N, 'S', -60.5, 5.6, 2.0)
for u in (-57.2, -38, -23, -7, 1.6, 14): scupper(B_N, 'S', u, 6.15)
fabric_awning(B_N, 'S', -23.7, 2.8, 3.05, ripped=True)
fabric_awning(B_N, 'S', -47.5, 2.4, 3.05)
lantern(B_N, 'S', -18.6, 3.2); lantern(B_N, 'S', -45.6, 3.2); lantern(B_N, 'S', 12.4, 3.75)
pipe(-26.4, 13.85, 0.0, 6.3); pipe(-55.6, 13.85, 0.0, 6.3)
roof_room(-1.0, 17.5, 6.5, 6.0, 5.0, 2.6); roof_room(-38, 18.0, 6.5, 4.0, 3.6, 2.3, m=M_WALL2)
tarp_roll(-10, 15.4, 6.5, 3.0, yaw=0.05); tv_antenna(-33, 16.5, 6.5, yaw=0.4); tv_antenna(7.5, 17.2, 6.5, h=2.8, yaw=-0.6)
water_tank(-56, 17.5, 6.5)
untrack()
ladder(B_N, 'S', -33.6, 0.0)
bench(-40.8, 13.52, 0.0)
handcart(-38.6, 12.55, 0.0, yaw=math.radians(-8))
track()

# -- east wall (B_E west face, x=16): site side + ramp / CT side
pilaster(B_E, 'W', 8.4, 0.05, 8.15)
pilaster(B_E, 'W', -28.5, -3.45, 8.15); pilaster(B_E, 'W', -41.0, -3.45, 8.15)
for a0, a1 in ((-12.2, -0.7), (1.7, 6.5), (7.5, 14.2)):
    string_course(B_E, 'W', 3.0, a0=a0, a1=a1)
string_course(B_E, 'W', -0.5, a0=-46, a1=-28)
window(B_E, 'W', -3.0, 4.3, w=1.0, h=1.3, shutters=M_SHUT_G, style='ajar')
window(B_E, 'W', 11.5, 3.9, w=0.7, h=0.8, arch=True, style='grille')
window(B_E, 'W', -26, 1.9, w=1.0, h=1.3, style='boarded')
window(B_E, 'W', -32, 2.0, w=1.1, h=1.4, shutters=M_SHUT_R, style='broken')
window(B_E, 'W', -39, 1.5, w=1.0, h=1.3, style='grille')
window(B_E, 'W', -24, 5.0, w=0.7, h=0.8, arch=True, style='grille')
balcony(B_E, 'W', 5.0, 4.05, w=2.0)
doorway(B_E, 'W', -10.3, 0.0, kind='roller', w=2.2, h=2.6)
doorway(B_E, 'W', -37.5, -3.5, kind='green', step=True)
track()
plaster_patch(B_E, 'W', -6.5, 5.4, 1.5, 1.2); plaster_patch(B_E, 'W', 10.1, 2.55, 1.2, 0.8); plaster_patch(B_E, 'W', -22, 3.2, 1.6, 1.3)
crack(B_E, 'W', 3.0, 7.6, 1.8); crack(B_E, 'W', -14, 6.2, 1.6)
for u in (-10.5, 2.6, 11.5, -30, -40): scupper(B_E, 'W', u, 8.15)
lantern(B_E, 'W', -3.4, 3.3); lantern(B_E, 'W', 10.4, 3.3)
pipe(15.85, 3.3, 0.0, 8.3); pipe(15.85, -22.5, -3.5, 8.3)
roof_room(21.0, -7.0, 8.5, 5.0, 4.0, 2.5, door_face='N'); tv_antenna(18.0, 12.5, 8.5, yaw=1.2); tarp_roll(18.5, -14.5, 8.5, 2.6, yaw=1.5)
merlons(15.8, 26.2, -46.2, -45.5, 9.12, t=0.7)   # far south end of the east roof
untrack()
drain_grate(15.5, 0.9, 0.0)
track()

# -- south building (B_S north face, y=-12): ninja / stairs side
pilaster(B_S, 'N', -3.2, 0.05, 6.15); pilaster(B_S, 'N', 9.5, 0.05, 6.15)
string_course(B_S, 'N', 2.70)
window(B_S, 'N', 6.8, 3.3, w=1.0, h=1.3, style='grille')
window(B_S, 'N', 1.6, 3.9, w=0.7, h=0.8, arch=True, style='grille')
doorway(B_S, 'N', 1.0, 0.0, kind='green')
track()
plaster_patch(B_S, 'N', 5.5, 4.5, 1.4, 0.9)
crack(B_S, 'N', -2.5, 6.0, 1.6)
for u in (-2.4, 8.6): scupper(B_S, 'N', u, 6.15)
fabric_awning(B_S, 'N', -1.0, 2.6, 3.0)
lantern(B_S, 'N', 8.6, 3.2)
tv_antenna(1.0, -14.5, 6.5, yaw=0.3); tarp_roll(-1.0, -16.5, 6.5, 2.4, yaw=0.3)
untrack()
bench(4.5, -11.52, 0.0)
track()

# -- west building (B_W north face, y=6): long's south wall + pit
pilaster(B_W, 'N', -64.8, 0.05, 6.15); pilaster(B_W, 'N', -41.5, 0.05, 6.15); pilaster(B_W, 'N', -23.2, 0.05, 6.15)
string_course(B_W, 'N', 2.72, a0=-65.9, a1=-56.9); string_course(B_W, 'N', 2.72, a0=-55.9, a1=-22.4)
vigas(B_W, 'N', 5.35, a0=-55.5, a1=-22.5)
window(B_W, 'N', -37, 3.3, w=1.0, h=1.3, shutters=M_SHUT_G, style='broken')
window(B_W, 'N', -55, 3.3, w=1.0, h=1.3, style='grille')
window(B_W, 'N', -42.6, 3.9, w=0.7, h=0.8, arch=True, style='grille')
window(B_W, 'N', -28, 3.9, w=0.7, h=0.8, arch=True, style='grille')
doorway(B_W, 'N', -52.5, 0.0, kind='roller', w=2.2, h=2.5)
doorway(B_W, 'N', -58.5, 0.0, kind='blue', step=True)
chamfer(B_W, -22.0, 6.0, 1.1, 6.5, size=0.5)   # long-corner / elbow corner, chamfered above the stone plinth
track()
plaster_patch(B_W, 'N', -32.5, 4.6, 1.6, 1.0); plaster_patch(B_W, 'N', -36.0, 1.9, 1.2, 0.9)
crack(B_W, 'N', -35, 6.0, 1.5)
for u in (-52, -38.5, -26): scupper(B_W, 'N', u, 6.15)
fabric_awning(B_W, 'N', -34, 2.4, 3.0)
lantern(B_W, 'N', -31.5, 3.2); lantern(B_W, 'N', -51.0, 3.2)
pipe(-22.6, 5.85, 0.0, 6.3); pipe(-45.6, 5.85, 0.0, 6.3)
roof_room(-36.0, -1.0, 6.5, 5.0, 4.0, 2.4, m=M_WALL2, door_face='N'); tv_antenna(-50, 2.5, 6.5, yaw=0.9)
untrack()
sandbags(-59.5, 13.45, 0.0, yaw=0.0)
track()

# -- pit wall building (B_PITS) + short-side wall (SH_N corridor face) + southwest building
merlons(-22.2, -13.8, -6.2, -3.8, 6.62, t=0.32)
window(B_PITS, 'N', -18.0, 2.4, w=0.9, h=1.1, style='grille')
window(B_PITS, 'N', -20.6, 4.2, w=0.7, h=0.8, arch=True, style='grille')
plaster_patch(B_PITS, 'N', -15.5, 3.6, 1.2, 1.0)
window(SH_N, 'S', -40, 4.7, w=0.9, h=1.1, style='grille')
window(SH_N, 'S', -28, 4.7, w=0.9, h=1.1, shutters=M_SHUT_R, style='ajar')
vigas(SH_N, 'S', 6.15, a0=-45.4, a1=-14.6, step=1.4)
window(B_SW, 'N', -36, 3.65, w=1.0, h=1.3, style='boarded')
window(B_SW, 'N', -14, 3.65, w=1.0, h=1.3, shutters=M_SHUT_G, style='ajar')
string_course(B_SW, 'N', 5.28, a0=-46, a1=-4)
vigas(B_SW, 'N', 5.53, a0=-45.5, a1=-4.5)
pilaster(B_SW, 'N', -45.6, 2.55, 5.65, m=M_WALL2)
plaster_patch(B_SW, 'N', -24, 4.6, 1.5, 1.0)
for u in (-42, -26, -10): scupper(B_SW, 'N', u, 5.65)
roof_room(-26, -15.5, 6.0, 4.0, 3.6, 2.2, m=M_WALL2, door_face='N')
merlons(-70.2, -65.8, 5.8, 22.2, 7.12, t=0.5)                          # T-spawn tower top
merlons(10.3, 11.2, 8.9, 14.05, 3.55, t=0.9, w=0.45, gap=0.35, h=0.35)   # goose nook wall

# -- south building, CT-court face (B_S south face, y=-30, ground -3.5): what the CTs see every round start
pilaster(B_S, 'S', 8.7, -3.45, 6.15); pilaster(B_S, 'S', -3.2, -3.45, 6.15)   # 8.7 (not the corner): the ramp_bot->ct_spawn bot edge skims the SE corner at 0.28 m
for a0, a1 in ((-3.9, 2.6), (4.4, 8.3)):                                   # ends at the pilaster; clear of the ramp_bot->ct_spawn edge
    string_course(B_S, 'S', -1.55, a0=a0, a1=a1)
vigas(B_S, 'S', 5.35, a0=-3.2, a1=9.3)
window(B_S, 'S', 7.5, -1.2, w=1.0, h=1.3, shutters=M_SHUT_R, style='ajar')
window(B_S, 'S', 0.0, -1.2, w=1.1, h=1.4, style='grille')
window(B_S, 'S', -2.0, 0.3, w=0.7, h=0.8, arch=True, style='grille')
doorway(B_S, 'S', 3.5, -3.5, kind='green', step=True)
track()
plaster_patch(B_S, 'S', 8.8, 1.6, 1.3, 1.0)
crack(B_S, 'S', 4.5, 5.8, 1.6)
for u in (-1.5, 6.0): scupper(B_S, 'S', u, 6.15)
lantern(B_S, 'S', 5.2, -0.4)

# -- west building, pit face (B_W east face, x=-22): seen from the elbow / pit
window(B_W, 'E', -1.0, 1.2, w=1.0, h=1.3, style='grille')
window(B_W, 'E', 3.5, 3.6, w=0.7, h=0.8, arch=True, style='grille')
string_course(B_W, 'E', 2.72, a0=-3.8, a1=5.6)
track()
plaster_patch(B_W, 'E', 1.5, 4.6, 1.3, 1.0)
crack(B_W, 'E', -2.8, 6.0, 1.4)
for u in (-2.5, 4.8): scupper(B_W, 'E', u, 6.15)
lantern(B_W, 'E', 0.8, 1.4)
window(B_PITS, 'E', -5.0, 3.2, w=0.7, h=0.8, arch=True, style='grille')   # pit wall's end face toward the elbow step

# -- CT side buildings (ramp / ct spawn)
for a0, a1 in ((-4.0, -2.05), (0.05, 16.0)):
    string_course(B_CTS, 'N', -1.78, a0=a0, a1=a1)
window(B_CTS, 'N', 2.0, 1.2, w=0.7, h=0.8, arch=True, style='grille')
doorway(B_CTS, 'N', -1.0, -3.5, kind='double', w=1.7, h=2.6, step=True)
window(B_CTW, 'E', -38, -1.6, w=1.0, h=1.3, style='boarded'); window(B_CTW, 'E', -31.5, -1.6, w=1.0, h=1.3, shutters=M_SHUT_G, style='broken')
doorway(B_CTW, 'E', -36.2, -3.5, kind='green')
plaster_patch(B_CTW, 'E', -34.5, 1.8, 1.4, 1.0); plaster_patch(B_CTS, 'N', 12.5, 1.8, 1.5, 1.1)
for u in (4, 12): scupper(B_CTS, 'N', u, 5.65)
lantern(B_CTS, 'N', 12.5, -0.4); lantern(B_CTW, 'E', -39.6, -0.4)
tv_antenna(14, -46, 6.0, yaw=-0.5); tv_antenna(-7.5, -24, 6.5, yaw=0.2)
untrack()
sandbags(15.3, -31.0, -3.5, yaw=math.radians(90))
track()

# -- ground: kerbs where the long asphalt meets the sand strips, manholes, rubble along the wall bases
untrack()
kerb_line(-65.5, -15.0, 12.62, skip=((-16.2, -13.8), (-31.2, -28.8), (-53.4, -50.6), (-40.4, -37.6), (-25.7, -22.3), (-57.0, -55.8), (-48.8, -46.2)))
kerb_line(-65.5, -15.0, 7.18, skip=((-49.2, -46.8), (-35.4, -32.6), (-57.0, -55.8)))
manhole(-36.0, 9.4, 0.0); manhole(-10.5, 7.6, 0.0)
drain_grate(-20.0, 13.35, 0.0)
rubble(-44.5, 13.4, 0.0, n=4, spread=0.5, seed=11); rubble(-4.0, -11.5, 0.0, n=3, spread=0.4, seed=12); rubble(15.3, 10.5, 0.0, n=3, spread=0.4, seed=13)
rubble(-57.5, 13.3, 0.0, n=3, spread=0.4, seed=14)
track()

# -- more overhead cables with insulators
insulated_wire((-45, 14.0, 6.3), (-45, 6.0, 6.2), sag=0.55); insulated_wire((-26, 14.0, 6.4), (-26, 6.0, 6.2), sag=0.6)
insulated_wire((16, -20, 8.2), (10, -20, 6.3), sag=0.45); insulated_wire((-8, 14.0, 6.9), (-3.5, -12, 6.3), sag=0.9)
insulated_wire((-1, 15.0, 9.1), (16, 9.5, 8.4), sag=0.5)

# -- nav clearance check: every street-level detail object must stay >= 0.7 m from the bot graph edges
_NAV_EDGES = [('long_t','long_1'),('long_1','long_2'),('long_2','long_3'),('long_3','long_4'),('long_4','long_corner'),('long_4','car'),('car','long_corner'),
    ('car','barrels'),('long_corner','elbow'),('long_corner','site_nw'),('elbow','site_sw'),('elbow','pit'),('elbow','site_nw'),('barrels','site_nw'),('barrels','site_n'),
    ('site_nw','site_center'),('site_nw','site_n'),('site_n','default'),('site_n','goose'),('default','site_center'),('default','site_e'),('site_e','goose'),('site_e','triple'),
    ('site_e','ramp_top'),('goose','ramp_top'),('site_center','site_s'),('site_center','site_sw'),('site_s','ninja'),('ninja','triple'),('triple','ramp_top'),('ramp_top','ramp_mid'),
    ('ramp_mid','ramp_bot'),('ramp_bot','ct_spawn'),('site_sw','stairs_bot'),('stairs_bot','stairs_top'),('stairs_top','short_plat'),('short_plat','short_2'),('short_2','short_1'),
    ('short_1','short_t'),('stairs_bot','site_s'),('site_sw','site_s'),('default','site_s')]
_NAV_P = {
 'long_t': (-60, 10, 0), 'long_1': (-50, 10, 0), 'long_2': (-40, 9, 0), 'long_3': (-30, 11, 0), 'long_4': (-22, 10, 0),
 'long_corner': (-16, 8, 0), 'car': (-17, 12, 0), 'elbow': (-11, 4, 0), 'barrels': (-9, 11, 0),
 'site_nw': (-6, 7, 0), 'site_n': (3, 10, 0), 'site_center': (0, 0, 0), 'default': (4, 1, 0), 'site_e': (10, 4, 0),
 'goose': (13, 10, 0), 'site_s': (0, -6, 0), 'ninja': (8.5, -7.5, 0), 'triple': (12, -8, 0), 'ramp_top': (13, -13, 0),
 'ramp_mid': (13, -20, -1.75), 'ramp_bot': (13, -27, -3.5), 'ct_spawn': (6, -35, -3.5),
 'short_t': (-43, -8.5, 2.5), 'short_1': (-34, -8.5, 2.5), 'short_2': (-24, -8.5, 2.5), 'short_plat': (-11, -8.5, 2.5),
 'stairs_top': (-7.5, -8.5, 2.5), 'stairs_bot': (-3, -8.5, 0), 'site_sw': (-8, -3, 0), 'pit': (-18, -1, -2.4)}
def _seg_dist(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay; L2 = vx*vx + vy*vy
    t = max(0.0, min(1.0, ((px-ax)*vx + (py-ay)*vy) / L2)) if L2 > 0 else 0.0
    return math.hypot(px - (ax + t*vx), py - (ay + t*vy))
NAV_CLEAR = []
for ob in DETAIL:
    if ob.name not in bpy.data.objects: continue
    x0, x1, y0, y1, zlo, zhi = _mesh_bounds(ob)      # from vertices: bound_box is stale for data-API objects until a depsgraph update
    for a, b in _NAV_EDGES:
        A, B = _NAV_P[a], _NAV_P[b]
        if zhi < min(A[2], B[2]) + 0.12 or zlo > max(A[2], B[2]) + 2.0: continue
        # distance from the edge to the object's footprint rectangle (sampled along the edge; a bounding circle flagged every long ledge)
        d = min(math.hypot(max(x0 - px, 0, px - x1), max(y0 - py, 0, py - y1))
                for t in (i / 40 for i in range(41)) for px, py in ((A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])),))
        if d < 0.7: NAV_CLEAR.append((ob.name, a, b, round(d, 2)))
print('NAV_CLEAR issues:', len(NAV_CLEAR), NAV_CLEAR[:20])

# distant skyline (white cubic town) + hills. nocollide via material flag.
import random
rnd = random.Random(7)
def bg_block(cx, cy, w, d, h, z0=-0.5):
    add_box('bg', cx - w/2, cx + w/2, cy - d/2, cy + d/2, z0, z0 + h, M_BG)
    add_box('bg_cap', cx - w/2 - 0.15, cx + w/2 + 0.15, cy - d/2 - 0.15, cy + d/2 + 0.15, z0 + h - 0.3, z0 + h + 0.4, M_BG)
    if rnd.random() < 0.6:  # stair-head bump
        add_box('bg_top', cx - w*0.2, cx + w*0.2, cy - d*0.2, cy + d*0.2, z0 + h, z0 + h + rnd.uniform(1.5, 3.0), M_BG)
    if rnd.random() < 0.35: dish(cx + rnd.uniform(-w*0.3, w*0.3), cy + rnd.uniform(-d*0.3, d*0.3), z0 + h, rnd.uniform(0, 6.28))
    if rnd.random() < 0.35:  # rooftop water tank on a stand
        tx, ty = cx + rnd.uniform(-w*0.3, w*0.3), cy + rnd.uniform(-d*0.3, d*0.3)
        t = add_cyl_axis('bg_tank', (tx, ty, z0 + h + 1.6), 0.9, 1.7, M_WHITEMET, axis='z', verts=14); t['nocollide'] = 1
        add_box('bg_tankstand', tx - 0.7, tx + 0.7, ty - 0.7, ty + 0.7, z0 + h, z0 + h + 0.8, M_DARK)['nocollide'] = 1
    if rnd.random() < 0.3:   # antenna mast
        ax, ay = cx + rnd.uniform(-w*0.35, w*0.35), cy + rnd.uniform(-d*0.35, d*0.35)
        add_cyl_axis('bg_mast', (ax, ay, z0 + h + 2.5), 0.06, 5.0, M_WIRE, axis='z', verts=6)['nocollide'] = 1
        add_box('bg_mastbar', ax - 0.9, ax + 0.9, ay - 0.03, ay + 0.03, z0 + h + 4.6, z0 + h + 4.66, M_WIRE)['nocollide'] = 1
    # a few dark window slits for silhouette variety
    for _ in range(rnd.randint(2, 5)):
        wx = cx + rnd.uniform(-w*0.4, w*0.4); wz = z0 + rnd.uniform(2.0, h - 2.0)
        side = rnd.choice((-1, 1))
        add_box('bg_win', wx - 0.5, wx + 0.5, cy + side*(d/2) - 0.05, cy + side*(d/2) + 0.05, wz, wz + 1.3, M_DARK)

def skyline(seg, hmin=8, hmax=17):
    # seg: (x0,x1,y0,y1) band; fill with blocks of varying footprint/height
    x0, x1, y0, y1 = seg
    x = x0
    while x < x1:
        w = rnd.uniform(9, 16); d = rnd.uniform(9, 16); h = rnd.uniform(hmin, hmax)
        bg_block(x + w/2, rnd.uniform(y0, y1), w, d, h)
        x += w + rnd.uniform(2, 6)

skyline((-90, 40, 30, 40), 14, 26); skyline((-100, 50, 48, 62), 18, 32)          # north rows
skyline((-100, 50, -62, -54), 14, 24); skyline((-90, 40, -80, -68), 18, 30)      # south rows
for y in range(-70, 60, 14): bg_block(-82 + rnd.uniform(-4, 4), y, rnd.uniform(9, 14), 11, rnd.uniform(14, 26))   # west
for y in range(-60, 60, 18): bg_block(-100 + rnd.uniform(-4, 4), y, rnd.uniform(10, 16), 12, rnd.uniform(20, 34))
for y in range(-70, 60, 14): bg_block(38 + rnd.uniform(-4, 4), y, rnd.uniform(9, 14), 11, rnd.uniform(14, 26))    # east
for y in range(-60, 60, 18): bg_block(56 + rnd.uniform(-4, 4), y, rnd.uniform(10, 16), 12, rnd.uniform(20, 34))
# minaret + dome landmark (north-east, visible from ramp/site)
add_cyl_axis('minaret', (48, 48, 12), 1.6, 26, M_BG, axis='z', verts=16)
add_cyl_axis('minaret_cap', (48, 48, 25.6), 2.1, 1.2, M_BG, axis='z', verts=16)
bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, radius=5.5, location=(36, 50, 13.5))
_d = bpy.context.object; _d.name = 'dome'; apply_all(_d); assign(_d, M_TEAL); _d['nocollide'] = 1; ALL.append(_d)
bpy.ops.object.shade_smooth()

# hills ring
for i, (hx, hy, hr, hz) in enumerate([(-40, 260, 220, 90), (150, 220, 180, 70), (-230, 170, 190, 80), (-60, -280, 230, 85), (180, -220, 180, 65), (-300, -60, 190, 75), (280, 20, 200, 80), (-260, 40, 170, 60)]):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=10, radius=1.0, location=(hx, hy, -6))
    o = bpy.context.object; o.name = f'hill_{i}'; o.scale = (hr, hr * 0.8, hz); apply_all(o); assign(o, M_HILLS); ALL.append(o)
    bpy.ops.object.shade_smooth()
add_box('world_ground', -400, 400, -400, 400, -8.0, -5.5, M_HILLS)

# ---------------------------------------------------------------- gameplay markers (empties -> glTF nodes)
empty('SPAWN_CT', (6, -36, -3.5))
for i, p in enumerate([(-63, 8, 0), (-63, 12, 0), (-61, 10, 0), (-44.5, -9.5, 2.5), (-43, -7.5, 2.5)]):
    empty(f'SPAWN_T_{i}', p)
empty('BOMBSITE_A', (1, 1, 0), scale=(7, 7, 1))
NAV = {
 'long_t': (-60, 10, 0), 'long_1': (-50, 10, 0), 'long_2': (-40, 9, 0), 'long_3': (-30, 11, 0), 'long_4': (-22, 10, 0),
 'long_corner': (-16, 8, 0), 'car': (-17, 12, 0), 'elbow': (-11, 4, 0), 'barrels': (-9, 11, 0),
 'site_nw': (-6, 7, 0), 'site_n': (3, 10, 0), 'site_center': (0, 0, 0), 'default': (4, 1, 0), 'site_e': (10, 4, 0),
 'goose': (13, 10, 0), 'site_s': (0, -6, 0), 'ninja': (8.5, -7.5, 0), 'triple': (12, -8, 0), 'ramp_top': (13, -13, 0),
 'ramp_mid': (13, -20, -1.75), 'ramp_bot': (13, -27, -3.5), 'ct_spawn': (6, -35, -3.5),
 'short_t': (-43, -8.5, 2.5), 'short_1': (-34, -8.5, 2.5), 'short_2': (-24, -8.5, 2.5), 'short_plat': (-11, -8.5, 2.5),
 'stairs_top': (-7.5, -8.5, 2.5), 'stairs_bot': (-3, -8.5, 0), 'site_sw': (-8, -3, 0), 'pit': (-18, -1, -2.4),
}
for k, p in NAV.items(): empty(f'NAV_{k}', p)
COVER = {
 'long_corner_peek': ((-15.5, 6.8, 0), math.radians(-20)), 'car_peek': ((-18.5, 12.6, 0), math.radians(-10)),
 'default_peek': ((2.4, 4.6, 0), math.radians(-90)), 'bigbox_peek': ((-2.8, 5.8, 0), math.radians(-90)),
 'ninja_peek': ((4.7, -7.8, 0), math.radians(160)), 'triple_peek': ((13.4, -6.2, 0), math.radians(170)),
 'goose_peek': ((11.9, 9.2, 0), math.radians(-120)), 'barrels_peek': ((-10.5, 11.5, 0), math.radians(-60)),
 'short_peek': ((-9.5, -7.0, 2.5), math.radians(20)), 'stairs_peek': ((-4.6, -7.2, 0), math.radians(30)),
 'ramp_peek': ((11.0, -13.5, 0), math.radians(100)), 'elbow_peek': ((-12.5, 2.5, 0), math.radians(10)),
}
for k, (p, yaw) in COVER.items(): empty(f'COVER_{k}', p, rot=(0, 0, yaw))

# ---------------------------------------------------------------- UVs, smoothing, custom props
def box_uv(o, scale, cyl=False):
    me = o.data
    bm = bmesh.new(); bm.from_mesh(me)
    uv = bm.loops.layers.uv.verify()
    mw = o.matrix_world
    if cyl:
        W = [mw @ v.co for v in bm.verts]
        cx = sum(p.x for p in W) / len(W); cy = sum(p.y for p in W) / len(W)
        r = max(math.hypot(p.x-cx, p.y-cy) for p in W)
        circ = math.tau * r
        for f in bm.faces:
            n = f.normal
            if abs(n.z) > 0.7:
                for l in f.loops:
                    p = mw @ l.vert.co; l[uv].uv = (p.x/scale, p.y/scale)
            else:
                angs = []
                for l in f.loops:
                    p = mw @ l.vert.co
                    angs.append(math.atan2(p.y-cy, p.x-cx))
                base = angs[0]
                for l, a in zip(f.loops, angs):
                    while a - base > math.pi: a -= math.tau
                    while base - a > math.pi: a += math.tau
                    p = mw @ l.vert.co
                    l[uv].uv = ((a/math.tau) * circ / scale, p.z/scale)
    else:
        for f in bm.faces:
            n = f.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            for l in f.loops:
                p = mw @ l.vert.co
                if ax == 0: u, v = (p.y, p.z) if n.x > 0 else (-p.y, p.z)
                elif ax == 1: u, v = (-p.x, p.z) if n.y > 0 else (p.x, p.z)
                else: u, v = (p.x, p.y)
                l[uv].uv = (u/scale, v/scale)
    bm.to_mesh(me); bm.free()

def sign_uv(o):
    me = o.data; bm = bmesh.new(); bm.from_mesh(me); uv = bm.loops.layers.uv.verify()
    mw = o.matrix_world
    W = [mw @ v.co for v in bm.verts]
    xs = [p.x for p in W]; zs = [p.z for p in W]
    x0, x1, z0, z1 = min(xs), max(xs), min(zs), max(zs)
    for f in bm.faces:
        for l in f.loops:
            p = mw @ l.vert.co
            l[uv].uv = ((p.x-x0)/(x1-x0), (p.z-z0)/(z1-z0))
    bm.to_mesh(me); bm.free()

def smooth_sharp(o, angle=math.radians(32)):
    me = o.data; bm = bmesh.new(); bm.from_mesh(me)
    for f in bm.faces: f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) == 2:
            e.smooth = e.calc_face_angle(0) < angle
        else:
            e.smooth = False
    bm.to_mesh(me); bm.free()

for o in list(bpy.data.objects):
    if o.type != 'MESH': continue
    m = o.data.materials[0] if o.data.materials else None
    if m is None: continue
    if m.name == 'sign_a': sign_uv(o)
    else: box_uv(o, float(m.get('uv_scale', 2.0)), cyl=bool(m.get('cyl', 0)))
    smooth_sharp(o)
    o['surface'] = m.get('surface', 'concrete')

# ---------------------------------------------------------------- merge by material (draw calls)
groups = {}
for o in list(bpy.data.objects):
    if o.type != 'MESH' or not o.data.materials: continue
    groups.setdefault(o.data.materials[0].name, []).append(o)
for key, objs in groups.items():
    j = join(objs, f'MAP_{key}') if len(objs) > 1 else objs[0]
    j.name = f'MAP_{key}'
    j['surface'] = bpy.data.materials[key].get('surface', 'concrete')
    if bpy.data.materials[key].get('nocollide') or key == 'wire': j['nocollide'] = 1

# ---------------------------------------------------------------- preview lighting (not exported)
sun_data = bpy.data.lights.new('Sun', 'SUN'); sun_data.energy = 4.0; sun_data.angle = math.radians(1.5)
sun = bpy.data.objects.new('Sun', sun_data); bpy.context.collection.objects.link(sun)
sun.rotation_euler = (math.radians(52), math.radians(12), math.radians(-35))
world = bpy.data.worlds[0] if bpy.data.worlds else bpy.data.worlds.new('World')
bpy.context.scene.world = world; world.use_nodes = True
bg = world.node_tree.nodes.get('Background')
if bg: bg.inputs[0].default_value = (0.55, 0.7, 0.95, 1); bg.inputs[1].default_value = 1.0
cam_data = bpy.data.cameras.new('Cam'); cam_data.lens = 24
cam = bpy.data.objects.new('Cam', cam_data); bpy.context.collection.objects.link(cam)
cam.location = (13, -13, 1.7); cam.rotation_euler = (math.radians(86), 0, math.radians(150))
bpy.context.scene.camera = cam

print('BUILD OK objects:', len([o for o in bpy.data.objects if o.type == 'MESH']),
      'tris:', sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in bpy.data.objects if o.type == 'MESH'))
