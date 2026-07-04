import fs from "node:fs";
import path from "node:path";

const wavPath = process.argv[2];

if (!wavPath) {
  console.error("Usage: node scripts/generate-mouth-cues-from-wav.mjs public/audio/test-audio.wav");
  process.exit(1);
}

const bytes = fs.readFileSync(wavPath);

function readAscii(offset, length) {
  return bytes.toString("ascii", offset, offset + length);
}

function readUInt32LE(offset) {
  return bytes.readUInt32LE(offset);
}

function readUInt16LE(offset) {
  return bytes.readUInt16LE(offset);
}

if (readAscii(0, 4) !== "RIFF" || readAscii(8, 4) !== "WAVE") {
  throw new Error("Not a valid WAV file.");
}

let offset = 12;
let fmt = null;
let dataOffset = null;
let dataSize = null;

while (offset + 8 <= bytes.length) {
  const chunkId = readAscii(offset, 4);
  const chunkSize = readUInt32LE(offset + 4);
  const chunkDataOffset = offset + 8;

  if (chunkId === "fmt ") {
    fmt = {
      audioFormat: readUInt16LE(chunkDataOffset),
      channels: readUInt16LE(chunkDataOffset + 2),
      sampleRate: readUInt32LE(chunkDataOffset + 4),
      byteRate: readUInt32LE(chunkDataOffset + 8),
      blockAlign: readUInt16LE(chunkDataOffset + 12),
      bitsPerSample: readUInt16LE(chunkDataOffset + 14),
    };
  }

  if (chunkId === "data") {
    dataOffset = chunkDataOffset;
    dataSize = chunkSize;
    break;
  }

  offset += 8 + chunkSize + (chunkSize % 2);
}

if (!fmt || dataOffset === null || dataSize === null) {
  throw new Error("Could not find WAV fmt/data chunks.");
}

if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
  throw new Error("This simple generator expects 16-bit PCM WAV.");
}

const duration = dataSize / fmt.byteRate;
const windowSeconds = 0.045;
const samplesPerWindow = Math.max(1, Math.floor(fmt.sampleRate * windowSeconds));
const mouthShapes = ["aa", "ih", "oh", "ee", "ou"];

const rmsValues = [];

for (let sampleStart = 0; sampleStart < dataSize / fmt.blockAlign; sampleStart += samplesPerWindow) {
  let sumSquares = 0;
  let count = 0;

  for (let i = 0; i < samplesPerWindow; i++) {
    const sampleIndex = sampleStart + i;
    const frameOffset = dataOffset + sampleIndex * fmt.blockAlign;

    if (frameOffset + fmt.blockAlign > dataOffset + dataSize) {
      break;
    }

    let frameTotal = 0;

    for (let channel = 0; channel < fmt.channels; channel++) {
      const sampleOffset = frameOffset + channel * 2;
      const sample = bytes.readInt16LE(sampleOffset) / 32768;
      frameTotal += sample;
    }

    const monoSample = frameTotal / fmt.channels;
    sumSquares += monoSample * monoSample;
    count++;
  }

  const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0;

  rmsValues.push({
    time: sampleStart / fmt.sampleRate,
    rms,
  });
}

const maxRms = Math.max(...rmsValues.map((item) => item.rms), 0.0001);
const threshold = maxRms * 0.12;

const cues = [];

for (let i = 0; i < rmsValues.length; i++) {
  const item = rmsValues[i];

  if (item.rms < threshold) {
    continue;
  }

  const normalized = Math.min(1, item.rms / maxRms);
  const value = Math.max(0.25, Math.min(0.95, normalized * 1.2));

  cues.push({
    start: Number(item.time.toFixed(3)),
    end: Number(Math.min(item.time + windowSeconds, duration).toFixed(3)),
    shape: mouthShapes[i % mouthShapes.length],
    value: Number(value.toFixed(2)),
  });
}

const outputPath = path.join("public", "cues", "test-cues.json");

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(cues, null, 2), "utf8");

console.log(`Wrote ${cues.length} audio-based mouth cues to ${outputPath}`);
console.log(`Audio duration: ${duration.toFixed(3)} seconds`);
console.log(`Final cue end: ${cues.length ? cues[cues.length - 1].end : 0} seconds`);
