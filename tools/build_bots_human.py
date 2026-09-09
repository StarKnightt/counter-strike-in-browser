"""T-side bots as real humans: MPFB2 (MakeHuman) base body retargeted onto the existing Mixamo skeleton.

Route
  1. Import assets_src/characters/Soldier.glb  -> keeps the EXACT armature (bone names, rest matrices) and the
     Idle / Walk / Run / TPose actions the game already relies on. The Vanguard meshes are thrown away.
  2. MPFB2 generates a male base mesh + the 'mixamo_unity' rig with MakeHuman-authored skin weights
     (bone names are already `mixamorig:*`). The base mesh is A-posed, so MPFB's t-pose is applied as the rest pose.
  3. The MPFB rig is posed bone-by-bone onto the Soldier rest pose (head position + bone direction + length scale)
     and the deformation is baked, so the body ends up exactly in the Soldier skeleton's rest pose.
  4. Clothing is pushed out of the body itself per region (shirt / cargo trousers / boots / balaclava / gloves),
     plus a plate carrier, pouches, belt and head gear built as separate props and shrinkwrapped on.
  5. Everything is joined into one skinned mesh, UV unwrapped, and a 2048 albedo/roughness/normal atlas is baked
     from procedural materials with Cycles. Exported as public/models/bot_<variant>.glb with the original clips.

Run inside Blender:
  exec(compile(open(r'C:\\Code\\cs2-dust2\\tools\\build_bots_human.py', encoding='utf-8').read(), 'build_bots_human.py', 'exec'), {'__name__': '__main__'})
"""
import bpy, bmesh, os, math, json, re, importlib, colorsys
from mathutils import Vector, Matrix, Euler, Quaternion

ROOT = r'C:\Code\cs2-dust2'
CHAR = os.path.join(ROOT, 'assets_src', 'characters', 'Soldier.glb')
OUT = os.path.join(ROOT, 'public', 'models')
TMP = os.path.join(ROOT, '_tmp_blender')
os.makedirs(TMP, exist_ok=True)

PRE = 'mixamorig:'
BAKE_SIZE = 2048

# ---------------------------------------------------------------- logging
def log(*a): print('[bot]', *a)

def deselect():
    for o in bpy.context.view_layer.objects:
        o.select_set(False)

def activate(o):
    deselect(); bpy.context.view_layer.objects.active = o; o.select_set(True)

def srgb(c):
    return tuple((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)

# ---------------------------------------------------------------- 1. skeleton donor
def import_skeleton():
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=CHAR)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == 'ARMATURE')
    arm.name = 'BotRig'
    for o in new:
        if o is not arm:
            bpy.data.objects.remove(o, do_unlink=True)
    # rest pose, no action bound (the actions stay in bpy.data and are pushed to NLA at export time)
    if arm.animation_data:
        arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.matrix_basis.identity()
    bpy.context.view_layer.update()
    lengthen_neck(arm)
    lengthen_arms(arm)
    reshape_hands(arm)
    return arm


# The donor rig is an armoured trooper: 33 mm from the shoulder line to the head bone, so a human neck gets
# squashed to nothing by the retarget. Mixamo clips key rotation only for Neck/Head (Hips carries the
# translation), so raising these two in the REST pose is animation-safe.
NECK_UP, HEAD_UP = 0.026, 0.074

# The same donor rig has a stubby upper arm: measured in-game it was 0.211 m on a 1.786 m bot (0.118 of height,
# against ~0.186 anthropometric), which is what stopped the left hand from ever reaching the AK handguard --
# the arm's whole reach was 0.43 m for a 0.66 m target. Every other segment sits at 0.90-0.92 of the
# anthropometric value (that is just the model-scale Bot.js applies), so only this one is out. Scaling the
# upper arm in the REST pose is animation-safe for the same reason the neck is: Mixamo keys rotation only.
UPPER_ARM = 1.42            # multiplier on LeftArm/RightArm length

# Measured in-game on the finished bot: wrist -> middle knuckle 138 mm and phalanges of 31/25 mm, against
# ~95/45/28 for a hand this size. The palm therefore ends *past* the AK handguard and the fingers are stubby
# hooks behind it, which is why the support hand read as a rake laid over the weapon rather than a grip.
# Rebalancing the chain in the REST pose keeps overall hand length (~190 mm) but puts the knuckles where a
# knuckle goes. Animation-safe: Mixamo keys rotation only below the wrist.
PALM, PHALANX = 0.70, 1.32


def action_fcurves(act):
    """Blender 4.4+ moved fcurves into layer/strip channelbags; keep both shapes working."""
    if hasattr(act, 'fcurves'):
        yield from act.fcurves; return
    for layer in getattr(act, 'layers', []):
        for strip in getattr(layer, 'strips', []):
            for slot in act.slots:
                cb = strip.channelbag(slot)
                if cb: yield from cb.fcurves


def lengthen_neck(arm):
    activate(arm)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    nk, hd = eb.get(PRE + 'Neck'), eb.get(PRE + 'Head')
    # the glTF armature sits in a rotated, 100x space; convert a world +Z shift into it
    w2l = arm.matrix_world.inverted().to_3x3()
    dn, dh = w2l @ Vector((0, 0, NECK_UP)), w2l @ Vector((0, 0, NECK_UP + HEAD_UP))
    # heads AND tails move together, so every bone keeps its rest orientation and the clips stay valid
    for b, d in ((nk, dn), (hd, dh)):
        if not b: continue
        b.head = b.head + d; b.tail = b.tail + d
    if hd:
        for c in hd.children_recursive:
            c.head = c.head + dh; c.tail = c.tail + dh
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.context.view_layer.update()
    # any translation channel on these bones in the clips would fight the new rest pose - check and report
    bad = []
    for act in bpy.data.actions:
        for fc in action_fcurves(act):
            if '"' not in fc.data_path or '.location' not in fc.data_path: continue
            bn = fc.data_path.split('"')[1]
            if bn.endswith('Neck') or bn.endswith('Head'):
                if any(abs(k.co[1]) > 1e-5 for k in fc.keyframe_points): bad.append((act.name, bn))
    log('neck +%.0f mm, head +%.0f mm; translated head/neck curves:' % (NECK_UP * 1000, HEAD_UP * 1000), sorted(set(bad)) or 'none')
    return arm


def lengthen_arms(arm):
    """Stretch the upper arm in the rest pose; the elbow, wrist and fingers ride along so the chain keeps its
    shape, and the MPFB retarget (which follows bone direction + length) stretches the mesh to match."""
    activate(arm)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    l2w = arm.matrix_world
    grew = []
    for side in ('Left', 'Right'):
        up, lo = eb.get(PRE + side + 'Arm'), eb.get(PRE + side + 'ForeArm')
        if not (up and lo): continue
        # NOT tail - head: this donor's arm bones carry a stray tail ~100x past the elbow (a glTF import
        # artefact). The elbow bone's head is the only trustworthy end of the upper arm.
        d = (lo.head - up.head) * (UPPER_ARM - 1.0)
        up.tail = up.tail + d
        for c in up.children_recursive:
            c.head = c.head + d; c.tail = c.tail + d
        was = ((l2w @ lo.head) - (l2w @ up.head)).length
        grew.append('%s %.0f->%.0f mm' % (side, was * 1000, was * UPPER_ARM * 1000))
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.context.view_layer.update()
    bad = []
    for act in bpy.data.actions:
        for fc in action_fcurves(act):
            if '"' not in fc.data_path or '.location' not in fc.data_path: continue
            bn = fc.data_path.split('"')[1]
            if bn.endswith('ForeArm') or bn.endswith('Hand') or bn.endswith('Arm'):
                if any(abs(k.co[1]) > 1e-5 for k in fc.keyframe_points): bad.append((act.name, bn))
    log('upper arm x%.2f on' % UPPER_ARM, grew, '; translated arm curves:', sorted(set(bad)) or 'none')


def reshape_hands(arm):
    """Shorten the metacarpals and lengthen the phalanges in the REST pose (see PALM / PHALANX).

    Bones are re-laid along their own existing directions, so the hand keeps its splay and the retarget, which
    follows bone direction and length, carries the mesh with it. Each chain is rebuilt from the wrist outwards
    from the ORIGINAL head positions; walking children_recursive here would apply the parent's shift twice."""
    activate(arm)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    report = []
    for side in ('Left', 'Right'):
        hand = eb.get(PRE + side + 'Hand')
        if not hand: continue
        for f in ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky'):
            chain = [b for b in (eb.get(PRE + side + 'Hand' + f + str(j)) for j in (1, 2, 3)) if b]
            if not chain: continue
            old = [b.head.copy() for b in chain]
            # the fingertip: this donor's bones carry stray tails (see lengthen_arms), so an implausible one is
            # replaced by a segment continuing the last phalanx
            tip = chain[-1].tail.copy()
            prev_seg = (old[-1] - (old[-2] if len(old) > 1 else hand.head))
            if (tip - old[-1]).length > 2.5 * prev_seg.length:
                tip = old[-1] + prev_seg.normalized() * (prev_seg.length * 0.75)
            old.append(tip)
            new = [hand.head + (old[0] - hand.head) * PALM]
            for j in range(1, len(old)):
                new.append(new[-1] + (old[j] - old[j - 1]) * PHALANX)
            for j, b in enumerate(chain):
                b.head, b.tail = new[j], new[j + 1]
            # the leaf (…4 / _end) rides on the last tail so the glove tip is not left behind
            for c in chain[-1].children:
                d = new[-1] - old[-1]
                c.head, c.tail = c.head + d, c.tail + d
            if side == 'Left' and f == 'Middle':
                report.append('palm %.0f->%.0f mm, tip %.0f->%.0f mm' % (
                    (old[0] - hand.head).length * 1000, (new[0] - hand.head).length * 1000,
                    (old[-1] - hand.head).length * 1000, (new[-1] - hand.head).length * 1000))
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.context.view_layer.update()
    bad = []
    for act in bpy.data.actions:
        for fc in action_fcurves(act):
            if '"' not in fc.data_path or '.location' not in fc.data_path: continue
            if 'Hand' in fc.data_path.split('"')[1] and any(abs(k.co[1]) > 1e-5 for k in fc.keyframe_points):
                bad.append((act.name, fc.data_path.split('"')[1]))
    log('hands: metacarpal x%.2f, phalanx x%.2f ->' % (PALM, PHALANX), report,
        '; translated finger curves:', sorted(set(bad)) or 'none')


def bone_world(arm, name):
    b = arm.data.bones.get(PRE + name)
    return None if b is None else (arm.matrix_world @ b.head_local)


# ---------------------------------------------------------------- 2. MPFB body
MACRO = {'gender': 1.0, 'age': 0.55, 'muscle': 0.72, 'weight': 0.52, 'proportions': 0.62,
         'height': 0.58, 'cupsize': 0.0, 'firmness': 0.5,
         'race': {'asian': 0.3, 'caucasian': 0.45, 'african': 0.25}}


def make_body():
    HS = importlib.import_module('bl_ext.blender_org.mpfb.services.humanservice').HumanService
    LS = importlib.import_module('bl_ext.blender_org.mpfb.services.locationservice').LocationService
    # feet_on_ground translates the mesh but not the rig definition's joint fallbacks -> keep MakeHuman space,
    # the retarget puts the body on the game skeleton anyway.
    body = HS.create_human(mask_helpers=True, detailed_helpers=False, extra_vertex_groups=True,
                           feet_on_ground=False, scale=0.1, macro_detail_dict=MACRO)
    body.name = 'Body'
    rig = HS.add_builtin_rig(body, 'mixamo_unity', import_weights=True)
    rig.name = 'MPRig'
    # --- helper geometry has to go before anything else touches the topology
    activate(body)
    for md in list(body.modifiers):
        if md.type != 'ARMATURE':
            body.modifiers.remove(md)
    if body.data.shape_keys:                       # macro details are shape keys; bake them into the mesh
        bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
    gi = {g.name: g.index for g in body.vertex_groups}
    kill = set()
    for v in body.data.vertices:
        for g in v.groups:
            if g.group in (gi['HelperGeometry'], gi['JointCubes']) and g.weight > 0.5:
                kill.add(v.index); break
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='DESELECT'); bpy.ops.object.mode_set(mode='OBJECT')
    for i in kill:
        body.data.vertices[i].select = True
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.delete(type='VERT'); bpy.ops.object.mode_set(mode='OBJECT')
    for n in ('HelperGeometry', 'JointCubes', 'Left', 'Mid', 'Right', 'nippleTip', 'nipple', 'lips',
              'fingernails', 'toenails', 'ears', 'scalp', 'genitals', 'body'):
        g = body.vertex_groups.get(n)
        if g: body.vertex_groups.remove(g)
    log('body', len(body.data.vertices), 'verts', len(body.data.polygons), 'faces')

    # --- A-pose -> T-pose (MPFB ships the exact correction for this rig)
    pose = json.load(open(os.path.join(LS.get_mpfb_data(), 'poses', 'mixamo_unity_fk', 't-pose.json'), encoding='utf-8'))
    for bn, rot in pose['bone_rotations'].items():
        pb = rig.pose.bones.get(bn)
        if pb:
            pb.rotation_mode = 'XYZ'; pb.rotation_euler = Euler(rot)
    bpy.context.view_layer.update()
    apply_pose_as_rest(rig, [body])

    # MakeHuman faces -Y with Left on +X; the game skeleton faces +Y with Left on -X.
    activate(body); bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    for o in (body, rig):
        activate(o)
        o.rotation_euler = Euler((0, 0, math.pi))
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    bpy.context.view_layer.update()
    return body, rig


def apply_pose_as_rest(rig, meshes):
    """Bake the current pose into the bound meshes, then make it the armature's rest pose."""
    for m in meshes:
        md = next((x for x in m.modifiers if x.type == 'ARMATURE'), None)
        if not md: continue
        activate(m)
        bpy.ops.object.modifier_copy(modifier=md.name)
        bpy.ops.object.modifier_apply(modifier=md.name)
    activate(rig)
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.select_all(action='SELECT')
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.context.view_layer.update()


# ---------------------------------------------------------------- 3. retarget onto the Soldier rest pose
# MPFB bones with no counterpart in the game skeleton: fold their weights into the nearest real bone.
FOLD = {'Root': None, 'Jaw': 'Head', 'LeftEye': 'Head', 'RightEye': 'Head',
        'LeftOrbicularisTop': 'Head', 'RightOrbicularisTop': 'Head',
        'LeftOrbicularisBottom': 'Head', 'RightOrbicularisBottom': 'Head',
        'LeftBreast': 'Spine2', 'RightBreast': 'Spine2',
        'LeftButtock': 'Hips', 'RightButtock': 'Hips',
        'LeftHandThumb3': 'LeftHandThumb2', 'LeftHandPinky3': 'LeftHandPinky2',
        'RightHandPinky3': 'RightHandPinky2'}


def fold_groups(mesh, arm):
    """Merge weights of bones the game skeleton doesn't have into their surviving parent."""
    have = {b.name for b in arm.data.bones}
    for short, into in FOLD.items():
        src = mesh.vertex_groups.get(PRE + short)
        if not src: continue
        dst = None
        if into:
            dst = mesh.vertex_groups.get(PRE + into) or mesh.vertex_groups.new(name=PRE + into)
        if dst:
            si = src.index
            for v in mesh.data.vertices:
                w = next((g.weight for g in v.groups if g.group == si), 0.0)
                if w > 0: dst.add([v.index], w, 'ADD')
        mesh.vertex_groups.remove(src)
    for g in list(mesh.vertex_groups):
        if g.name not in have:
            log('drop group', g.name); mesh.vertex_groups.remove(g)


# the child that continues each chain; must be identical in both rigs or the limb directions won't correspond
NEXT = {'Hips': 'Spine', 'Spine': 'Spine1', 'Spine1': 'Spine2', 'Spine2': 'Neck', 'Neck': 'Head'}
for S in ('Left', 'Right'):
    NEXT[S + 'Shoulder'] = S + 'Arm'; NEXT[S + 'Arm'] = S + 'ForeArm'; NEXT[S + 'ForeArm'] = S + 'Hand'
    NEXT[S + 'Hand'] = S + 'HandMiddle1'
    NEXT[S + 'UpLeg'] = S + 'Leg'; NEXT[S + 'Leg'] = S + 'Foot'; NEXT[S + 'Foot'] = S + 'ToeBase'
    for f in ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky'):
        NEXT[f'{S}Hand{f}1'] = f'{S}Hand{f}2'; NEXT[f'{S}Hand{f}2'] = f'{S}Hand{f}3'


def child_head(arm, bone):
    nxt = NEXT.get(bone.name[len(PRE):] if bone.name.startswith(PRE) else bone.name)
    if not nxt: return None
    c = arm.data.bones.get(PRE + nxt)
    return None if c is None else (arm.matrix_world @ c.head_local)


def retarget(src_rig, dst_rig, meshes, gscale=None):
    """Pose src_rig so every shared bone lands on dst_rig's rest bone, then bake it into the meshes."""
    # connected bones can't be moved independently
    activate(src_rig); bpy.ops.object.mode_set(mode='EDIT')
    for eb in src_rig.data.edit_bones:
        eb.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT'); bpy.context.view_layer.update()

    order = []
    def walk(b):
        order.append(b)
        for c in b.children: walk(c)
    for b in src_rig.data.bones:
        if b.parent is None: walk(b)

    # One uniform scale for every bone: per-bone length ratios wreck the silhouette wherever the two skeletons
    # distribute a chain differently (the game rig's neck is 3 cm, MakeHuman's is 10 cm -> a shrunken head).
    # Joints are still pinned exactly onto the target skeleton; limb lengths follow from the weight blend.
    if gscale is None:
        def span(a):
            hp, nk = a.matrix_world @ a.data.bones[PRE + 'Hips'].head_local, a.matrix_world @ a.data.bones[PRE + 'Neck'].head_local
            ft = a.matrix_world @ a.data.bones[PRE + 'LeftFoot'].head_local
            return (nk - ft).length
        gscale = span(dst_rig) / span(src_rig)
    log('global scale', round(gscale, 4))

    moved = 0
    for sb in order:
        db = dst_rig.data.bones.get(sb.name)
        pb = src_rig.pose.bones[sb.name]
        if db is None:
            continue
        s_head = src_rig.matrix_world @ sb.head_local
        d_head = dst_rig.matrix_world @ db.head_local
        s_next, d_next = child_head(src_rig, sb), child_head(dst_rig, db)
        rot = (src_rig.matrix_world @ sb.matrix_local).to_3x3()
        if s_next and d_next:
            sv, dv = (s_next - s_head), (d_next - d_head)
            if sv.length > 1e-5 and dv.length > 1e-5:
                rot = sv.normalized().rotation_difference(dv.normalized()).to_matrix() @ rot
        else:
            # chain end (head, toes, finger tips): the head still gets pinned onto the target joint - the head
            # capsule in Bot.js hangs off this bone - only the rotation is inherited from the parent.
            par = sb.parent
            if par is not None and dst_rig.data.bones.get(par.name):
                ppb = src_rig.pose.bones[par.name]
                pm = src_rig.matrix_world @ ppb.matrix
                corr = pm.to_3x3() @ (src_rig.matrix_world @ par.matrix_local).to_3x3().inverted()
                rot = corr.to_quaternion().to_matrix() @ rot
        for i in range(3):
            rot[0][i] *= gscale; rot[1][i] *= gscale; rot[2][i] *= gscale
        M = Matrix.Translation(d_head) @ rot.to_4x4()
        pb.matrix = src_rig.matrix_world.inverted() @ M
        bpy.context.view_layer.update()
        moved += 1
    log('retargeted', moved, 'bones')
    apply_pose_as_rest(src_rig, meshes)


# ---------------------------------------------------------------- 4. clothing
BODY_REGIONS = {
    'head': ['Head', 'Jaw', 'LeftEye', 'RightEye'],
    'neck': ['Neck'],
    'torso': ['Spine', 'Spine1', 'Spine2', 'LeftShoulder', 'RightShoulder', 'LeftBreast', 'RightBreast'],
    'arm': ['LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm'],
    'hand': ['LeftHand', 'RightHand'],
    'pelvis': ['Hips', 'LeftButtock', 'RightButtock'],
    'thigh': ['LeftUpLeg', 'RightUpLeg'],
    'shin': ['LeftLeg', 'RightLeg'],
    'foot': ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'],
}


def dominant_regions(mesh):
    """region name per vertex, from the strongest bone weight."""
    b2r = {}
    for r, bones in BODY_REGIONS.items():
        for b in bones: b2r[PRE + b] = r
    names = {g.index: g.name for g in mesh.vertex_groups}
    out = []
    for v in mesh.data.vertices:
        best, bw = 'torso', -1
        for g in v.groups:
            n = names.get(g.group, '')
            if n.startswith(PRE + 'LeftHand') or n.startswith(PRE + 'RightHand'):
                n = PRE + ('LeftHand' if 'Left' in n else 'RightHand')
            r = b2r.get(n)
            if r and g.weight > bw: bw, best = g.weight, r
        out.append(best)
    return out


def smooth_scalar(mesh, vals, iters=6, keep=0.35):
    """Laplacian-smooth a per-vertex scalar so garment thickness changes gradually across region borders."""
    adj = [[] for _ in range(len(mesh.data.vertices))]
    for e in mesh.data.edges:
        a, b = e.vertices; adj[a].append(b); adj[b].append(a)
    for _ in range(iters):
        nv = vals[:]
        for i, ns in enumerate(adj):
            if not ns: continue
            nv[i] = vals[i] * keep + (sum(vals[n] for n in ns) / len(ns)) * (1 - keep)
        vals = nv
    return vals


# region -> (offset along the normal in m, xz widening, albedo key)
GARMENT = {
    'head':   (0.010, 0.00, 'mask'),
    'neck':   (0.022, 0.00, 'mask'),
    'torso':  (0.022, 0.004, 'shirt'),
    'arm':    (0.021, 0.005, 'shirt'),
    'hand':   (0.006, 0.00, 'glove'),
    'pelvis': (0.028, 0.008, 'pants'),
    'thigh':  (0.034, 0.014, 'pants'),
    'shin':   (0.027, 0.011, 'pants'),
    'foot':   (0.028, 0.022, 'boot'),
}
# per-variant cloth colours (sRGB values; converted on assignment)
# Readability at range comes from the *value* contrast between garments, not from the weave: at 30 m a bot is ~60 px
# tall and every garment mips to its mean colour. The previous palettes put vest, trousers and pouches within ~0.03 of
# each other (all near-black on 'mask'/'wrap', all mid-khaki on the sand kits), so past 15 m each bot read as a
# single-colour clay mannequin. Now every kit alternates light / dark down the body (shirt vs vest, vest vs pouches,
# trousers vs boots) the way the CS2 T models do: a near-black plate carrier over a lighter shirt, pouches a step
# lighter than the carrier, trousers a different value from both, dark boots and gloves, a distinct head colour.
PALETTE = {
    # Phoenix: olive shirt, black carrier + balaclava, khaki-grey trousers, olive-tan pouches
    'mask':        {'shirt': (0.34, 0.36, 0.20), 'pants': (0.40, 0.36, 0.27), 'boot': (0.09, 0.07, 0.05),
                    'glove': (0.08, 0.08, 0.08), 'mask': (0.06, 0.06, 0.07), 'skin': (0.46, 0.31, 0.21),
                    'vest': (0.07, 0.07, 0.075), 'pouch': (0.30, 0.27, 0.17)},
    # Elite Crew: tan shirt, rolled sleeves, ball cap; charcoal carrier, dark olive trousers, brown pouches
    'mask_cap':    {'shirt': (0.60, 0.49, 0.29), 'pants': (0.17, 0.18, 0.14), 'boot': (0.11, 0.08, 0.06),
                    'glove': (0.15, 0.12, 0.09), 'mask': (0.20, 0.18, 0.13), 'skin': (0.43, 0.27, 0.17),
                    'vest': (0.09, 0.09, 0.095), 'pouch': (0.36, 0.30, 0.20)},
    # charcoal shirt + tan shemagh; black carrier, desert-khaki trousers, grey-olive pouches
    'wrap':        {'shirt': (0.16, 0.16, 0.17), 'pants': (0.44, 0.39, 0.27), 'boot': (0.10, 0.08, 0.06),
                    'glove': (0.09, 0.09, 0.09), 'mask': (0.62, 0.54, 0.37), 'skin': (0.44, 0.30, 0.20),
                    'vest': (0.07, 0.07, 0.075), 'pouch': (0.26, 0.26, 0.20)},
    # sand shirt + olive shemagh and goggles; dark olive carrier + trousers, tan pouches
    'wrap_goggles': {'shirt': (0.52, 0.46, 0.31), 'pants': (0.16, 0.17, 0.13), 'boot': (0.12, 0.10, 0.07),
                     'glove': (0.14, 0.13, 0.10), 'mask': (0.31, 0.33, 0.20), 'skin': (0.42, 0.28, 0.19),
                     'vest': (0.10, 0.11, 0.085), 'pouch': (0.33, 0.30, 0.21)},
}
ROLLED = {'mask_cap'}          # sleeves rolled to the elbow: bare forearms + a cuff roll


def dress(body, arm):
    """Push the naked body out into clothing: per-region offsets along the normal + a bit of fabric slack."""
    NECK_Z = (bone_world(arm, 'LeftShoulder').z - 0.02, bone_world(arm, 'Head').z)
    SHOULDER = (bone_world(arm, 'LeftShoulder').z - 0.055, bone_world(arm, 'LeftShoulder').z + 0.075)
    DELTOID = (bone_world(arm, 'LeftArm').z - 0.115, bone_world(arm, 'LeftArm').z + 0.030)
    me = body.data
    me.calc_normals_split() if hasattr(me, 'calc_normals_split') else None
    regions = dominant_regions(body)
    off = [GARMENT[r][0] for r in regions]
    wide = [GARMENT[r][1] for r in regions]
    off = smooth_scalar(body, off, iters=5)
    wide = smooth_scalar(body, wide, iters=5)
    nrm = [v.normal.copy() for v in me.vertices]
    # trousers blouse over the boot: a little extra just above the ankle
    ankle = min(v.co.z for v in me.vertices) + 0.16
    import random
    random.seed(3)
    for i, v in enumerate(me.vertices):
        n = nrm[i]
        o = off[i]
        if regions[i] in ('thigh', 'shin') and abs(v.co.z - ankle) < 0.07:
            o += 0.016 * (1 - abs(v.co.z - ankle) / 0.07)
        # low-frequency slack so cloth doesn't read as shrink-wrap
        s = math.sin(v.co.z * 26 + v.co.x * 9) * math.cos(v.co.y * 17 + v.co.z * 7)
        if regions[i] in ('torso', 'arm', 'thigh', 'shin', 'pelvis'):
            o += s * 0.0045
        if regions[i] in ('torso', 'neck') and v.co.z > NECK_Z[0]:   # keep the collar slim so the head isn't sunk
            o *= max(0.15, 1 - (v.co.z - NECK_Z[0]) / (NECK_Z[1] - NECK_Z[0]))
        v.co = v.co + n * o
        # squarer trapezius: lift the shoulder shelf between the neck and the deltoid, and put some mass back on
        # the deltoid itself -- without the second part the shelf alone still reads as a cone running to a thin arm.
        if regions[i] in ('torso', 'arm') and SHOULDER[0] < v.co.z < SHOULDER[1]:
            ax = smoothstep(min(1.0, abs(v.co.x) / 0.19))
            v.co.z += 0.042 * ax * smoothstep(1 - (v.co.z - SHOULDER[0]) / (SHOULDER[1] - SHOULDER[0]))
        if regions[i] == 'arm' and v.co.z > DELTOID[0]:
            t = smoothstep(1 - (DELTOID[1] - v.co.z) / (DELTOID[1] - DELTOID[0]))
            v.co.x += math.copysign(0.020 * t, v.co.x)
            v.co.y += n.y * 0.014 * t
        if wide[i] > 0:                                    # extra girth sideways only: cargo legs / boot bulk
            v.co.x += n.x * wide[i]; v.co.y += n.y * wide[i] * 0.6
    me.update()
    return regions


def carve_neck(body, regions, arm):
    """The target rig has ~6 cm between the shoulder line and the head bone, so the dressed trapezius swallows the
    head. Taper the top of the torso down to a real neck column and trim the (MakeHuman-large) skull a touch."""
    shz = bone_world(arm, 'LeftShoulder').z
    nk = bone_world(arm, 'Neck')
    hd = bone_world(arm, 'Head')
    lo, hi = shz - 0.030, nk.z + 0.045
    for i, r in enumerate(regions):
        v = body.data.vertices[i]
        # --- neck column: taper the trapezius into a ~7 cm-radius column, then flare back out for the collar
        if r in ('torso', 'neck') and lo < v.co.z < hi + 0.10:
            dx, dy = v.co.x - nk.x, v.co.y - nk.y
            rad = math.hypot(dx, dy)
            if 1e-5 < rad < 0.140:
                t = smoothstep((v.co.z - lo) / (hi - lo))
                k = (1 - t) + t * min(1.0, 0.068 / rad)
                v.co.x = nk.x + dx * k; v.co.y = nk.y + dy * k
        # --- shirt collar: a ring of extra thickness around the base of the neck column
        if r in ('torso', 'neck'):
            dx, dy = v.co.x - nk.x, v.co.y - nk.y
            rad = math.hypot(dx, dy)
            d = abs(v.co.z - (nk.z - 0.020))
            if rad < 0.120 and d < 0.060:
                k = (0.015 * smoothstep(1 - d / 0.060)) / max(rad, 1e-4)
                v.co.x += dx * k; v.co.y += dy * k
        # --- MakeHuman's skull is ~30 % too big for this body once the neck is real
        if r == 'head':
            v.co = hd + (v.co - hd) * 0.88


def relax(body, regions, arm):
    """Smooth only where the reshaping above stacked several displacements: neck, collar, shoulder shelf."""
    lo = bone_world(arm, 'LeftShoulder').z - 0.09
    g = body.vertex_groups.new(name='relax')
    for i, r in enumerate(regions):
        if r in ('torso', 'neck', 'arm') and body.data.vertices[i].co.z > lo:
            g.add([i], 1.0, 'REPLACE')
    activate(body)
    m = body.modifiers.new('sm', 'SMOOTH')
    m.factor = 0.6; m.iterations = 4; m.vertex_group = 'relax'
    bpy.ops.object.modifier_apply(modifier='sm')
    body.vertex_groups.remove(body.vertex_groups['relax'])


def smoothstep(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def tuck_ears(body, regions):
    """The base mesh's ears poke straight through the head covering, so pull them back to the skull line."""
    head = [i for i, r in enumerate(regions) if r == 'head']
    if not head: return
    xs = sorted(abs(body.data.vertices[i].co.x) for i in head)
    lim = xs[int(len(xs) * 0.90)]
    for i in head:
        v = body.data.vertices[i]
        a = abs(v.co.x)
        if a > lim:
            v.co.x = math.copysign(lim + (a - lim) * 0.25, v.co.x)


def region_colors(body, regions, palette, arm, variant=''):
    """Base cloth colour per region plus the painted-on details: belt, knee patches, boot shafts, cuffs."""
    ca = body.data.color_attributes.get('Col') or body.data.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    hips = bone_world(arm, 'Hips').z
    knee = bone_world(arm, 'LeftLeg').z
    ankle = bone_world(arm, 'LeftFoot').z
    wrist = bone_world(arm, 'LeftHand')
    belt = srgb(tuple(c * 0.55 for c in palette['pants']))
    kneep = srgb(tuple(c * 0.78 for c in palette['pants']))
    shaft = srgb(tuple(c * 1.25 for c in palette['boot']))
    cuff = srgb(tuple(c * 0.8 for c in palette['shirt']))
    # the glove must stop at the wrist: anything on the elbow side of it is still sleeve
    wrists = [(bone_world(arm, s + 'Hand'), (bone_world(arm, s + 'Hand') - bone_world(arm, s + 'ForeArm')).normalized())
              for s in ('Left', 'Right')]
    rolled = variant in ROLLED
    elbows = [(bone_world(arm, s + 'ForeArm'),
               (bone_world(arm, s + 'Hand') - bone_world(arm, s + 'ForeArm')).normalized()) for s in ('Left', 'Right')]
    keys = []
    for i, r in enumerate(regions):
        co = body.data.vertices[i].co
        key = GARMENT[r][2]
        # the shirt is worn over the trousers: everything above the waistline is shirt, below it is pants
        if key == 'pants' and co.z > hips + 0.020: key = 'shirt'
        elif r == 'torso' and co.z < hips + 0.020: key = 'pants'
        elif r == 'hand':
            w, d = min(wrists, key=lambda t: (co - t[0]).length)
            if (co - w).dot(d) < -0.012: key = 'shirt'
        if rolled and r == 'arm':
            e, d = min(elbows, key=lambda t: (co - t[0]).length)
            along = (co - e).dot(d)                    # + is the wrist side of the elbow
            if along > 0.02: key = 'skin'
            elif along > -0.03: key = 'gear'           # the rolled-up cuff itself
        c = srgb(palette.get(key, (0.05, 0.05, 0.055)))
        if hips - 0.055 < co.z < hips + 0.020 and r in ('pelvis', 'thigh', 'torso'):
            c = belt; key = 'gear'
        elif r in ('thigh', 'shin') and abs(co.z - knee) < 0.10 and co.y > 0:
            c = kneep
        elif r == 'foot' and co.z > ankle - 0.02:
            c = shaft
        elif r == 'arm' and (co - wrist).length < 0.10:
            c = cuff
        ca.data[i].color = (*c, 1.0)
        keys.append(key)
    return keys


# ---------------------------------------------------------------- 5. gear props
def dup_region(body, name, pred, offset, thickness, smooth=True):
    """Copy the part of the body where pred(vertex) holds and turn it into a shell (offset + solidify)."""
    o = body.copy(); o.data = body.data.copy(); o.name = name
    bpy.context.collection.objects.link(o)
    bm = bmesh.new(); bm.from_mesh(o.data); bm.verts.ensure_lookup_table()
    kill = [v for v in bm.verts if not pred(v.co, v.index)]
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    if not len(bm.verts):
        bm.free(); bpy.data.objects.remove(o, do_unlink=True); return None
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * offset
    bm.to_mesh(o.data); bm.free()
    activate(o)
    m = o.modifiers.new('sol', 'SOLIDIFY'); m.thickness = thickness; m.offset = 1.0
    bpy.ops.object.modifier_apply(modifier='sol')
    if smooth:
        m = o.modifiers.new('sm', 'SMOOTH'); m.factor = 0.5; m.iterations = 2
        bpy.ops.object.modifier_apply(modifier='sm')
    for p in o.data.polygons: p.use_smooth = True
    return o


def prim_box(name, c, s, bevel=0.008, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=c)
    o = bpy.context.active_object; o.name = name; o.scale = s
    o.rotation_euler = Euler([math.radians(a) for a in rot])
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if bevel > 0:
        m = o.modifiers.new('bv', 'BEVEL'); m.width = bevel; m.segments = 2; m.limit_method = 'ANGLE'
        activate(o); bpy.ops.object.modifier_apply(modifier='bv')
    for p in o.data.polygons: p.use_smooth = True
    return o


def prim_sphere(name, c, r, s=(1, 1, 1), seg=16, ring=10):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, segments=seg, ring_count=ring, location=c)
    o = bpy.context.active_object; o.name = name; o.scale = s
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for p in o.data.polygons: p.use_smooth = True
    return o


def prim_torus(name, c, R, r, s=(1, 1, 1), rot=(0, 0, 0), maj=18, mino=7):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=maj, minor_segments=mino, location=c)
    o = bpy.context.active_object; o.name = name; o.scale = s
    o.rotation_euler = Euler([math.radians(a) for a in rot])
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    for p in o.data.polygons: p.use_smooth = True
    return o


def torso_front(body, z, x=0.0, back=False):
    """y of the body surface at (x, z) - used to sit the carrier and pouches on the chest instead of inside it."""
    ys = [v.co.y for v in body.data.vertices if abs(v.co.z - z) < 0.05 and abs(v.co.x - x) < 0.07]
    if not ys: return -0.16 if back else 0.16
    return min(ys) if back else max(ys)


def build_gear(body, arm, variant, regions):
    """Plate carrier, pouches, belt, straps and head gear. Returns [(object, albedo key)]."""
    zs = [v.co.z for v in body.data.vertices]
    top = max(zs)
    hips = bone_world(arm, 'Hips').z
    neck = bone_world(arm, 'Neck').z
    head = bone_world(arm, 'Head').z
    rset = {i: regions[i] for i in range(len(regions))}
    out = []

    # --- plate carrier: the chest slab of the body, pushed out and solidified
    lo, hi = hips + 0.170, neck - 0.030
    vest = dup_region(body, 'vest', lambda co, i: rset[i] in ('torso', 'pelvis') and lo < co.z < hi and abs(co.x) < 0.152,
                      0.014, 0.015)
    if vest:
        activate(vest)
        d = vest.modifiers.new('dec', 'DECIMATE'); d.ratio = 0.45; d.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier='dec')
        out.append((vest, 'vest'))

    # --- shoulder straps over the trapezius
    for sgn in (-1, 1):
        s = prim_box(f'strap{sgn}', (sgn * 0.098, 0.005, neck - 0.022), (0.080, 0.27, 0.038), bevel=0.010)
        out.append((s, 'vest'))

    # --- three rifle-mag pouches across the lower front of the carrier, placed off the vest's real bounds
    vb = [vest.matrix_world @ Vector(c) for c in vest.bound_box] if vest else None
    vlo = min(v.z for v in vb) if vb else hips + 0.17
    vhi = max(v.z for v in vb) if vb else neck - 0.03
    vfy = max(v.y for v in vb) if vb else torso_front(body, hips + 0.25, 0.0)
    zp = vlo + (vhi - vlo) * 0.30
    for k, dx in enumerate((-0.108, 0.0, 0.108)):
        yf = max(vfy, torso_front(body, zp, dx)) + 0.028
        p = prim_box(f'pouch{k}', (dx, yf, zp), (0.084, 0.056, 0.120), bevel=0.014, rot=(4, 0, 0))
        out.append((p, 'pouch'))
    # a utility pouch on the back
    yb = torso_front(body, zp + 0.05, 0.0, back=True) - 0.055
    out.append((prim_box('pouch_b', (0.0, yb, zp + 0.06), (0.18, 0.065, 0.13), bevel=0.012), 'pouch'))
    # radio on the left shoulder strap
    out.append((prim_box('radio', (-0.112, 0.03, neck + 0.010), (0.052, 0.085, 0.060), bevel=0.008), 'pouch'))

    # --- belt hardware: the strap itself is painted on, this is the buckle and two hip pouches
    zb = hips - 0.020
    out.append((prim_box('buckle', (0, torso_front(body, zb, 0.0) + 0.014, zb), (0.058, 0.030, 0.048), bevel=0.008), 'gear'))
    for sgn in (-1, 1):
        out.append((prim_box(f'hip{sgn}', (sgn * 0.150, torso_front(body, zb, sgn * 0.15) - 0.030, zb - 0.020),
                             (0.060, 0.085, 0.105), bevel=0.012), 'pouch'))

    # --- boot soles
    for sgn in (-1, 1):
        f = bone_world(arm, ('Left' if sgn < 0 else 'Right') + 'Foot')
        t = bone_world(arm, ('Left' if sgn < 0 else 'Right') + 'ToeBase')
        c = ((f.x + t.x) / 2, (f.y + t.y) / 2 + 0.035, 0.017)
        out.append((prim_box(f'sole{sgn}', c, (0.115, 0.29, 0.034), bevel=0.010), 'boot'))

    # --- head gear, sized off the actual skull rather than fixed numbers (the head is scaled during reshaping)
    hv = [body.data.vertices[i].co for i in range(len(regions)) if regions[i] == 'head' and body.data.vertices[i].co.z > head]
    hw = max(abs(c.x) for c in hv)                     # skull half-width
    hf = max(c.y for c in hv)                          # face plane
    hb = min(c.y for c in hv)                          # back of the skull
    hc = Vector((0, (hf + hb) * 0.5, head + (top - head) * 0.55))             # skull centre
    dep = (hf - hb) * 0.5 / (hw + 0.010)               # a head is ~25 % deeper than it is wide
    if 'cap' in variant:
        out.append((prim_sphere('cap', (0, hc.y, hc.z + 0.018), hw + 0.010, s=(1.0, dep, 0.80)), 'mask'))
        # the brim starts at the face and runs ~7 cm forward, tilted down, so the cap reads in profile
        out.append((prim_box('brim', (0, hf + 0.030, hc.z - 0.006), (2 * hw + 0.014, 0.085, 0.015), bevel=0.006, rot=(-13, 0, 0)), 'mask'))
        out.append((prim_box('cap_band', (0, hc.y, hc.z - 0.026), (2 * hw + 0.012, hf - hb + 0.018, 0.028), bevel=0.012), 'mask'))
    if 'wrap' in variant:
        # shemagh: cloth over the whole skull, a loose collar, and a tail down the back
        out.append((prim_sphere('wrap_crown', (0, hc.y, hc.z + 0.012), hw + 0.012, s=(1.0, dep, 0.88)), 'mask'))
        out.append((prim_torus('wrap_neck', (0, bone_world(arm, 'Neck').y, neck + 0.030), 0.076, 0.030, s=(1.15, 1.2, 0.9)), 'mask'))
        out.append((prim_box('wrap_tail', (0, bone_world(arm, 'Neck').y - 0.088, neck - 0.045), (0.17, 0.044, 0.19), bevel=0.014, rot=(12, 0, 0)), 'mask'))
    if 'goggles' in variant:
        out.append((prim_box('gg', (0, hf - 0.004, hc.z + 0.016), (2 * hw - 0.016, 0.046, 0.046), bevel=0.012), 'gear'))
        out.append((prim_torus('gg_strap', (0, hc.y, hc.z + 0.016), hw + 0.008, 0.009, s=(1.0, dep, 1.0)), 'gear'))
    return out


def build_kd(src):
    from mathutils import kdtree
    kd = kdtree.KDTree(len(src.data.vertices))
    mw = src.matrix_world
    for i, v in enumerate(src.data.vertices): kd.insert(mw @ v.co, i)
    kd.balance()
    names = {g.index: g.name for g in src.vertex_groups}
    wts = [[(names[g.group], g.weight) for g in v.groups if g.weight > 0.01] for v in src.data.vertices]
    return kd, wts


def transfer_weights(dst, kd, wts, k=3):
    """Skin a gear piece from the body: inverse-distance blend of the k nearest body vertices' weights.

    The primitives are built with `location=` on the operator, so their vertices sit around the object origin;
    the lookup has to happen in world space or every prop ends up weighted to whatever bone is near (0,0,0).
    """
    dst.vertex_groups.clear()
    groups = {}
    mw = dst.matrix_world
    for vi, v in enumerate(dst.data.vertices):
        near = kd.find_n(mw @ v.co, k)
        acc, tot = {}, 0.0
        for co, idx, dist in near:
            iw = 1.0 / (dist * dist + 1e-4)
            tot += iw
            for n, w in wts[idx]: acc[n] = acc.get(n, 0.0) + w * iw
        if not tot: continue
        for n, w in acc.items():
            g = groups.get(n) or groups.setdefault(n, dst.vertex_groups.new(name=n))
            g.add([vi], w / tot, 'REPLACE')


# ---------------------------------------------------------------- 6. assemble + export
VARIANTS = ['mask', 'mask_cap', 'wrap', 'wrap_goggles']
MAT_KEYS = ['shirt', 'pants', 'boot', 'glove', 'mask', 'skin', 'vest', 'pouch', 'gear']


# decimation weight, 1.0 = keep. Hands are pinned at 1.0: the gloved fingers wrapping the AK grip and handguard
# are the closest thing to the camera on a dead or reloading bot, and MakeHuman gives them for free.
DENSITY = {'head': 0.62, 'neck': 0.85, 'torso': 1.00, 'arm': 0.85, 'hand': 1.00,
           'pelvis': 0.95, 'thigh': 0.85, 'shin': 0.75, 'foot': 0.28}


def _collapse(o, ratio, weights=None):
    activate(o)
    m = o.modifiers.new('dec', 'DECIMATE')
    m.ratio = ratio; m.use_collapse_triangulate = True
    if weights:
        g = o.vertex_groups.new(name='dens')
        for i, w in enumerate(weights): g.add([i], w, 'REPLACE')
        m.vertex_group = 'dens'; m.vertex_group_factor = 1.0; m.invert_vertex_group = True
    bpy.ops.object.modifier_apply(modifier='dec')
    if weights: o.vertex_groups.remove(o.vertex_groups['dens'])


def decimate(o, ratio, regions, hand_tris=1400):
    """Collapse, spending the budget on the torso and legs rather than MakeHuman's very dense face and feet.

    The hands are split off first: a graded vertex group saturates well below the density the gloved fingers
    need (they are the closest geometry to the camera on a reloading or dead bot), so they get their own pass.
    """
    # --- split the hands out at the wrist
    for i, r in enumerate(regions):
        o.data.vertices[i].select = (r == 'hand')
    activate(o)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='VERT')
    bpy.ops.mesh.separate(type='SELECTED')
    bpy.ops.object.mode_set(mode='OBJECT')
    hands = next((x for x in bpy.context.selected_objects if x is not o), None)

    if hands:
        src = sum(len(p.vertices) - 2 for p in hands.data.polygons)
        _collapse(hands, min(1.0, hand_tris / max(1, src)))
        log('hands', src, '->', sum(len(p.vertices) - 2 for p in hands.data.polygons), 'tris')

    body_regions = dominant_regions(o)
    _collapse(o, ratio, [DENSITY[r] for r in body_regions])

    if hands:
        deselect(); o.select_set(True); hands.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.join()
        activate(o)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.remove_doubles(threshold=0.0035)      # weld the wrist seam back together
        bpy.ops.object.mode_set(mode='OBJECT')
    after = dominant_regions(o)
    per = {}
    for p in o.data.polygons:
        r = after[p.vertices[0]]
        per[r] = per.get(r, 0) + len(p.vertices) - 2
    log('tris per region', {k: per.get(k, 0) for k in sorted(per)})
    return len(o.data.polygons)


def face_colors(body, regions, palette, variant, keys):
    """Head colouring: balaclava with an eye slot, or a shemagh with the face showing."""
    ca = body.data.color_attributes['Col']
    zs = [v.co.z for v in body.data.vertices]
    top = max(zs)
    hy = max(v.co.y for v in body.data.vertices if v.co.z > top - 0.16)
    for i, v in enumerate(body.data.vertices):
        if regions[i] != 'head': continue
        front = v.co.y > hy - 0.075
        eye = (top - 0.115) < v.co.z < (top - 0.072)
        if ('wrap' in variant or 'cap' in variant) and front and v.co.z < top - 0.062:
            ca.data[i].color = (*srgb(palette['skin']), 1); keys[i] = 'skin'
        elif eye and front:
            ca.data[i].color = (*srgb((0.05, 0.045, 0.045)), 1); keys[i] = 'gear'


def bake_ao(objs, strength=0.42):
    """Cheap contact shading straight into the vertex colours (no texture, no UVs)."""
    sc = bpy.context.scene
    prev = sc.render.engine
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 16
    sc.cycles.use_denoising = False
    sc.render.bake.target = 'VERTEX_COLORS'
    for o in objs:
        if not o.data.color_attributes: continue
        o.data.color_attributes.active_color_index = o.data.color_attributes.find('Col')
        o.data.attributes.active_color_index = o.data.color_attributes.find('Col')
    deselect()
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    try:
        bpy.ops.object.bake(type='AO')
    except Exception as e:
        log('AO bake failed', e)
    # raw AO crushes the albedo (mean ~0.63 and black in the creases); COLOR_0 only needs to hint at contact
    for o in objs:
        ca = o.data.color_attributes.get('Col')
        if not ca: continue
        for d in ca.data:
            v = 1.0 - strength * (1.0 - d.color[0])
            d.color = (v, v, v, 1.0)
    sc.render.engine = prev


def make_material(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes.get('Principled BSDF')
    for n in list(nt.nodes):
        if n.type == 'VERTEX_COLOR' or n.name == 'vc': nt.nodes.remove(n)
    vc = nt.nodes.new('ShaderNodeVertexColor'); vc.name = 'vc'; vc.layer_name = 'Col'
    nt.links.new(vc.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = 0.88
    b.inputs['Metallic'].default_value = 0.0
    if 'Specular IOR Level' in b.inputs: b.inputs['Specular IOR Level'].default_value = 0.32
    return m


# ---------------------------------------------------------------- 6. procedural cloth -> baked atlas
# One Blender material per garment key while baking, so the boundaries between shirt / trousers / nylon stay
# crisp in the atlas. They all collapse into a single `bot_cloth` material afterwards.
# key -> (weave scale, weave depth, panel-line period in cm (0 = none), roughness, bump strength)
# Weave scales are deliberately coarse: the atlas gives a torso island roughly 400 px across, so anything
# finer than ~4 texels per thread mips away to flat colour by 3 m and the cloth reads as painted plastic.
SURFACE = {
    'shirt': (190.0, 0.42, 0.0, 0.88, 0.0012),      # ripstop grid
    'pants': (150.0, 0.46, 0.0, 0.90, 0.0016),      # heavier cargo cloth
    'vest':  (90.0, 0.34, 3.6, 0.60, 0.0022),       # nylon + MOLLE rows
    'pouch': (95.0, 0.34, 0.0, 0.62, 0.0018),
    'boot':  (240.0, 0.22, 0.0, 0.50, 0.0010),      # leather grain
    'glove': (220.0, 0.36, 0.0, 0.55, 0.0010),
    'mask':  (130.0, 0.62, 0.0, 0.86, 0.0018),      # knit rib
    'skin':  (700.0, 0.08, 0.0, 0.62, 0.0003),
    'gear':  (320.0, 0.10, 0.0, 0.45, 0.0005),
}


def landmarks(arm):
    """Object-space (= world, the meshes sit at the origin) rest-pose reference points for the garment detail."""
    g = lambda n: bone_world(arm, n)
    lm = {'arm_x': abs(g('LeftArm').x), 'elbow_x': abs(g('LeftForeArm').x), 'wrist_x': abs(g('LeftHand').x),
          'chest_z': g('Spine2').z, 'hip_z': g('Hips').z, 'knee_z': g('LeftLeg').z, 'ankle_z': g('LeftFoot').z,
          'shoulder_z': g('LeftShoulder').z}
    log('landmarks', {k: round(v, 3) for k, v in lm.items()})
    for n in ('LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand'):
        log('  bone', n, [round(c, 3) for c in g(n)])
    return lm


def bake_material(key, base_rgb, lm):
    """A procedural cloth/nylon/leather surface: fine weave in UV space, dirt and panel lines in object space."""
    scale, depth, period, rough, bump = SURFACE[key]
    m = bpy.data.materials.new('bake_' + key)
    m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    tc = nt.nodes.new('ShaderNodeTexCoord')

    def nd(t, **kw):
        n = nt.nodes.new(t)
        for k, v in kw.items():
            if '.' in k:
                a, b = k.split('.'); getattr(n, a)[b].default_value = v
            else: setattr(n, k, v)
        return n

    def math(op, a, b=None, c=None):
        n = nt.nodes.new('ShaderNodeMath'); n.operation = op
        for i, s in enumerate((a, b, c)):
            if s is None: continue
            if hasattr(s, 'bl_idname') or hasattr(s, 'node'): nt.links.new(s, n.inputs[i])
            else: n.inputs[i].default_value = s
        return n.outputs[0]

    # --- weave: two crossed wave bands in UV space make a ripstop / knit grid
    wx = nd('ShaderNodeTexWave', bands_direction='X', wave_profile='SIN')
    wy = nd('ShaderNodeTexWave', bands_direction='Y', wave_profile='SIN')
    for w in (wx, wy):
        w.inputs['Scale'].default_value = scale
        w.inputs['Distortion'].default_value = 1.5
        nt.links.new(tc.outputs['UV'], w.inputs['Vector'])
    grid = math('MAXIMUM', wx.outputs['Fac'], wy.outputs['Fac'])
    # fibre noise on top so the weave isn't a perfect lattice
    fib = nd('ShaderNodeTexNoise'); fib.inputs['Scale'].default_value = scale * 3.5
    fib.inputs['Detail'].default_value = 2.0
    nt.links.new(tc.outputs['UV'], fib.inputs['Vector'])
    surf = math('MULTIPLY_ADD', grid, depth, math('MULTIPLY', fib.outputs['Fac'], 0.35))

    # --- panel lines (MOLLE rows, cargo-pocket seams, boot welts) in object space so they stay level
    if period > 0:
        pw = nd('ShaderNodeTexWave', bands_direction='Z', wave_profile='SAW')
        pw.inputs['Scale'].default_value = 100.0 / period
        pw.inputs['Distortion'].default_value = 0.0
        nt.links.new(tc.outputs['Object'], pw.inputs['Vector'])
        line = nd('ShaderNodeValToRGB')
        line.color_ramp.elements[0].position = 0.86
        line.color_ramp.elements[1].position = 0.96
        nt.links.new(pw.outputs['Fac'], line.inputs['Fac'])
        surf = math('ADD', surf, math('MULTIPLY', line.outputs['Color'], -0.9))

    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(tc.outputs['Object'], sep.inputs[0])
    clamp01 = lambda s: math('MAXIMUM', math('MINIMUM', s, 1.0), 0.0)

    def slab(chan, lo, hi):
        """1 inside [lo, hi] on an object-space axis, 0 outside, with a ~4 mm soft edge."""
        return math('MULTIPLY', clamp01(math('MULTIPLY', math('SUBTRACT', chan, lo), 250.0)),
                    clamp01(math('MULTIPLY', math('SUBTRACT', hi, chan), 250.0)))

    absx = math('ABSOLUTE', sep.outputs['X'])
    front = clamp01(math('MULTIPLY', sep.outputs['Y'], 40.0))
    zc = sep.outputs['Z']

    def ring(lo, hi, chan=None):
        return slab(chan or absx, lo, hi)

    def cut(mask, depth_):                      # a recessed seam / stitch line
        return math('ADD', surf, math('MULTIPLY', mask, depth_))

    # --- shirt: chest pocket flaps, button placket, armhole + cuff seams, shoulder yoke
    if key == 'shirt':
        flap = math('MULTIPLY', front, math('MULTIPLY', slab(absx, 0.045, 0.125),
                                            slab(zc, lm['chest_z'] - 0.035, lm['chest_z'] + 0.045)))
        plac = math('MULTIPLY', front, math('MULTIPLY', slab(absx, 0.0, 0.016),
                                            slab(zc, lm['hip_z'] + 0.10, lm['chest_z'] + 0.14)))
        surf = math('ADD', surf, math('MULTIPLY', math('MAXIMUM', flap, plac), 0.95))
        # seams: armhole where the sleeve meets the body, and a cuff just short of the wrist
        seam = math('MAXIMUM', ring(lm['arm_x'] + 0.012, lm['arm_x'] + 0.030),
                    ring(lm['wrist_x'] - 0.055, lm['wrist_x'] - 0.035))
        yoke = math('MULTIPLY', slab(absx, 0.0, lm['arm_x']), slab(zc, lm['shoulder_z'] - 0.010, lm['shoulder_z'] + 0.010))
        surf = cut(math('MAXIMUM', seam, yoke), -1.05)

    # --- trousers: cargo pockets on the outer thigh, a waistband and a knee seam
    if key == 'pants':
        z1 = lm['hip_z'] - 0.13
        z0 = z1 - 0.19
        outer = math('MULTIPLY', slab(absx, 0.055, 0.170), slab(zc, z0, z1))
        inner = math('MULTIPLY', slab(absx, 0.068, 0.157), slab(zc, z0 + 0.013, z1 - 0.013))
        surf = cut(clamp01(math('SUBTRACT', outer, inner)), -1.15)
        band = slab(zc, lm['hip_z'] + 0.035, lm['hip_z'] + 0.075)
        surf = math('ADD', surf, math('MULTIPLY', band, 0.6))
        surf = cut(slab(zc, lm['knee_z'] + 0.055, lm['knee_z'] + 0.072), -0.7)

    # --- boots: a lace ladder up the front of the ankle
    if key == 'boot':
        lw = nd('ShaderNodeTexWave', bands_direction='Z', wave_profile='SIN')
        lw.inputs['Scale'].default_value = 100.0 / 1.7
        lw.inputs['Distortion'].default_value = 0.0
        nt.links.new(tc.outputs['Object'], lw.inputs['Vector'])
        laces = math('MULTIPLY', math('MULTIPLY', front, slab(zc, lm['ankle_z'] - 0.02, lm['ankle_z'] + 0.13)),
                     math('MULTIPLY', lw.outputs['Fac'], 1.4))
        surf = math('ADD', surf, laces)

    # --- large-scale dirt: dust settles on the shoulders and cakes the lower legs
    grime = nd('ShaderNodeTexNoise')
    grime.inputs['Scale'].default_value = 7.0; grime.inputs['Detail'].default_value = 4.0
    nt.links.new(tc.outputs['Object'], grime.inputs['Vector'])
    lowz = math('SMOOTH_MIN', math('MULTIPLY', math('SUBTRACT', 0.36, zc), 1.3), 0.26, 0.12)
    dirt = clamp01(math('MULTIPLY', math('ADD', math('MULTIPLY', grime.outputs['Fac'], 0.34), lowz), 0.62))
    if key == 'pants':                                  # kneeling in the dirt
        knee = math('MULTIPLY', front, slab(zc, lm['knee_z'] - 0.06, lm['knee_z'] + 0.09))
        dirt = clamp01(math('MULTIPLY_ADD', knee, 0.30, dirt))
    # sweat: a darker patch down the spine/chest centre and under the arms
    if key in ('shirt', 'mask'):
        sweat = math('MULTIPLY', slab(math('ABSOLUTE', sep.outputs['X']), 0.0, 0.075),
                     slab(sep.outputs['Z'], 1.15, 1.40))
        dirt = clamp01(math('SUBTRACT', dirt, math('MULTIPLY', sweat, 0.35)))

    # --- data pass: height in R, roughness in G. Baked as a second DIFFUSE pass, because Cycles' dedicated
    #     ROUGHNESS and NORMAL bake types silently write nothing for this material graph.
    rough_out = clamp01(math('MULTIPLY_ADD', dirt, 0.10, math('MULTIPLY_ADD', surf, -0.06, rough)))
    pack = nt.nodes.new('ShaderNodeCombineColor'); pack.name = 'datapack'
    nt.links.new(clamp01(math('MULTIPLY_ADD', surf, 0.5, 0.5)), pack.inputs[0])
    nt.links.new(rough_out, pack.inputs[1])
    pack.inputs[2].default_value = 0.0

    # --- albedo = base tint, modulated by the weave and darkened by dirt
    tint = nd('ShaderNodeRGB'); tint.outputs[0].default_value = (*srgb(base_rgb), 1.0)
    lift = math('MULTIPLY_ADD', surf, 0.19, 0.925)
    shade = nt.nodes.new('ShaderNodeMixRGB'); shade.blend_type = 'MULTIPLY'; shade.inputs['Fac'].default_value = 1.0
    nt.links.new(tint.outputs[0], shade.inputs['Color1'])
    nt.links.new(lift, shade.inputs['Color2'])
    dusty = nt.nodes.new('ShaderNodeMixRGB'); dusty.blend_type = 'MIX'
    nt.links.new(dirt, dusty.inputs['Fac'])
    nt.links.new(shade.outputs[0], dusty.inputs['Color1'])
    # dust is a *lighter, desaturated* version of the garment, not a flat sand tone: mixing pure sand into
    # near-black boots bleaches them to beige
    dusty.inputs['Color2'].default_value = (*srgb(tuple(min(1.0, 0.55 * c + 0.30) for c in base_rgb)), 1.0)
    nt.links.new(dusty.outputs[0], bsdf.inputs['Base Color'])
    dusty.name = 'albedo'
    nt.links.new(rough_out, bsdf.inputs['Roughness'])
    bsdf.inputs['Metallic'].default_value = 0.0
    if 'Specular IOR Level' in bsdf.inputs: bsdf.inputs['Specular IOR Level'].default_value = 0.30

    bmp = nt.nodes.new('ShaderNodeBump'); bmp.inputs['Strength'].default_value = 1.0
    bmp.inputs['Distance'].default_value = bump
    nt.links.new(surf, bmp.inputs['Height'])
    nt.links.new(bmp.outputs['Normal'], bsdf.inputs['Normal'])
    return m


def unwrap(o):
    activate(o)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.select_all(action='SELECT')
    # scale=True is what actually fills the atlas: without it the islands keep their world-proportional size and
    # the pack left ~9 % of the 2048 in use, i.e. the cloth weave was being baked at ~600 px of real resolution.
    try: bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=0.004)
    except TypeError:
        try: bpy.ops.uv.pack_islands(rotate=True, margin=0.004)
        except TypeError: bpy.ops.uv.pack_islands(margin=0.004)
    bpy.ops.object.mode_set(mode='OBJECT')
    log('uv coverage', round(uv_coverage(o), 3))


def uv_coverage(o):
    """Fraction of the 0-1 square the UV triangles actually occupy (shoelace over the loop triangles)."""
    me = o.data
    uv = me.uv_layers.active.data
    me.calc_loop_triangles()
    a = 0.0
    for t in me.loop_triangles:
        p = [uv[i].uv for i in t.loops]
        a += abs((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1])) * 0.5
    return a


def bake_atlas(o, variant, size=BAKE_SIZE):
    """Cycles-bake the per-key procedural materials down to one albedo / roughness / normal set."""
    sc = bpy.context.scene
    prev = sc.render.engine
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 8
    sc.cycles.use_denoising = False
    sc.cycles.bake_type = 'DIFFUSE'
    sc.render.bake.margin = 6
    sc.render.bake.use_selected_to_active = False
    sc.render.bake.use_pass_direct = False
    sc.render.bake.use_pass_indirect = False
    sc.render.bake.use_pass_color = True
    sc.render.bake.target = 'IMAGE_TEXTURES'

    def img(kind, data, sz=size):
        nm = f'bot_{variant}_{kind}'
        old = bpy.data.images.get(nm)
        if old: bpy.data.images.remove(old)
        i = bpy.data.images.new(nm, sz, sz, alpha=True, float_buffer=data)
        if data: i.colorspace_settings.name = 'Non-Color'
        return i

    # the weave normal is per-pixel noise, which WebP cannot compress - half res keeps the GLB under budget
    imgs = {'albedo': img('albedo', False), 'rough': img('rough', True), 'normal': img('normal', True, size // 2)}
    packed = img('_data', True)

    nodes = []
    for slot in o.data.materials:
        if slot is None: continue
        n = slot.node_tree.nodes.new('ShaderNodeTexImage'); n.name = 'bake_target'
        nodes.append((slot, n))

    for target, data_pass in ((imgs['albedo'], False), (packed, True)):
        for slot, n in nodes:
            nt = slot.node_tree
            bsdf = next(x for x in nt.nodes if x.type == 'BSDF_PRINCIPLED')
            src = nt.nodes['datapack' if data_pass else 'albedo']
            nt.links.new(src.outputs[0], bsdf.inputs['Base Color'])
            n.image = target
            for x in nt.nodes: x.select = False
            nt.nodes.active = n          # this clears the node's own selection, so select it afterwards
            n.select = True
        sc.cycles.bake_type = 'DIFFUSE'
        activate(o)
        bpy.ops.object.bake(type='DIFFUSE')
    for slot, n in nodes:
        slot.node_tree.nodes.remove(n)

    split_data(packed, imgs['rough'], imgs['normal'])
    bpy.data.images.remove(packed)
    sc.render.engine = prev
    return imgs


def split_data(packed, rough, normal, strength=2.4):
    """R = height, G = roughness -> a greyscale roughness map and a tangent-space normal map (UV-space Sobel)."""
    import numpy as np
    w, h = packed.size
    buf = np.empty(w * h * 4, np.float32)
    packed.pixels.foreach_get(buf)
    a = buf.reshape(h, w, 4)
    hz, rg, mask = a[:, :, 0], a[:, :, 1], (a[:, :, 3] > 0.5)

    out = np.ones((h, w, 4), np.float32)
    out[:, :, 0] = out[:, :, 1] = out[:, :, 2] = np.where(mask, rg, 0.85)
    rough.pixels.foreach_set(out.reshape(-1)); rough.update()
    log('split: rough', round(float(rg[mask].mean()) if mask.any() else -1, 3),
        'height', round(float(hz[mask].mean()) if mask.any() else -1, 3), 'cover', round(float(mask.mean()), 3))

    nw, nh = normal.size
    k = w // nw
    if k > 1:                                          # box-downsample the height first
        hz = hz.reshape(nh, k, nw, k).mean((1, 3))
        mask = mask.reshape(nh, k, nw, k).max((1, 3))
    w, h = nw, nh
    strength *= k
    dx = (np.roll(hz, -1, 1) - np.roll(hz, 1, 1)) * strength
    dy = (np.roll(hz, -1, 0) - np.roll(hz, 1, 0)) * strength
    dx = np.where(mask, dx, 0.0); dy = np.where(mask, dy, 0.0)
    inv = 1.0 / np.sqrt(dx * dx + dy * dy + 1.0)
    n = np.ones((h, w, 4), np.float32)
    n[:, :, 0] = (-dx * inv) * 0.5 + 0.5
    n[:, :, 1] = (-dy * inv) * 0.5 + 0.5
    n[:, :, 2] = inv * 0.5 + 0.5
    normal.pixels.foreach_set(n.reshape(-1)); normal.update()


def final_material(name, imgs):
    """Single glTF-friendly material: baseColor + metallicRoughness (roughness in G) + normal."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs['BSDF'], out.inputs['Surface'])
    ta = nt.nodes.new('ShaderNodeTexImage'); ta.image = imgs['albedo']
    nt.links.new(ta.outputs['Color'], b.inputs['Base Color'])
    # NB: do not re-assign colorspace_settings here - on a byte image that reloads the (empty) byte buffer
    # and throws away the pixels written by split_data.
    tr = nt.nodes.new('ShaderNodeTexImage'); tr.image = imgs['rough']
    nt.links.new(tr.outputs['Color'], b.inputs['Roughness'])
    tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = imgs['normal']
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    b.inputs['Metallic'].default_value = 0.0
    if 'Specular IOR Level' in b.inputs: b.inputs['Specular IOR Level'].default_value = 0.30
    return m


def bone_slot(act):
    """The slot holding the pose.bones curves. A glTF import also makes a slot per stray leaf-bone object,
    so pick by curve count rather than by index."""
    best, n_best = None, -1
    for slot in getattr(act, 'slots', []):
        n = 0
        for layer in getattr(act, 'layers', []):
            for strip in getattr(layer, 'strips', []):
                cb = strip.channelbag(slot)
                if cb: n += len(cb.fcurves)
        if n > n_best: best, n_best = slot, n
    return best


def push_nla(arm):
    if not arm.animation_data: arm.animation_data_create()
    for t in list(arm.animation_data.nla_tracks): arm.animation_data.nla_tracks.remove(t)
    arm.animation_data.action = None
    for name in ('Idle', 'Walk', 'Run', 'TPose'):
        act = bpy.data.actions.get(name)
        if not act: log('no action', name); continue
        f0, f1 = act.frame_range
        tr = arm.animation_data.nla_tracks.new(); tr.name = name
        st = tr.strips.new(name, int(f0), act)
        # Blender sizes a new strip from whichever slot it can auto-resolve BY OBJECT NAME. The donor's slot is
        # 'OBCharacter' and this rig is renamed, so nothing resolves and the strip is born one frame long --
        # which the exporter then bakes as a frozen 2-key pose. Bind the slot, then restate the range by hand.
        try:
            slot = bone_slot(act)
            if hasattr(st, 'action_slot') and slot: st.action_slot = slot
        except Exception as e: log('slot', e)
        for attr, v in (('action_frame_start', f0), ('action_frame_end', f1),
                        ('frame_start_ui', f0), ('frame_end_ui', f1),
                        ('frame_start', f0), ('frame_end', f1)):
            try: setattr(st, attr, v)
            except Exception: pass
        log('clip', name, 'frames %.1f-%.1f -> strip %.1f-%.1f' % (f0, f1, st.frame_start, st.frame_end))
    end = max((s.frame_end for t in arm.animation_data.nla_tracks for s in t.strips), default=1)
    bpy.context.scene.frame_start = 0
    bpy.context.scene.frame_end = int(math.ceil(end))


def build_base():
    arm = import_skeleton()
    body, mprig = make_body()
    fold_groups(body, arm)
    retarget(mprig, arm, [body], gscale=1.0)
    bpy.data.objects.remove(mprig, do_unlink=True)
    activate(body)
    for md in list(body.modifiers): body.modifiers.remove(md)
    n = decimate(body, 0.36, dominant_regions(body))
    log('body after decimate', n, 'tris')
    regions = dress(body, arm)
    carve_neck(body, regions, arm)
    tuck_ears(body, regions)
    relax(body, regions, arm)
    body.name = 'BaseBody'
    return arm, body, regions


def build_variant(arm, base, regions, variant):
    body = base.copy(); body.data = base.data.copy(); body.name = 'bot_' + variant
    bpy.context.collection.objects.link(body)
    body.hide_set(False); body.hide_render = False              # baking needs it renderable
    pal = PALETTE[variant]
    keys = region_colors(body, regions, pal, arm, variant)
    face_colors(body, regions, pal, variant, keys)
    gear = build_gear(body, arm, variant, regions)
    kd, wts = build_kd(body)

    lm = landmarks(arm)
    mats = [bake_material(k, pal.get(k, (0.05, 0.05, 0.055)), lm) for k in MAT_KEYS]

    def slots(o, per_poly):
        o.data.materials.clear()
        for m in mats: o.data.materials.append(m)
        for j, p in enumerate(o.data.polygons): p.material_index = per_poly(j, p)

    slots(body, lambda j, p: MAT_KEYS.index(keys[p.vertices[0]]))
    pieces = []
    for o, key in gear:
        transfer_weights(o, kd, wts)
        ca = o.data.color_attributes.get('Col') or o.data.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        for d in ca.data: d.color = (*srgb(pal.get(key, (0.05, 0.05, 0.055))), 1)
        slots(o, lambda j, p, k=MAT_KEYS.index(key): k)
        pieces.append(o)
    # join everything into one skinned mesh
    deselect()
    for o in [body] + pieces: o.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    unwrap(body)
    imgs = bake_atlas(body, variant)
    bake_ao([body])                                    # contact shading rides along in COLOR_0
    body.data.materials.clear()
    body.data.materials.append(final_material('bot_cloth', imgs))
    for p in body.data.polygons: p.material_index = 0
    # bind
    body.parent = arm
    body.matrix_parent_inverse = arm.matrix_world.inverted()
    md = body.modifiers.new('Armature', 'ARMATURE'); md.object = arm
    bpy.ops.object.select_all(action='DESELECT')
    activate(body)
    bpy.ops.object.vertex_group_limit_total(limit=4)
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)
    tris = sum(len(p.vertices) - 2 for p in body.data.polygons)
    return body, tris


def export(arm, mesh, variant):
    deselect()
    arm.select_set(True); mesh.select_set(True)
    bpy.context.view_layer.objects.active = arm
    path = os.path.join(OUT, f'bot_{variant}.glb')
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
              export_skins=True, export_animations=True, export_animation_mode='NLA_TRACKS',
              export_lights=False, export_cameras=False,
              export_extras=False, export_def_bones=False, export_leaf_bone=False,
              export_apply=False, export_vertex_color='ACTIVE', export_all_vertex_colors=False)
    try:
        bpy.ops.export_scene.gltf(export_image_format='WEBP', export_image_quality=82, **kw)
    except TypeError:
        bpy.ops.export_scene.gltf(export_image_format='JPEG', export_image_quality=82, **kw)
    return path, os.path.getsize(path)


def main():
    if bpy.context.mode != 'OBJECT': bpy.ops.object.mode_set(mode='OBJECT')
    for o in list(bpy.data.objects):
        if o.name not in ('RCAM', 'RSUN'): bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.actions, bpy.data.armatures):
        for x in list(coll):
            if x.users == 0: coll.remove(x)
    arm, base, regions = build_base()
    push_nla(arm)
    base.hide_set(True); base.hide_render = True
    results = []
    for v in VARIANTS:
        m, tris = build_variant(arm, base, regions, v)
        p, sz = export(arm, m, v)
        log('exported', v, tris, 'tris', round(sz / 1024), 'KB')
        results.append((v, tris, sz))
        m.hide_set(True); m.hide_render = True
    return results


if __name__ == '__main__':
    log('module loaded')
