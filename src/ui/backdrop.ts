/**
 * Static, richly textured stage backdrop (arch, halo, layered mountains,
 * print grain). Rendered once in its own SVG so the animated monk layer on top
 * never forces the expensive filters to repaint.
 */
export function createBackdrop(): SVGSVGElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
<svg class="backdrop" viewBox="0 0 800 700" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
  <defs>
    <radialGradient id="bd-halo" cx="0.42" cy="0.38" r="0.7">
      <stop offset="0" stop-color="#efd9a0"/>
      <stop offset="0.55" stop-color="#d8b567"/>
      <stop offset="1" stop-color="#b38637"/>
    </radialGradient>
    <linearGradient id="bd-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b2644"/>
      <stop offset="1" stop-color="#26355a"/>
    </linearGradient>
    <linearGradient id="bd-brass" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#7d6127"/>
      <stop offset="0.35" stop-color="#d4b061"/>
      <stop offset="0.6" stop-color="#b8913f"/>
      <stop offset="1" stop-color="#6d5220"/>
    </linearGradient>
    <filter id="bd-mottle" x="0" y="0" width="1" height="1">
      <feTurbulence type="fractalNoise" baseFrequency="0.016" numOctaves="4" seed="7" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.45  0 0 0 0 0.3  0 0 0 0 0.1  0 0 0 -1.1 0.95" result="stain"/>
      <feComposite in="stain" in2="SourceGraphic" operator="in" result="stainIn"/>
      <feBlend in="stainIn" in2="SourceGraphic" mode="multiply"/>
    </filter>
    <filter id="bd-ink" x="0" y="0" width="1" height="1">
      <feTurbulence type="fractalNoise" baseFrequency="0.04 0.2" numOctaves="3" seed="3" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 -0.9 0.6" result="speck"/>
      <feComposite in="speck" in2="SourceGraphic" operator="in" result="s"/>
      <feBlend in="s" in2="SourceGraphic" mode="screen"/>
    </filter>
    <filter id="bd-grain" x="0" y="0" width="1" height="1">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="11" stitchTiles="stitch"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0.08  0 0 0 0 0.07  0 0 0 0 0.12  0 0 0 -1.6 1.1"/>
    </filter>
    <clipPath id="bd-arch"><path d="M104 700V330A296 296 0 0 1 696 330V700Z"/></clipPath>
  </defs>

  <rect x="-800" y="-700" width="2400" height="1400" fill="#141b31"/>

  <g clip-path="url(#bd-arch)">
    <rect width="800" height="700" fill="url(#bd-sky)"/>
    <!-- registration shadow + halo -->
    <circle cx="408" cy="256" r="222" fill="#6d1f2b" opacity="0.28"/>
    <circle cx="400" cy="248" r="222" fill="url(#bd-halo)" filter="url(#bd-mottle)"/>
    <circle cx="400" cy="248" r="222" fill="none" stroke="#7d6127" stroke-width="3"/>
    <circle cx="400" cy="248" r="200" fill="none" stroke="#f3e2b4" stroke-width="1.2" opacity="0.35"/>

    <!-- far range -->
    <path d="M104 470L150 438L196 452L246 404L290 430L336 372L380 418L430 356L476 402L520 380L566 424L616 392L660 430L696 414V700H104Z"
      fill="#6a7b98" filter="url(#bd-ink)"/>
    <path d="M336 372L352 398M430 356L446 384M246 404L258 424M520 380L532 398M616 392L630 410"
      stroke="#dfe3ea" stroke-width="3" stroke-linecap="round" opacity="0.55"/>
    <!-- middle range -->
    <path d="M104 520L160 478L214 506L272 452L322 492L372 440L436 500L494 456L552 494L610 462L660 500L696 486V700H104Z"
      fill="#46597d" filter="url(#bd-ink)"/>
    <path d="M272 452L262 478M372 440L360 470M494 456L484 480M610 462L600 486"
      stroke="#9fb0c8" stroke-width="2.4" stroke-linecap="round" opacity="0.5"/>
    <!-- near range -->
    <path d="M104 580L180 540L250 566L330 530L410 568L490 528L570 560L640 536L696 556V700H104Z" fill="#2e3d60"/>
    <path d="M140 600C200 586 260 596 320 588M470 596C530 584 590 592 660 584" stroke="#5b6f93" stroke-width="2" fill="none" opacity="0.6"/>
  </g>

  <!-- arch frame -->
  <path d="M104 700V330A296 296 0 0 1 696 330V700" fill="none" stroke="#b8913f" stroke-width="3"/>
  <path d="M92 700V330A308 308 0 0 1 708 330V700" fill="none" stroke="#7d6127" stroke-width="1.5" opacity="0.8"/>

  <!-- columns -->
  <g>
    <rect x="58" y="176" width="30" height="524" fill="url(#bd-brass)" opacity="0.92"/>
    <rect x="50" y="160" width="46" height="16" rx="2" fill="url(#bd-brass)"/>
    <rect x="54" y="150" width="38" height="10" rx="2" fill="#8c6c2b"/>
    <rect x="712" y="176" width="30" height="524" fill="url(#bd-brass)" opacity="0.92"/>
    <rect x="704" y="160" width="46" height="16" rx="2" fill="url(#bd-brass)"/>
    <rect x="708" y="150" width="38" height="10" rx="2" fill="#8c6c2b"/>
    <path d="M66 190V700M80 190V700M720 190V700M734 190V700" stroke="#5b4418" stroke-width="1.2" opacity="0.6"/>
  </g>

  <rect x="-800" y="-700" width="2400" height="1400" filter="url(#bd-grain)" opacity="0.55" style="mix-blend-mode:multiply"/>
</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}
