"""Synthesised soundtrack for the Штурман promo (numpy only).

    python3 promo/music.py            -> promo/out/music.wav

The UI accents (file ready, checklist ticks, the red mismatch, tool calls) are
placed at the same timestamps the animation uses in shturman-promo.html — keep
the two in sync if you retime a scene.
"""
import os
import wave

import numpy as np

SR = 44100
DUR = 54.0
N = int(SR * DUR)
rng = np.random.default_rng(7)
mix = np.zeros((N, 2))


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def add(sig, t0, gain=1.0, pan=0.0):
    i0 = int(t0 * SR)
    if i0 >= N:
        return
    sig = sig[: N - i0]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    mix[i0 : i0 + len(sig), 0] += sig * gain * l * 1.414
    mix[i0 : i0 + len(sig), 1] += sig * gain * r * 1.414


def adsr(n, a, r, sustain_len=None):
    t = np.arange(n) / SR
    env = np.minimum(1, t / max(a, 1e-4))
    tail = n / SR - r
    env *= np.where(t > tail, np.clip((n / SR - t) / r, 0, 1), 1)
    return env


def pad_note(f, dur, bright=6):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = np.zeros(n)
    for det in (-0.06, 0.0, 0.07):  # three detuned voices -> chorus
        ff = f * 2 ** (det / 12)
        ph = rng.uniform(0, 2 * np.pi)
        for h in range(1, bright + 1):
            s += np.sin(2 * np.pi * ff * h * t + ph * h) / h**1.6
    return s * adsr(n, 0.9, 1.4) / 3


def pluck(f, dur=0.9):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) + 0.12 * np.sin(6 * np.pi * f * t)
    return s * np.exp(-t * 5.5) * np.minimum(1, t / 0.004)


def bass(f, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)
    return s * adsr(n, 0.02, 0.25) * np.exp(-t * 0.6)


def kick():
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    f = 45 + 85 * np.exp(-t * 28)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)


def hat():
    n = int(0.06 * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    noise = np.diff(np.concatenate([[0], noise]))  # crude high-pass
    return noise * np.exp(-t * 90)


def blip(f, dur=0.16):
    n = int(dur * SR)
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t)) * np.exp(-t * 26) * np.minimum(1, t / 0.002)


def err_tone():
    a = blip(392, 0.22) * 1.0
    b = blip(311, 0.32)
    out = np.zeros(int(0.11 * SR) + len(b))
    out[: len(a)] += a
    out[int(0.11 * SR) : int(0.11 * SR) + len(b)] += b
    return out


def band_noise(dur, lo, hi):
    n = int(dur * SR)
    spec = np.fft.rfft(rng.standard_normal(n))
    fr = np.fft.rfftfreq(n, 1 / SR)
    spec *= (fr > lo) & (fr < hi)
    s = np.fft.irfft(spec, n)
    return s / (np.abs(s).max() + 1e-9)


def whoosh(dur=0.5):
    n = int(dur * SR)
    t = np.arange(n) / SR
    env = np.sin(np.pi * t / dur) ** 2
    return band_noise(dur, 900, 5000) * env


def riser(dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = band_noise(dur, 400, 7000) * (t / dur) ** 2.2
    s += 0.5 * np.sin(2 * np.pi * np.cumsum(220 + 660 * (t / dur) ** 2) / SR) * (t / dur) ** 3
    return s


def impact():
    n = int(2.6 * SR)
    t = np.arange(n) / SR
    f = 38 + 60 * np.exp(-t * 12)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 2.2)
    air = band_noise(2.6, 200, 3000) * np.exp(-t * 4) * 0.35
    return boom + air


# ---------------- arrangement ----------------
BEAT = 0.6  # 100 bpm
# A minor -> F -> C -> G  (root, chord tones as midi)
PROG = [(45, [57, 60, 64, 69]), (41, [57, 60, 65, 69]), (48, [55, 60, 64, 67]), (43, [55, 59, 62, 67])]

# intro tension (documents chaos + mismatch): low drone, slowly opening
add(pad_note(midi(45), 10.8, bright=3), 0.0, 0.22)
add(pad_note(midi(52), 10.8, bright=3), 0.4, 0.14, -0.3)
add(pad_note(midi(57), 5.5, bright=4), 5.3, 0.10, 0.3)
for i in range(10):  # each document card flying in
    add(whoosh(0.45), 0.1 + 0.11 * i, 0.06, (-1) ** i * 0.6)
add(whoosh(0.7), 5.4, 0.08)
add(err_tone(), 8.0, 0.30)
add(riser(2.1), 8.4, 0.20)
add(impact(), 10.5, 0.55)

# main groove from the reveal to the end
SECTION_END = 52.2
start = 10.5
bar = 0
t = start
while t < SECTION_END:
    root, chord = PROG[bar % 4]
    dur = 4 * BEAT
    for k, m in enumerate(chord):
        add(pad_note(midi(m), dur + 1.2), t, 0.09, (-0.4, 0.4, -0.2, 0.2)[k])
    if t >= 14.4:
        for b in range(4):
            add(bass(midi(root), BEAT * 0.95), t + b * BEAT, 0.26)
    if t >= 12.9 and t < 49.0:
        arp = chord + [chord[1] + 12, chord[2] + 12]
        seq = [0, 2, 1, 3, 4, 2, 5, 3]
        for e in range(8):
            add(pluck(midi(arp[seq[e]] + 12)), t + e * BEAT / 2, 0.06, (-0.5, 0.5)[e % 2])
    if 14.4 <= t < 44.4:
        add(kick(), t, 0.42)
        add(kick(), t + 2 * BEAT, 0.42)
        if t >= 21.5:
            for e in range(4):
                add(hat(), t + e * BEAT + BEAT / 2, 0.022, 0.3)
    bar += 1
    t += dur

# outro: final A-major-ish resolve
for k, m in enumerate([45, 57, 61, 64, 69, 76]):
    add(pad_note(midi(m), 5.2), 49.0, 0.08, (-0.4, 0.4, -0.2, 0.2, 0, 0)[k])
add(impact(), 49.3, 0.25)

# ---------------- UI accents (timings mirror shturman-promo.html) ----------------
add(whoosh(0.6), 14.4, 0.10)
for i in range(7):  # files -> ready
    a = 15.0 + 0.3 * i
    add(blip(1318.5), a + 1.6 + 0.12 * i, 0.12, 0.3)
for k in range(9):  # checklist rows
    done = 22.3 + 0.32 * k + 0.35
    add(blip(1568.0) if k < 7 else err_tone(), done, 0.10 if k < 7 else 0.20, 0.3)
for i in range(5):  # reconciliation verdicts
    v = 29.4 + 0.35 * i + 0.45
    add(blip(1174.7) if i != 3 else err_tone(), v, 0.10 if i != 3 else 0.24, 0.3)
add(whoosh(0.5), 31.6, 0.08)
add(blip(987.8, 0.2), 36.9, 0.10)  # user message
for i in range(3):  # tool calls finish
    add(blip(1760.0), 38.0 + 0.65 * i + 0.55, 0.09, 0.3)
add(blip(2093.0, 0.3), 43.7, 0.10)  # "verified" pill
for k, tt in enumerate([45.5, 46.2, 46.9]):  # trust lines
    add(blip(1318.5 * 2 ** (k * 4 / 12), 0.25), tt, 0.08)

# ---------------- reverb + master ----------------
ir_n = int(2.2 * SR)
ir_t = np.arange(ir_n) / SR
size = 1 << int(np.ceil(np.log2(N + ir_n)))
wet = np.zeros_like(mix)
for ch in range(2):
    ir = rng.standard_normal(ir_n) * np.exp(-ir_t * 3.2)
    ir /= np.sqrt((ir**2).sum())
    wet[:, ch] = np.fft.irfft(np.fft.rfft(mix[:, ch], size) * np.fft.rfft(ir, size), size)[:N]
out = mix * 0.82 + wet * 0.30

t_all = np.arange(N) / SR
out *= np.clip(t_all / 0.3, 0, 1)[:, None]
out *= np.clip((DUR - t_all) / 2.5, 0, 1)[:, None]
out = np.tanh(out * 1.4) / np.tanh(1.4)  # gentle glue / limiting
out *= 0.77 / np.abs(out).max()  # ≈ -14 LUFS integrated (web/social target)

os.makedirs(os.path.join(os.path.dirname(__file__), "out"), exist_ok=True)
path = os.path.join(os.path.dirname(__file__), "out", "music.wav")
with wave.open(path, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((out * 32767).astype("<i2").tobytes())
print(path)
