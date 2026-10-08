"""Synthesize the reel's soundtrack (music bed + SFX) from scratch, synced to the
scene timeline in src/theme.ts. Writes public/soundtrack.wav (48 kHz stereo).

    python3 tools/sound.py
"""
import wave
from pathlib import Path

import numpy as np

SR = 48000
FPS = 30
TOTAL_FRAMES = 880
DUR = TOTAL_FRAMES / FPS
N = int(DUR * SR)
rng = np.random.default_rng(7)

# Scene starts (frames) — keep in sync with T in src/theme.ts
SCENES = {"hook": 0, "lockup": 72, "headline": 184, "product": 296, "family": 492, "cta": 628, "end": 764}

L = np.zeros(N)
R = np.zeros(N)


def t_of(n):
    return np.arange(n) / SR


def place(sig, at_s, gain=1.0, pan=0.0):
    i = int(at_s * SR)
    if i >= N:
        return
    sig = sig[: N - i] * gain
    L[i : i + len(sig)] += sig * np.sqrt(0.5 * (1 - pan))
    R[i : i + len(sig)] += sig * np.sqrt(0.5 * (1 + pan))


def env(n, a, d):
    """Attack/exponential-decay envelope (seconds)."""
    t = t_of(n)
    e = np.minimum(1, t / max(a, 1e-4)) * np.exp(-np.maximum(0, t - a) / d)
    return e


def lowpass(x, cutoff):
    # one-pole lowpass
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc = (1 - a) * v + a * acc
        y[i] = acc
    return y


def midi(m):
    return 440 * 2 ** ((m - 69) / 12)


# ---------------- music bed ----------------
BPM = 112
beat = 60 / BPM
bar = beat * 4

# Dmaj9 – Bm9 – Gmaj9 – A6/9, warm and optimistic
CHORDS = [[50, 57, 61, 64, 66], [47, 54, 57, 61, 64], [43, 50, 54, 57, 62], [45, 52, 57, 59, 64]]


def pad_note(freq, dur):
    n = int(dur * SR)
    t = t_of(n)
    sig = np.zeros(n)
    for det in (-0.06, 0.0, 0.07):  # detuned voices
        f = freq * 2 ** (det / 12)
        for h in range(1, 7):  # soft saw: few harmonics, rolled off
            sig += np.sin(2 * np.pi * f * h * t + rng.uniform(0, 6.28)) / (h**1.6)
    a = np.minimum(1, t / 0.6) * np.minimum(1, (dur - t) / 0.5)
    return sig * a / 6


music_start = SCENES["lockup"] / FPS - 0.05
t0 = music_start
ci = 0
while t0 < DUR:
    dur = bar * 2
    for m in CHORDS[ci % 4]:
        place(pad_note(midi(m + 12), dur + 0.4), t0, 0.05, pan=rng.uniform(-0.5, 0.5))
    # sub bass: root, pulsing on each beat
    root = CHORDS[ci % 4][0] - 12
    for b in range(8):
        n = int(beat * SR)
        tb = t_of(n)
        bass = np.sin(2 * np.pi * midi(root) * tb) * env(n, 0.01, 0.22)
        place(bass, t0 + b * beat, 0.22)
    t0 += dur
    ci += 1


def kick():
    n = int(0.35 * SR)
    t = t_of(n)
    f = 45 + 95 * np.exp(-t / 0.04)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * env(n, 0.002, 0.12)


def hat(open_=False):
    n = int((0.18 if open_ else 0.06) * SR)
    x = rng.standard_normal(n)
    x = np.diff(np.concatenate([[0], x]))  # crude highpass
    return x * env(n, 0.001, 0.05 if open_ else 0.015)


def clap():
    n = int(0.25 * SR)
    x = rng.standard_normal(n)
    x = lowpass(x - lowpass(x, 900), 8000)
    e = env(n, 0.002, 0.08)
    for k in (0.012, 0.024):
        e[int(k * SR) :] += env(n - int(k * SR), 0.001, 0.02) * 0.6
    return x * e


# beat drops in at the lockup reveal; family scene breaks down to pads only
beat_t = music_start
k = 0
fam0 = SCENES["family"] / FPS
fam1 = SCENES["cta"] / FPS - beat * 2
while beat_t < DUR - 1.4:
    in_break = fam0 <= beat_t < fam1
    if not in_break:
        place(kick(), beat_t, 0.55)
        place(hat(), beat_t + beat / 2, 0.06, pan=0.3)
        if k % 4 in (1, 3):
            place(clap(), beat_t, 0.11, pan=-0.1)
        if k % 2 == 1:
            place(hat(), beat_t + beat * 0.75, 0.035, pan=-0.3)
    beat_t += beat
k = 0

# ---------------- SFX ----------------


def whoosh(dur=0.55, up=True):
    n = int(dur * SR)
    t = t_of(n)
    x = rng.standard_normal(n)
    # sweep a resonant band by mixing lowpasses
    lo = lowpass(x, 600)
    hi = x - lowpass(x, 2500)
    mix = np.linspace(0, 1, n) if up else np.linspace(1, 0, n)
    hi = lowpass(lowpass(hi, 7000), 7000)  # keep it airy, not hissy
    sig = lo * (1 - mix) + hi * mix * 0.9
    e = np.sin(np.pi * np.minimum(1, t / dur)) ** 2
    return sig * e


def pop(f0=880, f1=520, dur=0.12):
    n = int(dur * SR)
    t = t_of(n)
    f = f1 + (f0 - f1) * np.exp(-t / 0.02)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, 0.002, 0.04)


def click():
    n = int(0.05 * SR)
    x = rng.standard_normal(n)
    return (x - lowpass(x, 3000)) * env(n, 0.0005, 0.006) + pop(2400, 1800, 0.05) * 0.4


def tick():
    n = int(0.03 * SR)
    x = rng.standard_normal(n)
    return (x - lowpass(x, 4000)) * env(n, 0.0005, 0.004)


def bell(freq, dur=1.2):
    n = int(dur * SR)
    t = t_of(n)
    s = np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(2 * np.pi * freq * 2.76 * t) * np.exp(-t / 0.15)
    return s * env(n, 0.003, 0.35)


def impact():
    n = int(1.4 * SR)
    t = t_of(n)
    boom = np.sin(2 * np.pi * np.cumsum(38 + 70 * np.exp(-t / 0.08)) / SR) * env(n, 0.003, 0.4)
    air = rng.standard_normal(n)
    air = lowpass(air, 1800) * env(n, 0.01, 0.25)
    return boom + air * 0.5


def riser(dur):
    n = int(dur * SR)
    t = t_of(n)
    x = rng.standard_normal(n)
    sig = lowpass(lowpass(x - lowpass(x, 1200), 6000), 6000) * (t / dur) ** 2.2
    tone = np.sin(2 * np.pi * np.cumsum(200 + 600 * (t / dur) ** 2) / SR) * (t / dur) ** 2 * 0.3
    return sig + tone


f2s = lambda f: f / FPS

# hook: dots assemble (10 little pops), then big-news pill, riser into the lockup
for i in range(10):
    place(pop(700 + i * 60, 420 + i * 30, 0.1), f2s(2 + i * 1.6 + 4), 0.18, pan=rng.uniform(-0.6, 0.6))
place(pop(1200, 800, 0.15), f2s(38), 0.22)
place(riser(1.0), f2s(SCENES["lockup"]) - 1.0, 0.16)
place(impact(), f2s(SCENES["lockup"]), 0.55)

# wipes
for name in ("lockup", "headline", "product", "family", "cta", "end"):
    place(whoosh(0.6), f2s(SCENES[name]) - 0.08, 0.28, pan=rng.uniform(-0.3, 0.3))

lk = SCENES["lockup"]
for i in range(10):
    place(pop(900 + i * 40, 600, 0.08), f2s(lk + 4 + i * 1.4 + 4), 0.1)
place(pop(1400, 700, 0.18), f2s(lk + 36), 0.28)  # + badge
place(whoosh(0.7), f2s(lk + 42), 0.2)  # Ethos swoosh spin
place(bell(midi(81)), f2s(lk + 76), 0.12)  # lands as the O
place(pop(1100, 700, 0.12), f2s(lk + 92), 0.18)

hd = SCENES["headline"]
place(pop(1000, 650), f2s(hd + 10), 0.2)
place(whoosh(0.3), f2s(hd + 44), 0.12)

pr = SCENES["product"]
place(whoosh(0.6), f2s(pr + 8), 0.18)  # phone rises
for start, text_len in ((26, 11), (40, 14), (58, 5)):  # field typing
    for c in range(text_len):
        place(tick(), f2s(pr + start + c / 1.4), 0.12, pan=0.2)
for at in (40, 86, 154, 168):
    place(pop(1050, 640, 0.13), f2s(pr + at + 2), 0.24, pan=-0.3 if at in (40, 154) else 0.3)
place(click(), f2s(pr + 146), 0.5)
for i, m in enumerate((74, 78, 81, 86)):  # success arpeggio
    place(bell(midi(m), 1.0), f2s(pr + 154) + i * 0.07, 0.11)

fa = SCENES["family"]
for i in range(3):
    place(pop(900, 600, 0.1), f2s(fa + 48 + i * 7), 0.16)

ct = SCENES["cta"]
place(pop(1100, 700), f2s(ct + 4), 0.2)
place(whoosh(0.5), f2s(ct + 22), 0.18)
for c in range(len("agents.ethoslife.com/invite/24ef7")):
    place(tick(), f2s(ct + 32 + c / 1.3), 0.12, pan=0.15)
place(click(), f2s(ct + 82), 0.5)
place(bell(midi(83), 0.8), f2s(ct + 84), 0.1)
place(pop(800, 500, 0.12), f2s(ct + 112), 0.18)
place(pop(1200, 800, 0.12), f2s(ct + 118), 0.2)

en = SCENES["end"]
place(impact(), f2s(en), 0.4)
for i in range(3):
    place(pop(900, 600, 0.12), f2s(en + 36 + i * 6), 0.18)
place(pop(1300, 800, 0.18), f2s(en + 58), 0.22)

# ---------------- master ----------------
fade = np.ones(N)
fade_n = int(1.6 * SR)
fade[-fade_n:] = np.linspace(1, 0, fade_n) ** 1.5
L *= fade
R *= fade
peak = max(np.abs(L).max(), np.abs(R).max())
L /= peak / 0.89
R /= peak / 0.89
stereo = np.stack([L, R], axis=1)
pcm = (np.clip(stereo, -1, 1) * 32767).astype(np.int16)
out = Path(__file__).resolve().parent.parent / "public" / "soundtrack.wav"
with wave.open(str(out), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print("wrote", out, f"{DUR:.2f}s")
