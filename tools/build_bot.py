"""Segmented T-side bot character (Elite-Crew look) for procedural animation + per-part hitboxes.
Hierarchy: Bot > Hips > (Torso > (Head, UpperArm_L/R > LowerArm_L/R, Rifle), UpperLeg_L/R > LowerLeg_L/R)
Names use '_' (three.js GLTFLoader strips '.' from node names).
Blender: +Y forward, +Z up. Exported glTF: -Z forward, +Y up. Origin at the feet. Height 1.83 m.
Variants: mask, mask_cap, wrap, wrap_goggles."""
import bpy, bmesh, math, os
from mathutils import Vector, Matrix, Euler

OUT = r'C:\Code\cs2-dust2\public\models'

def reset():
    if bpy.context.mode != 'OBJECT': bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete()
    for x in list(bpy.data.meshes):
        if x.users == 0: bpy.data.meshes.remove(x)

def srgb(hexstr):
    """'#rrggbb' sRGB -> linear rgb tuple."""
    h = hexstr.lstrip('#'); c = [int(h[i:i+2], 16) / 255 for i in (0, 2, 4)]
    return tuple((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)

def mat(name, hexstr, rough=0.7, metallic=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True; b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*srgb(hexstr), 1); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metallic
    return m

M_SHIRT = mat('bot_shirt', '#26262a', 0.92)
M_VEST  = mat('bot_vest',  '#5c5238', 0.95)     # dark coyote plate carrier (was tan -> fused with the face)
M_PANTS = mat('bot_pants', '#4d4b38', 0.90)
M_BOOT  = mat('bot_boot',  '#22190f', 0.72)
M_GLOVE = mat('bot_glove', '#1a1a1a', 0.85)
M_SKIN  = mat('bot_skin',  '#7d5a3c', 0.70)
M_MASK  = mat('bot_mask',  '#1c1c1f', 0.95)
M_WRAP  = mat('bot_wrap',  '#c9b58c', 0.95)
M_WRAPB = mat('bot_wrap_band', '#9c8a66', 0.95)
M_STEEL = mat('bot_gun_steel', '#3a3a3f', 0.5, 0.8)
M_WOOD  = mat('bot_gun_wood', '#7a4a28', 0.45)
M_POUCH = mat('bot_pouch', '#7a6a4a', 0.95)
M_STRAP = mat('bot_strap', '#1f1a15', 0.90)
M_DARK  = mat('bot_dark',  '#151412', 0.90)

def _finish(o, m, bevel=0.0, smooth=True, seg=3):
    o.data.materials.append(m)
    if bevel > 0:
        b = o.modifiers.new('bevel', 'BEVEL'); b.width = bevel; b.segments = seg; b.limit_method = 'ANGLE'
    if smooth:
        for p in o.data.polygons: p.use_smooth = True
    return o

def box(name, c, s, m, bevel=0.0, rot=(0, 0, 0), seg=3):
    bpy.ops.mesh.primitive_cube_add(size=1, location=c)
    o = bpy.context.active_object; o.name = name; o.scale = s; o.rotation_euler = Euler([math.radians(a) for a in rot])
    return _finish(o, m, bevel, seg=seg)

def cyl(name, c, r, L, m, axis='Z', r2=None, verts=16, rot=None):
    if r2 is None: bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=L, vertices=verts, location=c)
    else: bpy.ops.mesh.primitive_cone_add(radius1=r, radius2=r2, depth=L, vertices=verts, location=c)
    o = bpy.context.active_object; o.name = name
    if axis == 'Y': o.rotation_euler = Euler((math.radians(-90), 0, 0))
    elif axis == 'X': o.rotation_euler = Euler((0, math.radians(90), 0))
    if rot: o.rotation_euler = Euler([math.radians(a) for a in rot])
    return _finish(o, m)

def sph(name, c, r, m, s=(1, 1, 1)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, segments=20, ring_count=12, location=c)
    o = bpy.context.active_object; o.name = name; o.scale = s
    return _finish(o, m)

def part(name, pivot, objs, parent=None):
    """Join objs into one mesh object whose origin is at `pivot`; parent it (keeping world transform)."""
    objs = [o for o in objs if o]
    for o in objs:
        bpy.context.view_layer.objects.active = o
        for md in list(o.modifiers): bpy.ops.object.modifier_apply(modifier=md.name)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1: bpy.ops.object.join()
    o = bpy.context.active_object; o.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    P = Vector(pivot)
    for v in o.data.vertices: v.co -= P
    o.location = P
    if parent is not None:
        o.parent = parent
        o.matrix_parent_inverse = parent.matrix_world.inverted()
    o['part'] = name
    return o

def empty(name, loc, parent=None):
    e = bpy.data.objects.new(name, None); e.location = loc; e.empty_display_size = 0.05
    bpy.context.collection.objects.link(e)
    if parent is not None:
        e.parent = parent; e.matrix_parent_inverse = parent.matrix_world.inverted()
    return e

# key heights (m): hip joint 0.92, shoulder 1.45, head 1.575-1.805
HIP, KNEE, ANKLE = 0.92, 0.48, 0.05
SHOULDER, ELBOW, WRIST = 1.45, 1.15, 0.87

def build(variant='mask'):
    reset()
    root = empty('Bot', (0, 0, 0))
    # ---- pelvis (stomach hitbox)
    hips = part('Hips', (0, 0, 0.98), [
        box('pelvis', (0, 0, 1.00), (0.34, 0.20, 0.18), M_PANTS, bevel=0.05),
        box('belt', (0, 0, 1.09), (0.355, 0.215, 0.04), M_STRAP, bevel=0.01, seg=2),
        box('buckle', (0, 0.11, 1.09), (0.05, 0.012, 0.03), M_STEEL, bevel=0.004, seg=1),
        box('holster', (0.19, -0.02, 0.93), (0.06, 0.10, 0.17), M_POUCH, bevel=0.018),
        box('dump', (-0.18, -0.01, 0.92), (0.08, 0.11, 0.16), M_POUCH, bevel=0.018),
        # hip joint fillers (sockets at x = +-0.09 so the legs hang under the pelvis, not off its corners)
        sph('hipj_l', (-0.09, 0, HIP), 0.085, M_PANTS), sph('hipj_r', (0.09, 0, HIP), 0.085, M_PANTS),
    ], root)
    # ---- torso (chest hitbox): shirt + plate carrier (proud of the chest, three mag pouches) + flush deltoids + neck
    torso = part('Torso', (0, 0, 1.08), [
        box('chest', (0, 0, 1.28), (0.40, 0.22, 0.40), M_SHIRT, bevel=0.06),
        box('rig', (0, 0.0, 1.27), (0.34, 0.26, 0.30), M_VEST, bevel=0.02),                 # carrier wraps the torso, 0.02 proud all round
        box('mag1', (-0.085, 0.15, 1.20), (0.07, 0.045, 0.11), M_POUCH, bevel=0.012),
        box('mag2', (0.0, 0.15, 1.20), (0.07, 0.045, 0.11), M_POUCH, bevel=0.012),
        box('mag3', (0.085, 0.15, 1.20), (0.07, 0.045, 0.11), M_POUCH, bevel=0.012),
        box('radio', (-0.12, 0.14, 1.38), (0.06, 0.045, 0.10), M_DARK, bevel=0.01),
        box('admin', (0.055, 0.14, 1.37), (0.12, 0.03, 0.06), M_POUCH, bevel=0.01),
        box('strap_l', (-0.10, 0, 1.44), (0.05, 0.25, 0.05), M_STRAP, bevel=0.01, seg=2),
        box('strap_r', (0.10, 0, 1.44), (0.05, 0.25, 0.05), M_STRAP, bevel=0.01, seg=2),
        box('cummer', (0, 0, 1.13), (0.36, 0.24, 0.06), M_STRAP, bevel=0.01, seg=2),        # cummerbund under the carrier
        # deltoids: bevelled blocks flush with the chest top (no epaulettes); total shoulder width 0.46
        box('shoulder_l', (-0.17, 0, SHOULDER - 0.035), (0.12, 0.16, 0.11), M_SHIRT, bevel=0.035),
        box('shoulder_r', (0.17, 0, SHOULDER - 0.035), (0.12, 0.16, 0.11), M_SHIRT, bevel=0.035),
        box('collar', (0, 0.0, 1.495), (0.16, 0.16, 0.035), M_SHIRT, bevel=0.012),
    ], root)
    torso.parent = hips; torso.matrix_parent_inverse = hips.matrix_world.inverted()
    # ---- head: bevelled box, not a sphere
    base = variant.split('_')[0]
    headm = M_MASK if base == 'mask' else M_WRAP
    # skin neck (r 0.05) leaves a visible gap between collar (top 1.51) and skull (bottom 1.60): head reads as a head, not a cube on a box
    head_objs = [
        cyl('neck', (0, 0, 1.555), 0.05, 0.10, M_SKIN),
        box('skull', (0, 0.0, 1.70), (0.16, 0.19, 0.20), headm, bevel=0.028),
    ]
    if base == 'mask':
        # recessed-looking eye slot: skin slit just proud of the face, dark brow strip above casting a shadow
        head_objs.append(box('eyes', (0, 0.090, 1.715), (0.078, 0.012, 0.026), M_SKIN, bevel=0.004, seg=1))
        head_objs.append(box('brow', (0, 0.096, 1.735), (0.095, 0.014, 0.014), M_DARK, bevel=0.003, seg=1))
        head_objs.append(cyl('mask_neck', (0, 0, 1.60), 0.058, 0.03, M_MASK))   # balaclava hem over the top of the neck
        if variant == 'mask_cap':
            head_objs.append(box('cap', (0, 0.0, 1.79), (0.17, 0.19, 0.05), M_DARK, bevel=0.02))
            head_objs.append(box('brim', (0, 0.14, 1.77), (0.16, 0.09, 0.012), M_DARK, bevel=0.004, seg=1))
    else:
        head_objs.append(box('face', (0, 0.082, 1.67), (0.12, 0.03, 0.11), M_SKIN, bevel=0.02))
        head_objs.append(box('band', (0, 0.0, 1.745), (0.165, 0.195, 0.03), M_WRAPB, bevel=0.008, seg=2))
        head_objs.append(box('wrap_tail', (-0.06, -0.10, 1.60), (0.06, 0.05, 0.18), M_WRAP, bevel=0.012))
        if variant == 'wrap_goggles':
            head_objs.append(box('goggles', (0, 0.09, 1.785), (0.14, 0.03, 0.04), M_DARK, bevel=0.01, seg=2))
            head_objs.append(box('gstrap', (0, 0.0, 1.785), (0.17, 0.195, 0.02), M_DARK, bevel=0.004, seg=1))
    head = part('Head', (0, 0, 1.53), head_objs, torso)
    # ---- arms (pivot at shoulder / elbow), hanging straight down in rest pose
    for side, sx in (('R', 1), ('L', -1)):
        AX = 0.235
        ua = part(f'UpperArm_{side}', (sx * AX, 0, SHOULDER), [
            cyl('ua', (sx * AX, 0, (SHOULDER + ELBOW) / 2), 0.055, SHOULDER - ELBOW + 0.03, M_SHIRT, r2=0.046),
            sph('elbow', (sx * AX, 0, ELBOW), 0.045, M_SHIRT),
        ], torso)
        la = part(f'LowerArm_{side}', (sx * AX, 0, ELBOW), [
            cyl('la', (sx * AX, 0, (ELBOW + WRIST) / 2), 0.045, ELBOW - WRIST, M_SHIRT, r2=0.037),
            cyl('cuff', (sx * AX, 0, WRIST + 0.01), 0.042, 0.03, M_STRAP),
            box('hand', (sx * AX, 0.005, WRIST - 0.055), (0.085, 0.045, 0.10), M_GLOVE, bevel=0.015),
            box('thumb', (sx * AX, 0.035, WRIST - 0.04), (0.03, 0.03, 0.05), M_GLOVE, bevel=0.01, seg=2),
        ], ua)
    # ---- legs (tapered: thigh 0.08 -> 0.064, calf 0.062 -> 0.048)
    for side, sx in (('R', 1), ('L', -1)):
        LX = 0.09
        ul = part(f'UpperLeg_{side}', (sx * LX, 0, HIP), [
            cyl('ul', (sx * LX, 0, (HIP + KNEE) / 2), 0.08, HIP - KNEE, M_PANTS, r2=0.064),
            box('cargo', (sx * (LX + 0.07), 0.0, 0.70), (0.045, 0.13, 0.15), M_PANTS, bevel=0.014),
            sph('knee', (sx * LX, 0, KNEE), 0.056, M_PANTS),
            box('kneepad', (sx * LX, 0.062, KNEE + 0.02), (0.115, 0.05, 0.10), M_BOOT, bevel=0.025),
        ], hips)
        ll = part(f'LowerLeg_{side}', (sx * LX, 0, KNEE), [
            cyl('ll', (sx * LX, 0, (KNEE + ANKLE) / 2 + 0.05), 0.062, KNEE - ANKLE - 0.06, M_PANTS, r2=0.048),
            box('boot', (sx * LX, 0.04, 0.09), (0.125, 0.29, 0.16), M_BOOT, bevel=0.03),
            box('sole', (sx * LX, 0.04, 0.014), (0.13, 0.30, 0.03), M_DARK, bevel=0.005, seg=1),
        ], ul)
    # ---- rifle (child of Torso; posed in Three), compact AK, barrel +Y
    rifle_objs = [
        box('recv', (0, 0.06, 0), (0.04, 0.27, 0.06), M_STEEL, bevel=0.004, seg=1),
        box('dust', (0, 0.06, 0.028), (0.036, 0.22, 0.02), M_STEEL, bevel=0.003, seg=1),
        box('grip', (0, -0.02, -0.07), (0.03, 0.04, 0.10), M_WOOD, bevel=0.006, seg=1, rot=(-20, 0, 0)),
        box('mag', (0, 0.08, -0.10), (0.03, 0.07, 0.16), M_STEEL, bevel=0.004, seg=1, rot=(25, 0, 0)),
        box('hg', (0, 0.28, -0.01), (0.042, 0.14, 0.05), M_WOOD, bevel=0.008, seg=1),
        cyl('barrel', (0, 0.50, 0.0), 0.009, 0.42, M_STEEL, axis='Y'),
        cyl('gas', (0, 0.30, 0.036), 0.010, 0.16, M_STEEL, axis='Y'),
        box('stock', (0, -0.20, -0.035), (0.038, 0.26, 0.06), M_WOOD, bevel=0.008, seg=1, rot=(-6, 0, 0)),
        box('fsight', (0, 0.63, 0.03), (0.02, 0.03, 0.05), M_STEEL, seg=1),
    ]
    rifle = part('Rifle', (0, 0, 0), rifle_objs, torso)
    empty('Muzzle', (0, 0.72, 0), rifle)
    empty('Eye', (0, 0.08, 1.71), head)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, f'bot_{variant}.glb'), export_format='GLB', use_selection=True,
        export_apply=True, export_yup=True, export_lights=False, export_cameras=False, export_animations=False, export_extras=True, export_image_format='NONE')

for v in ('mask', 'mask_cap', 'wrap', 'wrap_goggles'): build(v)
print('bots exported')
