"""Rigged T-side bots from a REAL skinned character (Mixamo-compatible skeleton) + optional Mixamo clip files.

Inputs
  assets_src/characters/<BASE>            rigged + textured character (.glb/.gltf/.fbx) with a Mixamo-style skeleton
                                           (mixamorig:Hips ... or the same names without the prefix). Should contain at
                                           least idle/walk/run clips; more clips can be dropped in as separate files:
  assets_src/anim/*.fbx|*.glb              optional Mixamo clips (download "Without Skin", FBX binary). The file stem is the
                                           clip name the game sees ("Rifle Idle.fbx" -> "Rifle Idle"). Bone names may or may
                                           not carry the 'mixamorig:' prefix; the script adapts them to the base rig.
Outputs
  public/models/bot_<variant>.glb for mask, mask_cap, wrap, wrap_goggles: skins + all clips (NLA tracks), JPEG q85 textures.
  Variants = per-material colour tint + simple accessory meshes parented to the head bone (shemagh, goggles, cap, balaclava).
Run inside Blender:  exec(compile(open(path, encoding='utf-8').read(), 'build_bots_rigged.py', 'exec'), {'__name__': '__main__'})
Then (optional, smaller):  npx @gltf-transform/cli webp public/models/bot_mask.glb public/models/bot_mask.glb --quality 85
"""
import bpy, os, glob, math, re
from mathutils import Vector, Euler

ROOT = r'C:\Code\cs2-dust2'
CHAR_DIR, ANIM_DIR, OUT = os.path.join(ROOT, 'assets_src', 'characters'), os.path.join(ROOT, 'assets_src', 'anim'), os.path.join(ROOT, 'public', 'models')
BASE = os.environ.get('BOT_BASE', '')                         # file name inside CHAR_DIR; '' = first .glb/.gltf/.fbx found
BASE_HAS_HELMET = True                                        # three.js "Soldier" (Mixamo Vanguard) wears a helmet: no cap / balaclava on top of it
VARIANTS = {
    #          body tint (multiplies the albedo)   visor/extra   accessories
    'mask':         {'tint': (0.82, 0.80, 0.76), 'visor': (0.02, 0.02, 0.025), 'acc': ['balaclava']},
    'mask_cap':     {'tint': (0.55, 0.55, 0.56), 'visor': (0.02, 0.02, 0.025), 'acc': ['balaclava', 'cap']},
    'wrap':         {'tint': (0.98, 0.88, 0.70), 'visor': (0.10, 0.09, 0.07),  'acc': ['shemagh']},
    'wrap_goggles': {'tint': (0.74, 0.80, 0.62), 'visor': (0.10, 0.09, 0.07),  'acc': ['shemagh', 'goggles']},
}
FORWARD = Vector((0, 1, 0))                                   # character forward in Blender after import (glTF -Z -> Blender +Y)

# ------------------------------------------------------------ helpers
def log(*a): print('[bots]', *a)

def reset():
    if bpy.context.mode != 'OBJECT': bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete()
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.actions, bpy.data.armatures):
        for x in list(coll):
            if x.users == 0: coll.remove(x)

def import_any(path):
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    if ext in ('.glb', '.gltf'): bpy.ops.import_scene.gltf(filepath=path)
    elif ext == '.fbx': bpy.ops.import_scene.fbx(filepath=path, use_anim=True, ignore_leaf_bones=False, automatic_bone_orientation=False)
    else: raise RuntimeError('unsupported ' + path)
    return [o for o in bpy.data.objects if o not in before]

def srgb(c):
    return tuple((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)

def flat_mat(name, rgb, rough=0.85, metallic=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True; b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*srgb(rgb), 1); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metallic
    return m

def bone_prefix(arm):
    return 'mixamorig:' if any(b.name.startswith('mixamorig:') for b in arm.data.bones) else ''

def bone(arm, short):
    """Find a bone by its Mixamo short name, tolerant to prefix / separators / case."""
    key = re.sub(r'[^a-z0-9]', '', short.lower())
    for b in arm.data.bones:
        n = re.sub(r'[^a-z0-9]', '', b.name.lower().replace('mixamorig', ''))
        if n == key: return b
    return None

# ------------------------------------------------------------ clips
def add_clip(arm, path, hip_rest_h):
    """Import a Mixamo clip file and push its action onto `arm` as an NLA track named after the file."""
    name = os.path.splitext(os.path.basename(path))[0]
    objs = import_any(path)
    src = next((o for o in objs if o.type == 'ARMATURE'), None)
    act = src.animation_data.action if (src and src.animation_data) else None
    if not act:
        for o in objs: bpy.data.objects.remove(o, do_unlink=True)
        log('no action in', name); return
    act.name = name
    pre_dst, pre_src = bone_prefix(arm), bone_prefix(src)
    # rename channels to the base rig's naming + rescale hip translations (cm vs m rigs)
    src_hip = bone(src, 'Hips'); ratio = 1.0
    if src_hip is not None:
        h = (src.matrix_world @ src_hip.head_local).z
        if h > 1e-6: ratio = hip_rest_h / h
    curves = act.fcurves if hasattr(act, 'fcurves') else []
    if not len(curves):                                       # Blender 4.4+ layered actions
        for layer in act.layers:
            for strip in layer.strips:
                for cb in strip.channelbags: curves = list(curves) + list(cb.fcurves)
    for fc in curves:
        m = re.match(r'pose\.bones\["(.+?)"\]\.(.+)', fc.data_path)
        if not m: continue
        bn, prop = m.group(1), m.group(2)
        bn2 = pre_dst + bn[len(pre_src):] if bn.startswith(pre_src) else pre_dst + bn
        if bn2 != bn: fc.data_path = f'pose.bones["{bn2}"].{prop}'
        if prop == 'location' and abs(ratio - 1) > 1e-3:
            for kp in fc.keyframe_points: kp.co.y *= ratio; kp.handle_left.y *= ratio; kp.handle_right.y *= ratio
    if not arm.animation_data: arm.animation_data_create()
    tr = arm.animation_data.nla_tracks.new(); tr.name = name
    st = tr.strips.new(name, int(act.frame_range[0]), act)
    try:
        if hasattr(st, 'action_slot') and len(act.slots): st.action_slot = act.slots[0]
    except Exception as e: log('slot', e)
    for o in objs: bpy.data.objects.remove(o, do_unlink=True)
    log('clip', name, 'frames', tuple(int(v) for v in act.frame_range), 'hip scale', round(ratio, 3))

# ------------------------------------------------------------ accessories (parented to the head bone)
def _prim_box(name, c, s, m, bevel=0.0, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=c)
    o = bpy.context.active_object; o.name = name; o.scale = s; o.rotation_euler = Euler([math.radians(a) for a in rot])
    o.data.materials.append(m)
    if bevel > 0:
        b = o.modifiers.new('bevel', 'BEVEL'); b.width = bevel; b.segments = 2; b.limit_method = 'ANGLE'
    for p in o.data.polygons: p.use_smooth = bevel > 0
    return o

def _prim_sphere(name, c, r, m, s=(1, 1, 1)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, segments=20, ring_count=12, location=c)
    o = bpy.context.active_object; o.name = name; o.scale = s; o.data.materials.append(m)
    for p in o.data.polygons: p.use_smooth = True
    return o

def _prim_torus(name, c, R, r, m, s=(1, 1, 1), rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=20, minor_segments=8, location=c)
    o = bpy.context.active_object; o.name = name; o.scale = s; o.rotation_euler = Euler([math.radians(a) for a in rot]); o.data.materials.append(m)
    for p in o.data.polygons: p.use_smooth = True
    return o

def join(objs, name):
    for o in objs:
        bpy.context.view_layer.objects.active = o
        for md in list(o.modifiers): bpy.ops.object.modifier_apply(modifier=md.name)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1: bpy.ops.object.join()
    o = bpy.context.active_object; o.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return o

def accessories(arm, kinds, head_pos, head_top, fwd):
    """Simple head-worn props: built in world space around the head, then bone-parented to the head."""
    M_WRAP, M_BAND = flat_mat('acc_wrap', (0.78, 0.69, 0.52), 0.95), flat_mat('acc_wrap_band', (0.55, 0.48, 0.36), 0.95)
    M_DARK, M_LENS = flat_mat('acc_dark', (0.09, 0.09, 0.10), 0.85), flat_mat('acc_lens', (0.16, 0.24, 0.28), 0.15, 0.2)
    M_MASK, M_SKIN = flat_mat('acc_mask', (0.10, 0.10, 0.11), 0.95), flat_mat('acc_skin', (0.49, 0.35, 0.24), 0.7)
    right = Vector((fwd.y, -fwd.x, 0))
    up = Vector((0, 0, 1))
    H = head_top.z - head_pos.z                               # head height (bone base -> top of the mesh)
    c = head_pos + up * (H * 0.55)                             # skull centre
    out = []
    P = lambda f, r, u: c + fwd * f + right * r + up * u
    for k in kinds:
        parts = []
        if k == 'shemagh':                                      # loose wrap around the neck/collar with a tail down the back
            nk = head_pos + up * (-0.02)
            parts.append(_prim_torus('sh_ring', nk, 0.125, 0.045, M_WRAP, s=(1, 1.1, 1.3)))
            parts.append(_prim_torus('sh_ring2', nk + up * 0.05 - fwd * 0.03, 0.105, 0.035, M_BAND, s=(1, 1.05, 1.0)))
            parts.append(_prim_box('sh_tail', nk - fwd * 0.12 + up * -0.10, (0.16, 0.05, 0.22), M_WRAP, bevel=0.015, rot=(12, 0, 0)))
        elif k == 'goggles':
            parts.append(_prim_box('gg_frame', P(0.105, 0, H * 0.14), (0.15, 0.045, 0.05), M_DARK, bevel=0.012))
            parts.append(_prim_box('gg_lens_l', P(0.128, -0.037, H * 0.14), (0.05, 0.012, 0.032), M_LENS, bevel=0.006))
            parts.append(_prim_box('gg_lens_r', P(0.128, 0.037, H * 0.14), (0.05, 0.012, 0.032), M_LENS, bevel=0.006))
            parts.append(_prim_torus('gg_strap', P(0.0, 0, H * 0.14), 0.112, 0.010, M_DARK, s=(1.15, 1, 1)))
        elif k == 'cap':
            parts.append(_prim_sphere('cap_dome', P(0.0, 0, H * 0.78), 0.105, M_DARK, s=(1.0, 1.08, 0.62)))
            parts.append(_prim_box('cap_brim', P(0.15, 0, H * 0.72), (0.16, 0.10, 0.012), M_DARK, bevel=0.004, rot=(-10, 0, 0)))
        elif k == 'balaclava':
            parts.append(_prim_sphere('bal_head', P(0.0, 0, H * 0.1), 0.105, M_MASK, s=(1.0, 1.12, 1.25)))
            parts.append(_prim_box('bal_slot', P(0.108, 0, H * 0.25), (0.085, 0.02, 0.03), M_SKIN, bevel=0.006))
            parts.append(_prim_box('bal_brow', P(0.11, 0, H * 0.33), (0.10, 0.016, 0.014), M_MASK, bevel=0.004))
        if parts:
            # skinned 100 % to the head bone (bone parenting + a scaled armature exports with a bogus offset)
            o = join(parts, 'acc_' + k)
            o.parent = arm; o.matrix_parent_inverse = arm.matrix_world.inverted()
            vg = o.vertex_groups.new(name=bone(arm, 'Head').name); vg.add(list(range(len(o.data.vertices))), 1.0, 'REPLACE')
            md = o.modifiers.new('Armature', 'ARMATURE'); md.object = arm
            out.append(o)
    return out

# ------------------------------------------------------------ build
def tint_materials(meshes, tint, visor):
    for me in meshes:
        for m in me.data.materials:
            if not m or not m.use_nodes: continue
            nt = m.node_tree; b = nt.nodes.get('Principled BSDF')
            if not b: continue
            if 'visor' in m.name.lower() or 'glass' in m.name.lower():
                for l in list(b.inputs['Base Color'].links): nt.links.remove(l)
                b.inputs['Base Color'].default_value = (*visor, 1); b.inputs['Roughness'].default_value = 0.25; b.inputs['Metallic'].default_value = 0.3
                continue
            mix = nt.nodes.get('bot_tint')
            if not mix:
                links = b.inputs['Base Color'].links
                if not links: b.inputs['Base Color'].default_value = (*tint, 1); continue
                src = links[0].from_socket
                mix = nt.nodes.new('ShaderNodeMix'); mix.name = 'bot_tint'; mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
                mix.inputs['Factor'].default_value = 1.0
                nt.links.new(src, mix.inputs[6]); nt.links.new(mix.outputs[2], b.inputs['Base Color'])
            mix.inputs[7].default_value = (*tint, 1)

def main():
    reset()
    files = sorted(glob.glob(os.path.join(CHAR_DIR, '*.glb')) + glob.glob(os.path.join(CHAR_DIR, '*.gltf')) + glob.glob(os.path.join(CHAR_DIR, '*.fbx')))
    if BASE: files = [f for f in files if os.path.basename(f) == BASE] or files
    if not files: raise RuntimeError('no character in ' + CHAR_DIR)
    base = files[0]; log('base', base)
    objs = import_any(base)
    arm = next(o for o in objs if o.type == 'ARMATURE')
    meshes = [o for o in objs if o.type == 'MESH' and (o.parent == arm or any(md.type == 'ARMATURE' for md in o.modifiers))]
    for o in objs:                                             # leaf empties (finger tips etc.) are useless in the game
        if o.type == 'EMPTY' and o not in (arm,): bpy.data.objects.remove(o, do_unlink=True)
    # rest-pose landmarks
    if arm.animation_data: arm.animation_data.action = None
    for pb in arm.pose.bones: pb.matrix_basis.identity()
    bpy.context.view_layer.update()
    hb = bone(arm, 'Head'); head_pos = arm.matrix_world @ hb.head_local
    hip_h = (arm.matrix_world @ bone(arm, 'Hips').head_local).z
    top = max((arm.matrix_world @ Vector(cn)).z for me in meshes for cn in me.bound_box)
    head_top = Vector((head_pos.x, head_pos.y, top))
    log('bones', len(arm.data.bones), 'prefix', repr(bone_prefix(arm)), 'hip', round(hip_h, 3), 'head', tuple(round(v, 3) for v in head_pos), 'top', round(top, 3))
    tris = sum(len(p.vertices) - 2 for me in meshes for p in me.data.polygons); log('tris', tris)
    # extra clips
    for f in sorted(glob.glob(os.path.join(ANIM_DIR, '*.fbx')) + glob.glob(os.path.join(ANIM_DIR, '*.glb'))): add_clip(arm, f, hip_h)
    log('clips', [t.name for t in (arm.animation_data.nla_tracks if arm.animation_data else [])])
    # variants
    for v, cfg in VARIANTS.items():
        acc = [k for k in cfg['acc'] if not (BASE_HAS_HELMET and k in ('cap', 'balaclava'))]
        props = accessories(arm, acc, head_pos, head_top, FORWARD)
        tint_materials(meshes, cfg['tint'], cfg['visor'])
        bpy.ops.object.select_all(action='DESELECT')
        for o in [arm] + meshes + props: o.select_set(True)
        bpy.context.view_layer.objects.active = arm
        path = os.path.join(OUT, f'bot_{v}.glb')
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_skins=True, export_animations=True,
                                  export_animation_mode='NLA_TRACKS', export_image_format='JPEG', export_jpeg_quality=85, export_lights=False,
                                  export_cameras=False, export_extras=True, export_def_bones=False, export_leaf_bone=False, export_apply=False)
        log('exported', path, round(os.path.getsize(path) / 1024), 'KB', 'acc', acc)
        for o in props: bpy.data.objects.remove(o, do_unlink=True)

if __name__ == '__main__': main()
