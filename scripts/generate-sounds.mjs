#!/usr/bin/env node
// Generate short WAV sound effects and write them to build/sounds/.
// Pure Node.js, no dependencies. Run once at setup time or via npm script.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "build", "sounds");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const SAMPLE_RATE = 22050;
const BITS = 16;
const CHANNELS = 1;

function writeWav(path, samples) {
  const dataLength = samples.length * (BITS / 8);
  const buffer = Buffer.alloc(44 + dataLength);
  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8);
  // fmt chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20);  // PCM format
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * (BITS / 8), 28);
  buffer.writeUInt16LE(CHANNELS * (BITS / 8), 32);
  buffer.writeUInt16LE(BITS, 34);
  // data chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLength, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buffer);
}

function envelope(t, total, attack = 0.01, release = 0.08) {
  if (t < attack) return t / attack;
  if (t > total - release) return Math.max(0, (total - t) / release);
  return 1;
}

function tone(freq, durationSec, gain = 0.3) {
  const n = Math.floor(SAMPLE_RATE * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    out[i] = Math.sin(2 * Math.PI * freq * t) * envelope(t, durationSec) * gain;
  }
  return out;
}

function chord(notes, durationSec, gain = 0.25) {
  const n = Math.floor(SAMPLE_RATE * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    let v = 0;
    for (const f of notes) v += Math.sin(2 * Math.PI * f * t);
    out[i] = (v / notes.length) * envelope(t, durationSec) * gain;
  }
  return out;
}

function sweep(f1, f2, durationSec, gain = 0.3) {
  const n = Math.floor(SAMPLE_RATE * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const f = f1 + (f2 - f1) * (t / durationSec);
    out[i] = Math.sin(2 * Math.PI * f * t) * envelope(t, durationSec) * gain;
  }
  return out;
}

function concat(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// done.wav — pleasant two-note chime
writeWav(join(outDir, "done.wav"),
  concat(tone(523.25, 0.10, 0.28), tone(659.25, 0.16, 0.28))
);

// error.wav — low buzzy
writeWav(join(outDir, "error.wav"),
  concat(tone(196.0, 0.08, 0.30), tone(164.8, 0.16, 0.30))
);

// permission.wav — bright attention
writeWav(join(outDir, "permission.wav"),
  concat(tone(880.0, 0.06, 0.30), tone(1318.5, 0.10, 0.30))
);

// session-start.wav — gentle wake-up sweep
writeWav(join(outDir, "session-start.wav"),
  sweep(440, 880, 0.20, 0.28)
);

console.log("Generated 4 sound files in", outDir);
