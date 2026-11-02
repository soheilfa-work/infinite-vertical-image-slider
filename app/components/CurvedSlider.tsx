"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import * as THREE from "three";
import Lenis from "lenis";

const SLIDES = [
  {
    src: "/images/01.jpg",
    title: "Chromatic Drift",
    desc: "Slow bands of color sliding past each other.",
    href: "https://example.com/chromatic-drift",
  },
  {
    src: "/images/02.jpg",
    title: "Soft Interference",
    desc: "Overlapping waves that blur into gentle patterns.",
    href: "https://example.com/soft-interference",
  },
  {
    src: "/images/03.jpg",
    title: "Painted Silence",
    desc: "Quiet brushstrokes frozen mid-motion.",
    href: "https://example.com/painted-silence",
  },
  {
    src: "/images/04.jpg",
    title: "Neon Bloom",
    desc: "Glowing petals opening in the dark.",
    href: "https://example.com/neon-bloom",
  },
  {
    src: "/images/05.jpg",
    title: "Velvet Static",
    desc: "Grainy texture with a soft, tactile warmth.",
    href: "https://example.com/velvet-static",
  },
  {
    src: "/images/06.jpg",
    title: "Liquid Form",
    desc: "Shapes that melt and reshape as you look.",
    href: "https://example.com/liquid-form",
  },
  {
    src: "/images/07.jpg",
    title: "Aurora Fold",
    desc: "Ribbons of light folding across the sky.",
    href: "https://example.com/aurora-fold",
  },
  {
    src: "/images/08.jpg",
    title: "Glass Memory",
    desc: "Translucent layers holding faded moments.",
    href: "https://example.com/glass-memory",
  },
] as const;

const COUNT = SLIDES.length;

// ---- Scene constants (world units) ----
const PARENT_HEIGHT = 75; // controls how quickly the strip bends toward the camera
const CURVATURE = 35;
const CARD_WIDTH = 18; // 90% of the old 20-unit-wide strip
const SLIDE_HEIGHT = 15;
const GAP = 0.5;
const PITCH = SLIDE_HEIGHT + GAP;
// Cards are laid out on a loop this tall. A card that scrolls off one end
// re-enters at the other, far outside the visible area, so the loop is seamless.
const CYCLE = COUNT * PITCH;
const CARD_SEGMENTS_Y = 48; // enough to follow the curve smoothly
const TEXTURE_PPU = 64; // texture pixels per world unit
const IMAGE_ZOOM = 1.1; // hover: the image inside the card zooms by this much
const HOVER_SPEED = 12; // higher = snappier hover easing

const FONT_STACK = `"Helvetica Neue", Helvetica, Arial, sans-serif`;

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      console.warn(`CurvedSlider: failed to load ${src}`);
      resolve(null);
    };
    img.src = src;
  });
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

// Splits text into lines that fit inside maxWidth (uses the ctx's current font).
function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// ---------------------------------------------------------------------------
// Layout helpers (pure, no DOM)
// ---------------------------------------------------------------------------

// Height of the curved surface at a given y.
const curveZ = (y: number) =>
  Math.pow(Math.abs(y / (PARENT_HEIGHT / 2)), 2) * CURVATURE;

// Vertical center of a card for a given scroll shift, wrapped into
// [-CYCLE / 2, CYCLE / 2). Scrolling down (shift increasing) moves cards up.
function cardCenterY(index: number, shift: number): number {
  const raw = -index * PITCH + shift;
  return ((((raw + CYCLE / 2) % CYCLE) + CYCLE) % CYCLE) - CYCLE / 2;
}

interface Card {
  index: number;
  mesh: THREE.Mesh; // image layer (this is what gets hit-tested)
  textMesh: THREE.Mesh | null; // title + description layer, drawn on top
  geometry: THREE.PlaneGeometry; // shared by both layers
  imageTexture: THREE.Texture | null;
  hover: number; // 0..1, eased toward the hover target
}

function createCard(
  index: number,
  imageMaterial: THREE.Material,
  textMaterial?: THREE.Material,
  imageTexture: THREE.Texture | null = null,
): Card {
  const geometry = new THREE.PlaneGeometry(
    CARD_WIDTH,
    SLIDE_HEIGHT,
    1,
    CARD_SEGMENTS_Y,
  );

  const mesh = new THREE.Mesh(geometry, imageMaterial);
  mesh.frustumCulled = false; // vertices move every frame
  mesh.userData.index = index;

  let textMesh: THREE.Mesh | null = null;
  if (textMaterial) {
    textMesh = new THREE.Mesh(geometry, textMaterial);
    textMesh.frustumCulled = false;
    textMesh.renderOrder = 1; // always after the image layers
  }

  // Keep the flat plane's (x, y) so layout can be recomputed from it.
  geometry.userData.base = Float32Array.from(
    geometry.attributes.position.array as Float32Array,
  );

  return { index, mesh, textMesh, geometry, imageTexture, hover: 0 };
}

// Places a card on the curve. The card itself never changes size.
function layoutCard(card: Card, centerY: number) {
  const pos = card.geometry.attributes.position as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const base = card.geometry.userData.base as Float32Array;
  for (let v = 0; v < pos.count; v++) {
    const x = base[v * 3];
    const y = centerY + base[v * 3 + 1];
    arr[v * 3] = x;
    arr[v * 3 + 1] = y;
    arr[v * 3 + 2] = curveZ(y);
  }
  pos.needsUpdate = true;
  // Raycasting uses these, so they must follow the moving vertices.
  card.geometry.computeBoundingSphere();
  card.geometry.computeBoundingBox();
}

// Zooms the picture inside its card: UV scale around the center.
// zoom = 1 shows the whole image, zoom = 1.1 shows the middle ~91% of it.
function setImageZoom(texture: THREE.Texture, zoom: number) {
  texture.center.set(0.5, 0.5);
  texture.repeat.set(1 / zoom, 1 / zoom);
}

const _ndc = new THREE.Vector2();

// Index of the card under the given NDC point, or -1.
function pickCard(
  raycaster: THREE.Raycaster,
  camera: THREE.PerspectiveCamera,
  meshes: THREE.Object3D[],
  x: number,
  y: number,
): number {
  _ndc.set(x, y);
  raycaster.setFromCamera(_ndc, camera);
  const hits = raycaster.intersectObjects(meshes, false);
  return hits.length ? (hits[0].object.userData.index as number) : -1;
}

function setupCamera(camera: THREE.PerspectiveCamera) {
  const distance = 17.5;
  const heightOffset = 5;
  const offsetX = distance * Math.sin(THREE.MathUtils.degToRad(20));
  const offsetZ = distance * Math.cos(THREE.MathUtils.degToRad(20));
  camera.position.set(offsetX, heightOffset, offsetZ);
  camera.lookAt(0, -2, 0);
  camera.rotation.z = THREE.MathUtils.degToRad(-5);
  camera.updateMatrixWorld();
}

// ---------------------------------------------------------------------------
// Canvas drawing (three separate layers per card)
// ---------------------------------------------------------------------------

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(CARD_WIDTH * TEXTURE_PPU);
  canvas.height = Math.round(SLIDE_HEIGHT * TEXTURE_PPU);
  return canvas;
}

// Layer 1: the picture only ("object-fit: cover"), full rectangle, no rounding.
function drawImageCanvas(
  img: HTMLImageElement | null,
): HTMLCanvasElement | null {
  const canvas = makeCanvas();
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;
  const W = canvas.width;
  const H = canvas.height;

  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, W, H);

  if (img) {
    const imageAspect = img.naturalWidth / img.naturalHeight;
    const rectAspect = W / H;
    let drawWidth: number;
    let drawHeight: number;
    let drawX: number;
    let drawY: number;

    if (imageAspect > rectAspect) {
      drawHeight = H;
      drawWidth = drawHeight * imageAspect;
      drawX = (W - drawWidth) / 2;
      drawY = 0;
    } else {
      drawWidth = W;
      drawHeight = drawWidth / imageAspect;
      drawX = 0;
      drawY = (H - drawHeight) / 2;
    }
    ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
  }
  return canvas;
}

// Layer 2: rounded-corner mask (white = visible). Shared by every card and
// never zoomed, so the card keeps its exact shape while the image moves.
function drawMaskCanvas(): HTMLCanvasElement | null {
  const canvas = makeCanvas();
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  roundedRectPath(ctx, 0, 0, canvas.width, canvas.height, 0.6 * TEXTURE_PPU);
  ctx.fill();
  return canvas;
}

// Layer 3: title + short description on a transparent background.
function drawTextCanvas(
  slide: (typeof SLIDES)[number],
): HTMLCanvasElement | null {
  const ppu = TEXTURE_PPU;
  const canvas = makeCanvas();
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const W = canvas.width;
  const H = canvas.height;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const titleSize = Math.round(ppu * 1.75);
  const descSize = Math.round(ppu * 0.62);
  const descLineHeight = descSize * 1.4;
  const blockGap = ppu * 0.45;

  ctx.font = `400 ${descSize}px ${FONT_STACK}`;
  const descLines = wrapLines(ctx, slide.desc, W * 0.62);

  const blockHeight = titleSize + blockGap + descLines.length * descLineHeight;
  const blockTop = H / 2 - blockHeight / 2;
  const cx = W / 2;

  // Soft shadow keeps the text readable without dimming the image itself.
  ctx.shadowColor = "rgba(0, 0, 0, 0.65)";
  ctx.shadowBlur = ppu * 0.5;

  ctx.fillStyle = "#fff";
  ctx.font = `500 ${titleSize}px ${FONT_STACK}`;
  ctx.fillText(slide.title, cx, blockTop + titleSize / 2);

  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.font = `400 ${descSize}px ${FONT_STACK}`;
  descLines.forEach((line, k) => {
    ctx.fillText(
      line,
      cx,
      blockTop + titleSize + blockGap + (k + 0.5) * descLineHeight,
    );
  });

  return canvas;
}

function initScene(
  canvas: HTMLCanvasElement,
  images: (HTMLImageElement | null)[],
): () => void {
  // ---------- Renderer / camera ----------
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    1000,
  );
  setupCamera(camera);

  // ---------- Cards (one curved mesh per slide) ----------
  const group = new THREE.Group();
  group.rotation.x = THREE.MathUtils.degToRad(-20);
  group.rotation.y = THREE.MathUtils.degToRad(20);
  scene.add(group);

  const maxAniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const cards: Card[] = [];
  const textures: THREE.Texture[] = [];
  const materials: THREE.Material[] = [];

  const makeTexture = (
    source: HTMLCanvasElement | null,
    srgb: boolean,
  ): THREE.CanvasTexture | null => {
    if (!source) return null;
    const t = new THREE.CanvasTexture(source);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = maxAniso;
    textures.push(t);
    return t;
  };

  // One rounded-corner mask shared by all cards (alphaMap reads the green channel).
  const maskTexture = makeTexture(drawMaskCanvas(), false);

  for (let i = 0; i < COUNT; i++) {
    const imageTexture = makeTexture(drawImageCanvas(images[i]), true);
    const textTexture = makeTexture(drawTextCanvas(SLIDES[i]), true);

    // Image layer: zoomed through its own UV transform on hover.
    // The mask has a separate UV transform, so the card outline never moves.
    const imageMaterial = new THREE.MeshBasicMaterial({
      map: imageTexture,
      alphaMap: maskTexture,
      color: imageTexture ? 0xffffff : 0x111111,
      side: THREE.DoubleSide,
      transparent: true,
      alphaTest: 0.01,
    });
    materials.push(imageMaterial);

    // Text layer: never zoomed, always drawn after (and over) the images.
    const textMaterial = new THREE.MeshBasicMaterial({
      map: textTexture,
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    materials.push(textMaterial);

    const card = createCard(i, imageMaterial, textMaterial, imageTexture);
    if (imageTexture) setImageZoom(imageTexture, 1);
    layoutCard(card, cardCenterY(i, 0));
    group.add(card.mesh);
    if (card.textMesh) group.add(card.textMesh);
    cards.push(card);
  }
  scene.updateMatrixWorld(true);

  // Only the image layers are hit-tested.
  const meshes = cards.map((c) => c.mesh);
  const raycaster = new THREE.Raycaster();

  // ---------- Pointer: hover + click ----------
  const pointer = { x: 0, y: 0, inside: false, moved: false };
  let hovered = -1;

  const toNdc = (clientX: number, clientY: number) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / r.width) * 2 - 1,
      y: -((clientY - r.top) / r.height) * 2 + 1,
    };
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") return; // no hover on touch screens
    const p = toNdc(e.clientX, e.clientY);
    pointer.x = p.x;
    pointer.y = p.y;
    pointer.inside = true;
    pointer.moved = true;
  };
  const onPointerLeave = () => {
    pointer.inside = false;
    pointer.moved = true;
  };

  let downX = 0;
  let downY = 0;
  const onPointerDown = (e: PointerEvent) => {
    downX = e.clientX;
    downY = e.clientY;
  };
  const onClick = (e: MouseEvent) => {
    // Ignore drags (mouse press-move-release)
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
    const p = toNdc(e.clientX, e.clientY);
    const idx = pickCard(raycaster, camera, meshes, p.x, p.y);
    if (idx >= 0) {
      window.open(SLIDES[idx].href, "_blank", "noopener,noreferrer");
    }
  };

  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("click", onClick);

  // ---------- Infinite smooth scroll + render loop ----------
  // infinite: Lenis wraps `scroll` back to 0 at the end of the page.
  // syncTouch: needed so touch devices also use Lenis' virtual scrolling.
  const lenis = new Lenis({
    duration: 1.05,
    smoothWheel: true,
    infinite: true,
    syncTouch: true,
  });

  // Lenis' `scroll` jumps back to 0 at the wrap point. Undo that jump so we
  // get one continuous, ever-growing distance. Cards wrap with a modulo
  // anyway, so the picture never jumps.
  let lastScroll = lenis.scroll;
  let totalScroll = 0;
  let dirty = true;

  const tick = (time: number, deltaTime: number) => {
    lenis.raf(time * 1000);

    // --- scroll distance (unwrapped) ---
    let shiftChanged = false;
    const limit = lenis.limit;
    const s = lenis.scroll;
    if (limit > 0) {
      let d = s - lastScroll;
      if (d > limit / 2) d -= limit;
      else if (d < -limit / 2) d += limit;
      if (d !== 0) {
        totalScroll += d;
        shiftChanged = true;
      }
      lastScroll = s;
    }

    // --- ease the hover amounts (this only zooms the image inside the card) ---
    const dt = Math.min(deltaTime / 1000, 0.05);
    const k = 1 - Math.exp(-dt * HOVER_SPEED);
    let animating = false;
    for (const card of cards) {
      const target = card.index === hovered ? 1 : 0;
      const diff = target - card.hover;
      let changed = false;
      if (Math.abs(diff) > 0.0005) {
        card.hover += diff * k;
        changed = true;
      } else if (diff !== 0) {
        card.hover = target;
        changed = true;
      }
      if (changed) {
        animating = true;
      }
      if (changed && card.imageTexture) {
        const e = card.hover * card.hover * (3 - 2 * card.hover); // smoothstep
        setImageZoom(card.imageTexture, 1 + (IMAGE_ZOOM - 1) * e);
      }
    }

    // --- move cards only when scrolling; render only when something changed ---
    if (shiftChanged || dirty) {
      // One slide per viewport height of scrolling
      const shift = totalScroll * (PITCH / window.innerHeight);
      for (const card of cards)
        layoutCard(card, cardCenterY(card.index, shift));
    }
    if (shiftChanged || animating || dirty) {
      renderer.render(scene, camera);
      dirty = false;
    }

    // --- hover hit-test (also while scrolling under a still mouse) ---
    if (pointer.inside) {
      if (pointer.moved || shiftChanged) {
        pointer.moved = false;
        hovered = pickCard(raycaster, camera, meshes, pointer.x, pointer.y);
        canvas.style.cursor = hovered >= 0 ? "pointer" : "";
      }
    } else if (hovered !== -1) {
      hovered = -1;
      canvas.style.cursor = "";
    }
  };
  gsap.ticker.add(tick);
  gsap.ticker.lagSmoothing(0);

  // ---------- Resize ----------
  let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
  const onResize = () => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      dirty = true;
    }, 250);
  };
  window.addEventListener("resize", onResize);

  // ---------- Cleanup ----------
  return () => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    window.removeEventListener("resize", onResize);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("click", onClick);
    canvas.style.cursor = "";
    gsap.ticker.remove(tick);
    lenis.destroy();
    cards.forEach((c) => c.geometry.dispose());
    materials.forEach((m) => m.dispose());
    textures.forEach((t) => t.dispose());
    // Don't call forceContextLoss(): React StrictMode remounts reuse this canvas.
    renderer.dispose();
  };
}

export default function CurvedSlider() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let teardown: (() => void) | null = null;

    // Promise.all keeps the images in slide order regardless of load timing.
    Promise.all(SLIDES.map((slide) => loadImage(slide.src))).then((images) => {
      if (disposed) return;
      teardown = initScene(canvas, images);
      setReady(true);
    });

    return () => {
      disposed = true;
      teardown?.();
    };
  }, []);

  return (
    // The page needs real height so Lenis has something to scroll.
    <main className="curve-root" style={{ height: `${COUNT * 100}vh` }}>
      <div
        className={`loader ${ready ? "loader--done" : ""}`}
        aria-hidden
        // Once loaded, make sure the loader can never tint the canvas.
        style={
          ready
            ? { opacity: 0, visibility: "hidden", pointerEvents: "none" }
            : undefined
        }
      >
        <span>Loading gallery</span>
      </div>

      <header className="site-nav">
        <p className="logo">CURVE</p>
        <p>Mind-bending 3D scroll</p>
      </header>

      {/* The canvas stays pinned while the page scrolls underneath it. */}
      <div className="slider-wrapper" style={{ position: "fixed", inset: 0 }}>
        <canvas ref={canvasRef} />
      </div>

      {/* Edge-only vignette: the center stays fully transparent so images
          show at full brightness. Set the alpha to 0 to remove it entirely. */}
      <div
        className="overlay"
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          background:
            "radial-gradient(ellipse at center, rgba(0,0,0,0) 60%, rgba(0,0,0,0.45) 100%)",
          opacity: 1,
        }}
      ></div>
    </main>
  );
}
