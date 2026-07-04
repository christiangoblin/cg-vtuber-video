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

export function applyBodyCues(vrm, time, cues) {
  const active = cues.filter((cue) => time >= cue.start && time <= cue.end);
  for (const cue of active) {
    const s = strength(cue, time);
    if (cue.type === "head" && cue.action === "nod") rot(vrm, VRMHumanBoneName.Head, Math.sin(time * 16) * 0.18 * s, 0, 0);
    if (cue.type === "head" && cue.action === "lookLeft") rot(vrm, VRMHumanBoneName.Head, 0, 0.45 * s, 0);
    if (cue.type === "head" && cue.action === "lookRight") rot(vrm, VRMHumanBoneName.Head, 0, -0.45 * s, 0);
    if (cue.type === "body" && cue.action === "leanForward") { rot(vrm, VRMHumanBoneName.Chest, 0.22 * s, 0, 0); rot(vrm, VRMHumanBoneName.Spine, 0.12 * s, 0, 0); }
    if (cue.type === "gesture" && cue.action === "rightHandOut") { rot(vrm, VRMHumanBoneName.RightUpperArm, -0.55 * s, 0, 0.55 * s); rot(vrm, VRMHumanBoneName.RightLowerArm, -0.25 * s, 0, -0.2 * s); }
    if (cue.type === "gesture" && cue.action === "leftHandOut") { rot(vrm, VRMHumanBoneName.LeftUpperArm, -0.55 * s, 0, -0.55 * s); rot(vrm, VRMHumanBoneName.LeftLowerArm, -0.25 * s, 0, 0.2 * s); }
    if (cue.type === "gesture" && cue.action === "bothHandsOut") { rot(vrm, VRMHumanBoneName.LeftUpperArm, -0.45 * s, 0, -0.5 * s); rot(vrm, VRMHumanBoneName.RightUpperArm, -0.45 * s, 0, 0.5 * s); }
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
    rot(vrm, VRMHumanBoneName.RightUpperArm, -0.12 * emphasis, 0, 0.45);
  }

  if (preset === "sermon") {
    rot(vrm, VRMHumanBoneName.Head, talk * 0.035, slow * 0.06, 0);
    rot(vrm, VRMHumanBoneName.Chest, 0.06 + emphasis * 0.07, 0, slow * 0.02);
    rot(vrm, VRMHumanBoneName.RightUpperArm, -0.18 * emphasis, 0, 0.38);
  }

  if (preset === "dramatic") {
    rot(vrm, VRMHumanBoneName.Head, slow * 0.09, Math.sin(time * 0.45) * 0.18, slow * 0.055);
    rot(vrm, VRMHumanBoneName.Chest, emphasis * 0.12, 0, Math.sin(time * 0.8) * 0.08);
  }
}
