import { isWhite, noteName, pitchClass } from '../music/notes';

export interface PianoOptions {
  /** velocity 0..1 from where the key is pressed (further down = louder). */
  onDown: (midi: number, velocity: number) => void;
  onUp: (midi: number) => void;
  /** Vertical drag on a held key: positive = towards EE. */
  onVowelDelta: (d: number) => void;
}

// Black-key centres in white-key widths from the left edge of the white key
// to their left (1.0 = the boundary between the two white keys). Real
// keyboards nudge C♯/F♯ left, D♯/A♯ right and centre G♯.
const BLACK_OFFSET: Record<number, number> = { 1: 0.9, 3: 1.1, 6: 0.88, 8: 1.0, 10: 1.12 };
const BLACK_WIDTH = 0.58;

/**
 * On-screen keyboard. Keys are laid out in % so it scales with the window.
 * Each pointer holds one key; sliding across keys plays legato, sliding
 * vertically on a key steers the vowel.
 */
export class Piano {
  readonly el: HTMLElement;
  private readonly o: PianoOptions;
  private keys = new Map<number, HTMLElement>();
  private pointers = new Map<number, { midi: number; lastY: number; velocity: number }>();
  private pressed = new Set<number>();
  private sounding: number | null = null;

  constructor(o: PianoOptions) {
    this.o = o;
    this.el = document.createElement('div');
    this.el.className = 'piano';
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', 'Piano keyboard. Use the computer keys shown on each key to play.');
    this.bind();
  }

  build(lo: number, hi: number, labels: Map<number, string>): void {
    this.el.innerHTML = '';
    this.keys.clear();
    const whites: number[] = [];
    for (let m = lo; m <= hi; m++) if (isWhite(m)) whites.push(m);
    const w = 100 / whites.length;
    let wi = -1;
    for (let m = lo; m <= hi; m++) {
      const white = isWhite(m);
      if (white) wi++;
      const k = document.createElement('div');
      k.className = white ? 'key white' : 'key black';
      k.dataset.midi = String(m);
      k.setAttribute('aria-hidden', 'true');
      if (white) {
        k.style.left = `${wi * w}%`;
        k.style.width = `${w}%`;
      } else {
        const center = (wi + BLACK_OFFSET[pitchClass(m)]) * w;
        k.style.left = `${center - (BLACK_WIDTH * w) / 2}%`;
        k.style.width = `${BLACK_WIDTH * w}%`;
      }
      const hint = labels.get(m);
      const name = white ? (pitchClass(m) === 0 ? noteName(m) : noteName(m).replace(/-?\d+$/, '')) : '';
      if (white && hint) k.classList.add('has-hint');
      if (pitchClass(m) === 0) k.classList.add('is-c');
      const hintHtml = hint ? `<kbd class="key-hint">${hint}</kbd>` : '';
      k.innerHTML = white ? `<span class="key-label">${hintHtml}<span class="key-name">${name}</span></span>` : hintHtml;
      this.el.appendChild(k);
      this.keys.set(m, k);
    }
    this.refresh();
  }

  setPressed(midis: Iterable<number>): void {
    this.pressed = new Set(midis);
    this.refresh();
  }

  setSounding(midi: number | null): void {
    if (midi === this.sounding) return;
    this.sounding = midi;
    this.refresh();
  }

  private refresh(): void {
    for (const [m, k] of this.keys) {
      k.classList.toggle('is-pressed', this.pressed.has(m));
      k.classList.toggle('is-sounding', this.sounding === m);
    }
  }

  /** Forget all held pointers (e.g. when the window loses focus). */
  releaseAll(): void {
    this.pointers.clear();
  }

  private velocityAt(midi: number, y: number): number {
    const r = this.keys.get(midi)!.getBoundingClientRect();
    return 0.55 + 0.45 * Math.min(1, Math.max(0, (y - r.top) / r.height));
  }

  private keyAt(x: number, y: number): number | null {
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('.key');
    return hit && this.el.contains(hit) ? Number(hit.dataset.midi) : null;
  }

  private bind(): void {
    this.el.addEventListener('pointerdown', (e) => {
      const midi = this.keyAt(e.clientX, e.clientY);
      if (midi === null) return;
      this.el.setPointerCapture(e.pointerId);
      const velocity = this.velocityAt(midi, e.clientY);
      this.pointers.set(e.pointerId, { midi, lastY: e.clientY, velocity });
      this.o.onDown(midi, velocity);
      e.preventDefault();
    });
    this.el.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const midi = this.keyAt(e.clientX, e.clientY);
      if (midi !== null && midi !== p.midi) {
        // Press the new key before releasing the old one → legato glide.
        const old = p.midi;
        p.midi = midi;
        this.o.onDown(midi, p.velocity);
        this.o.onUp(old);
      }
      const dy = e.clientY - p.lastY;
      p.lastY = e.clientY;
      if (dy) this.o.onVowelDelta(-dy / 140);
    });
    const end = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      this.pointers.delete(e.pointerId);
      this.o.onUp(p.midi);
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('lostpointercapture', end);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
