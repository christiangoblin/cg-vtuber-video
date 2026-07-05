import { VRMHumanBoneName } from "@pixiv/three-vrm";

function bone(vrm, name) { return vrm.humanoid?.getNormalizedBoneNode(name); }
function rot(vrm, name, x = 0, y = 0, z = 0) { const b = bone(vrm, name); if (b) b.rotation.set(x, y, z); }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function strength(cue, time) { const d = Math.max(0.001, cue.end - cue.start); const p = clamp01((time - cue.start) / d); return Math.sin(p * Math.PI) * (cue.intensity ?? 0.7); }

export function normalizeBodyCueFile(data) {
  const source = Array.isArray(data) ? data : Array.isArray(data.timeline) ? data.timeline : [];
  return source.filter((cue) => ["head", "body", "gesture"].includes(cue.type)).map((cue) => ({
    start: Number(cue.start ?? 0),
    end: Number(cue.end ?? cue.start ?? 0),
    type: cue.type,
    action: cue.action,
    intensity: Number(cue.intensity ?? 0.7),
    avatarId: cue.avatarId ?? null,
  }));
}

export const GESTURE_ACTIONS = {
  head: ["nod", "lookLeft", "lookRight", "lookDown", "lookShocked"],
  body: ["leanForward", "leanBack"],
  gesture: [
    "rightHandOut",
    "leftHandOut",
    "bothHandsOut",
    "pointRight",
    "pointLeft",
    "shrug",
    "prayerHands",
    "handsOpen",
    "sermonEmphasis",
  ],
};

export function applyBodyCues(vrm, time, cues) {
  // Half-open interval: a cue is active for [start, end), so two cues that
  // touch end-to-end don't both claim the exact boundary frame.
  const active = cues.filter((cue) => time >= cue.start && time < cue.end);

  // Accumulate contributions per bone instead of overwriting with .set(),
  // so overlapping cues (e.g. a head "nod" while a "shrug" gesture is also
  // active) blend together instead of the later cue silently winning.
  const accum = new Map();
  const add = (boneName, x = 0, y = 0, z = 0) => {
    const current = accum.get(boneName) || [0, 0, 0];
    accum.set(boneName, [current[0] + x, current[1] + y, current[2] + z]);
  };

  for (const cue of active) {
    const s = strength(cue, time);

    // Head cues
    if (cue.type === "head" && cue.action === "nod") add(VRMHumanBoneName.Head, Math.sin(time * 16) * 0.18 * s, 0, 0);
    if (cue.type === "head" && cue.action === "lookLeft") add(VRMHumanBoneName.Head, 0, 0.45 * s, 0);
    if (cue.type === "head" && cue.action === "lookRight") add(VRMHumanBoneName.Head, 0, -0.45 * s, 0);
    if (cue.type === "head" && cue.action === "lookDown") add(VRMHumanBoneName.Head, 0.4 * s, 0, 0);
    if (cue.type === "head" && cue.action === "lookShocked") {
      add(VRMHumanBoneName.Head, -0.3 * s, 0, 0);
      add(VRMHumanBoneName.Neck, -0.15 * s, 0, 0);
    }

    // Body cues
    if (cue.type === "body" && cue.action === "leanForward") { add(VRMHumanBoneName.Chest, 0.22 * s, 0, 0); add(VRMHumanBoneName.Spine, 0.12 * s, 0, 0); }
    if (cue.type === "body" && cue.action === "leanBack") { add(VRMHumanBoneName.Chest, -0.2 * s, 0, 0); add(VRMHumanBoneName.Spine, -0.1 * s, 0, 0); }

    // Gesture cues
    if (cue.type === "gesture" && cue.action === "rightHandOut") { add(VRMHumanBoneName.RightUpperArm, -0.55 * s, 0, 0.55 * s); add(VRMHumanBoneName.RightLowerArm, -0.25 * s, 0, -0.2 * s); }
    if (cue.type === "gesture" && cue.action === "leftHandOut") { add(VRMHumanBoneName.LeftUpperArm, -0.55 * s, 0, -0.55 * s); add(VRMHumanBoneName.LeftLowerArm, -0.25 * s, 0, 0.2 * s); }
    if (cue.type === "gesture" && cue.action === "bothHandsOut") { add(VRMHumanBoneName.LeftUpperArm, -0.45 * s, 0, -0.5 * s); add(VRMHumanBoneName.RightUpperArm, -0.45 * s, 0, 0.5 * s); }

    if (cue.type === "gesture" && cue.action === "pointRight") {
      add(VRMHumanBoneName.RightUpperArm, -0.7 * s, 0.1 * s, 0.15 * s);
      add(VRMHumanBoneName.RightLowerArm, -0.05 * s, 0, 0);
    }
    if (cue.type === "gesture" && cue.action === "pointLeft") {
      add(VRMHumanBoneName.LeftUpperArm, -0.7 * s, -0.1 * s, -0.15 * s);
      add(VRMHumanBoneName.LeftLowerArm, -0.05 * s, 0, 0);
    }
    if (cue.type === "gesture" && cue.action === "shrug") {
      add(VRMHumanBoneName.LeftUpperArm, -0.35 * s, 0.1 * s, -0.75 * s);
      add(VRMHumanBoneName.RightUpperArm, -0.35 * s, -0.1 * s, 0.75 * s);
      add(VRMHumanBoneName.LeftLowerArm, -0.4 * s, 0, -0.3 * s);
      add(VRMHumanBoneName.RightLowerArm, -0.4 * s, 0, 0.3 * s);
      add(VRMHumanBoneName.Head, 0, 0, 0.05 * s);
    }
    if (cue.type === "gesture" && cue.action === "prayerHands") {
      add(VRMHumanBoneName.LeftUpperArm, -0.85 * s, 0.35 * s, -0.25 * s);
      add(VRMHumanBoneName.RightUpperArm, -0.85 * s, -0.35 * s, 0.25 * s);
      add(VRMHumanBoneName.LeftLowerArm, -1.5 * s, 0, 0);
      add(VRMHumanBoneName.RightLowerArm, -1.5 * s, 0, 0);
      add(VRMHumanBoneName.Head, 0.1 * s, 0, 0);
    }
    if (cue.type === "gesture" && cue.action === "handsOpen") {
      add(VRMHumanBoneName.LeftUpperArm, -0.4 * s, -0.15 * s, -0.7 * s);
      add(VRMHumanBoneName.RightUpperArm, -0.4 * s, 0.15 * s, 0.7 * s);
      add(VRMHumanBoneName.LeftLowerArm, -0.2 * s, 0, -0.15 * s);
      add(VRMHumanBoneName.RightLowerArm, -0.2 * s, 0, 0.15 * s);
    }
    if (cue.type === "gesture" && cue.action === "sermonEmphasis") {
      const secondsIn = time - cue.start;
      const punch = Math.exp(-secondsIn * 6) * 0.06;
      add(VRMHumanBoneName.Chest, 0.15 * s + punch, 0, 0);
      add(VRMHumanBoneName.RightUpperArm, -0.6 * s, 0, 0.42 * s);
      add(VRMHumanBoneName.RightLowerArm, -0.35 * s, 0, -0.1 * s);
      add(VRMHumanBoneName.Head, 0.08 * s, 0, 0);
    }
  }

  for (const [boneName, [x, y, z]] of accum) {
    rot(vrm, boneName, x, y, z);
  }
}

export function applyMovementPreset(vrm, time, preset = "neutral") {
  const talk = Math.sin(time * 5);
  const slow = Math.sin(time * 1.4);
  const emphasis = Math.max(0, Math.sin(time * 2.2));

  if (preset === "neutral") {
    rot(vrm, VRMHumanBoneName.Head, Math.sin(time * 0.8) * 0.025, Math.sin(time * 0.6) * 0.035, 0);
  }

  if (preset === "talking") {
    rot(vrm, VRMHumanBoneName.Head, talk * 0.04, slow * 0.08, slow * 0.02);
    rot(vrm, VRMHumanBoneName.Chest, emphasis * 0.04, 0, slow * 0.035);
  }

  if (preset === "energetic") {
    rot(vrm, VRMHumanBoneName.Head, talk * 0.08, slow * 0.14, slow * 0.04);
    rot(vrm, VRMHumanBoneName.Chest, emphasis * 0.08, 0, slow * 0.07);
    rot(vrm, VRMHumanBoneName.RightUpperArm, -0.12 * emphasis, 0, 0.18 + 0.27 * emphasis);
  }

  if (preset === "sermon") {
    rot(vrm, VRMHumanBoneName.Head, talk * 0.035, slow * 0.06, 0);
    rot(vrm, VRMHumanBoneName.Chest, 0.06 + emphasis * 0.07, 0, slow * 0.02);
    rot(vrm, VRMHumanBoneName.RightUpperArm, -0.18 * emphasis, 0, 0.15 + 0.23 * emphasis);
  }

  if (preset === "dramatic") {
    rot(vrm, VRMHumanBoneName.Head, slow * 0.09, Math.sin(time * 0.45) * 0.18, slow * 0.055);
    rot(vrm, VRMHumanBoneName.Chest, emphasis * 0.12, 0, Math.sin(time * 0.8) * 0.08);
  }
}
