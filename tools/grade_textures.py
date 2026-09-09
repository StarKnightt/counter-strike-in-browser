"""Color-grade cached Poly Haven diffuse maps toward the CS2 Dust2 palette.
Writes <tid>_graded.jpg next to the source; build_map.py prefers graded files."""
import os
from PIL import Image, ImageEnhance, ImageChops

TEX = os.path.join(os.path.dirname(__file__), 'texcache')

# tid: (target mean luminance 0..1, tint rgb, chroma keep 0..1, contrast)
GRADE = {
    'beige_wall_002':        (0.80, (1.00, 0.96, 0.88), 0.25, 1.05),  # main plaster -> off-white cream
    'worn_plaster_wall':     (0.76, (0.99, 0.94, 0.85), 0.30, 0.62),  # dirtier cream, contrast crushed (no camo blotches)
    'plaster_stone_wall_01': (0.72, (0.98, 0.92, 0.82), 0.35, 0.9),
    'cobblestone_04':        (0.56, (0.96, 0.92, 0.84), 0.45, 1.0),   # site slab -> light sandstone
    'concrete_pavement':     (0.72, (0.98, 0.95, 0.88), 0.35, 0.9),   # smooth cream trims
    'stone_wall_03':         (0.62, (0.97, 0.93, 0.85), 0.5, 1.0),
    'dry_ground_01':         (0.50, (0.98, 0.94, 0.86), 0.5, 0.95),   # long road: mid-tone, not clipped
    'sandy_gravel':          (0.56, (1.00, 0.94, 0.84), 0.55, 0.95),
    'weathered_planks':      (0.64, (1.00, 0.88, 0.66), 0.35, 0.8),   # sun-bleached tan crates (#C4A878-ish)
    'wood_planks_dirt':      (0.62, (1.00, 0.88, 0.68), 0.35, 0.8),
    'rough_wood':            (0.50, (1.00, 0.86, 0.68), 0.5, 0.9),
    'worn_asphalt':          (0.50, (1.00, 0.97, 0.92), 0.3, 0.62),   # long road: warm-grey dusty asphalt, speckle crushed
}

def grade(tid, mean_l, tint, chroma, contrast):
    src = os.path.join(TEX, f'{tid}_diffao.jpg')
    if not os.path.exists(src): src = os.path.join(TEX, f'{tid}_diff.jpg')
    im = Image.open(src).convert('RGB')
    L = im.convert('L')
    # normalise luminance to target mean
    hist = L.histogram(); n = sum(hist); cur = sum(i * c for i, c in enumerate(hist)) / n / 255.0
    L = L.point(lambda v: min(255, int(v * (mean_l / max(cur, 1e-3)))))
    L = ImageEnhance.Contrast(L).enhance(contrast)
    tinted = Image.merge('RGB', tuple(L.point(lambda v, k=k: min(255, int(v * k))) for k in tint))
    # keep part of the original chroma so streaks/stains stay coloured
    out = Image.blend(tinted, ImageChops.multiply(im, Image.new('RGB', im.size, tuple(int(255 * mean_l / max(cur, 1e-3) * 0.85) for _ in range(3)))), chroma)
    dst = os.path.join(TEX, f'{tid}_graded.jpg')
    out.save(dst, quality=92)
    print(tid, f'{cur:.2f} -> {mean_l:.2f}', dst)

for tid, args in GRADE.items():
    grade(tid, *args)

# worn plaster: keep only a hint of the peeling -> blend toward the smooth plaster
worn = Image.open(os.path.join(TEX, 'worn_plaster_wall_graded.jpg'))
smooth = Image.open(os.path.join(TEX, 'beige_wall_002_graded.jpg')).resize(worn.size)
Image.blend(worn, smooth, 0.62).save(os.path.join(TEX, 'worn_plaster_wall_graded.jpg'), quality=92)
print('worn_plaster_wall blended toward smooth plaster')
