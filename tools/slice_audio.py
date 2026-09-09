"""Slice the raw CC0 takes in assets_src/audio_raw into game one-shots in public/audio (ogg).
Onset detection on the RMS envelope; each slice is peak-normalised, faded and trimmed. A few assets are layered /
synthesised here on top of the slices (AK sub-thump + outdoor tail, distant reports, C4 sub + rumble, seamless
multi-period ambience loops). Voice lines are a separate script: tools/make_voice.py.
Run: python tools/slice_audio.py
"""
import subprocess, numpy as np, os, sys, json

RAW = 'assets_src/audio_raw'; OUT = 'public/audio'; SR = 44100
os.makedirs(OUT, exist_ok=True)

def load(name):
    p = subprocess.run(['ffmpeg', '-v', 'error', '-i', f'{RAW}/{name}.mp3', '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'], capture_output=True, check=True)
    return np.frombuffer(p.stdout, dtype=np.float32).copy()

def save(name, x, fade_in=0.002, fade_out=0.03, gain_db=0.0, q=5):
    x = x.astype(np.float32)
    n = len(x)
    fi, fo = int(fade_in * SR), int(fade_out * SR)
    if fi > 0: x[:fi] *= np.linspace(0, 1, fi, dtype=np.float32)
    if fo > 0 and fo < n: x[-fo:] *= np.linspace(1, 0, fo, dtype=np.float32)
    pk = float(np.max(np.abs(x))) or 1.0
    x = x / pk * (10 ** (gain_db / 20)) * 0.95
    p = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-i', '-', '-c:a', 'libvorbis', '-q:a', str(q), f'{OUT}/{name}.ogg'], input=x.astype(np.float32).tobytes(), capture_output=True)
    if p.returncode: print(p.stderr.decode()); sys.exit(1)
    print(f'{name:18s} {n / SR:5.2f}s')

def envelope(x, win=0.005):
    w = int(win * SR)
    e = np.sqrt(np.convolve(x * x, np.ones(w) / w, mode='same'))
    return e

def onsets(x, thresh_rel=0.18, min_gap=0.12, pre=0.008):
    """Return start indices where the envelope jumps above thresh (relative to the max) after a quiet gap."""
    e = envelope(x)
    th = e.max() * thresh_rel
    idx = []; last = -1e9; gap = int(min_gap * SR)
    above = e > th
    for i in range(1, len(e)):
        if above[i] and not above[i - 1] and i - last > gap:
            idx.append(max(0, i - int(pre * SR))); last = i
    return idx

def slice_at(x, start, length, tail_rel=0.02):
    """Cut `length` seconds from start, then trim trailing near-silence (below tail_rel of slice peak)."""
    seg = x[start:start + int(length * SR)]
    e = envelope(seg, 0.01); pk = e.max()
    keep = np.where(e > pk * tail_rel)[0]
    if len(keep): seg = seg[:min(len(seg), keep[-1] + int(0.03 * SR))]
    return seg

def pick(x, n, length, **kw):
    """n slices spread across the onsets (skips the very quiet ones)."""
    on = onsets(x, **kw)
    if not on: return []
    segs = [slice_at(x, s, length) for s in on]
    segs = [s for s in segs if len(s) > int(0.04 * SR)]
    if len(segs) <= n: return segs
    step = len(segs) / n
    return [segs[int(i * step)] for i in range(n)]

def hp(x, fc):
    from scipy.signal import butter, sosfilt
    sos = butter(2, fc / (SR / 2), 'high', output='sos'); return sosfilt(sos, x).astype(np.float32)

def lp(x, fc):
    from scipy.signal import butter, sosfilt
    sos = butter(2, fc / (SR / 2), 'low', output='sos'); return sosfilt(sos, x).astype(np.float32)

# ---------------- synthesis / layering helpers (everything below is rendered here, nothing sampled from a game)
def mix(*parts):
    n = max(len(p) for p in parts); y = np.zeros(n, np.float32)
    for p in parts: y[:len(p)] += p
    return y

def sub_thump(dur=0.35, f0=140, f1=42, decay=0.09, amp=1.0, glide=0.03):
    """Pitched-down sine: the chest thump under a close shot / the sub of the blast."""
    n = int(dur * SR); t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t / glide)
    return (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / decay) * amp).astype(np.float32)

def tail(x, dur=0.8, lp_fc=2500, level_db=-18, seed=1):
    """Convolve with an exponentially decaying noise IR (outdoor reflections); peak set relative to x's peak."""
    from scipy.signal import fftconvolve
    rng = np.random.default_rng(seed); n = int(dur * SR)
    ir = rng.standard_normal(n).astype(np.float32) * np.exp(-np.arange(n) / (n / 5.5)).astype(np.float32)
    ir = lp(ir, lp_fc); ir /= np.sqrt(np.sum(ir * ir))
    y = fftconvolve(x, ir)[: len(x) + n].astype(np.float32)
    return y / (np.max(np.abs(y)) + 1e-9) * 10 ** (level_db / 20) * float(np.max(np.abs(x)))

def delayed(x, sec):
    return np.concatenate([np.zeros(int(sec * SR), np.float32), x])

def distant_shot(core, seed, echoes=(0.19, 0.43, 0.71)):
    """A rifle report heard across the map: muffled crack, long reflection wash, a few discrete slaps off far walls."""
    x = lp(hp(core, 60), 1100)
    y = mix(x * 0.9, tail(x, 1.6, 1400, -7, seed))
    for i, d in enumerate(echoes): y = mix(y, delayed(lp(x, 750 - i * 150) * 0.32 * 0.6 ** i, d + (seed % 3) * 0.02))
    return y

def loopify(x, xf=1.5):
    """Seamless loop: the last xf seconds are cross-faded under the first xf seconds and dropped."""
    n = int(xf * SR); w = np.linspace(0, 1, n, dtype=np.float32)
    return np.concatenate([x[-n:] * (1 - w) + x[:n] * w, x[n:-n]])

def repitch(x, ratio):
    """Resample so the pitch moves by `ratio` (>1 = higher, shorter)."""
    n = int(len(x) / ratio); return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)

# ---------------- weapons
# AK: the recording is bright and dies in ~0.25 s. Layer a 140->42 Hz thump under the onset and a short lowpassed
# reflection tail (an open street, not a room) so a burst has weight up close and a sense of place.
ak = load('ak_a'); o = onsets(ak, 0.3)[0]; ak_core = slice_at(ak, o, 1.6, 0.003)
ak_core[-int(0.12 * SR):] *= np.linspace(1, 0, int(0.12 * SR), dtype=np.float32)   # the recording's noise floor must not stop dead under the tail
save('ak47_fire', mix(ak_core, sub_thump(0.32, 140, 42, 0.085, 0.55), tail(ak_core, 0.7, 2500, -16)), fade_out=0.3)
awp = load('awp_a'); o = onsets(awp, 0.3)[0]; save('awp_fire', slice_at(awp, o, 1.5, 0.003), fade_out=0.25)
bolt = load('bolt'); segs = pick(bolt, 2, 0.9, thresh_rel=0.25, min_gap=0.6)
for i, s in enumerate(segs): save(f'awp_bolt_{i + 1}', s, fade_out=0.05)
rl = load('ak_reload_seq'); on = onsets(rl, 0.2, 0.15)
print('reload onsets', [round(i / SR, 2) for i in on])
for i, s in enumerate(on[:3]):
    end = on[i + 1] if i + 1 < len(on) else len(rl)
    save(f'ak47_reload_{i + 1}', slice_at(rl, s, (end - s) / SR + 0.05), fade_out=0.04)
kw = load('knife_whoosh'); segs = pick(kw, 2, 0.5, thresh_rel=0.2, min_gap=0.3)
save('knife_swing', segs[0], fade_out=0.06, gain_db=-4)
ks = load('knife_steel'); save('knife_wall', slice_at(ks, onsets(ks, 0.3)[0], 0.5), fade_out=0.06)
kf = load('knife_flesh'); segs = pick(kf, 3, 0.7, thresh_rel=0.3, min_gap=0.5)
for i, s in enumerate(segs): save(f'knife_flesh_{i + 1}', s, fade_out=0.08)
# distant reports are rendered from the close AK (the distant_* recordings were clicky and had almost no echo body)
save('ak47_distant_a', distant_shot(ak_core, 1), fade_out=0.5, gain_db=-2)
save('ak47_distant_b', distant_shot(ak_core, 2, echoes=(0.15, 0.36, 0.62, 0.95)), fade_out=0.5, gain_db=-2)
# ---------------- impacts
im = load('impacts_misc'); segs = pick(im, 6, 0.6, thresh_rel=0.2, min_gap=0.25)
for i, s in enumerate(segs): save(f'impact_concrete_{i + 1}', s, fade_out=0.05)
ig = load('impact_ground'); save('impact_dirt', slice_at(ig, onsets(ig, 0.3)[0], 0.8), fade_out=0.08)
fl = load('impacts_flesh'); segs = pick(fl, 3, 0.5, thresh_rel=0.25, min_gap=0.25)
for i, s in enumerate(segs): save(f'impact_flesh_{i + 1}', s, fade_out=0.06)
hs = load('headshot_a'); save('headshot', lp(slice_at(hs, onsets(hs, 0.3)[0], 0.45), 8500), fade_out=0.05)   # keep the dink, lose the 13 kHz ring
fb = load('flyby'); save('whiz', fb, fade_out=0.01)
rc = load('ricochet'); segs = pick(rc, 2, 0.8, thresh_rel=0.25, min_gap=0.4)
for i, s in enumerate(segs): save(f'ricochet_{i + 1}', s, fade_out=0.1, gain_db=-3)
br = load('brass'); segs = pick(hp(br, 900), 5, 0.6, thresh_rel=0.2, min_gap=0.3)
for i, s in enumerate(segs): save(f'brass_{i + 1}', s, fade_out=0.06, gain_db=-6)
# ---------------- movement
for src, name, n in (('steps_concrete', 'step_concrete', 6), ('steps_stone', 'step_stone', 4), ('steps_dirt', 'step_dirt', 4), ('steps_gravel', 'step_gravel', 4)):
    x = load(src); segs = pick(x, n, 0.35, thresh_rel=0.3, min_gap=0.25)
    for i, s in enumerate(segs): save(f'{name}_{i + 1}', s, fade_out=0.05, gain_db=-3)
bf = load('bodyfall'); save('bodyfall', slice_at(bf, onsets(bf, 0.3)[0], 1.2), fade_out=0.1)
# ---------------- voice
g = load('grunts'); save('hurt', g, fade_out=0.04)
ag = load('agony'); segs = pick(ag, 4, 1.2, thresh_rel=0.3, min_gap=0.7)
for i, s in enumerate(segs): save(f'death_{i + 1}', s, fade_out=0.15)
# ---------------- bomb / ambience
kp = load('keypad'); segs = pick(hp(kp, 400), 3, 0.18, thresh_rel=0.3, min_gap=0.12)
for i, s in enumerate(segs): save(f'c4_key_{i + 1}', s, fade_out=0.03, gain_db=-6)
ex = load('explosion_a'); ex_core = slice_at(ex, max(0, onsets(ex, 0.3)[0] - int(0.01 * SR)), 3.8, 0.003)
# C4: the recording is crackle-heavy; add a 90->30 Hz sub that rings ~1.5 s and a long low-passed rumble tail (Sfx adds the muffled-ears sweep)
save('c4_explode', mix(ex_core, sub_thump(2.0, 90, 30, 0.55, 1.1, 0.06), tail(lp(ex_core, 1200), 2.4, 900, -11, 3)), fade_out=0.8, q=4)
# ---------------- ambience: three seamless loops with unrelated periods (38.5 / 28.5 / 23.5 s) so nothing repeats audibly
w = load('wind_b'); save('amb_wind', loopify(w[: int(40 * SR)]), fade_in=0, fade_out=0, gain_db=-1, q=2)
w2 = load('wind_a'); save('amb_wind2', loopify(lp(hp(w2[int(3 * SR): int(33 * SR)], 150), 3000)), fade_in=0, fade_out=0, gain_db=-1, q=1)
city = load('city_distant'); save('amb_city', loopify(lp(hp(city[int(60 * SR): int(85 * SR)], 60), 800)), fade_in=0, fade_out=0, gain_db=-1, q=1)
# far-off one-shots (Sfx scatters them 50-80 m out every 12-35 s): a dog, a crow, two pitches each
dg = load('dog_distant'); dg = hp(dg, 180); save('far_dog_1', dg, fade_out=0.05); save('far_dog_2', repitch(dg, 0.9), fade_out=0.05)
cr = load('crow'); cr = hp(cr, 250); save('far_crow_1', cr, fade_out=0.05); save('far_crow_2', repitch(cr, 1.08), fade_out=0.05)
print('done')
