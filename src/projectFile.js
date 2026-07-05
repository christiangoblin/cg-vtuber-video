// Bundles everything needed to resume a session (audio, transcript, avatars,
// cues, camera framing, background) into one portable JSON "project" file.
// Uploaded (blob:) assets are inlined as base64 data URLs so the file is
// fully self-contained; built-in assets are stored by their public path.

export const PROJECT_FORMAT_VERSION = 1;

async function urlToDataUrl(url) {
  const response = await fetch(url);
  const blob = await response.blob();

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read asset for project export."));
    reader.readAsDataURL(blob);
  });
}

function isBlobUrl(url) {
  return typeof url === "string" && url.startsWith("blob:");
}

export async function buildProjectFile(state) {
  const {
    audioSrc,
    audioIsUploaded,
    transcriptText,
    transcriptFileName,
    avatars,
    activeAvatarId,
    lipSyncMode,
    movementPreset,
    breathingStyle,
    backgroundMode,
    showGrid,
    framing,
    mouthCues,
    timelineCues,
    cueFileName,
  } = state;

  const audio = {
    fileName: audioIsUploaded ? "uploaded-audio" : null,
    src: isBlobUrl(audioSrc) ? await urlToDataUrl(audioSrc) : audioSrc,
    isEmbedded: isBlobUrl(audioSrc),
  };

  const avatarEntries = await Promise.all(
    avatars.map(async (avatar) => ({
      id: avatar.id,
      name: avatar.name,
      src: isBlobUrl(avatar.url) ? await urlToDataUrl(avatar.url) : avatar.url,
      isEmbedded: isBlobUrl(avatar.url),
    }))
  );

  const project = {
    formatVersion: PROJECT_FORMAT_VERSION,
    savedAt: new Date().toISOString(),
    audio,
    transcript: { text: transcriptText, fileName: transcriptFileName },
    avatars: avatarEntries,
    activeAvatarId,
    scene: {
      lipSyncMode,
      movementPreset,
      breathingStyle,
      backgroundMode,
      showGrid,
      framing,
    },
    cues: {
      fileName: cueFileName,
      mouthCues,
      timeline: timelineCues.map(({ id: _id, ...rest }) => rest),
    },
  };

  return new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
}

export function parseProjectFile(jsonText) {
  const data = JSON.parse(jsonText);

  if (!data || typeof data !== "object" || !data.scene || !data.cues) {
    throw new Error("This doesn't look like a valid project file.");
  }

  return data;
}
