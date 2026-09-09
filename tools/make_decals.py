"""Procedural, text-free decal sheets for src/level/Decals.js (run with the system Python: PIL + numpy).

    python tools/make_decals.py

Writes public/textures/decals/posters.png and graffiti.png (1024x1024, 2x2 cells, white background).
  posters  cell 0 'poster'  torn paper poster: zigzag border + eight-point star medallion
           cell 1 'sign'    rusty enamel sign: teapot pictogram in a red roundel
           cell 2 'posters' three overlapping torn strips: sun rays / numeral / emblem bars
           cell 3 'sign2'   green enamel plate: numeral 3, corner diamonds, chevrons
  graffiti cell 0 'tag'     blue spray: abstract loops, crossed arrows, drips
           cell 1 'stencil' black star-and-crescent stencil
           cell 2 'script'  red stencil frame with numeral 7 and drips
           cell 3 'marks'   small tally marks / arrow / exclamation
No letters or words anywhere (the user asked for every bit of Urdu/Arabic script to go); numerals only.
Posters are keyed from white in Decals.js (min channel >= 250 -> transparent), so poster paint stays <= 235.
The grime sheet (grime.png) is untouched: it never carried text."""
import math, os, random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'textures', 'decals')
S = 512                                   # cell size
rng = random.Random(1234)
np_rng = np.random.default_rng(1234)

def font(size, bold=True):
    for name in ('impact.ttf', 'arialbd.ttf', 'arial.ttf'):
        p = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts', name)
        if os.path.exists(p):
            try: return ImageFont.truetype(p, size)
            except Exception: pass
    return ImageFont.load_default()

def noise(size, scale, seed):
    """Smooth value noise in [0,1] at the given feature scale (pixels)."""
    r = np.random.default_rng(seed)
    small = r.random((max(2, size // scale), max(2, size // scale)))
    img = Image.fromarray((small * 255).astype(np.uint8)).resize((size, size), Image.BICUBIC)
    return np.asarray(img).astype(np.float32) / 255.0

def spray(mask, blur=1.6, grain=0.55, seed=1, halo=6):
    """Turn a hard L mask into a spray-paint mask: soft core, speckled halo, uneven coverage."""
    m = np.asarray(mask.filter(ImageFilter.GaussianBlur(blur))).astype(np.float32) / 255.0
    halo_m = np.asarray(mask.filter(ImageFilter.GaussianBlur(halo))).astype(np.float32) / 255.0
    r = np.random.default_rng(seed)
    speck = (r.random(m.shape) < halo_m * 0.35) & (r.random(m.shape) < 0.5)
    cover = 0.75 + 0.25 * noise(m.shape[0], 24, seed + 7)
    out = np.clip(m * cover + speck * (0.5 + 0.5 * r.random(m.shape)) * (1 - m), 0, 1)
    out *= 1.0 - grain * 0.5 * (r.random(m.shape) < 0.08)
    return out

def drips(draw, points, seed, n=(6, 12), length=(30, 140), width=(3, 7)):
    r = random.Random(seed)
    for _ in range(r.randint(*n)):
        x, y = r.choice(points)
        L = r.randint(*length); w = r.randint(*width)
        draw.line([(x, y), (x + r.randint(-3, 3), y + L)], fill=255, width=w)
        draw.ellipse([x - w, y + L - w, x + w, y + L + w], fill=255)

def paint(canvas, mask, color):
    """Composite a solid colour through a float mask [0,1] onto the RGB canvas (numpy)."""
    a = mask[..., None]
    canvas[:] = canvas * (1 - a) + np.array(color, dtype=np.float32)[None, None, :] * a

def torn_polygon(x0, y0, x1, y1, seed, rough=14, step=22):
    """Rectangle outline with a ragged, torn-paper edge."""
    r = random.Random(seed)
    pts = []
    def edge(ax, ay, bx, by):
        n = max(2, int(math.hypot(bx - ax, by - ay) / step))
        for i in range(n):
            t = i / n
            px, py = ax + (bx - ax) * t, ay + (by - ay) * t
            nx, ny = -(by - ay), (bx - ax); L = math.hypot(nx, ny); nx /= L; ny /= L
            d = r.uniform(-rough, rough * 0.3)
            pts.append((px + nx * d, py + ny * d))
    edge(x0, y0, x1, y0); edge(x1, y0, x1, y1); edge(x1, y1, x0, y1); edge(x0, y1, x0, y0)
    return pts

def paper(cell, poly, base, seed):
    """Cream paper with fibre noise + stains inside `poly`; returns the paper alpha mask (np float)."""
    m = Image.new('L', (S, S), 0); ImageDraw.Draw(m).polygon(poly, fill=255)
    a = np.asarray(m).astype(np.float32) / 255.0
    fib = noise(S, 6, seed) * 0.12 + noise(S, 40, seed + 1) * 0.18
    stain = np.clip(noise(S, 90, seed + 2) - 0.55, 0, 1) * 1.6
    col = np.array(base, dtype=np.float32)[None, None, :] * (1 - fib)[..., None]
    col = col * (1 - stain[..., None] * np.array([0.25, 0.35, 0.5])[None, None, :])
    cell[:] = cell * (1 - a[..., None]) + col * a[..., None]
    # darker torn edge
    edge = np.asarray(m.filter(ImageFilter.GaussianBlur(3))).astype(np.float32) / 255.0
    edge = np.clip(a - edge, 0, 1) * 2.5
    cell[:] *= (1 - edge * 0.35)[..., None]
    return a

def rust_plate(cell, x0, y0, x1, y1, base, seed, radius=26):
    """Enamel plate: rounded rect, chipped rusty edges, scratches."""
    m = Image.new('L', (S, S), 0); ImageDraw.Draw(m).rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=255)
    a = np.asarray(m).astype(np.float32) / 255.0
    n1 = noise(S, 12, seed); n2 = noise(S, 50, seed + 1)
    dist = np.asarray(m.filter(ImageFilter.GaussianBlur(18))).astype(np.float32) / 255.0   # low near the rim
    rust = np.clip((0.75 - dist) * 2.2 + (n1 - 0.5) * 1.3 + (n2 - 0.5) * 0.8, 0, 1) * a
    rust = np.clip(rust - 0.25, 0, 1) * 1.4
    col = np.array(base, dtype=np.float32)[None, None, :] * (0.94 + 0.08 * n1)[..., None]
    rust_col = np.array([120, 62, 30], dtype=np.float32) * (0.7 + 0.5 * n1)[..., None]
    col = col * (1 - rust[..., None]) + rust_col * rust[..., None]
    cell[:] = cell * (1 - a[..., None]) + col * a[..., None]
    return a, rust

def star_points(cx, cy, r_out, r_in, n=5, rot=-math.pi / 2):
    pts = []
    for i in range(2 * n):
        r = r_out if i % 2 == 0 else r_in
        a = rot + i * math.pi / n
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts

# ------------------------------------------------------------------ posters sheet
def poster_cell():
    cell = np.full((S, S, 3), 255, np.float32)
    poly = torn_polygon(28, 26, 486, 480, 11, rough=16)
    a = paper(cell, poly, (222, 206, 172), 21)
    d = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(d)
    # zigzag border bands (indigo) + inner thin red rule
    for y in (62, 448):
        pts = [(x, y + (-10 if (i % 2) else 10)) for i, x in enumerate(range(50, 470, 20))]
        dr.line(pts, fill=255, width=9)
    for x in (62, 448):
        pts = [(x + (-10 if (i % 2) else 10), y) for i, y in enumerate(range(80, 430, 20))]
        dr.line(pts, fill=255, width=9)
    ind = np.asarray(d).astype(np.float32) / 255.0 * a
    paint(cell, ind * (0.8 + 0.2 * noise(S, 30, 3)), (62, 74, 122))
    d = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(d)
    dr.rectangle([88, 92, 424, 418], outline=255, width=4)
    red = np.asarray(d).astype(np.float32) / 255.0 * a
    paint(cell, red * 0.85, (150, 60, 52))
    # eight-point star medallion (two rotated squares) with a ring and a dot
    d = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(d)
    cx, cy = 256, 252
    for rot in (0, math.pi / 4):
        pts = [(cx + 118 * math.cos(rot + i * math.pi / 2), cy + 118 * math.sin(rot + i * math.pi / 2)) for i in range(4)]
        dr.polygon(pts, fill=255)
    star = np.asarray(d).astype(np.float32) / 255.0
    d2 = Image.new('L', (S, S), 0); dr2 = ImageDraw.Draw(d2)
    dr2.ellipse([cx - 70, cy - 70, cx + 70, cy + 70], fill=255)
    hole = np.asarray(d2).astype(np.float32) / 255.0
    d3 = Image.new('L', (S, S), 0); dr3 = ImageDraw.Draw(d3)
    dr3.ellipse([cx - 52, cy - 52, cx + 52, cy + 52], outline=255, width=7)
    dr3.ellipse([cx - 14, cy - 14, cx + 14, cy + 14], fill=255)
    ring = np.asarray(d3).astype(np.float32) / 255.0
    fade = 0.7 + 0.3 * noise(S, 20, 5)
    paint(cell, np.clip(star - hole, 0, 1) * a * fade, (58, 70, 118))
    paint(cell, ring * a * fade, (150, 60, 52))
    # small red diamonds row under the medallion
    d = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(d)
    for x in range(150, 380, 38):
        dr.polygon([(x, 392), (x + 12, 404), (x, 416), (x - 12, 404)], fill=255)
    paint(cell, np.asarray(d).astype(np.float32) / 255.0 * a * 0.85, (150, 60, 52))
    return cell

def teapot_mask(cx, cy, s):
    d = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(d)
    dr.ellipse([cx - s, cy - s * 0.62, cx + s, cy + s * 0.62], fill=255)                     # body
    dr.rectangle([cx - s * 0.75, cy + s * 0.45, cx + s * 0.75, cy + s * 0.68], fill=255)         # foot
    dr.ellipse([cx - s * 0.42, cy - s * 0.92, cx + s * 0.42, cy - s * 0.42], fill=255)        # lid
    dr.ellipse([cx - s * 0.12, cy - s * 1.08, cx + s * 0.12, cy - s * 0.84], fill=255)        # knob
    dr.polygon([(cx + s * 0.7, cy - s * 0.05), (cx + s * 1.35, cy - s * 0.75), (cx + s * 1.5, cy - s * 0.62), (cx + s * 0.9, cy + s * 0.3)], fill=255)   # spout
    dr.arc([cx - s * 1.55, cy - s * 0.75, cx - s * 0.55, cy + s * 0.35], 100, 300, fill=255, width=int(s * 0.14))   # handle
    return d

def sign_cell():
    cell = np.full((S, S, 3), 255, np.float32)
    a, rust = rust_plate(cell, 30, 46, 482, 466, (226, 216, 190), 31)
    # dark red roundel with the teapot in cream, plus two thin rules
    d = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(d)
    dr.ellipse([256 - 150, 256 - 150, 256 + 150, 256 + 150], fill=255)
    roundel = np.asarray(d).astype(np.float32) / 255.0 * a * (1 - rust)
    paint(cell, roundel * (0.88 + 0.12 * noise(S, 25, 9)), (128, 40, 44))
    pot = np.asarray(teapot_mask(262, 268, 82)).astype(np.float32) / 255.0 * a * (1 - rust)
    paint(cell, pot * 0.95, (226, 214, 186))
    d = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(d)
    for y in (74, 438):
        dr.line([(70, y), (442, y)], fill=255, width=5)
    for x in range(96, 430, 42):
        dr.polygon([(x, 74 - 14), (x + 7, 74), (x, 74 + 14), (x - 7, 74)], fill=255)
        dr.polygon([(x, 438 - 14), (x + 7, 438), (x, 438 + 14), (x - 7, 438)], fill=255)
    rules = np.asarray(d).astype(np.float32) / 255.0 * a * (1 - rust)
    paint(cell, rules * 0.9, (60, 92, 74))
    return cell

def strips_cell():
    cell = np.full((S, S, 3), 255, np.float32)
    # back strip: green with a cream circle emblem and bars
    poly = torn_polygon(300, 40, 480, 470, 41, rough=12)
    a = paper(cell, poly, (74, 118, 88), 43)
    d = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(d)
    dr.ellipse([340, 110, 440, 210], outline=255, width=10)
    for y in (260, 300, 340):
        dr.rectangle([330, y, 450, y + 16], fill=255)
    paint(cell, np.asarray(d).astype(np.float32) / 255.0 * a * 0.9, (222, 210, 176))
    # middle strip: cream with a big numeral and horizontal stripes
    poly = torn_polygon(150, 26, 340, 486, 42, rough=12)
    a = paper(cell, poly, (218, 202, 166), 45)
    d = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(d)
    f = font(230)
    dr.text((190, 120), '7', font=f, fill=255)
    for y in (60, 76):
        dr.rectangle([170, y, 320, y + 6], fill=255)
    for y in (400, 416, 432):
        dr.rectangle([170, y, 320, y + 6], fill=255)
    paint(cell, np.asarray(d).astype(np.float32) / 255.0 * a * (0.75 + 0.25 * noise(S, 18, 8)), (40, 44, 52))
    # front strip: orange with a rising sun and rays
    poly = torn_polygon(22, 60, 200, 470, 44, rough=12)
    a = paper(cell, poly, (206, 118, 62), 47)
    d = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(d)
    cx, cy = 112, 250
    dr.ellipse([cx - 44, cy - 44, cx + 44, cy + 44], fill=255)
    for i in range(12):
        ang = i * math.pi / 6
        dr.line([(cx + 58 * math.cos(ang), cy + 58 * math.sin(ang)), (cx + 92 * math.cos(ang), cy + 92 * math.sin(ang))], fill=255, width=9)
    dr.rectangle([40, 380, 184, 396], fill=255); dr.rectangle([40, 410, 184, 426], fill=255)
    paint(cell, np.asarray(d).astype(np.float32) / 255.0 * a * 0.92, (226, 210, 170))
    return cell

def sign2_cell():
    cell = np.full((S, S, 3), 255, np.float32)
    a, rust = rust_plate(cell, 34, 56, 478, 456, (48, 92, 70), 51, radius=18)
    d = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(d)
    dr.rectangle([62, 84, 450, 428], outline=255, width=6)
    dr.rectangle([78, 100, 434, 412], outline=255, width=3)
    for (x, y) in ((70, 92), (442, 92), (70, 420), (442, 420)):
        dr.polygon([(x, y - 18), (x + 18, y), (x, y + 18), (x - 18, y)], fill=255)
    f = font(250)
    dr.text((178, 96), '3', font=f, fill=255)
    for i, y in enumerate((390, 372)):     # small chevrons under the numeral
        dr.line([(226, y + 14), (256, y), (286, y + 14)], fill=255, width=7)
    m = np.asarray(d).astype(np.float32) / 255.0 * a * (1 - rust) * (0.8 + 0.2 * noise(S, 22, 13))
    paint(cell, m, (224, 216, 190))
    return cell

# ------------------------------------------------------------------ graffiti sheet
def tag_cell():
    cell = np.full((S, S, 3), 255, np.float32)
    m = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(m)
    r = random.Random(77)
    # abstract scrawl: smooth random loops (catmull-like via many short segments)
    def loop(cx, cy, rx, ry, turns, w, phase=0.0, squash=1.0):
        pts = []
        for i in range(int(120 * turns)):
            t = phase + i / 120 * math.tau
            pts.append((cx + rx * math.cos(t) + 18 * math.sin(3.1 * t), cy + ry * math.sin(t) * squash + 12 * math.cos(2.3 * t)))
        dr.line(pts, fill=255, width=w, joint='curve')
    loop(190, 240, 120, 70, 1.15, 26, 0.4)
    loop(300, 250, 95, 60, 1.0, 22, 2.2, 0.8)
    dr.line([(70, 330), (160, 170), (240, 320), (330, 160), (430, 320)], fill=255, width=22, joint='curve')   # zigzag underline
    # one long arrow slashing under the loops + a ringed dot off to the side
    for (ax, ay, bx, by) in ((60, 300, 450, 190),):
        dr.line([(ax, ay), (bx, by)], fill=255, width=16)
        ang = math.atan2(by - ay, bx - ax)
        for s in (-1, 1):
            dr.line([(bx, by), (bx - 44 * math.cos(ang + s * 0.5), by - 44 * math.sin(ang + s * 0.5))], fill=255, width=16)
    dr.ellipse([420 - 30, 110 - 30, 420 + 30, 110 + 30], outline=255, width=13)   # ringed dot
    dr.ellipse([420 - 9, 110 - 9, 420 + 9, 110 + 9], fill=255)
    drips(dr, [(x, 330) for x in range(90, 430, 24)], 78, n=(10, 16), length=(30, 120), width=(4, 7))
    sp = spray(m, blur=1.8, seed=79)
    paint(cell, sp * (0.75 + 0.25 * noise(S, 40, 80)), (36, 58, 132))
    return cell

def stencil_cell():
    cell = np.full((S, S, 3), 255, np.float32)
    m = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(m)
    dr.polygon(star_points(180, 250, 120, 50), fill=255)
    dr.ellipse([300, 120, 480, 380], fill=255)
    cut = Image.new('L', (S, S), 0); ImageDraw.Draw(cut).ellipse([300 - 52, 130, 480 - 52, 370], fill=255)
    m = ImageChops.subtract(m, cut)
    dr = ImageDraw.Draw(m)
    drips(dr, [(x, 360) for x in range(140, 230, 14)] + [(430, 370), (445, 340)], 81, n=(5, 8), length=(25, 90), width=(3, 6))
    sp = spray(m, blur=1.4, seed=82, halo=9)
    paint(cell, sp * (0.7 + 0.3 * noise(S, 30, 83)), (28, 28, 30))
    return cell

def script_cell():
    cell = np.full((S, S, 3), 255, np.float32)
    m = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(m)
    # stencil frame with bridges (the little gaps stencils have) + big numeral 7 + three bars
    dr.rectangle([70, 80, 450, 420], outline=255, width=20)
    for x in (150, 260, 370):
        dr.rectangle([x - 12, 70, x + 12, 100], fill=0); dr.rectangle([x - 12, 400, x + 12, 430], fill=0)
    for y in (170, 250, 330):
        dr.rectangle([60, y - 12, 90, y + 12], fill=0); dr.rectangle([430, y - 12, 460, y + 12], fill=0)
    f = font(270)
    dr.text((150, 90), '7', font=f, fill=255)
    for i in range(3):
        dr.rectangle([300, 300 + i * 34, 410, 318 + i * 34], fill=255)
    drips(dr, [(x, 420) for x in range(90, 440, 20)], 84, n=(8, 13), length=(30, 110), width=(4, 8))
    sp = spray(m, blur=1.3, seed=85, halo=7)
    paint(cell, sp * (0.72 + 0.28 * noise(S, 26, 86)), (140, 32, 36))
    return cell

def marks_cell():
    cell = np.full((S, S, 3), 255, np.float32)
    groups = [((150, 40, 40), [((70, 190), (70, 300), 20), ((72, 150), (72, 165), 22), ((110, 250), (160, 250), 18)]),
              ((30, 30, 32), [((215, 160), (215, 280), 22), ((215, 310), (215, 330), 24)]),
              ((40, 70, 150), [((270, 170), (270, 290), 18), ((300, 170), (300, 290), 18), ((350, 230), (450, 230), 18), ((450, 230), (415, 195), 18), ((450, 230), (415, 265), 18)])]
    for col, segs in groups:
        m = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(m)
        for (a, b, w) in segs:
            dr.line([a, b], fill=255, width=w)
            dr.ellipse([a[0] - w // 2, a[1] - w // 2, a[0] + w // 2, a[1] + w // 2], fill=255)
            dr.ellipse([b[0] - w // 2, b[1] - w // 2, b[0] + w // 2, b[1] + w // 2], fill=255)
        sp = spray(m, blur=1.2, seed=hash(col) & 0xffff, halo=5)
        paint(cell, sp * 0.9, col)
    return cell

def sheet(cells):
    img = np.full((2 * S, 2 * S, 3), 255, np.float32)
    for i, c in enumerate(cells):
        y, x = (i // 2) * S, (i % 2) * S
        img[y:y + S, x:x + S] = c
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    sheet([poster_cell(), sign_cell(), strips_cell(), sign2_cell()]).save(os.path.join(OUT, 'posters.png'), optimize=True)
    sheet([tag_cell(), stencil_cell(), script_cell(), marks_cell()]).save(os.path.join(OUT, 'graffiti.png'), optimize=True)
    print('decal sheets written to', OUT)
