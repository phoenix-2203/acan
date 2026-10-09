"""Film v2 soundtrack: narration at its timings, Morse beeps for the cold open (same
schedule as film.html), a low drone under the incident, silence before "No hack",
a quiet bed after, and confirm/deny cues on the outcomes. Deterministic.

Usage: python3 mix.py <narration-wav-dir> <timing.json> <out.wav>
"""
import json
import sys

import numpy as np
import soundfile as sf

SR = 48000
DUR = 155.0
wav_dir, timing_path, out_path = sys.argv[1:4]
rng = np.random.default_rng(7)
n = int(DUR * SR)
t = np.arange(n) / SR


def env(length, attack, release):
    e = np.ones(length)
    a, r = max(1, int(attack * SR)), max(1, int(release * SR))
    e[:a] = np.linspace(0, 1, a)
    e[-r:] *= np.linspace(1, 0, r)
    return e


def tone(freq, dur, gain, attack=0.01, release=0.3, harmonics=((1, 1.0), (2, 0.25), (3, 0.08)), decay=2.2):
    m = int(dur * SR)
    x = np.arange(m) / SR
    s = sum(a * np.sin(2 * np.pi * freq * h * x) for h, a in harmonics)
    return gain * s * env(m, attack, release) * np.exp(-x * decay)


def place(buf, clip, at):
    i = int(at * SR)
    j = min(n, i + len(clip))
    buf[i:j] += clip[: j - i]


def confirm(at):
    place(fx, tone(523.25, 0.5, 0.07), at)
    place(fx, tone(783.99, 0.7, 0.06), at + 0.18)


def deny(at, g=0.2):
    place(fx, tone(98, 1.3, g, release=0.9), at)


fx = np.zeros(n)

# Cold open: Morse for "SEND 3B DRB TO", one beep per symbol as film.html reveals it.
MORSE = "... . -. -..   ...-- -...   -.. .-. -...   - ---"
M0, M1 = 0.7, 6.3
for i, ch in enumerate(MORSE):
    at = M0 + (i + 1) / len(MORSE) * (M1 - M0)
    if ch in ".-":
        d = 0.055 if ch == "." else 0.15
        place(fx, tone(720, d, 0.05, attack=0.004, release=0.01, harmonics=((1, 1.0),), decay=0), at)
# Decode ticks, then the transfer: a low drone that swells to the total.
for i in range(8):
    place(fx, tone(1318.5, 0.05, 0.02, release=0.04, harmonics=((1, 1.0),)), 7.1 + i * 0.15)
m = int(6.0 * SR)
x = np.arange(m) / SR
drone = 0.06 * (np.sin(2 * np.pi * 49 * x) + 0.5 * np.sin(2 * np.pi * 73.4 * x)) * np.linspace(0.2, 1, m) ** 2 * env(m, 0.8, 0.4)
place(fx, drone, 8.4)
place(fx, tone(55, 2.6, 0.26, release=2.0, decay=0.9), 12.4)
# "No hack." / "Just words.": two hits out of silence.
place(fx, tone(65.4, 1.0, 0.22, release=0.8), 16.6)
place(fx, tone(49, 1.6, 0.26, release=1.2), 17.5)
# ACAN stops it: three refusals, then the two title beats.
for a in (20.25, 22.95, 25.05):
    deny(a, 0.17)
place(fx, tone(146.8, 0.5, 0.06), 27.95)
deny(28.95, 0.16)
# The gate: paid, held, refused.
confirm(64.85)
place(fx, tone(220, 0.6, 0.05, release=0.5), 68.55)
deny(70.55, 0.15)
# Any AI client: paid, three blocks.
confirm(81.65)
for a in (83.65, 84.55, 85.45):
    deny(a, 0.1)
# Agent team: two refusals.
deny(97.05, 0.1)
deny(100.75, 0.1)
# Close: one soft low note under the wordmark.
place(fx, tone(110, 2.5, 0.06, attack=0.4, release=2.0), 143.4)

# Quiet bed from the turn onward; ducked under the title beats and the close.
pad = 0.016 * (np.sin(2 * np.pi * 55 * t) + 0.6 * np.sin(2 * np.pi * 82.4 * t)) * (0.75 + 0.25 * np.sin(2 * np.pi * t / 23))
noise = np.convolve(rng.normal(0, 1, n), np.ones(400) / 400, mode="same") * 0.045
bed = (pad + noise) * env(n, 2.0, 2.5)
bed[: int(20.0 * SR)] = 0
bed[int(20.0 * SR): int(22.0 * SR)] *= np.linspace(0, 1, int(2.0 * SR))
for a, b in ((27.8, 32.0), (136.5, 155)):
    bed[int(a * SR): int(b * SR)] *= 0.45

voice = np.zeros(n)
for line in json.load(open(timing_path)):
    clip, sr = sf.read(f"{wav_dir}/{line['id']}.wav", dtype="float32")
    if clip.ndim > 1:
        clip = clip.mean(axis=1)
    if sr != SR:
        xs = np.arange(int(len(clip) * SR / sr)) / SR
        clip = np.interp(xs, np.arange(len(clip)) / sr, clip)
    place(voice, clip * 0.9, line["at"])

mix = voice + bed + fx
mix /= max(1.0, np.abs(mix).max() / 0.95)
fade = int(0.8 * SR)
mix[-fade:] *= np.linspace(1, 0, fade)
sf.write(out_path, np.stack([mix, mix], axis=1).astype(np.float32), SR)
print("wrote", out_path, f"{DUR:.0f}s")
