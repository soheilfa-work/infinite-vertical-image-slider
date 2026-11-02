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
  },
  {
    src: "/images/02.jpg",
    title: "Soft Interference",
    desc: "Overlapping waves that blur into gentle patterns.",
  },
  {
    src: "/images/03.jpg",
    title: "Painted Silence",
    desc: "Quiet brushstrokes frozen mid-motion.",
  },
  {
    src: "/images/04.jpg",
    title: "Neon Bloom",
    desc: "Glowing petals opening in the dark.",
  },
  {
    src: "/images/05.jpg",
    title: "Velvet Static",
    desc: "Grainy texture with a soft, tactile warmth.",
  },
  {
    src: "/images/06.jpg",
    title: "Liquid Form",
    desc: "Shapes that melt and reshape as you look.",
  },
  {
    src: "/images/07.jpg",
    title: "Aurora Fold",
    desc: "Ribbons of light folding across the sky.",
  },
  {
    src: "/images/08.jpg",
    title: "Glass Memory",
    desc: "Translucent layers holding faded moments.",
  },
] as const;

const COUNT = SLIDES.length;

// ---- Scene constants (world units) ----
const PARENT_WIDTH = 20;
const PARENT_HEIGHT = 75;
const CURVATURE = 35;
const SEGMENTS_X = 200;
const SEGMENTS_Y = 200;
const SLIDE_HEIGHT = 15;
const GAP = 0.5;
const SLIDE_PITCH = SLIDE_HEIGHT + GAP;
// One full loop of slides. The texture holds exactly one cycle and repeats.
const CYCLE_HEIGHT = COUNT * SLIDE_PITCH;

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

  // ---------- Curved parent plane ----------
  const parentGeometry = new THREE.PlaneGeometry(
    PARENT_WIDTH,
    PARENT_HEIGHT,
    SEGMENTS_X,
    SEGMENTS_Y,
  );
  const positions = parentGeometry.attributes.position.array as Float32Array;
  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1];
    const distanceFromCenter = Math.abs(y / (PARENT_HEIGHT / 2));
    positions[i + 2] = Math.pow(distanceFromCenter, 2) * CURVATURE;
  }
  parentGeometry.attributes.position.needsUpdate = true;
  parentGeometry.computeVertexNormals();

  // ---------- Texture canvas (drawn ONCE, scrolled via texture.offset) ----------
  // Keep pixels-per-world-unit identical on both axes so images aren't stretched.
  const maxTex = Math.min(8192, renderer.capabilities.maxTextureSize);
  const ppu = Math.min(2048 / PARENT_WIDTH, maxTex / CYCLE_HEIGHT);

  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = Math.round(PARENT_WIDTH * ppu);
  textureCanvas.height = Math.round(CYCLE_HEIGHT * ppu);

  const ctx = textureCanvas.getContext("2d", { alpha: false });
  if (!ctx) {
    renderer.dispose();
    parentGeometry.dispose();
    return () => {};
  }

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, textureCanvas.width, textureCanvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let i = 0; i < COUNT; i++) {
    const rect = {
      x: PARENT_WIDTH * 0.05 * ppu,
      y: (i * SLIDE_PITCH + GAP / 2) * ppu,
      width: PARENT_WIDTH * 0.9 * ppu,
      height: SLIDE_HEIGHT * ppu,
    };

    ctx.save();
    roundedRectPath(ctx, rect.x, rect.y, rect.width, rect.height, 0.6 * ppu);
    ctx.clip();
    ctx.fillStyle = "#111";
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

    const img = images[i];
    if (img) {
      // "object-fit: cover"
      const imageAspect = img.naturalWidth / img.naturalHeight;
      const rectAspect = rect.width / rect.height;
      let drawWidth: number;
      let drawHeight: number;
      let drawX: number;
      let drawY: number;

      if (imageAspect > rectAspect) {
        drawHeight = rect.height;
        drawWidth = drawHeight * imageAspect;
        drawX = rect.x + (rect.width - drawWidth) / 2;
        drawY = rect.y;
      } else {
        drawWidth = rect.width;
        drawHeight = drawWidth / imageAspect;
        drawX = rect.x;
        drawY = rect.y + (rect.height - drawHeight) / 2;
      }
      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
    }
    ctx.restore();

    // ---- Title + short description, centered as one block ----
    const slide = SLIDES[i];
    const titleSize = Math.round(ppu * 1.75);
    const descSize = Math.round(ppu * 0.62);
    const descLineHeight = descSize * 1.4;
    const blockGap = ppu * 0.45;

    ctx.font = `400 ${descSize}px ${FONT_STACK}`;
    const descLines = wrapLines(ctx, slide.desc, rect.width * 0.62);

    const blockHeight =
      titleSize + blockGap + descLines.length * descLineHeight;
    const blockTop = rect.y + rect.height / 2 - blockHeight / 2;
    const cx = textureCanvas.width / 2;

    ctx.save();
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
    ctx.restore();
  }

  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());

  // The plane shows PARENT_HEIGHT units of a CYCLE_HEIGHT-tall texture.
  const repeatY = PARENT_HEIGHT / CYCLE_HEIGHT;
  texture.repeat.set(1, repeatY);
  texture.needsUpdate = true;

  // offset.y that puts slide 1 in the middle of the plane at scroll progress 0
  const baseOffset =
    1 - (GAP / 2 + SLIDE_HEIGHT / 2) / CYCLE_HEIGHT - repeatY / 2;
  // progress 0 -> 1 moves from slide 1 to the last slide
  const travel = ((COUNT - 1) * SLIDE_PITCH) / CYCLE_HEIGHT;

  const parentMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
  });

  const parentMesh = new THREE.Mesh(parentGeometry, parentMaterial);
  parentMesh.position.set(0, 0, 0);
  parentMesh.rotation.x = THREE.MathUtils.degToRad(-20);
  parentMesh.rotation.y = THREE.MathUtils.degToRad(20);
  scene.add(parentMesh);

  const distance = 17.5;
  const heightOffset = 5;
  const offsetX = distance * Math.sin(THREE.MathUtils.degToRad(20));
  const offsetZ = distance * Math.cos(THREE.MathUtils.degToRad(20));
  camera.position.set(offsetX, heightOffset, offsetZ);
  camera.lookAt(0, -2, 0);
  camera.rotation.z = THREE.MathUtils.degToRad(-5);

  // ---------- Smooth scroll + render loop ----------
  const lenis = new Lenis({ duration: 1.05, smoothWheel: true });

  let dirty = true;
  let lastProgress = -1;

  const tick = (time: number) => {
    lenis.raf(time * 1000);

    const progress = lenis.limit > 0 ? lenis.scroll / lenis.limit : 0;
    if (progress !== lastProgress) {
      lastProgress = progress;
      texture.offset.y = baseOffset - progress * travel;
      dirty = true;
    }

    if (dirty) {
      dirty = false;
      renderer.render(scene, camera);
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
    gsap.ticker.remove(tick);
    lenis.destroy();
    parentGeometry.dispose();
    parentMaterial.dispose();
    texture.dispose();
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
