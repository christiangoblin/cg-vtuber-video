import fs from "node:fs";
import path from "node:path";

const inputPath = process.argv[2] || "public/cues/rhubarb.json";
const outputPath = process.argv[3] || "public/cues/test-cues.json";

if (!fs.existsSync(inputPath)) {
  console.error(`Missing input file: ${inputPath}`);
  process.exit(1);
}

const rhubarb = JSON.parse(fs.readFileSync(inputPath, "utf8"));

const shapeMap = {
  X: null,
  A: null,
  B: "ee",
  C: "ih",
  D: "aa",
  E: "oh",
  F: "ou",
  G: "ee",
  H: "ih"
};

const cues = [];

for (const cue of rhubarb.mouthCues || []) {
  const vrmShape = shapeMap[cue.value];

  if (!vrmShape) {
    continue;
  }

  cues.push({
    start: Number(cue.start.toFixed(3)),
    end: Number(cue.end.toFixed(3)),
    shape: vrmShape,
    value: cue.value === "D" ? 0.95 : 0.85
  });
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(cues, null, 2), "utf8");

console.log(`Converted ${cues.length} Rhubarb cues to ${outputPath}`);
