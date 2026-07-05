import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMHumanBoneName } from "@pixiv/three-vrm";
import "./App.css";
import { applyBodyCues, normalizeBodyCueFile, applyMovementPreset, GESTURE_ACTIONS } from "./bodyCues.js";
import { generateCuesFromTranscript } from "./transcriptCues.js";
import { buildProjectFile, parseProjectFile } from "./projectFile.js";
import { createZipBlob, downloadBlob } from "./zipUtils.js";

function setBoneRotation(vrm, boneName, x = 0, y = 0, z = 0) {
  const bone = vrm.humanoid?.getNormalizedBoneNode(boneName);

  if (!bone) {
    console.warn("Missing bone:", boneName);
    return;
  }

  bone.rotation.set(x, y, z);
}

function applyRelaxedPose(vrm) {
  setBoneRotation(vrm, VRMHumanBoneName.LeftUpperArm, 0, 0, -Math.PI * 0.32);
  setBoneRotation(vrm, VRMHumanBoneName.RightUpperArm, 0, 0, Math.PI * 0.32);

  setBoneRotation(vrm, VRMHumanBoneName.LeftLowerArm, 0, 0, Math.PI * 0.08);
  setBoneRotation(vrm, VRMHumanBoneName.RightLowerArm, 0, 0, -Math.PI * 0.08);

  setBoneRotation(vrm, VRMHumanBoneName.LeftHand, 0, 0, Math.PI * 0.03);
  setBoneRotation(vrm, VRMHumanBoneName.RightHand, 0, 0, -Math.PI * 0.03);
}

const BREATHING_STYLES = {
  normal: { rate: 2.0, sway: 0.8, ampY: 0.006, ampSpine: 0.012, ampChest: 0.018 },
  calm: { rate: 1.2, sway: 0.5, ampY: 0.004, ampSpine: 0.008, ampChest: 0.012 },
  energetic: { rate: 3.0, sway: 1.1, ampY: 0.008, ampSpine: 0.016, ampChest: 0.024 },
  deep: { rate: 1.0, sway: 0.6, ampY: 0.009, ampSpine: 0.02, ampChest: 0.03 },
};

function applyIdleAnimation(vrm, time, style = "normal") {
  const cfg = BREATHING_STYLES[style] ?? BREATHING_STYLES.normal;

  const breath = Math.sin(time * cfg.rate);
  const slowSway = Math.sin(time * cfg.sway);
  const headTurn = Math.sin(time * 0.7);
  const headNod = Math.sin(time * 0.55);

  vrm.scene.position.y = breath * cfg.ampY;

  setBoneRotation(vrm, VRMHumanBoneName.Spine, breath * cfg.ampSpine, 0, slowSway * 0.01);
  setBoneRotation(vrm, VRMHumanBoneName.Chest, breath * cfg.ampChest, 0, slowSway * 0.012);
  setBoneRotation(vrm, VRMHumanBoneName.Neck, headNod * 0.012, headTurn * 0.018, 0);
  setBoneRotation(vrm, VRMHumanBoneName.Head, headNod * 0.025, headTurn * 0.045, slowSway * 0.012);
}

function hasExpression(vrm, name) {
  return Boolean(vrm.expressionManager?.getExpression(name));
}

function setExpression(vrm, name, value) {
  if (!vrm.expressionManager) return;
  if (!hasExpression(vrm, name)) return;

  vrm.expressionManager.setValue(name, value);
}

function applyBlinking(vrm, time) {
  const blinkInterval = 4.0;
  const blinkDuration = 0.16;
  const blinkTime = time % blinkInterval;

  let blinkValue = 0;

  if (blinkTime < blinkDuration) {
    const blinkProgress = blinkTime / blinkDuration;
    blinkValue = Math.sin(blinkProgress * Math.PI);
  }

  if (hasExpression(vrm, "blink")) {
    setExpression(vrm, "blink", blinkValue);
  } else {
    setExpression(vrm, "blinkLeft", blinkValue);
    setExpression(vrm, "blinkRight", blinkValue);
  }
}

function resetMouthExpressions(vrm) {
  setExpression(vrm, "aa", 0);
  setExpression(vrm, "ih", 0);
  setExpression(vrm, "ou", 0);
  setExpression(vrm, "ee", 0);
  setExpression(vrm, "oh", 0);
}

// Picks the most relevant cue active at `time` out of possibly-overlapping
// cues. Uses a half-open interval [start, end) so two cues that touch
// end-to-end don't both claim the exact boundary frame, and deterministically
// prefers the cue with the latest start (rather than whichever happens to
// come first in the array) so cue order in a JSON file can't silently change
// playback.
function pickActiveCue(cues, time) {
  let best = null;

  for (const cue of cues) {
    if (time >= cue.start && time < cue.end) {
      if (!best || cue.start > best.start) {
        best = cue;
      }
    }
  }

  return best;
}

function applyMouthCues(vrm, audioTime, cues) {
  resetMouthExpressions(vrm);

  const activeCue = pickActiveCue(cues, audioTime);

  if (!activeCue) return;

  setExpression(vrm, activeCue.shape, activeCue.value ?? 0.8);
}

function applyLiveAudioMouth(vrm, analyser, dataArray, time) {
  resetMouthExpressions(vrm);

  if (!analyser || !dataArray) return;

  analyser.getByteTimeDomainData(dataArray);

  let sumSquares = 0;

  for (let i = 0; i < dataArray.length; i++) {
    const sample = (dataArray[i] - 128) / 128;
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / dataArray.length);

  if (rms < 0.018) {
    return;
  }

  const value = Math.min(0.95, Math.max(0.25, rms * 9));
  const shapes = ["aa", "ih", "oh", "ee", "ou"];
  const shape = shapes[Math.floor(time * 10) % shapes.length];

  setExpression(vrm, shape, value);
}

export default function App() {
  const mountRef = useRef(null);
  const audioRef = useRef(null);
  const rendererRef = useRef(null);
  const gridRef = useRef(null);
  const cameraRef = useRef(null);
  const framingRef = useRef({ zoom: 3, avatarHeight: 0, avatarX: 0, cameraAngle: 0 });
  const backgroundModeRef = useRef("dark");
  const recorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const recordedVideoBlobRef = useRef(null);
  const autoStopOnEndRef = useRef(true);
  const recordingStartedAtRef = useRef(null);
  const recordingTimerIdRef = useRef(null);

  const audioContextRef = useRef(null);
  const audioSourceRef = useRef(null);
  const audioDestinationRef = useRef(null);
  const audioAnalyserRef = useRef(null);
  const audioDataRef = useRef(null);

  const mouthCuesRef = useRef([]);
  const bodyCuesRef = useRef([]);
  const movementPresetRef = useRef("talking");
  const breathingStyleRef = useRef("normal");
  const uploadObjectUrlRef = useRef(null);
  const audioIsUploadedRef = useRef(false);
  // False until the person explicitly uploads a cue file, generates cues
  // from a transcript, or loads a project with saved cues. The demo cues
  // fetched from /cues/test-cues.json on startup don't count — they only
  // match the bundled test-audio.wav, so they shouldn't block switching to
  // live mic-style lip sync when the person uploads their own audio.
  const userMouthCuesLoadedRef = useRef(false);
  const lipSyncModeRef = useRef("cues");
  const sceneRef = useRef(null);
  const loaderRef = useRef(null);
  const currentVrmRef = useRef(null);
  const avatarObjectUrlsRef = useRef([]);
  const avatarsRef = useRef([{ id: "default", name: "ChristianGoblin", url: "/avatars/ChristianGoblin.vrm" }]);
  const activeAvatarIdRef = useRef("default");
  const avatarCuesRef = useRef([]);
  const presetCuesRef = useRef([]);
  const timelineCuesRef = useRef([]);
  const nextCueIdRef = useRef(1);
  const pendingAvatarIdRef = useRef(null);

  const [isRecording, setIsRecording] = useState(false);
  const [autoStopOnEnd, setAutoStopOnEnd] = useState(true);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [hasRecordedVideo, setHasRecordedVideo] = useState(false);
  const [projectStatus, setProjectStatus] = useState("");
  const [audioSrc, setAudioSrc] = useState("/audio/test-audio.wav");
  const [lipSyncMode, setLipSyncMode] = useState("cues");
  const [movementPreset, setMovementPreset] = useState("talking");
  const [breathingStyle, setBreathingStyle] = useState("normal");
  const [editingAvatarNames, setEditingAvatarNames] = useState({});
  const [cueFileName, setCueFileName] = useState("test-cues.json");
  const [transcriptText, setTranscriptText] = useState("");
  const [transcriptFileName, setTranscriptFileName] = useState("");
  const [avatars, setAvatars] = useState([{ id: "default", name: "ChristianGoblin", url: "/avatars/ChristianGoblin.vrm" }]);
  const [activeAvatarId, setActiveAvatarId] = useState("default");
  const [backgroundMode, setBackgroundMode] = useState("dark");
  const [showGrid, setShowGrid] = useState(true);
  const [framing, setFraming] = useState({ zoom: 3, avatarHeight: 0, avatarX: 0, cameraAngle: 0 });
  const [timelineCues, setTimelineCues] = useState([]);
  const [cueDraft, setCueDraft] = useState({
    category: "avatar",
    action: GESTURE_ACTIONS.head[0],
    avatarId: "default",
    preset: "talking",
    start: "0",
    end: "1",
    intensity: "0.7",
  });

  useEffect(() => {
    fetch("/cues/test-cues.json")
      .then((response) => response.json())
      .then((cues) => {
        mouthCuesRef.current = cues;
        console.log("Mouth cues loaded:", cues);
      })
      .catch((error) => {
        console.error("Failed to load mouth cues:", error);
      });

    const mount = mountRef.current;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x202020);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      30,
      mount.clientWidth / mount.clientHeight,
      0.1,
      100
    );

    camera.position.set(0, 1.4, 3);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
    });

    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(1, 2, 3);
    scene.add(light);

    const ambientLight = new THREE.AmbientLight(0xffffff, 1);
    scene.add(ambientLight);

    const grid = new THREE.GridHelper(10, 10);
    gridRef.current = grid;
    scene.add(grid);

    // React StrictMode intentionally mounts, cleans up, and remounts this
    // effect once in dev. Without this guard, a slow first-mount VRM load
    // could still resolve after cleanup and write a stale VRM into the
    // refs shared with the (already running) second mount.
    let cancelled = false;

    const loader = new GLTFLoader();
    loaderRef.current = loader;

    loader.register((parser) => {
      return new VRMLoaderPlugin(parser);
    });

    loader.load(
      "/avatars/ChristianGoblin.vrm",
      (gltf) => {
        if (cancelled) return;

        const currentVrm = gltf.userData.vrm;
        currentVrmRef.current = currentVrm;

        scene.add(currentVrm.scene);
        currentVrm.scene.rotation.y = 0;

        applyRelaxedPose(currentVrm);
        applyFramingSettings();

        console.log("VRM loaded:", currentVrm);
      },
      (progress) => {
        console.log("Loading:", Math.round((progress.loaded / progress.total) * 100) + "%");
      },
      (error) => {
        if (cancelled) return;
        console.error("Failed to load VRM:", error);
      }
    );

    const clock = new THREE.Clock();
    let elapsedTime = 0;
    let animationFrameId = null;

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);

      const delta = clock.getDelta();
      elapsedTime += delta;

      if (audioRef.current && !audioRef.current.paused) {
        applyAvatarCues(audioRef.current.currentTime);
      }

      const currentVrm = currentVrmRef.current;

      if (currentVrm) {
        const audio = audioRef.current;

        applyRelaxedPose(currentVrm);
        applyIdleAnimation(currentVrm, elapsedTime, breathingStyleRef.current);

        if (audio && !audio.paused) {
          const time = audio.currentTime;
          const activeAvatarId = activeAvatarIdRef.current;

          // Run the movement preset as a continuous base layer every frame,
          // then layer any active head/body/gesture cues on top of it.
          // Previously the preset was skipped entirely while a body cue was
          // active, which made the avatar's talking/energetic motion visibly
          // cut out and then snap back the instant a short gesture cue
          // started or ended. Always running the preset underneath means
          // cues just take over their specific bones for their window and
          // hand back to a preset that never stopped running.
          const activePresetCue = pickActiveCue(presetCuesRef.current, time);
          applyMovementPreset(currentVrm, time, activePresetCue?.preset ?? movementPresetRef.current);

          const relevantBodyCues = bodyCuesRef.current.filter(
            (cue) => !cue.avatarId || cue.avatarId === activeAvatarId
          );

          const hasActiveBodyCue = relevantBodyCues.some(
            (cue) => time >= cue.start && time < cue.end
          );

          if (hasActiveBodyCue) {
            applyBodyCues(currentVrm, time, relevantBodyCues);
          }
        } else {
          applyMovementPreset(currentVrm, elapsedTime, "neutral");
        }

        applyBlinking(currentVrm, elapsedTime);

        if (audio && !audio.paused) {
          if (lipSyncModeRef.current === "live") {
            if (!audioAnalyserRef.current) {
              setupAudioGraph(audio);
            }

            applyLiveAudioMouth(
              currentVrm,
              audioAnalyserRef.current,
              audioDataRef.current,
              audio.currentTime
            );
          } else {
            applyMouthCues(currentVrm, audio.currentTime, mouthCuesRef.current);
          }
        } else {
          resetMouthExpressions(currentVrm);
        }

        currentVrm.update(delta);
      }

      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", handleResize);

      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }

      if (recordingTimerIdRef.current) {
        clearInterval(recordingTimerIdRef.current);
      }

      if (uploadObjectUrlRef.current) {
        URL.revokeObjectURL(uploadObjectUrlRef.current);
      }

      // Intentionally reading .current here: we want whatever avatar object
      // URLs have accumulated by unmount time, not a snapshot from mount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const url of avatarObjectUrlsRef.current) {
        URL.revokeObjectURL(url);
      }

      renderer.dispose();

      if (renderer.domElement && mount.contains(renderer.domElement)) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, []);

  function setupAudioGraph(audio) {
    if (!audio) {
      console.warn("No audio element found.");
      return [];
    }

    if (!audioContextRef.current) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioContextRef.current = new AudioContextClass();
    }

    const audioContext = audioContextRef.current;

    if (!audioSourceRef.current) {
      const source = audioContext.createMediaElementSource(audio);
      const destination = audioContext.createMediaStreamDestination();
      const analyser = audioContext.createAnalyser();

      analyser.fftSize = 1024;

      source.connect(analyser);
      analyser.connect(audioContext.destination);
      source.connect(destination);

      audioSourceRef.current = source;
      audioDestinationRef.current = destination;
      audioAnalyserRef.current = analyser;
      audioDataRef.current = new Uint8Array(analyser.fftSize);
    }

    return audioDestinationRef.current.stream.getAudioTracks();
  }

  async function resumeAudioContextIfNeeded() {
    if (audioContextRef.current?.state === "suspended") {
      await audioContextRef.current.resume();
    }
  }

  function getAudioTracksForRecording(audio) {
    const tracks = setupAudioGraph(audio);
    console.log("Audio tracks for recorder:", tracks);
    return tracks;
  }

  async function startRecording() {
    const renderer = rendererRef.current;
    const audio = audioRef.current;

    if (!renderer) {
      console.error("Renderer is not ready yet.");
      return;
    }

    const canvas = renderer.domElement;
    const canvasStream = canvas.captureStream(30);

    const audioTracks = getAudioTracksForRecording(audio);

    await resumeAudioContextIfNeeded();

    const combinedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...audioTracks,
    ]);

    console.log("Combined stream tracks:", combinedStream.getTracks());

    recordedChunksRef.current = [];

    const preferredMimeType = "video/webm;codecs=vp8,opus";
    const fallbackMimeType = "video/webm";

    const mimeType = MediaRecorder.isTypeSupported(preferredMimeType)
      ? preferredMimeType
      : fallbackMimeType;

    const recorder = new MediaRecorder(combinedStream, {
      mimeType,
    });

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunksRef.current.push(event.data);
      }
    };

    recorder.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, {
        type: "video/webm",
      });

      recordedVideoBlobRef.current = blob;
      setHasRecordedVideo(true);

      downloadBlob(blob, "vtuber-video.webm");
    };

    recorderRef.current = recorder;

    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }

    recorder.start();
    setIsRecording(true);
    setHasRecordedVideo(false);
    recordedVideoBlobRef.current = null;

    recordingStartedAtRef.current = Date.now();
    setRecordingElapsed(0);

    if (recordingTimerIdRef.current) {
      clearInterval(recordingTimerIdRef.current);
    }

    recordingTimerIdRef.current = setInterval(() => {
      if (recordingStartedAtRef.current) {
        setRecordingElapsed((Date.now() - recordingStartedAtRef.current) / 1000);
      }
    }, 200);

    if (audio) {
      try {
        await audio.play();
      } catch (error) {
        console.error("Audio play failed:", error);
      }
    }

    console.log("Recording started.");
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    const audio = audioRef.current;

    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }

    if (audio) {
      audio.pause();
    }

    if (recordingTimerIdRef.current) {
      clearInterval(recordingTimerIdRef.current);
      recordingTimerIdRef.current = null;
    }

    recordingStartedAtRef.current = null;
    setIsRecording(false);

    console.log("Recording stopped.");
  }

  function handleAudioEnded() {
    if (recorderRef.current && recorderRef.current.state !== "inactive" && autoStopOnEndRef.current) {
      console.log("Audio finished — auto-stopping recording.");
      stopRecording();
    }
  }

  function handleAutoStopOnEndChange(event) {
    const checked = event.target.checked;
    autoStopOnEndRef.current = checked;
    setAutoStopOnEnd(checked);
  }

  function applyBackgroundSettings(mode = backgroundModeRef.current, gridVisible = showGrid) {
    const scene = sceneRef.current;
    const grid = gridRef.current;

    backgroundModeRef.current = mode;

    const colors = {
      dark: 0x202020,
      green: 0x00ff00,
      white: 0xffffff,
      gray: 0x808080,
      blue: 0x5d7ea0,
    };

    if (scene) {
      scene.background = new THREE.Color(colors[mode] ?? colors.dark);
    }

    if (grid) {
      grid.visible = gridVisible;
    }
  }

  function handleBackgroundModeChange(event) {
    const mode = event.target.value;
    setBackgroundMode(mode);
    applyBackgroundSettings(mode, showGrid);
  }

  function handleShowGridChange(event) {
    const checked = event.target.checked;
    setShowGrid(checked);
    applyBackgroundSettings(backgroundModeRef.current, checked);
  }

  function applyFramingSettings(nextFraming = framingRef.current) {
    const settings = { ...framingRef.current, ...nextFraming };
    framingRef.current = settings;

    const camera = cameraRef.current;
    const avatarScene = currentVrmRef.current?.scene;
    const zoom = Number(settings.zoom) || 3;
    const angle = THREE.MathUtils.degToRad(Number(settings.cameraAngle) || 0);

    if (camera) {
      camera.position.set(Math.sin(angle) * zoom, 1.4, Math.cos(angle) * zoom);
      camera.lookAt(0, 1.25, 0);
    }

    if (avatarScene) {
      avatarScene.position.set(Number(settings.avatarX) || 0, Number(settings.avatarHeight) || 0, 0);
    }
  }

  function handleFramingChange(key, value) {
    const next = { ...framingRef.current, [key]: Number(value) };
    framingRef.current = next;
    setFraming(next);
    applyFramingSettings(next);
  }

  function findAvatarForCue(cue) {
    if (!cue) {
      return null;
    }

    if (cue.avatarId) {
      return avatarsRef.current.find((avatar) => avatar.id === cue.avatarId) || null;
    }

    if (cue.avatarName) {
      const wanted = String(cue.avatarName).toLowerCase();
      return avatarsRef.current.find((avatar) => avatar.name.toLowerCase() === wanted) || null;
    }

    return null;
  }

  function applyAvatarCues(time) {
    const cue = pickActiveCue(avatarCuesRef.current, time);
    const avatar = findAvatarForCue(cue);

    if (!avatar) {
      return;
    }

    if (avatar.id === activeAvatarIdRef.current || avatar.id === pendingAvatarIdRef.current) {
      return;
    }

    pendingAvatarIdRef.current = avatar.id;
    loadAvatar(avatar);
  }

  function loadAvatar(avatar) {
    const scene = sceneRef.current;
    const loader = loaderRef.current;

    if (!scene || !loader || !avatar) {
      return;
    }

    // Keep the current avatar in place until the new one has actually
    // loaded, so a failed/broken avatar URL doesn't blank the scene.
    const previousVrm = currentVrmRef.current;

    loader.load(
      avatar.url,
      (gltf) => {
        const nextVrm = gltf.userData.vrm;

        if (previousVrm?.scene) {
          scene.remove(previousVrm.scene);
        }

        currentVrmRef.current = nextVrm;
        scene.add(nextVrm.scene);
        nextVrm.scene.rotation.y = 0;
        applyRelaxedPose(nextVrm);
        applyFramingSettings();
        activeAvatarIdRef.current = avatar.id;
        setActiveAvatarId(avatar.id);
        pendingAvatarIdRef.current = null;
        console.log("Avatar loaded:", avatar.name, nextVrm);
      },
      undefined,
      (error) => {
        console.error("Failed to load avatar:", error);
        pendingAvatarIdRef.current = null;
        alert("Failed to load avatar. Make sure it is a valid VRM file. Keeping the current avatar.");
      }
    );
  }

  function handleAvatarUpload(event) {
    const files = Array.from(event.target.files || []).filter((file) => file.name.toLowerCase().endsWith(".vrm"));

    if (files.length === 0) {
      return;
    }

    const roomLeft = Math.max(0, 5 - avatarsRef.current.length);
    const acceptedFiles = files.slice(0, roomLeft);

    if (acceptedFiles.length === 0) {
      alert("You can upload up to 5 avatars total.");
      return;
    }

    if (acceptedFiles.length < files.length) {
      alert(
        `You can upload up to 5 avatars total. Added ${acceptedFiles.length} of ${files.length} — ` +
        `the rest were skipped.`
      );
    }

    const newAvatars = acceptedFiles.map((file, index) => {
      const url = URL.createObjectURL(file);
      avatarObjectUrlsRef.current.push(url);

      return {
        id: `uploaded-${Date.now()}-${index}`,
        name: file.name.replace(/\.vrm$/i, ""),
        url,
      };
    });

    avatarsRef.current = [...avatarsRef.current, ...newAvatars];
    setAvatars(avatarsRef.current);
    loadAvatar(newAvatars[0]);
  }

  function handleActiveAvatarChange(event) {
    const avatar = avatarsRef.current.find((item) => item.id === event.target.value);
    if (avatar) {
      loadAvatar(avatar);
    }
  }

  function handleLipSyncModeChange(event) {
    const nextMode = event.target.value;
    lipSyncModeRef.current = nextMode;
    setLipSyncMode(nextMode);
  }

  function handleAudioUpload(event) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (uploadObjectUrlRef.current) {
      URL.revokeObjectURL(uploadObjectUrlRef.current);
    }

    const url = URL.createObjectURL(file);
    uploadObjectUrlRef.current = url;

    setAudioSrc(url);
    audioIsUploadedRef.current = true;

    // Only switch to live lip sync automatically if the person hasn't
    // actually loaded their own mouth cues — otherwise uploading new audio
    // would silently throw away cues they already built for their script.
    // Note this checks userMouthCuesLoadedRef, not mouthCuesRef.length: the
    // bundled demo cues from test-cues.json are loaded into mouthCuesRef on
    // startup and are non-empty, but they only line up with the bundled
    // test-audio.wav. Checking length alone left them in place and applied
    // to the newly uploaded audio, which just looked like the mouth wasn't
    // reacting to the new audio at all.
    if (!userMouthCuesLoadedRef.current) {
      mouthCuesRef.current = [];
      lipSyncModeRef.current = "live";
      setLipSyncMode("live");
    }

    const audio = audioRef.current;

    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audio.load();
    }

    console.log("Uploaded audio file:", file.name);
  }

  const MOUTH_SHAPES = new Set(["aa", "ih", "ou", "ee", "oh"]);

  function normalizeCueFile(data) {
    let cues;

    if (Array.isArray(data)) {
      cues = data;
    } else if (Array.isArray(data.mouthCues)) {
      cues = data.mouthCues;
    } else if (Array.isArray(data.timeline)) {
      cues = data.timeline.filter((cue) => {
        return cue.type === "mouth" || cue.shape;
      }).map((cue) => ({
        start: cue.start,
        end: cue.end,
        shape: cue.shape,
        value: cue.value ?? 0.85
      }));
    } else {
      throw new Error("Cue file must be an array, or an object with mouthCues/timeline.");
    }

    const usable = cues.filter((cue) => MOUTH_SHAPES.has(cue.shape));

    if (cues.length > 0 && usable.length === 0) {
      throw new Error(
        "This cue file doesn't contain usable mouth shapes (aa/ih/ou/ee/oh). If this is a raw " +
        "Rhubarb export (letter codes like X/A/B/C in a \"value\" field), convert it first with " +
        "`npm run mouth` (scripts/convert-rhubarb-to-vrm.mjs) and upload the converted file instead."
      );
    }

    return usable;
  }

  function normalizeAvatarCueFile(data) {
    const source = Array.isArray(data)
      ? data
      : Array.isArray(data.avatarCues)
        ? data.avatarCues
        : Array.isArray(data.timeline)
          ? data.timeline
          : [];

    return source
      .filter((cue) => cue.type === "avatar")
      .map((cue) => ({
        start: Number(cue.start ?? 0),
        end: Number(cue.end ?? cue.start ?? 0),
        avatarId: cue.avatarId ?? null,
        avatarName: cue.avatarName ?? cue.name ?? null,
      }));
  }

  function normalizePresetCueFile(data) {
    const source = Array.isArray(data) ? data : Array.isArray(data.timeline) ? data.timeline : [];

    return source
      .filter((cue) => cue.type === "preset")
      .map((cue) => ({
        start: Number(cue.start ?? 0),
        end: Number(cue.end ?? cue.start ?? 0),
        preset: cue.preset ?? "neutral",
      }));
  }

  function newCueId() {
    return `cue-${nextCueIdRef.current++}`;
  }

  function syncDerivedCueRefs() {
    const all = timelineCuesRef.current;
    bodyCuesRef.current = all.filter((cue) => cue.type === "head" || cue.type === "body" || cue.type === "gesture");
    avatarCuesRef.current = all.filter((cue) => cue.type === "avatar");
    presetCuesRef.current = all.filter((cue) => cue.type === "preset");
  }

  function addTimelineCue(cue) {
    const withId = { ...cue, id: newCueId() };
    timelineCuesRef.current = [...timelineCuesRef.current, withId];
    syncDerivedCueRefs();
    setTimelineCues(timelineCuesRef.current);
  }

  function removeTimelineCue(id) {
    timelineCuesRef.current = timelineCuesRef.current.filter((cue) => cue.id !== id);
    syncDerivedCueRefs();
    setTimelineCues(timelineCuesRef.current);
  }

  function handleCueCategoryChange(event) {
    const category = event.target.value;
    setCueDraft((prev) => ({
      ...prev,
      category,
      action: ["head", "body", "gesture"].includes(category) ? GESTURE_ACTIONS[category][0] : prev.action,
    }));
  }

  function handleAddCue(event) {
    event.preventDefault();

    const start = Number(cueDraft.start);
    const end = Number(cueDraft.end);

    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      alert("Enter a valid start/end time (end must be greater than or equal to start).");
      return;
    }

    if (cueDraft.category === "avatar") {
      const avatar = avatarsRef.current.find((item) => item.id === cueDraft.avatarId);
      addTimelineCue({
        type: "avatar",
        start,
        end,
        avatarId: cueDraft.avatarId,
        avatarName: avatar?.name ?? null,
      });
    } else if (cueDraft.category === "preset") {
      addTimelineCue({ type: "preset", start, end, preset: cueDraft.preset });
    } else {
      addTimelineCue({
        type: cueDraft.category,
        action: cueDraft.action,
        start,
        end,
        intensity: Number(cueDraft.intensity) || 0.7,
      });
    }
  }

  function describeCue(cue) {
    if (cue.type === "avatar") {
      return `Switch avatar to ${cue.avatarName || cue.avatarId || "?"}`;
    }
    if (cue.type === "preset") {
      return `Movement preset: ${cue.preset}`;
    }
    return `${cue.type} gesture: ${cue.action}`;
  }

  function downloadTimelineJson() {
    const timeline = timelineCuesRef.current.map(({ id: _id, ...rest }) => rest);
    const blob = new Blob([JSON.stringify({ timeline }, null, 2)], {
      type: "application/json",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "timeline-cues.json";
    link.click();

    URL.revokeObjectURL(url);
  }

  function handleCueUpload(event) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const reader = new FileReader();

    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || "[]"));
        const normalized = normalizeCueFile(parsed);
        const bodyCues = normalizeBodyCueFile(parsed);
        const avatarCues = normalizeAvatarCueFile(parsed).map((cue) => ({ ...cue, type: "avatar" }));
        const presetCues = normalizePresetCueFile(parsed).map((cue) => ({ ...cue, type: "preset" }));

        if (normalized.length > 0) {
          mouthCuesRef.current = normalized;
          userMouthCuesLoadedRef.current = true;
        }

        const combined = [...bodyCues, ...avatarCues, ...presetCues].map((cue) => ({
          ...cue,
          id: newCueId(),
        }));

        timelineCuesRef.current = combined;
        syncDerivedCueRefs();
        setTimelineCues(combined);
        setCueFileName(file.name);

        if (normalized.length > 0) {
          lipSyncModeRef.current = "cues";
          setLipSyncMode("cues");
        }

        console.log("Loaded custom cue file:", file.name, { mouthCues: normalized, timeline: combined });
      } catch (error) {
        console.error("Failed to load cue file:", error);
        alert("Failed to load cue file. Check that it is valid JSON.");
      }
    };

    reader.onerror = () => {
      console.error("Failed to read cue file:", file.name);
    };

    reader.readAsText(file);
  }

  function handleTranscriptUpload(event) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const reader = new FileReader();

    reader.onload = () => {
      setTranscriptText(String(reader.result || ""));
      setTranscriptFileName(file.name);
      console.log("Loaded transcript file:", file.name);
    };

    reader.onerror = () => {
      console.error("Failed to read transcript file:", file.name);
    };

    reader.readAsText(file);
  }

  function clearTranscript() {
    setTranscriptText("");
    setTranscriptFileName("");
  }

  function downloadTranscript() {
    const blob = new Blob([transcriptText], {
      type: "text/plain",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = transcriptFileName || "transcript.txt";
    link.click();

    URL.revokeObjectURL(url);
  }

  async function handleAudioPlay() {
    setupAudioGraph(audioRef.current);
    await resumeAudioContextIfNeeded();
  }
  function handleMovementPresetChange(event) {
    const preset = event.target.value;
    movementPresetRef.current = preset;
    setMovementPreset(preset);
  }

  function handleBreathingStyleChange(event) {
    const style = event.target.value;
    breathingStyleRef.current = style;
    setBreathingStyle(style);
  }

  // Browsers often don't populate audio.duration until metadata has loaded,
  // which may not have happened yet if the person just picked a file/loaded
  // the page without pressing play. Wait briefly for it instead of forcing
  // them to play the audio first just to "unlock" its duration.
  function waitForAudioDuration(audio, timeoutMs = 4000) {
    return new Promise((resolve) => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        resolve(audio.duration);
        return;
      }

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        audio.removeEventListener("loadedmetadata", onLoaded);
        clearTimeout(timer);
        resolve(value);
      };

      const onLoaded = () => finish(audio.duration);
      audio.addEventListener("loadedmetadata", onLoaded);

      const timer = setTimeout(() => finish(audio.duration), timeoutMs);

      // Nudge the browser to fetch metadata if it hasn't already.
      if (audio.readyState === 0) {
        audio.load();
      }
    });
  }

  async function handleGenerateCuesFromTranscript() {
    const audio = audioRef.current;

    if (!transcriptText.trim()) {
      alert("Add or upload a transcript first.");
      return;
    }

    if (!audio) {
      alert("Load audio first.");
      return;
    }

    setProjectStatus("Reading audio duration…");
    const duration = await waitForAudioDuration(audio);

    if (!Number.isFinite(duration) || duration <= 0) {
      setProjectStatus("");
      alert("Couldn't read the audio's duration. Try playing it briefly, then generate cues again.");
      return;
    }

    setProjectStatus("");

    try {
      const { mouthCues, bodyCues, wordCount } = generateCuesFromTranscript(transcriptText, duration);

      mouthCuesRef.current = mouthCues;
      userMouthCuesLoadedRef.current = true;

      const withIds = bodyCues.map((cue) => ({ ...cue, id: newCueId() }));
      const keptCues = timelineCuesRef.current.filter(
        (cue) => cue.type === "avatar" || cue.type === "preset"
      );

      timelineCuesRef.current = [...keptCues, ...withIds];
      syncDerivedCueRefs();
      setTimelineCues(timelineCuesRef.current);

      setCueFileName(`generated from transcript (${wordCount} words)`);
      lipSyncModeRef.current = "cues";
      setLipSyncMode("cues");

      console.log("Generated cues from transcript:", { mouthCues, bodyCues });
    } catch (error) {
      console.error("Failed to generate cues from transcript:", error);
      alert(error.message || "Failed to generate cues from transcript.");
    }
  }

  function gatherProjectState() {
    return {
      audioSrc,
      audioIsUploaded: audioIsUploadedRef.current,
      transcriptText,
      transcriptFileName,
      avatars: avatarsRef.current,
      activeAvatarId,
      lipSyncMode,
      movementPreset,
      breathingStyle,
      backgroundMode,
      showGrid,
      framing,
      mouthCues: mouthCuesRef.current,
      timelineCues: timelineCuesRef.current,
      cueFileName,
    };
  }

  async function handleSaveProject() {
    try {
      setProjectStatus("Bundling project…");
      const blob = await buildProjectFile(gatherProjectState());
      downloadBlob(blob, "vtuber-project.json");
      setProjectStatus("Project saved.");
    } catch (error) {
      console.error("Failed to save project:", error);
      setProjectStatus("Failed to save project.");
      alert("Failed to save project. See console for details.");
    }
  }

  function restoreAvatarsFromProject(project) {
    const restored = project.avatars.map((avatar) => ({
      id: avatar.id,
      name: avatar.name,
      url: avatar.src,
    }));

    avatarsRef.current = restored.length > 0 ? restored : avatarsRef.current;
    setAvatars(avatarsRef.current);

    const target =
      avatarsRef.current.find((avatar) => avatar.id === project.activeAvatarId) || avatarsRef.current[0];

    if (target) {
      loadAvatar(target);
    }
  }

  function restoreCuesFromProject(project) {
    mouthCuesRef.current = Array.isArray(project.cues.mouthCues) ? project.cues.mouthCues : [];
    userMouthCuesLoadedRef.current = mouthCuesRef.current.length > 0;

    const withIds = (project.cues.timeline || []).map((cue) => ({ ...cue, id: newCueId() }));
    timelineCuesRef.current = withIds;
    syncDerivedCueRefs();
    setTimelineCues(withIds);
    setCueFileName(project.cues.fileName || "loaded project");
  }

  function restoreSceneFromProject(project) {
    const scene = project.scene || {};

    lipSyncModeRef.current = scene.lipSyncMode || "cues";
    setLipSyncMode(lipSyncModeRef.current);

    movementPresetRef.current = scene.movementPreset || "talking";
    setMovementPreset(movementPresetRef.current);

    breathingStyleRef.current = scene.breathingStyle || "normal";
    setBreathingStyle(breathingStyleRef.current);

    setBackgroundMode(scene.backgroundMode || "dark");
    setShowGrid(scene.showGrid ?? true);
    applyBackgroundSettings(scene.backgroundMode || "dark", scene.showGrid ?? true);

    const nextFraming = scene.framing || framingRef.current;
    setFraming(nextFraming);
    applyFramingSettings(nextFraming);
  }

  function handleLoadProjectFile(event) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const reader = new FileReader();

    reader.onload = () => {
      try {
        const project = parseProjectFile(String(reader.result || "{}"));

        if (project.audio?.src) {
          setAudioSrc(project.audio.src);
        }
        audioIsUploadedRef.current = Boolean(project.audio?.isEmbedded);

        setTranscriptText(project.transcript?.text || "");
        setTranscriptFileName(project.transcript?.fileName || "");

        restoreAvatarsFromProject(project);
        restoreCuesFromProject(project);
        restoreSceneFromProject(project);

        setProjectStatus(`Loaded project saved ${project.savedAt ? new Date(project.savedAt).toLocaleString() : ""}`);
        console.log("Loaded project file:", project);
      } catch (error) {
        console.error("Failed to load project file:", error);
        setProjectStatus("Failed to load project file.");
        alert(error.message || "Failed to load project file.");
      }
    };

    reader.onerror = () => {
      console.error("Failed to read project file:", file.name);
    };

    reader.readAsText(file);
  }

  async function handleDownloadBundle() {
    try {
      setProjectStatus("Building export bundle…");

      const files = [];

      if (recordedVideoBlobRef.current) {
        files.push({
          name: "vtuber-video.webm",
          data: await recordedVideoBlobRef.current.arrayBuffer(),
        });
      }

      if (transcriptText.trim()) {
        files.push({ name: "transcript.txt", data: transcriptText });
      }

      const cuesJson = {
        mouthCues: mouthCuesRef.current,
        timeline: timelineCuesRef.current.map(({ id: _id, ...rest }) => rest),
      };
      files.push({ name: "cues.json", data: JSON.stringify(cuesJson, null, 2) });

      const scenePreset = {
        lipSyncMode,
        movementPreset,
        breathingStyle,
        backgroundMode,
        showGrid,
        framing,
      };
      files.push({ name: "scene-preset.json", data: JSON.stringify(scenePreset, null, 2) });

      const projectBlob = await buildProjectFile(gatherProjectState());
      files.push({ name: "vtuber-project.json", data: await projectBlob.arrayBuffer() });

      const zipBlob = createZipBlob(files);
      downloadBlob(zipBlob, "vtuber-export-bundle.zip");

      setProjectStatus(
        recordedVideoBlobRef.current
          ? "Bundle downloaded (video + transcript + cues + project)."
          : "Bundle downloaded (no recorded video yet — record first to include one)."
      );
    } catch (error) {
      console.error("Failed to build export bundle:", error);
      setProjectStatus("Failed to build export bundle.");
      alert("Failed to build export bundle. See console for details.");
    }
  }

  function commitAvatarRename(avatarId, nextName) {
    const trimmed = nextName.trim();
    if (!trimmed) return;

    avatarsRef.current = avatarsRef.current.map((avatar) =>
      avatar.id === avatarId ? { ...avatar, name: trimmed } : avatar
    );

    setAvatars(avatarsRef.current);
  }


  return (
    <main className="app">
      <div className="viewer" ref={mountRef} />

      <div className="controls">
        <audio
          ref={audioRef}
          controls
          src={audioSrc}
          onPlay={handleAudioPlay}
          onEnded={handleAudioEnded}
        />

        <details className="panel-section" open>
          <summary>Audio &amp; Recording</summary>

          <div className="upload-row">
            <label>
              Upload audio:
              <input type="file" accept="audio/*" onChange={handleAudioUpload} />
            </label>
          </div>

          <div className="mode-row">
            <label>
              <input type="checkbox" checked={autoStopOnEnd} onChange={handleAutoStopOnEndChange} />
              Auto-stop recording when audio ends
            </label>
          </div>

          <div className="button-row">
            <button onClick={startRecording} disabled={isRecording}>
              Start Recording
            </button>

            <button onClick={stopRecording} disabled={!isRecording}>
              Stop Recording
            </button>
          </div>

          <div className="status-text">
            {isRecording
              ? `Recording… ${recordingElapsed.toFixed(1)}s elapsed`
              : hasRecordedVideo
                ? "Last recording ready (included in export bundle below)."
                : "Not recording. Start Recording plays the audio from 0:00 and captures video automatically."}
          </div>
        </details>

        <details className="panel-section">
          <summary>Avatars</summary>

          <div className="upload-row">
            <label>
              Upload avatars:
              <input type="file" accept=".vrm" multiple onChange={handleAvatarUpload} />
            </label>
          </div>

          <div className="mode-row">
            <label>
              Active Avatar:
              <select value={activeAvatarId} onChange={handleActiveAvatarChange}>
                {avatars.map((avatar) => (
                  <option key={avatar.id} value={avatar.id}>
                    {avatar.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mode-row avatar-manager">
            <strong>Avatar Manager</strong>
            <div className="status-text">
              Rename avatars here so avatarName cues in your timeline JSON are easy to write correctly.
            </div>

            {avatars.map((avatar) => (
              <div className="avatar-manager-row" key={avatar.id}>
                <input
                  type="text"
                  value={editingAvatarNames[avatar.id] ?? avatar.name}
                  onChange={(event) =>
                    setEditingAvatarNames((prev) => ({ ...prev, [avatar.id]: event.target.value }))
                  }
                  onBlur={(event) => {
                    commitAvatarRename(avatar.id, event.target.value);
                    setEditingAvatarNames((prev) => {
                      const next = { ...prev };
                      delete next[avatar.id];
                      return next;
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.target.blur();
                    }
                  }}
                />
                {avatar.id === activeAvatarId && <span className="status-text">(active)</span>}
              </div>
            ))}
          </div>
        </details>

        <details className="panel-section">
          <summary>Lip Sync &amp; Movement</summary>

          <div className="mode-row">
            <label>
              Lip Sync Mode:
              <select value={lipSyncMode} onChange={handleLipSyncModeChange}>
                <option value="cues">Cue JSON / Rhubarb</option>
                <option value="live">Live audio loudness</option>
              </select>
            </label>
          </div>

          <div className="mode-row">
            <label>
              Movement Preset:
              <select value={movementPreset} onChange={handleMovementPresetChange}>
                <option value="neutral">Neutral</option>
                <option value="talking">Talking</option>
                <option value="energetic">Energetic</option>
                <option value="sermon">Sermon</option>
                <option value="dramatic">Dramatic</option>
              </select>
            </label>

            <label>
              Breathing Style:
              <select value={breathingStyle} onChange={handleBreathingStyleChange}>
                <option value="normal">Normal</option>
                <option value="calm">Calm</option>
                <option value="energetic">Energetic</option>
                <option value="deep">Deep / Sermon</option>
              </select>
            </label>
          </div>
        </details>

        <details className="panel-section">
          <summary>Camera &amp; Background</summary>

          <div className="mode-row">
            <label>
              Background:
              <select value={backgroundMode} onChange={handleBackgroundModeChange}>
                <option value="dark">Dark room</option>
                <option value="green">Green screen</option>
                <option value="white">White background</option>
                <option value="gray">Flat gray</option>
                <option value="blue">Flat blue</option>
              </select>
            </label>

            <label>
              <input type="checkbox" checked={showGrid} onChange={handleShowGridChange} />
              Show grid
            </label>
          </div>

          <div className="mode-row">
            <strong>Camera / Framing</strong>

            <label>
              Zoom: {framing.zoom}
              <input type="range" min="1.5" max="6" step="0.1" value={framing.zoom} onChange={(event) => handleFramingChange("zoom", event.target.value)} />
            </label>

            <label>
              Avatar Height: {framing.avatarHeight}
              <input type="range" min="-1" max="1" step="0.05" value={framing.avatarHeight} onChange={(event) => handleFramingChange("avatarHeight", event.target.value)} />
            </label>

            <label>
              Left / Right: {framing.avatarX}
              <input type="range" min="-1" max="1" step="0.05" value={framing.avatarX} onChange={(event) => handleFramingChange("avatarX", event.target.value)} />
            </label>

            <label>
              Camera Angle: {framing.cameraAngle}
              <input type="range" min="-45" max="45" step="1" value={framing.cameraAngle} onChange={(event) => handleFramingChange("cameraAngle", event.target.value)} />
            </label>
          </div>
        </details>

        <details className="panel-section">
          <summary>Cues &amp; Timeline</summary>

          <div className="cue-row">
            <label>
              Upload custom mouth/timeline cues:
              <input type="file" accept=".json,application/json" onChange={handleCueUpload} />
            </label>

            <div className="status-text">
              Active cue file: {cueFileName}
            </div>

            <button type="button" onClick={handleGenerateCuesFromTranscript} disabled={!transcriptText.trim()}>
              Auto-Generate Cues from Transcript
            </button>
            <div className="status-text">
              Estimates mouth shapes and sprinkles in head/gesture cues from the transcript text and the
              loaded audio's duration. Rough and local — the npm/Rhubarb scripts still give a more accurate pass.
            </div>
          </div>

          <div className="cue-row cue-editor">
            <strong>Cue Editor</strong>
            <div className="status-text">
              Build avatar-switch, gesture, and movement-preset cues without hand-writing JSON.
            </div>

            <form className="cue-editor-form" onSubmit={handleAddCue}>
              <label>
                Cue type:
                <select value={cueDraft.category} onChange={handleCueCategoryChange}>
                  <option value="avatar">Avatar switch</option>
                  <option value="head">Head movement</option>
                  <option value="body">Body movement</option>
                  <option value="gesture">Gesture</option>
                  <option value="preset">Movement preset moment</option>
                </select>
              </label>

              {cueDraft.category === "avatar" && (
                <label>
                  Switch to avatar:
                  <select
                    value={cueDraft.avatarId}
                    onChange={(event) => setCueDraft((draft) => ({ ...draft, avatarId: event.target.value }))}
                  >
                    {avatars.map((avatar) => (
                      <option key={avatar.id} value={avatar.id}>
                        {avatar.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {cueDraft.category === "preset" && (
                <label>
                  Preset:
                  <select
                    value={cueDraft.preset}
                    onChange={(event) => setCueDraft((draft) => ({ ...draft, preset: event.target.value }))}
                  >
                    <option value="neutral">Neutral</option>
                    <option value="talking">Talking</option>
                    <option value="energetic">Energetic</option>
                    <option value="sermon">Sermon</option>
                    <option value="dramatic">Dramatic</option>
                  </select>
                </label>
              )}

              {["head", "body", "gesture"].includes(cueDraft.category) && (
                <label>
                  Action:
                  <select
                    value={cueDraft.action}
                    onChange={(event) => setCueDraft((draft) => ({ ...draft, action: event.target.value }))}
                  >
                    {GESTURE_ACTIONS[cueDraft.category].map((action) => (
                      <option key={action} value={action}>
                        {action}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label>
                Start (s):
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  value={cueDraft.start}
                  onChange={(event) => setCueDraft((draft) => ({ ...draft, start: event.target.value }))}
                />
              </label>

              <label>
                End (s):
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  value={cueDraft.end}
                  onChange={(event) => setCueDraft((draft) => ({ ...draft, end: event.target.value }))}
                />
              </label>

              {["head", "body", "gesture"].includes(cueDraft.category) && (
                <label>
                  Intensity:
                  <input
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    value={cueDraft.intensity}
                    onChange={(event) => setCueDraft((draft) => ({ ...draft, intensity: event.target.value }))}
                  />
                </label>
              )}

              <button type="submit">Add Cue</button>
            </form>
          </div>

          <div className="cue-row timeline-preview">
            <strong>Timeline Preview</strong>

            <div className="status-text">
              0.0s — {avatars.find((avatar) => avatar.id === activeAvatarId)?.name ?? "Avatar"} starts (default)
            </div>

            {timelineCues.length === 0 ? (
              <div className="status-text">No avatar/gesture/preset cues yet — add one above or upload a cue file.</div>
            ) : (
              <ul className="timeline-list">
                {[...timelineCues]
                  .sort((a, b) => a.start - b.start)
                  .map((cue) => (
                    <li key={cue.id}>
                      <span>
                        {cue.start.toFixed(2)}s – {describeCue(cue)}
                      </span>
                      <button type="button" onClick={() => removeTimelineCue(cue.id)}>
                        Remove
                      </button>
                    </li>
                  ))}
              </ul>
            )}

            <button type="button" onClick={downloadTimelineJson} disabled={timelineCues.length === 0}>
              Download Timeline JSON
            </button>
          </div>
        </details>

        <details className="panel-section">
          <summary>Transcript</summary>

          <div className="transcript-row">
            <label>
              Transcript / script:
              <input type="file" accept=".txt,text/plain" onChange={handleTranscriptUpload} />
            </label>

            <textarea
              value={transcriptText}
              onChange={(event) => setTranscriptText(event.target.value)}
              placeholder="Paste or upload a transcript here. Use Auto-Generate Cues (in Cues & Timeline) to turn this into mouth/body cues."
              rows={6}
            />

            <div className="button-row">
              <button type="button" onClick={downloadTranscript} disabled={!transcriptText.trim()}>
                Download Transcript
              </button>

              <button type="button" onClick={clearTranscript} disabled={!transcriptText.trim()}>
                Clear Transcript
              </button>
            </div>

            {transcriptFileName && (
              <div className="status-text">
                Loaded transcript: {transcriptFileName}
              </div>
            )}
          </div>
        </details>

        <details className="panel-section">
          <summary>Project &amp; Export</summary>

          <div className="cue-row">
            <strong>Project</strong>
            <div className="status-text">
              Save bundles audio, transcript, avatars, cues, camera, and background into one .json file.
              Load restores everything from a previously saved project file.
            </div>

            <div className="button-row">
              <button type="button" onClick={handleSaveProject}>
                Save Project
              </button>

              <label className="file-button">
                Load Project
                <input type="file" accept=".json,application/json" onChange={handleLoadProjectFile} />
              </label>
            </div>
          </div>

          <div className="cue-row">
            <strong>Export Bundle</strong>
            <div className="status-text">
              One click, one .zip: last recorded video (if any), transcript, cue JSON, scene preset, and the
              full project file together.
            </div>

            <button type="button" onClick={handleDownloadBundle}>
              Download Everything (.zip)
            </button>
          </div>

          {projectStatus && <div className="status-text">{projectStatus}</div>}
        </details>
      </div>
    </main>
  );
}







































