import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import type { Blendshapes, Landmark } from './mouth';

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export interface FaceFrame {
  landmarks: Landmark[];
  blendshapes: Blendshapes;
  /** Video width / height. */
  aspect: number;
}

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

/** The face landmarker, loaded on first use (library, wasm and model are fetched lazily). */
function loadLandmarker(): Promise<FaceLandmarker> {
  landmarkerPromise ??= (async () => {
    const { FaceLandmarker } = await import('@mediapipe/tasks-vision');
    const create = (delegate: 'GPU' | 'CPU') =>
      FaceLandmarker.createFromOptions(
        { wasmLoaderPath, wasmBinaryPath },
        {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
        },
      );
    try {
      return await create('GPU');
    } catch {
      return await create('CPU');
    }
  })().catch((err) => {
    landmarkerPromise = null;
    throw err;
  });
  return landmarkerPromise;
}

function cameraError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera access was blocked. Allow the camera for this page, then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The camera is busy (another app may be using it).';
  return `The camera could not start: ${(err as Error)?.message ?? err}`;
}

/**
 * Webcam + MediaPipe face landmarker. Calls `onFrame` for every new camera
 * frame, with the tracked face or null.
 */
export class FaceTracker {
  readonly video: HTMLVideoElement;
  onFrame: (face: FaceFrame | null) => void = () => {};
  private stream: MediaStream | null = null;
  private landmarker: FaceLandmarker | null = null;
  private running = false;
  private session = 0;
  private lastVideoTime = -1;
  private lastStamp = 0;

  constructor() {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('aria-hidden', 'true');
  }

  get active(): boolean {
    return this.running;
  }

  /** Opens the camera and loads the tracker. Rejects with a user-facing message. */
  async start(): Promise<void> {
    if (this.running) return;
    const session = ++this.session;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera access (it needs HTTPS or localhost).');
    const tracker = loadLandmarker();
    tracker.catch(() => {}); // reported below, after the camera
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
        audio: false,
      });
    } catch (err) {
      throw new Error(cameraError(err));
    }
    if (session !== this.session) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch (err) {
      if (session !== this.session) return;
      this.stop();
      throw new Error(cameraError(err));
    }
    try {
      this.landmarker = await tracker;
    } catch {
      if (session !== this.session) return;
      this.stop();
      throw new Error('The face tracker could not load. It is downloaded on first use, so check your connection.');
    }
    if (session !== this.session) return;
    this.running = true;
    this.lastVideoTime = -1;
    this.schedule(session);
  }

  stop(): void {
    this.session++;
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  private schedule(session: number): void {
    const next = () => {
      if (session !== this.session) return;
      this.detect();
      this.schedule(session);
    };
    if ('requestVideoFrameCallback' in this.video) this.video.requestVideoFrameCallback(next);
    else requestAnimationFrame(next);
  }

  private detect(): void {
    const v = this.video;
    const lm = this.landmarker;
    if (!lm || v.readyState < 2 || v.currentTime === this.lastVideoTime || !v.videoWidth) return;
    this.lastVideoTime = v.currentTime;
    // Timestamps must strictly increase.
    const stamp = Math.max(performance.now(), this.lastStamp + 1);
    this.lastStamp = stamp;
    const res = lm.detectForVideo(v, stamp);
    const landmarks = res.faceLandmarks[0];
    if (!landmarks) return this.onFrame(null);
    const blendshapes: Blendshapes = {};
    for (const c of res.faceBlendshapes[0]?.categories ?? []) blendshapes[c.categoryName] = c.score;
    this.onFrame({ landmarks, blendshapes, aspect: v.videoWidth / v.videoHeight });
  }
}
