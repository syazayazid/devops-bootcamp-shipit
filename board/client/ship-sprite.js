// board/client/ship-sprite.js
// One-time GLB → 2D sprite renders for the race track. Each (shipModel, color)
// pair is rendered once to a small transparent canvas and cached as a data-URL;
// after that the race is plain DOM — no per-frame WebGL. Resolves null when
// WebGL or the models are unavailable; the track shows a tinted glyph instead.
import * as THREE from 'three';
import { createShip, preloadShipTemplates, disposeShip, disposeObject3D } from './ship-mesh.js';

const SIZE = 128; // ~2.5x the largest on-screen box so hiDPI stays crisp
const cache = new Map(); // `${shipModel}|${color}` -> Promise<string|null>
let ctx; // lazy { renderer, scene, camera }; null = WebGL unavailable
let templatesPromise; // cache the promise; all sprite renders share one load

function setup() {
  try {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(SIZE, SIZE);
    const scene = new THREE.Scene();
    // Elevated 3/4 vantage: ship stays level (no fake nose-down pitch), the
    // camera looks down at ~29° so the top surface and silhouette both read.
    const camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 50);
    camera.position.set(0, 5.5, 10);
    camera.lookAt(0, 0, 0);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(2, 4, 6);
    scene.add(key);
    return { renderer, scene, camera };
  } catch {
    return null;
  }
}

async function render(shipModel, color) {
  templatesPromise ??= preloadShipTemplates();
  const templates = await templatesPromise;
  if (ctx === undefined) ctx = setup();
  if (!ctx) return null;
  const template = templates.get(shipModel) || templates.get('fighter');
  const ship = createShip({ callsign: '', color, shipModel, template });
  // Strip the non-hull extras (label sprite; invisible trail/liveRing meshes):
  // Box3.setFromObject counts them even when invisible, which would inflate the
  // framing below and shrink the hull to a speck in the canvas.
  for (const o of [...ship.children]) {
    if (o.isSprite || o.visible === false) { ship.remove(o); disposeObject3D(o); }
  }
  // Yaw the nose toward +x (the track direction), leaning slightly toward the
  // viewer so the sprite isn't a flat side sliver; the camera above adds the
  // top-down component — the ship itself stays level. All four GLBs point
  // their nose down +z (confirmed on-screen against the track).
  ship.rotation.y = Math.PI / 2 - 0.4;
  ctx.scene.add(ship);
  ship.updateMatrixWorld(true);
  // Frame the hull in CAMERA space (the camera is tilted, so a world-space
  // box would mis-frame): project the world box's corners into view space
  // and fit the ortho frustum around them.
  const box = new THREE.Box3().setFromObject(ship);
  ctx.camera.updateMatrixWorld(true); // lazy until first render — without this the FIRST sprite frames against identity and comes out empty
  const view = new THREE.Matrix4().copy(ctx.camera.matrixWorld).invert();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        const v = new THREE.Vector3(x, y, z).applyMatrix4(view);
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      }
    }
  }
  const half = (Math.max(maxX - minX, maxY - minY) / 2) * 1.08 || 1.6;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  ctx.camera.left = cx - half;
  ctx.camera.right = cx + half;
  ctx.camera.top = cy + half;
  ctx.camera.bottom = cy - half;
  ctx.camera.updateProjectionMatrix();
  ctx.renderer.render(ctx.scene, ctx.camera);
  const url = ctx.renderer.domElement.toDataURL('image/png');
  ctx.scene.remove(ship);
  disposeShip(ship);
  return url;
}

export function shipSprite(shipModel, color) {
  const k = `${shipModel}|${color}`;
  if (!cache.has(k)) cache.set(k, render(shipModel, color).catch(() => null));
  return cache.get(k);
}