import { GESTURE_ACTIONS } from "./bodyCues.js";

const VOWEL_SHAPE = [
  { letters: "a", shape: "aa" },
  { letters: "e", shape: "ee" },
  { letters: "i", shape: "ih" },
  { letters: "o", shape: "oh" },
  { letters: "u", shape: "ou" },
];

function shapeForWord(word) {
  const lower = word.toLowerCase();

  for (const char of lower) {
    const match = VOWEL_SHAPE.find((entry) => entry.letters === char);
    if (match) return match.shape;
  }

  return "aa";
}

function splitIntoSentences(transcript) {
  return transcript
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function splitIntoWords(sentence) {
  return sentence
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

/**
 * Turn a transcript + known audio duration into an approximate set of mouth
 * cues (visemes) and a light sprinkling of head/gesture cues, entirely
 * client-side. This is a rough, proportional-timing estimate, not a real
 * forced-aligner substitute -- it is meant to give a reasonable starting
 * point without leaving the browser (the npm/Rhubarb scripts remain
 * available for a more accurate pass).
 */
export function generateCuesFromTranscript(transcript, durationSeconds) {
  const cleanTranscript = String(transcript || "").trim();
  const duration = Number(durationSeconds);

  if (!cleanTranscript) {
    return { mouthCues: [], bodyCues: [], wordCount: 0 };
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Load audio with a known duration before generating cues from the transcript.");
  }

  const sentences = splitIntoSentences(cleanTranscript);
  const words = [];

  sentences.forEach((sentence, sentenceIndex) => {
    splitIntoWords(sentence).forEach((word, wordIndex) => {
      words.push({
        word,
        sentenceIndex,
        isSentenceStart: wordIndex === 0,
      });
    });
  });

  if (words.length === 0) {
    return { mouthCues: [], bodyCues: [], wordCount: 0 };
  }

  const weights = words.map((entry) => Math.max(2, entry.word.replace(/[^a-zA-Z]/g, "").length));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const secondsPerWeight = duration / totalWeight;

  const mouthCues = [];
  const bodyCues = [];
  const gestureActions = GESTURE_ACTIONS.gesture;
  const headActions = ["nod", "lookLeft", "lookRight"];

  let cursor = 0;
  let gestureCounter = 0;

  words.forEach((entry, index) => {
    const slot = weights[index] * secondsPerWeight;
    const gap = Math.min(slot * 0.18, 0.12);
    const start = cursor;
    const end = Math.max(start + 0.05, cursor + slot - gap);

    mouthCues.push({
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      shape: shapeForWord(entry.word),
      value: 0.75,
    });

    if (entry.isSentenceStart && index > 0) {
      const headAction = headActions[entry.sentenceIndex % headActions.length];
      bodyCues.push({
        type: "head",
        action: headAction,
        start: Number(start.toFixed(3)),
        end: Number((start + Math.min(0.6, slot)).toFixed(3)),
        intensity: 0.55,
      });

      if (entry.sentenceIndex > 0 && entry.sentenceIndex % 3 === 0) {
        const action = gestureActions[gestureCounter % gestureActions.length];
        gestureCounter += 1;
        bodyCues.push({
          type: "gesture",
          action,
          start: Number(start.toFixed(3)),
          end: Number((start + Math.min(0.9, slot * 1.5)).toFixed(3)),
          intensity: 0.6,
        });
      }
    }

    cursor += slot;
  });

  return { mouthCues, bodyCues, wordCount: words.length };
}
