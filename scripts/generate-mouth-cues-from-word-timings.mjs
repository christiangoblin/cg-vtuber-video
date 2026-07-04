import fs from "node:fs";
import path from "node:path";

const timingsPath = process.argv[2];

if (!timingsPath) {
  console.error("Usage: node scripts/generate-mouth-cues-from-word-timings.mjs public/cues/word-timings.json");
  process.exit(1);
}

const timings = JSON.parse(fs.readFileSync(timingsPath, "utf8"));
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

function cleanWord(word) {
  return word.toLowerCase().replace(/[^a-z]/g, "");
}

const cues = [];

for (let i = 0; i < timings.words.length; i++) {
  const current = timings.words[i];
  const next = timings.words[i + 1];

  const word = cleanWord(current.text);

  if (!word) continue;

  const wordStart = current.start;
  const wordEnd = next ? Math.max(wordStart + 0.08, next.start - 0.03) : Math.max(wordStart + 0.08, timings.duration - 0.12);

  const usableLetters = [...word].filter((char) => mouthMap[char]);

  if (usableLetters.length === 0) continue;

  const wordDuration = Math.max(0.08, wordEnd - wordStart);
  const letterStep = wordDuration / usableLetters.length;

  usableLetters.forEach((char, index) => {
    const start = wordStart + index * letterStep;
    const end = Math.min(start + letterStep * 0.72, wordEnd);

    cues.push({
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      shape: mouthMap[char],
      value: 0.85
    });
  });
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(cues, null, 2), "utf8");

console.log(`Wrote ${cues.length} word-timed mouth cues to ${outputPath}`);
console.log(`Audio duration: ${timings.duration.toFixed(3)} seconds`);
