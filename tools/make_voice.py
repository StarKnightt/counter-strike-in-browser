"""Generate the announcer / radio voice lines: Windows SAPI TTS (offline, nothing ripped) -> radio DSP -> public/audio/voice/*.ogg.
Run: python tools/make_voice.py            (add --tts to re-run the TTS step; raw takes are cached in assets_src/audio_raw/voice)

Characters (all from 'Microsoft David Desktop', pitched / paced differently in DSP):
  ann_*   announcer: slowed 0.93, -2 st, gentle band (180-6 kHz), light compression -> calm, weighty
  ct_*    player radio: +0 st, quick, hard radio band 300-3400 Hz, overdrive, hiss bed, squelch click
  t_*_v1..3 terrorist bots: three pitches (-4 / -1 / +2.5 st) through the hard radio chain, positional in-game
Every file is trimmed, padded 40/80 ms, 5 ms fades, normalised to -16 LUFS (ebur128) with a 0.95 peak ceiling, libvorbis q4 mono.
"""
import subprocess, os, sys, json, re, tempfile
import numpy as np
from scipy.signal import butter, sosfilt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'assets_src', 'audio_raw', 'voice'); OUT = os.path.join(ROOT, 'public', 'audio', 'voice')
SR = 44100
os.makedirs(RAW, exist_ok=True); os.makedirs(OUT, exist_ok=True)

# id -> spoken text. Punctuation shapes SAPI prosody (commas = pauses, '!' = a little lift).
ANNOUNCER = {
  'ann_ct_win': 'Counter-Terrorists win.',
  'ann_t_win': 'Terrorists win.',
  'ann_bomb_planted': 'The bomb has been planted.',
  'ann_bomb_defused': 'The bomb has been defused.',
}
CT = {
  'ct_enemy_down': 'Enemy down.',
  'ct_enemy_spotted': 'Enemy spotted.',
  'ct_need_backup': 'Need backup!',
  'ct_defusing': 'Defusing the bomb.',
  'ct_cover_me': 'Cover me.',
}
T = {   # keys match BotManager LINES texts (see Sfx.T_LINE)
  't_spot': 'Enemy spotted.',
  't_contact': 'Contact!',
  't_takingfire': 'Taking fire, need assistance!',
  't_hit': "I'm hit!",
  't_down': 'Man down.',
  't_planting': 'Planting the bomb.',
  't_gotbomb': "I've got the bomb.",
  't_gogogo': 'Go go go!',
  't_cover': 'Cover me!',
}
T_VOICES = {1: (0.79, 1.00), 2: (0.94, 1.06), 3: (1.155, 1.10)}   # variant -> (pitch ratio, tempo)

# ------------------------------------------------------------------ TTS (System.Speech, offline)
def tts_all(lines):
  todo = {k: v for k, v in lines.items() if '--tts' in sys.argv or not os.path.exists(os.path.join(RAW, k + '.wav'))}
  if not todo: return
  spec = os.path.join(tempfile.gettempdir(), 'cs2_voice_lines.json')
  with open(spec, 'w', encoding='utf-8') as f: json.dump([[k, v, os.path.join(RAW, k + '.wav')] for k, v in todo.items()], f)
  ps = r'''
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft David Desktop')
$s.Rate = -1
$lines = Get-Content -Raw -Encoding UTF8 '%s' | ConvertFrom-Json
foreach ($l in $lines) { $s.SetOutputToWaveFile($l[2]); $s.Speak($l[1]); Write-Output ('tts ' + $l[0]) }
$s.Dispose()
''' % spec.replace('\\', '\\\\')
  p = subprocess.run(['powershell', '-NoProfile', '-Command', ps], capture_output=True, text=True)
  print(p.stdout.strip()); 
  if p.returncode: print(p.stderr); sys.exit(1)

# ------------------------------------------------------------------ DSP helpers
def load(path, pitch=1.0, tempo=1.0):
  """Decode to f32 mono, pitch-shift (asetrate/aresample) while keeping the pace set by `tempo`."""
  af = f'aresample={SR},asetrate={int(SR * pitch)},aresample={SR},atempo={tempo / pitch:.5f}'   # SAPI writes 22.05 kHz: resample before the rate trick
  p = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-af', af, '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'], capture_output=True, check=True)
  return np.frombuffer(p.stdout, dtype=np.float32).copy()

def band(x, lo, hi, order=4):
  sos = butter(order, [lo / (SR / 2), hi / (SR / 2)], 'band', output='sos'); return sosfilt(sos, x).astype(np.float32)

def env_follow(x, attack=0.003, release=0.08):
  a, r = np.exp(-1 / (attack * SR)), np.exp(-1 / (release * SR))
  e = np.zeros_like(x); v = 0.0
  ax = np.abs(x)
  for i in range(len(x)):
    s = ax[i]; v = (a * v + (1 - a) * s) if s > v else (r * v + (1 - r) * s); e[i] = v
  return e

def compress(x, th_db=-20, ratio=5, makeup_db=8):
  e = env_follow(x) + 1e-6
  th = 10 ** (th_db / 20)
  g = np.where(e > th, (th / e) ** (1 - 1 / ratio), 1.0)
  return (x * g * 10 ** (makeup_db / 20)).astype(np.float32)

def drive(x, k):
  return (np.tanh(x * k) / np.tanh(k)).astype(np.float32)

def trim(x, thresh_db=-42, win=0.005):
  w = int(win * SR); e = np.sqrt(np.convolve(x * x, np.ones(w) / w, mode='same'))
  th = e.max() * 10 ** (thresh_db / 20); idx = np.where(e > th)[0]
  if not len(idx): return x
  return x[max(0, idx[0] - int(0.01 * SR)): min(len(x), idx[-1] + int(0.04 * SR))]

def squelch(dur=0.03, lo=1200, hi=3200, vol=0.25, click=True):
  n = int(dur * SR); s = np.random.uniform(-1, 1, n).astype(np.float32) * np.exp(-np.linspace(0, 6, n)).astype(np.float32) * vol
  if click: s[:40] += np.linspace(0.5, 0, 40).astype(np.float32) * (1 if np.random.rand() < 0.5 else -1)
  return band(s, lo, hi + 1500, 2)     # click + burst share the channel band (no broadband spike)

def radio(x, lo=300, hi=3400, drv=3.0, hiss_db=-34, sq=True, comp=(-20, 6, 10)):
  x = band(x, lo, hi)
  x = compress(x, *comp)
  x = drive(x, drv)
  x = band(x, lo, hi, 2)               # the transmitter band again: strips the distortion harmonics above the channel
  n = len(x)
  pre, post = int(0.045 * SR), int(0.085 * SR)
  y = np.zeros(pre + n + post, dtype=np.float32); y[pre:pre + n] = x
  # hiss bed under the transmission (gated by the carrier, so it stops when the PTT releases)
  hiss = band(np.random.uniform(-1, 1, len(y)).astype(np.float32), 500, 3000) * 10 ** (hiss_db / 20)
  gate = np.ones(len(y), dtype=np.float32); gate[-int(0.05 * SR):] = np.linspace(1, 0, int(0.05 * SR)); gate[:int(0.01 * SR)] = np.linspace(0, 1, int(0.01 * SR))
  y += hiss * gate
  if sq:
    s0 = squelch(vol=0.22); y[:len(s0)] += s0
    s1 = squelch(dur=0.045, vol=0.28); y[-len(s1) - int(0.02 * SR): -int(0.02 * SR)] += s1
  return y

def announcer(x):
  x = band(x, 180, 6000)
  x = compress(x, -22, 3.5, 8)
  x = drive(x, 1.35)
  x = band(x, 160, 7000, 2)
  pre, post = int(0.03 * SR), int(0.12 * SR)
  y = np.zeros(pre + len(x) + post, dtype=np.float32); y[pre:pre + len(x)] = x
  return y

def measure_lufs(x):
  p = subprocess.run(['ffmpeg', '-v', 'info', '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-i', '-', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], input=x.astype(np.float32).tobytes(), capture_output=True)
  m = re.search(r'I:\s+(-?[\d.]+) LUFS', p.stderr.decode(errors='ignore'))
  return float(m.group(1)) if m else None

def save(name, x, target=-16.0):
  x = x.astype(np.float32); n = len(x)
  f = int(0.005 * SR); x[:f] *= np.linspace(0, 1, f, dtype=np.float32); x[-f:] *= np.linspace(1, 0, f, dtype=np.float32)
  lufs = measure_lufs(x)
  if lufs is not None: x = x * 10 ** ((target - lufs) / 20)
  pk = float(np.max(np.abs(x)))
  if pk > 0.95: x = x / pk * 0.95
  final = measure_lufs(x)
  p = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-i', '-', '-c:a', 'libvorbis', '-q:a', '4', os.path.join(OUT, name + '.ogg')], input=x.astype(np.float32).tobytes(), capture_output=True)
  if p.returncode: print(p.stderr.decode()); sys.exit(1)
  size = os.path.getsize(os.path.join(OUT, name + '.ogg'))
  print(f'{name:22s} {n / SR:4.2f}s  {final if final is not None else float("nan"):6.1f} LUFS  peak {min(pk, 0.95):.2f}  {size / 1024:5.1f} KB')

# ------------------------------------------------------------------ build
if __name__ == '__main__':
  np.random.seed(7)
  tts_all({**ANNOUNCER, **CT, **T})
  for k in ANNOUNCER:
    x = trim(load(os.path.join(RAW, k + '.wav'), pitch=0.891, tempo=0.93))
    save(k, announcer(x))
  for k in CT:
    x = trim(load(os.path.join(RAW, k + '.wav'), pitch=1.0, tempo=1.04))
    save(k, radio(x, drv=2.2, hiss_db=-36))
  for k in T:
    for v, (pitch, tempo) in T_VOICES.items():
      x = trim(load(os.path.join(RAW, k + '.wav'), pitch=pitch, tempo=tempo))
      save(f'{k}_v{v}', radio(x, drv=3.2 if v == 1 else 2.8, hiss_db=-33, comp=(-20, 6, 11)))
  total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
  print(f'voice bank: {len(os.listdir(OUT))} files, {total / 1024:.0f} KB')
