import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

let duration = null;
const textParts = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--duration") {
    duration = Number(args[i + 1]);
    i++;
  } else {
    textParts.push(args[i]);
  }
}

const text = textParts.join(" ").trim();

if (!text) {
  console.error('Usage: node scripts/generate-mouth-cues.mjs "your text here" --duration 3.2');
  process.exit(1);
}

const outputPath = path.join("public", "cues", "test-cues.json");

const mouthMap = {
  a: "aa",
  e: "ee",
  i: "ih",
  o: "oh",
  u: "ou",
  y: "ih",
  b: "aa",
  p: "aa",
  m: "aa",
  f: "ee",
  v: "ee",
  w: "ou",
  r: "ou",
  l: "ih",
  n: "ih",
  d: "ih",
  t: "ih",
  s: "ih",
  z: "ih",
  c: "aa",
  g: "aa",
  h: "aa",
  j: "ee",
  k: "aa",
  q: "ou",
  x: "ih"
};

function isPunctuation(char) {
  return ".,!?;:".includes(char);
}

let rawTime = 0;
const rawCues = [];

for (const char of text.toLowerCase()) {
  if (char === " ") {
    rawTime += 0.12;
    continue;
  }

  if (isPunctuation(char)) {
    rawTime += 0.35;
    continue;
  }

  const shape = mouthMap[char];

  if (!shape) {
    rawTime += 0.04;
    continue;
  }

  rawCues.push({
    start: rawTime,
    end: rawTime + 0.075,
    shape,
    value: 0.85
  });

  rawTime += 0.085;
}

const targetDuration = Number.isFinite(duration) && duration > 0 ? duration : rawTime;
const safeTargetDuration = Math.max(0.1, targetDuration - 0.12);
const scale = rawTime > 0 ? safeTargetDuration / rawTime : 1;

const cues = rawCues.map((cue) => ({
  start: Number((cue.start * scale).toFixed(3)),
  end: Number((cue.end * scale).toFixed(3)),
  shape: cue.shape,
  value: cue.value
}));

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(cues, null, 2), "utf8");

console.log(`Wrote ${cues.length} mouth cues to ${outputPath}`);
console.log(`Raw cue duration: ${rawTime.toFixed(2)} seconds`);
console.log(`Target audio duration: ${targetDuration.toFixed(2)} seconds`);
console.log(`Final cue end: ${cues.length ? cues[cues.length - 1].end : 0} seconds`);
