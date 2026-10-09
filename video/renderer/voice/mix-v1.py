"""Builds the soundtrack: narration placed at its timings, a quiet bed, and a few
restrained cues (confirm, deny, a short rise under the attack). Deterministic.

Usage: python3 mix.py <narration-wav-dir> <timing.json> <out.wav>
"""
import json
import sys

import numpy as np
import soundfile as sf

SR = 48000
DUR = 170.0
wav_dir, timing_path, out_path = sys.argv[1:4]
rng = np.random.default_rng(7)
n = int(DUR * SR)
t = np.arange(n) / SR


def env(length, attack, release):
    e = np.ones(length)
    a, r = int(attack * SR), int(release * SR)
    e[:a] = np.linspace(0, 1, a)
    e[-r:] *= np.linspace(1, 0, r)
    return e


def tone(freq, dur, gain, attack=0.01, release=0.3, harmonics=((1, 1.0), (2, 0.25), (3, 0.08))):
    m = int(dur * SR)
    x = np.arange(m) / SR
    s = sum(a * np.sin(2 * np.pi * freq * h * x) for h, a in harmonics)
    return gain * s * env(m, attack, release) * np.exp(-x * 2.2)


def place(buf, clip, at):
    i = int(at * SR)
    j = min(n, i + len(clip))
    buf[i:j] += clip[: j - i]


# Quiet bed: a low two-note pad with slow movement, plus very soft filtered noise.
pad = 0.018 * (np.sin(2 * np.pi * 55 * t) + 0.6 * np.sin(2 * np.pi * 82.4 * t)) * (0.75 + 0.25 * np.sin(2 * np.pi * t / 23))
noise = rng.normal(0, 1, n)
kernel = np.ones(400) / 400
noise = np.convolve(noise, kernel, mode="same") * 0.05
bed = (pad + noise) * env(n, 2.0, 2.5)
# Duck the bed in the two "said no" title moments and the final card.
for a, b in ((7.2, 11.8), (102.4, 108), (151, 170)):
    i, j = int(a * SR), int(b * SR)
    bed[i:j] *= 0.45

fx = np.zeros(n)
# Cold open: block card lands, then the two title beats.
place(fx, tone(98, 1.2, 0.20, release=0.9), 6.25)
place(fx, tone(146.8, 0.5, 0.06), 7.45)
place(fx, tone(73.4, 1.4, 0.16, release=1.0), 8.55)
# Approved run: soft ticks per check, then a two-note confirm.
for i in range(6):
    place(fx, tone(1318.5, 0.08, 0.025, release=0.06, harmonics=((1, 1.0),)), 76.4 + i * 0.55)
place(fx, tone(523.25, 0.5, 0.07), 80.2)
place(fx, tone(783.99, 0.7, 0.06), 80.38)
# Attack: a short low rise, ticks, then the deny tone.
m = int(5.0 * SR)
x = np.arange(m) / SR
rise = 0.05 * np.sin(2 * np.pi * (60 + 18 * x) * x) * np.linspace(0, 1, m) ** 2 * env(m, 0.5, 0.3)
place(fx, rise, 87.0)
for i in range(2):
    place(fx, tone(1318.5, 0.08, 0.025, release=0.06, harmonics=((1, 1.0),)), 88.6 + i * 0.9)
place(fx, tone(98, 1.4, 0.22, release=1.0), 91.8)
place(fx, tone(146.8, 0.5, 0.06), 102.65)
place(fx, tone(73.4, 1.4, 0.16, release=1.0), 103.85)
# Close: one soft low note under the wordmark.
place(fx, tone(110, 2.5, 0.06, attack=0.4, release=2.0), 157.4)

voice = np.zeros(n)
for line in json.load(open(timing_path)):
    clip, sr = sf.read(f"{wav_dir}/{line['id']}.wav", dtype="float32")
    if clip.ndim > 1:
        clip = clip.mean(axis=1)
    if sr != SR:  # simple resample by interpolation
        xs = np.arange(int(len(clip) * SR / sr)) / SR
        clip = np.interp(xs, np.arange(len(clip)) / sr, clip)
    place(voice, clip * 0.9, line["at"])

mix = voice + bed + fx
mix /= max(1.0, np.abs(mix).max() / 0.95)
fade = int(0.8 * SR)
mix[-fade:] *= np.linspace(1, 0, fade)
sf.write(out_path, np.stack([mix, mix], axis=1).astype(np.float32), SR)
print("wrote", out_path, f"{DUR:.0f}s")
