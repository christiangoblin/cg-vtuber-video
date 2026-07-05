import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMHumanBoneName } from "@pixiv/three-vrm";
import "./App.css";
import { applyBodyCues, normalizeBodyCueFile, applyMovementPreset } from "./bodyCues.js";

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

function applyIdleAnimation(vrm, time) {
  const breath = Math.sin(time * 2.0);
  const slowSway = Math.sin(time * 0.8);
  const headTurn = Math.sin(time * 0.7);
  const headNod = Math.sin(time * 0.55);

  vrm.scene.position.y = breath * 0.006;

  setBoneRotation(vrm, VRMHumanBoneName.Spine, breath * 0.012, 0, slowSway * 0.01);
  setBoneRotation(vrm, VRMHumanBoneName.Chest, breath * 0.018, 0, slowSway * 0.012);
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

function applyMouthCues(vrm, audioTime, cues) {
  resetMouthExpressions(vrm);

  const activeCue = cues.find((cue) => {
    return audioTime >= cue.start && audioTime <= cue.end;
  });

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
  const backgroundModeRef = useRef("dark");
  const recorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  const audioContextRef = useRef(null);
  const audioSourceRef = useRef(null);
  const audioDestinationRef = useRef(null);
  const audioAnalyserRef = useRef(null);
  const audioDataRef = useRef(null);

  const mouthCuesRef = useRef([]);
  const bodyCuesRef = useRef([]);
  const movementPresetRef = useRef("talking");
  const uploadObjectUrlRef = useRef(null);
  const lipSyncModeRef = useRef("cues");
  const sceneRef = useRef(null);
  const loaderRef = useRef(null);
  const currentVrmRef = useRef(null);
  const avatarObjectUrlsRef = useRef([]);
  const avatarsRef = useRef([{ id: "default", name: "ChristianGoblin", url: "/avatars/ChristianGoblin.vrm" }]);
  const activeAvatarIdRef = useRef("default");
  const avatarCuesRef = useRef([]);
  const pendingAvatarIdRef = useRef(null);

  const [isRecording, setIsRecording] = useState(false);
  const [audioSrc, setAudioSrc] = useState("/audio/test-audio.wav");
  const [lipSyncMode, setLipSyncMode] = useState("cues");
  const [movementPreset, setMovementPreset] = useState("talking");
  const [cueFileName, setCueFileName] = useState("test-cues.json");
  const [transcriptText, setTranscriptText] = useState("");
  const [transcriptFileName, setTranscriptFileName] = useState("");
  const [avatars, setAvatars] = useState([{ id: "default", name: "ChristianGoblin", url: "/avatars/ChristianGoblin.vrm" }]);
  const [activeAvatarId, setActiveAvatarId] = useState("default");
  const [backgroundMode, setBackgroundMode] = useState("dark");
  const [showGrid, setShowGrid] = useState(true);

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

    const camera = new THREE.PerspectiveCamera(
      30,
      mount.clientWidth / mount.clientHeight,
      0.1,
      100
    );

    camera.position.set(0, 1.4, 3);

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

    let currentVrm = null;

    const loader = new GLTFLoader();

    loader.register((parser) => {
      return new VRMLoaderPlugin(parser);
    });

    loader.load(
      "/avatars/ChristianGoblin.vrm",
      (gltf) => {
        currentVrm = gltf.userData.vrm;

        scene.add(currentVrm.scene);
        currentVrm.scene.rotation.y = 0;

        applyRelaxedPose(currentVrm);

        console.log("VRM loaded:", currentVrm);
      },
      (progress) => {
        console.log("Loading:", Math.round((progress.loaded / progress.total) * 100) + "%");
      },
      (error) => {
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
        applyIdleAnimation(currentVrm, elapsedTime);

        if (audio && !audio.paused) {
          if (bodyCuesRef.current.length > 0) {
            applyBodyCues(currentVrm, audio.currentTime, bodyCuesRef.current);
          } else {
            applyMovementPreset(currentVrm, audio.currentTime, movementPresetRef.current);
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
      window.removeEventListener("resize", handleResize);

      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }

      if (uploadObjectUrlRef.current) {
        URL.revokeObjectURL(uploadObjectUrlRef.current);
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

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = "vtuber-video.webm";
      link.click();

      URL.revokeObjectURL(url);
    };

    recorderRef.current = recorder;

    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }

    recorder.start();
    setIsRecording(true);

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

    setIsRecording(false);

    console.log("Recording stopped.");
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
    const cue = avatarCuesRef.current.find((item) => time >= item.start && time <= item.end);
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

    if (currentVrmRef.current?.scene) {
      scene.remove(currentVrmRef.current.scene);
    }

    currentVrmRef.current = null;

    loader.load(
      avatar.url,
      (gltf) => {
        const nextVrm = gltf.userData.vrm;
        currentVrmRef.current = nextVrm;
        scene.add(nextVrm.scene);
        nextVrm.scene.rotation.y = 0;
        applyRelaxedPose(nextVrm);
        activeAvatarIdRef.current = avatar.id;
        setActiveAvatarId(avatar.id);
        pendingAvatarIdRef.current = null;
        console.log("Avatar loaded:", avatar.name, nextVrm);
      },
      undefined,
      (error) => {
        console.error("Failed to load avatar:", error);
        pendingAvatarIdRef.current = null;
        alert("Failed to load avatar. Make sure it is a valid VRM file.");
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

    const newAvatars = acceptedFiles.map((file, index) => {
      const url = URL.createObjectURL(file);
      avatarObjectUrlsRef.current.push(url);

      return {
        id: uploaded--,
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
    lipSyncModeRef.current = "live";
    setLipSyncMode("live");

    const audio = audioRef.current;

    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audio.load();
    }

    console.log("Uploaded audio file:", file.name);
  }

  function normalizeCueFile(data) {
    if (Array.isArray(data)) {
      return data;
    }

    if (Array.isArray(data.mouthCues)) {
      return data.mouthCues;
    }

    if (Array.isArray(data.timeline)) {
      return data.timeline.filter((cue) => {
        return cue.type === "mouth" || cue.shape;
      }).map((cue) => ({
        start: cue.start,
        end: cue.end,
        shape: cue.shape,
        value: cue.value ?? 0.85
      }));
    }

    throw new Error("Cue file must be an array, or an object with mouthCues/timeline.");
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
        const avatarCues = normalizeAvatarCueFile(parsed);

        if (normalized.length > 0) {
          mouthCuesRef.current = normalized;
        }

        bodyCuesRef.current = bodyCues;
        avatarCuesRef.current = avatarCues;
        setCueFileName(file.name);

        if (normalized.length > 0) {
          lipSyncModeRef.current = "cues";
          setLipSyncMode("cues");
        }

        console.log("Loaded custom cue file:", file.name, { mouthCues: normalized, bodyCues, avatarCues });
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


  return (
    <main className="app">
      <div className="viewer" ref={mountRef} />

      <div className="controls">
        <audio
          ref={audioRef}
          controls
          src={audioSrc}
          onPlay={handleAudioPlay}
        />

        <div className="upload-row">
          <label>
            Upload audio:
            <input type="file" accept="audio/*" onChange={handleAudioUpload} />
          </label>
        </div>

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
          <div className="status-text">
            Timeline avatar names: {avatars.map((avatar) => avatar.name).join(", ")}
          </div>
        </div>
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
        </div>

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
<div className="cue-row">
          <label>
            Upload custom mouth/timeline cues:
            <input type="file" accept=".json,application/json" onChange={handleCueUpload} />
          </label>

          <div className="status-text">
            Active cue file: {cueFileName}
          </div>
        </div>

        <div className="transcript-row">
          <label>
            Transcript / script:
            <input type="file" accept=".txt,text/plain" onChange={handleTranscriptUpload} />
          </label>

          <textarea
            value={transcriptText}
            onChange={(event) => setTranscriptText(event.target.value)}
            placeholder="Paste or upload a transcript here. This panel is for keeping the script beside the audio. TTS/cue generation still happens through npm commands for now."
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

        <div className="button-row">
          <button onClick={startRecording} disabled={isRecording}>
            Start Recording
          </button>

          <button onClick={stopRecording} disabled={!isRecording}>
            Stop Recording
          </button>
        </div>
      </div>
    </main>
  );
}

































