export interface KnobOptions {
  id: string;
  label: string;
  min: number;
  max: number;
  value: number;
  /** Double-click resets to this (defaults to the initial value). */
  defaultValue?: number;
  step: number;
  size?: number;
  ends?: [string, string];
  format: (v: number) => string;
  onInput: (v: number) => void;
}

const START = -135;
const SWEEP = 270;

function arc(r: number, a0: number, a1: number): string {
  const p = (a: number) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return `${(50 + r * Math.cos(rad)).toFixed(2)} ${(50 + r * Math.sin(rad)).toFixed(2)}`;
  };
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${p(a0)}A${r} ${r} 0 ${large} 1 ${p(a1)}`;
}

/** Rotary control with ARIA slider semantics: drag, wheel, keys, double-click reset. */
export class Knob {
  readonly el: HTMLElement;
  value: number;
  private readonly o: KnobOptions;
  private readonly dial: HTMLElement;
  private readonly valueArc: SVGPathElement;
  private readonly pointer: SVGGElement;
  private readonly readout: HTMLElement;
  private readonly defaultValue: number;

  constructor(o: KnobOptions) {
    this.o = o;
    this.value = o.value;
    this.defaultValue = o.defaultValue ?? o.value;
    const size = o.size ?? 72;
    const ticks = Array.from({ length: 11 }, (_, i) => {
      const a = ((START + (SWEEP * i) / 10 - 90) * Math.PI) / 180;
      return `M${(50 + 44 * Math.cos(a)).toFixed(1)} ${(50 + 44 * Math.sin(a)).toFixed(1)}L${(50 + 47.5 * Math.cos(a)).toFixed(1)} ${(50 + 47.5 * Math.sin(a)).toFixed(1)}`;
    }).join('');
    this.el = document.createElement('div');
    this.el.className = 'knob-wrap';
    this.el.innerHTML = `
      <div class="ctl-label" id="${o.id}-label">${o.label}</div>
      <div class="knob" id="${o.id}" role="slider" tabindex="0" aria-labelledby="${o.id}-label"
        aria-valuemin="${o.min}" aria-valuemax="${o.max}" style="width:${size}px;height:${size}px">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <defs>
            <radialGradient id="${o.id}-g" cx="0.38" cy="0.32" r="0.75">
              <stop offset="0" stop-color="#ecd48f"/><stop offset="0.55" stop-color="#bf9745"/><stop offset="1" stop-color="#6f5420"/>
            </radialGradient>
          </defs>
          <path d="${ticks}" stroke="#7d6127" stroke-width="1.6" stroke-linecap="round"/>
          <path d="${arc(40, START, START + SWEEP)}" fill="none" stroke="#0e1426" stroke-width="5" stroke-linecap="round"/>
          <path class="knob-arc" fill="none" stroke="#dcbb6c" stroke-width="5" stroke-linecap="round"/>
          <circle cx="50" cy="52" r="31" fill="#0b1020" opacity="0.5"/>
          <circle cx="50" cy="50" r="30" fill="url(#${o.id}-g)" stroke="#4e3a14" stroke-width="1.5"/>
          <circle cx="50" cy="50" r="24" fill="none" stroke="#f6e3a8" stroke-width="0.8" opacity="0.35"/>
          <g class="knob-pointer"><line x1="50" y1="50" x2="50" y2="25" stroke="#1b2036" stroke-width="4.5" stroke-linecap="round"/></g>
        </svg>
      </div>
      <div class="knob-value" aria-hidden="true"></div>
      ${o.ends ? `<div class="knob-ends" aria-hidden="true"><span>${o.ends[0]}</span><span>${o.ends[1]}</span></div>` : ''}`;
    this.dial = this.el.querySelector('.knob')!;
    this.valueArc = this.el.querySelector('.knob-arc')!;
    this.pointer = this.el.querySelector('.knob-pointer')!;
    this.readout = this.el.querySelector('.knob-value')!;
    this.bind();
    this.render();
  }

  set(v: number, emit = false): void {
    const { min, max, step } = this.o;
    v = Math.min(max, Math.max(min, Math.round(v / step) * step));
    if (v === this.value && !emit) return this.render();
    this.value = v;
    this.render();
    if (emit) this.o.onInput(v);
  }

  private frac(): number {
    return (this.value - this.o.min) / (this.o.max - this.o.min);
  }

  private render(): void {
    const a = START + SWEEP * this.frac();
    this.valueArc.setAttribute('d', a - START < 0.5 ? '' : arc(40, START, a));
    this.pointer.setAttribute('transform', `rotate(${a.toFixed(1)} 50 50)`);
    const text = this.o.format(this.value);
    this.readout.textContent = text;
    this.dial.setAttribute('aria-valuenow', String(this.value));
    this.dial.setAttribute('aria-valuetext', text);
  }

  private bind(): void {
    const { min, max, step } = this.o;
    const range = max - min;
    let startY = 0;
    let startX = 0;
    let startV = 0;
    this.dial.addEventListener('pointerdown', (e) => {
      this.dial.setPointerCapture(e.pointerId);
      this.dial.focus();
      startY = e.clientY;
      startX = e.clientX;
      startV = this.value;
      e.preventDefault();
    });
    this.dial.addEventListener('pointermove', (e) => {
      if (!this.dial.hasPointerCapture(e.pointerId)) return;
      const d = (e.clientX - startX - (e.clientY - startY)) / (e.shiftKey ? 600 : 160);
      this.set(startV + d * range, true);
    });
    this.dial.addEventListener('dblclick', () => this.set(this.defaultValue, true));
    this.dial.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.set(this.value + (e.deltaY < 0 ? step : -step) * 2, true);
      },
      { passive: false },
    );
    this.dial.addEventListener('keydown', (e) => {
      const big = range / 10;
      const map: Record<string, number> = {
        ArrowUp: step,
        ArrowRight: step,
        ArrowDown: -step,
        ArrowLeft: -step,
        PageUp: big,
        PageDown: -big,
      };
      if (e.key in map) this.set(this.value + map[e.key] * (e.shiftKey ? 5 : 1), true);
      else if (e.key === 'Home') this.set(min, true);
      else if (e.key === 'End') this.set(max, true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }
}
