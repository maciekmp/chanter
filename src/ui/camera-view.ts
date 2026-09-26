import { LIPS_INNER, LIPS_OUTER, OPEN_OFF, OPEN_ON, type Landmark } from '../vision/mouth';

/** Extra zoom over "cover", so a lean of the head spans the pitch range. */
const ZOOM = 1.4;
/** The openness meter's full scale, in MouthModel.openness units. */
const METER_MAX = 2.5;

export interface CameraFace {
  landmarks: readonly Landmark[];
  /** Nose position (0..1 across the pad) and the note it points at. */
  noseX: number;
  note: string;
  open: number;
  singing: boolean;
}

/**
 * The mirrored webcam picture inside the XY pad, with the tracked lips, the
 * head's pitch marker, an openness meter and a message/prompt layer.
 */
export class CameraView {
  readonly el: HTMLElement;
  private readonly host: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly svg: SVGSVGElement;
  private readonly outer: SVGPathElement;
  private readonly inner: SVGPathElement;
  private readonly marker: SVGLineElement;
  private readonly markerLabel: HTMLElement;
  private readonly meter: HTMLElement;
  private readonly meterFill: HTMLElement;
  private readonly msg: HTMLElement;
  private readonly msgText: HTMLElement;
  private readonly msgBtn: HTMLButtonElement;
  private readonly prompt: HTMLElement;
  private msgAction: (() => void) | null = null;
  private geo = { w: 1, h: 1, dw: 1, dh: 1, ox: 0, oy: 0 };

  /** `host` is the pad element; the view is layered inside it. */
  constructor(host: HTMLElement, video: HTMLVideoElement) {
    this.host = host;
    this.video = video;
    video.className = 'cam-video';
    this.el = document.createElement('div');
    this.el.className = 'cam';
    this.el.hidden = true;
    this.el.innerHTML = `
      <svg class="cam-overlay" aria-hidden="true">
        <line class="cam-marker"></line>
        <path class="cam-lips cam-lips-outer"></path>
        <path class="cam-lips cam-lips-inner"></path>
      </svg>
      <span class="cam-marker-label" aria-hidden="true"></span>
      <div class="cam-meter" aria-hidden="true" style="--on:${OPEN_ON / METER_MAX};--off:${OPEN_OFF / METER_MAX}"><i></i></div>
      <div class="cam-prompt" aria-live="polite"></div>
      <div class="cam-msg" role="status"><p></p><button type="button" class="chip" hidden></button></div>`;
    this.el.prepend(video);
    this.svg = this.el.querySelector('svg')!;
    this.outer = this.el.querySelector('.cam-lips-outer')!;
    this.inner = this.el.querySelector('.cam-lips-inner')!;
    this.marker = this.el.querySelector('.cam-marker')!;
    this.markerLabel = this.el.querySelector('.cam-marker-label')!;
    this.meter = this.el.querySelector('.cam-meter')!;
    this.meterFill = this.meter.querySelector('i')!;
    this.prompt = this.el.querySelector('.cam-prompt')!;
    this.msg = this.el.querySelector('.cam-msg')!;
    this.msgText = this.msg.querySelector('p')!;
    this.msgBtn = this.msg.querySelector('button')!;
    this.msgBtn.addEventListener('click', () => this.msgAction?.());
    // The pad sits under this layer; only the message button takes clicks.
    host.insertBefore(this.el, host.firstChild);
  }

  set visible(on: boolean) {
    this.el.hidden = !on;
    this.host.classList.toggle('is-camera', on);
  }

  /** A message over the picture (empty hides it), optionally with one button. */
  setMessage(text: string, action?: { label: string; run: () => void }): void {
    this.msg.classList.toggle('is-on', !!text);
    this.msgText.textContent = text;
    this.msgAction = action?.run ?? null;
    this.msgBtn.hidden = !action;
    this.msgBtn.textContent = action?.label ?? '';
  }

  /** Calibration prompt (null hides it). */
  setPrompt(p: { title: string; hint: string; progress: number } | null): void {
    this.prompt.classList.toggle('is-on', !!p);
    if (!p) return;
    this.prompt.innerHTML = `<b>${p.title}</b><span>${p.hint}</span><i style="transform:scaleX(${p.progress.toFixed(3)})"></i>`;
  }

  /** Recompute where the (mirrored, cover-fitted, zoomed) video sits in the pad. */
  layout(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    const vw = this.video.videoWidth || 4;
    const vh = this.video.videoHeight || 3;
    const s = Math.max(w / vw, h / vh) * ZOOM;
    const dw = vw * s;
    const dh = vh * s;
    const g = { w, h, dw, dh, ox: (w - dw) / 2, oy: (h - dh) / 2 };
    if (g.w === this.geo.w && g.h === this.geo.h && g.dw === this.geo.dw && g.dh === this.geo.dh) return;
    this.geo = g;
    Object.assign(this.video.style, { width: `${dw}px`, height: `${dh}px`, left: `${g.ox}px`, top: `${g.oy}px` });
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }

  /** Landmark (normalised video coords) → fraction of the pad, mirrored. */
  toPad(p: Landmark): [number, number] {
    const g = this.geo;
    return [(g.ox + (1 - p.x) * g.dw) / g.w, (g.oy + p.y * g.dh) / g.h];
  }

  /** Draw the tracked face, or clear it when there is none. */
  show(face: CameraFace | null): void {
    this.el.classList.toggle('has-face', !!face);
    if (!face) {
      this.meterFill.style.transform = 'scaleY(0)';
      return;
    }
    const { w, h } = this.geo;
    const path = (idx: number[]) =>
      idx
        .map((i, n) => {
          const [x, y] = this.toPad(face.landmarks[i]);
          return `${n ? 'L' : 'M'}${(x * w).toFixed(1)} ${(y * h).toFixed(1)}`;
        })
        .join('') + 'Z';
    this.outer.setAttribute('d', path(LIPS_OUTER));
    this.inner.setAttribute('d', path(LIPS_INNER));
    const mx = (Math.min(1, Math.max(0, face.noseX)) * w).toFixed(1);
    this.marker.setAttribute('x1', mx);
    this.marker.setAttribute('x2', mx);
    this.marker.setAttribute('y1', '0');
    this.marker.setAttribute('y2', String(h));
    this.markerLabel.style.left = `${Math.min(1, Math.max(0, face.noseX)) * 100}%`;
    if (this.markerLabel.textContent !== face.note) this.markerLabel.textContent = face.note;
    this.el.classList.toggle('is-singing', face.singing);
    this.meterFill.style.transform = `scaleY(${Math.min(1, face.open / METER_MAX).toFixed(3)})`;
  }
}
