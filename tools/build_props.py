"""Props: C4 (CS2-style: two paper-wrapped charges, phone module with LCD + keypad, red LED, wires, tape).
Blender +Y forward / +Z up -> glTF -Y up. Origin at the base centre (sits on the floor). Size ~0.36 x 0.24 x 0.11 m."""
import bpy, math, os
from mathutils import Vector, Euler

OUT = r'C:\Code\cs2-dust2\public\models'

def reset():
    if bpy.context.mode != 'OBJECT': bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete()
    for x in list(bpy.data.meshes):
        if x.users == 0: bpy.data.meshes.remove(x)

def srgb(h):
    h = h.lstrip('#'); c = [int(h[i:i+2], 16) / 255 for i in (0, 2, 4)]
    return tuple((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)

def mat(name, hexstr, rough=0.7, metallic=0.0, emit=None, strength=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True; b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*srgb(hexstr), 1); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metallic
    if emit:
        b.inputs['Emission Color'].default_value = (*srgb(emit), 1); b.inputs['Emission Strength'].default_value = strength
    return m

M_BODY  = mat('c4_body', '#4a4f3a', 0.85)          # olive drab housing
M_PAPER = mat('c4_paper', '#b08a5a', 0.9)          # brown paper-wrapped charges
M_TAPE  = mat('c4_tape', '#6e6a5e', 0.6)           # duct tape
M_PHONE = mat('c4_phone', '#1c1d20', 0.45)
M_LCD   = mat('c4_lcd', '#5c7a3a', 0.3, emit='#9cd45a', strength=1.2)
M_KEY   = mat('c4_key', '#2b2c30', 0.5)
M_LED   = mat('c4_led', '#ff2a1a', 0.3, emit='#ff3020', strength=6.0)
M_WIRE_R = mat('c4_wire_r', '#c8201a', 0.5); M_WIRE_B = mat('c4_wire_b', '#1a3cc8', 0.5); M_WIRE_Y = mat('c4_wire_y', '#d8b820', 0.5)
M_STEEL = mat('c4_steel', '#8a8d90', 0.35, 0.9)

def finish(o, m, bevel=0.0, seg=2, smooth=True):
    o.data.materials.append(m)
    if bevel > 0:
        b = o.modifiers.new('bevel', 'BEVEL'); b.width = bevel; b.segments = seg; b.limit_method = 'ANGLE'
    if smooth:
        for p in o.data.polygons: p.use_smooth = True
    return o

def box(name, c, s, m, bevel=0.0, rot=(0, 0, 0), seg=2):
    bpy.ops.mesh.primitive_cube_add(size=1, location=c)
    o = bpy.context.active_object; o.name = name; o.scale = s; o.rotation_euler = Euler([math.radians(a) for a in rot])
    return finish(o, m, bevel, seg)

def cyl(name, c, r, L, m, axis='Z', verts=12):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=L, vertices=verts, location=c)
    o = bpy.context.active_object; o.name = name
    if axis == 'Y': o.rotation_euler = Euler((math.radians(90), 0, 0))
    elif axis == 'X': o.rotation_euler = Euler((0, math.radians(90), 0))
    return finish(o, m)

def wire(name, pts, r, m):
    """Bezier tube through pts."""
    cu = bpy.data.curves.new(name, 'CURVE'); cu.dimensions = '3D'; cu.bevel_depth = r; cu.bevel_resolution = 3; cu.resolution_u = 8
    sp = cu.splines.new('BEZIER'); sp.bezier_points.add(len(pts) - 1)
    for bp, p in zip(sp.bezier_points, pts):
        bp.co = Vector(p); bp.handle_left_type = bp.handle_right_type = 'AUTO'
    o = bpy.data.objects.new(name, cu); bpy.context.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o; o.select_set(True)
    bpy.ops.object.convert(target='MESH')
    o = bpy.context.active_object
    return finish(o, m)

def build_c4():
    reset()
    W, Dp, H = 0.36, 0.24, 0.11
    objs = [
        box('base', (0, 0, 0.02), (W, Dp, 0.04), M_BODY, bevel=0.008),
        # two charges side by side, paper wrapped, sitting in the tray
        box('charge_l', (-0.085, 0.0, 0.065), (0.15, 0.20, 0.07), M_PAPER, bevel=0.012),
        box('charge_r', (0.085, 0.0, 0.065), (0.15, 0.20, 0.07), M_PAPER, bevel=0.012),
        # tape straps across both charges
        box('tape_1', (0, -0.06, 0.066), (W + 0.004, 0.035, 0.073), M_TAPE, bevel=0.003, seg=1),
        box('tape_2', (0, 0.06, 0.066), (W + 0.004, 0.035, 0.073), M_TAPE, bevel=0.003, seg=1),
        # phone / detonator module on top, angled slightly
        box('phone', (0.0, -0.005, 0.113), (0.16, 0.085, 0.026), M_PHONE, bevel=0.006, rot=(0, 0, 0)),
        box('lcd', (0.0, 0.012, 0.1275), (0.12, 0.028, 0.004), M_LCD, bevel=0.001, seg=1),
        box('led', (0.062, -0.028, 0.128), (0.012, 0.012, 0.006), M_LED, bevel=0.002, seg=1),
        cyl('antenna', (-0.07, -0.03, 0.15), 0.003, 0.05, M_STEEL),
        # steel corner brackets
        box('brk_1', (-W / 2 + 0.01, -Dp / 2 + 0.01, 0.03), (0.02, 0.02, 0.06), M_STEEL, bevel=0.002, seg=1),
        box('brk_2', (W / 2 - 0.01, -Dp / 2 + 0.01, 0.03), (0.02, 0.02, 0.06), M_STEEL, bevel=0.002, seg=1),
        box('brk_3', (-W / 2 + 0.01, Dp / 2 - 0.01, 0.03), (0.02, 0.02, 0.06), M_STEEL, bevel=0.002, seg=1),
        box('brk_4', (W / 2 - 0.01, Dp / 2 - 0.01, 0.03), (0.02, 0.02, 0.06), M_STEEL, bevel=0.002, seg=1),
    ]
    # keypad: 3x4 buttons
    for r in range(3):
        for c in range(4):
            objs.append(box(f'key_{r}{c}', (-0.045 + c * 0.03, -0.028 + r * 0.0 - 0.0 + (r - 1) * 0.012, 0.128), (0.022, 0.009, 0.005), M_KEY, bevel=0.001, seg=1))
    # wires: from the phone down into each charge
    objs.append(wire('wire_r', [(0.06, 0.03, 0.125), (0.12, 0.07, 0.12), (0.14, 0.09, 0.10)], 0.0035, M_WIRE_R))
    objs.append(wire('wire_b', [(-0.06, 0.03, 0.125), (-0.12, 0.07, 0.12), (-0.14, 0.09, 0.10)], 0.0035, M_WIRE_B))
    objs.append(wire('wire_y', [(0.02, 0.04, 0.125), (0.0, 0.10, 0.11), (-0.05, 0.11, 0.10)], 0.003, M_WIRE_Y))
    for o in objs:
        bpy.context.view_layer.objects.active = o
        for md in list(o.modifiers): bpy.ops.object.modifier_apply(modifier=md.name)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object; o.name = 'C4'
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'c4.glb'), export_format='GLB', use_selection=True,
        export_apply=True, export_yup=True, export_lights=False, export_cameras=False, export_animations=False, export_image_format='NONE')

build_c4()
print('c4 exported')
