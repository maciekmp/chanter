import { isWhite, noteName, snapToWhite } from '../music/notes';

export type SnapMode = 'free' | 'semitone' | 'scale';

export interface XYPadOptions {
  onStart: (midi: number, vowel: number) => void;
  onMove: (midi: number, vowel: number) => void;
  onEnd: () => void;
}

const NS = 'http://www.w3.org/2000/svg';

/**
 * X = pitch, Y = vowel. Pressing sounds a note; dragging steers it
 * continuously. The cursor always shows the synth's actual pitch/vowel.
 */
export class XYPad {
  readonly el: HTMLElement;
  snap: SnapMode = 'scale';
  private lo = 36;
  private hi = 72;
  private readonly svg: SVGSVGElement;
  private readonly grid: SVGGElement;
  private readonly crossH: SVGLineElement;
  private readonly crossV: SVGLineElement;
  private readonly o: XYPadOptions;
  private pointerId: number | null = null;
  private kbMidi = 57;
  private kbVowel = 0.5;
  private kbHeld = false;

  constructor(o: XYPadOptions) {
    this.o = o;
    this.el = document.createElement('div');
    this.el.className = 'xypad';
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'application');
    this.el.setAttribute('aria-roledescription', 'XY pad');
    this.el.setAttribute(
      'aria-label',
      'Pitch and vowel pad. Horizontal is pitch, vertical is vowel. With focus, arrow keys move, hold Space or Enter to sing.',
    );
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('viewBox', '0 0 100 100');
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this.svg.setAttribute('aria-hidden', 'true');
    this.grid = document.createElementNS(NS, 'g');
    this.svg.appendChild(this.grid);
    this.crossH = this.line('pad-cross');
    this.crossV = this.line('pad-cross');
    this.el.appendChild(this.svg);

    this.el.insertAdjacentHTML('beforeend', `<div class="pad-cursor"><span></span></div><div class="pad-labels" aria-hidden="true"></div>`);
    this.bind();
  }

  private line(cls: string): SVGLineElement {
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('class', cls);
    l.setAttribute('vector-effect', 'non-scaling-stroke');
    this.svg.appendChild(l);
    return l;
  }

  setRange(lo: number, hi: number): void {
    this.lo = lo;
    this.hi = hi;
    this.kbMidi = Math.min(hi, Math.max(lo, this.kbMidi));
    this.grid.innerHTML = '';
    const labels = this.el.querySelector('.pad-labels')!;
    labels.innerHTML = '';
    for (let m = Math.ceil(lo); m <= hi; m++) {
      const x = this.xOf(m);
      const isC = m % 12 === 0;
      if (!isC && !isWhite(m)) continue;
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', String(x));
      l.setAttribute('x2', String(x));
      l.setAttribute('y1', '0');
      l.setAttribute('y2', '100');
      l.setAttribute('vector-effect', 'non-scaling-stroke');
      l.setAttribute('class', isC ? 'pad-grid pad-grid-c' : 'pad-grid');
      this.grid.appendChild(l);
      if (isC) labels.insertAdjacentHTML('beforeend', `<span style="left:${x}%">${noteName(m)}</span>`);
    }
    for (const y of [25, 50, 75]) {
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', '0');
      l.setAttribute('x2', '100');
      l.setAttribute('y1', String(y));
      l.setAttribute('y2', String(y));
      l.setAttribute('vector-effect', 'non-scaling-stroke');
      l.setAttribute('class', 'pad-grid pad-grid-v');
      this.grid.appendChild(l);
    }
  }

  private xOf(midi: number): number {
    return ((midi - this.lo) / (this.hi - this.lo)) * 100;
  }

  private quantize(midi: number): number {
    if (this.snap === 'semitone') return Math.round(midi);
    if (this.snap === 'scale') return snapToWhite(midi);
    return midi;
  }

  private fromEvent(e: PointerEvent): [number, number] {
    const r = this.el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    const midi = this.quantize(this.lo + x * (this.hi - this.lo));
    return [Math.min(this.hi, Math.max(this.lo, midi)), 1 - y];
  }

  private bind(): void {
    this.el.addEventListener('pointerdown', (e) => {
      if (this.pointerId !== null) return;
      this.pointerId = e.pointerId;
      this.el.setPointerCapture(e.pointerId);
      this.el.classList.add('is-active');
      const [m, v] = this.fromEvent(e);
      this.o.onStart(m, v);
      e.preventDefault();
    });
    this.el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.pointerId) return;
      const [m, v] = this.fromEvent(e);
      this.o.onMove(m, v);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.pointerId) return;
      this.pointerId = null;
      this.el.classList.remove('is-active');
      this.o.onEnd();
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('lostpointercapture', end);

    // Keyboard operation of the pad itself.
    this.el.addEventListener('keydown', (e) => {
      const step = this.snap === 'free' ? 0.5 : 1;
      let handled = true;
      switch (e.key) {
        case 'ArrowLeft':
          this.kbMidi = this.quantizeStep(this.kbMidi, -step);
          break;
        case 'ArrowRight':
          this.kbMidi = this.quantizeStep(this.kbMidi, step);
          break;
        case 'ArrowUp':
          this.kbVowel = Math.min(1, this.kbVowel + 0.125);
          break;
        case 'ArrowDown':
          this.kbVowel = Math.max(0, this.kbVowel - 0.125);
          break;
        case ' ':
        case 'Enter':
          if (!e.repeat && !this.kbHeld) {
            this.kbHeld = true;
            this.el.classList.add('is-active');
            this.o.onStart(this.kbMidi, this.kbVowel);
          }
          break;
        default:
          handled = false;
      }
      if (!handled) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.kbHeld) this.o.onMove(this.kbMidi, this.kbVowel);
    });
    this.el.addEventListener('keyup', (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && this.kbHeld) {
        this.kbHeld = false;
        this.el.classList.remove('is-active');
        this.o.onEnd();
        e.preventDefault();
        e.stopPropagation();
      }
    });
    this.el.addEventListener('blur', () => {
      if (this.kbHeld) {
        this.kbHeld = false;
        this.el.classList.remove('is-active');
        this.o.onEnd();
      }
    });
  }

  private quantizeStep(midi: number, dir: number): number {
    let m = midi + dir;
    if (this.snap === 'scale') while (!isWhite(m)) m += Math.sign(dir);
    return Math.min(this.hi, Math.max(this.lo, m));
  }

  /** Position the cursor from the synth's actual state. */
  show(midi: number, vowel: number, sounding: number): void {
    const x = Math.min(100, Math.max(0, this.xOf(midi)));
    const y = (1 - vowel) * 100;
    const c = this.el.querySelector<HTMLElement>('.pad-cursor')!;
    c.style.left = `${x}%`;
    c.style.top = `${y}%`;
    c.style.setProperty('--glow', sounding.toFixed(3));
    this.crossH.setAttribute('x1', '0');
    this.crossH.setAttribute('x2', '100');
    this.crossH.setAttribute('y1', y.toFixed(2));
    this.crossH.setAttribute('y2', y.toFixed(2));
    this.crossV.setAttribute('x1', x.toFixed(2));
    this.crossV.setAttribute('x2', x.toFixed(2));
    this.crossV.setAttribute('y1', '0');
    this.crossV.setAttribute('y2', '100');
    this.svg.style.setProperty('--cross', (0.25 + 0.5 * sounding).toFixed(3));
  }
}
