import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMHumanBoneName } from "@pixiv/three-vrm";
import "./App.css";

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

  setBoneRotation(
    vrm,
    VRMHumanBoneName.Spine,
    breath * 0.012,
    0,
    slowSway * 0.01
  );

  setBoneRotation(
    vrm,
    VRMHumanBoneName.Chest,
    breath * 0.018,
    0,
    slowSway * 0.012
  );

  setBoneRotation(
    vrm,
    VRMHumanBoneName.Neck,
    headNod * 0.012,
    headTurn * 0.018,
    0
  );

  setBoneRotation(
    vrm,
    VRMHumanBoneName.Head,
    headNod * 0.025,
    headTurn * 0.045,
    slowSway * 0.012
  );
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

  if (!activeCue) {
    return;
  }

  setExpression(vrm, activeCue.shape, activeCue.value ?? 0.8);
}

export default function App() {
  const mountRef = useRef(null);
  const audioRef = useRef(null);
  const rendererRef = useRef(null);
  const recorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  const audioContextRef = useRef(null);
  const audioSourceRef = useRef(null);
  const audioDestinationRef = useRef(null);
  const mouthCuesRef = useRef([]);

  const [isRecording, setIsRecording] = useState(false);

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
        console.log(
          "Loading:",
          Math.round((progress.loaded / progress.total) * 100) + "%"
        );
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

      if (currentVrm) {
        const audio = audioRef.current;

        applyRelaxedPose(currentVrm);
        applyIdleAnimation(currentVrm, elapsedTime);
        applyBlinking(currentVrm, elapsedTime);

        if (audio && !audio.paused) {
          applyMouthCues(currentVrm, audio.currentTime, mouthCuesRef.current);
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

      renderer.dispose();

      if (renderer.domElement && mount.contains(renderer.domElement)) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, []);

  function getAudioTracksForRecording(audio) {
    if (!audio) {
      console.warn("No audio element found.");
      return [];
    }

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    const audioContext = audioContextRef.current;

    if (!audioSourceRef.current) {
      const source = audioContext.createMediaElementSource(audio);
      const destination = audioContext.createMediaStreamDestination();

      source.connect(destination);
      source.connect(audioContext.destination);

      audioSourceRef.current = source;
      audioDestinationRef.current = destination;
    }

    const tracks = audioDestinationRef.current.stream.getAudioTracks();
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

    if (audioContextRef.current?.state === "suspended") {
      await audioContextRef.current.resume();
    }

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

    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }

    const audio = audioRef.current;

    if (audio) {
      audio.pause();
    }

    setIsRecording(false);

    console.log("Recording stopped.");
  }

  return (
    <main className="app">
      <div className="viewer" ref={mountRef} />

      <div className="controls">
        <audio ref={audioRef} controls src="/audio/test-audio.wav" />

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









