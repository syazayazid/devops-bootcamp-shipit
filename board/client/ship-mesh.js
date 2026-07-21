import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PALETTE } from './theme.js';
import { SHIPS, hueOf } from '../src/ships.js';

// Preload every ship GLB once; return id -> template Object3D. Templates own the
// shared geometry + textures; per-ship clones own only their cloned materials.
export function preloadShipTemplates() {
  const loader = new GLTFLoader();
  return Promise.all(
    SHIPS.map((s) => loader.loadAsync(import.meta.env.BASE_URL + s.file).then((g) => [s.id, g.scene])),
  ).then((pairs) => new Map(pairs));
}

export function createShip({ callsign, color, shipModel, template }) {
  const group = new THREE.Group();
  const model = template.clone(true);
  fitByMaxDimension(model, 0.8);

  const tint = new THREE.Color(color);
  const hue = hueOf(color); // target hue fraction [0,1), or null for a greyscale colour
  let mat = null; // the model's material — the launch beat drives its emissive
  model.traverse((node) => {
    if (node.isMesh && node.material) {
      node.userData.sharedGeometry = true;      // geometry belongs to the template — never dispose it
      node.material = node.material.clone();     // per-ship material...
      node.material.userData.keepTextures = true; // ...but its map textures are shared with the template
      node.material.emissive = tint.clone();
      node.material.emissiveIntensity = 0.35;   // low glow → blooms, same as the old rocket
      applyHueShift(node.material, hue);
      if (!mat) mat = node.material;
    }
  });
  group.add(model);

  // Exhaust trail — additive so it blooms; hidden until launch.
  const trailMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTE.ring), transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const trail = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.6, 12), trailMat);
  trail.position.y = -0.55;
  trail.rotation.x = Math.PI;
  trail.visible = false;
  group.add(trail);

  const label = makeLabel(callsign);
  label.position.y = 0.72;
  group.add(label);

  // LIVE halo — a green ring under the ship, shown only when the learner's real
  // Pages site answers 200. Additive so it blooms; opacity pulses in scene.tick.
  const liveMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTE.live), transparent: true, opacity: 0,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const liveRing = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.56, 40), liveMat);
  liveRing.rotation.x = -Math.PI / 2; // lie flat — a halo beneath the hull
  liveRing.position.y = -0.42;
  liveRing.visible = false;
  group.add(liveRing);

  group.userData = { callsign, color, shipModel, mat, trail, liveRing, live: false, baseEmissive: 0.35 };
  return group;
}

// Toggle the LIVE halo. Idempotent; scene.tick pulses its opacity while visible.
export function setLive(group, on) {
  const { liveRing } = group.userData;
  if (!liveRing) return;
  group.userData.live = !!on;
  liveRing.visible = !!on;
}

export function setEmissiveBoost(group, intensity) {
  if (group.userData.mat) group.userData.mat.emissiveIntensity = intensity;
}

export function setTrail(group, on, scale = 1) {
  const { trail } = group.userData;
  trail.visible = on;
  trail.material.opacity = on ? 0.9 * scale : 0;
  trail.scale.set(1, Math.max(0.001, scale), 1);
}

export function setGrounded(group, on) {
  const { mat, baseEmissive, color } = group.userData;
  if (!mat) return;
  mat.emissive.set(on ? PALETTE.grounded : color);
  mat.emissiveIntensity = on ? 0.6 : baseEmissive;
}

// Texture-cascading dispose — carried from launchpad M1. Label sprite + trail
// carry a texture/material, so this cascade is load-bearing.
export function disposeObject3D(obj) {
  obj.traverse((node) => {
    if (node.isMesh || node.isSprite) {
      node.geometry?.dispose?.();
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const m of mats) disposeMaterial(m);
    }
  });
}
function disposeMaterial(material) {
  if (!material) return;
  for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
  material.dispose();
}

// A ship clone shares the template's geometry + textures; disposing those would
// break sibling clones. createShip flags cloned-model nodes: node.userData
// .sharedGeometry and material.userData.keepTextures. Skip those; dispose the
// rest (the trail + the callsign label the clone uniquely owns).
export function disposeShip(group) {
  group.traverse((node) => {
    if (!node.isMesh && !node.isSprite) return;
    if (node.geometry && !node.userData.sharedGeometry) node.geometry.dispose();
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    for (const m of mats) {
      if (!m) continue;
      if (!m.userData.keepTextures) {
        for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      }
      m.dispose();
    }
  });
}

// SET every saturated texel's hue to `hueFrac` ([0,1)), in-shader, after the
// base-colour texture is sampled. Setting (not rotating) lands exactly on the
// chosen colour on any model — the 4 ships share one atlas with no base hue.
// Greys/blacks (saturation ~0) stay neutral. Null hueFrac → leave the paint.
// MUST match launchpad/src/scene.js's applyHueShift verbatim.
function applyHueShift(material, hueFrac) {
  if (hueFrac == null) return;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHue = { value: hueFrac };
    shader.fragmentShader =
      `uniform float uHue;
       vec3 rgb2hsv(vec3 c) {
         vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
         vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
         vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
         float d = q.x - min(q.w, q.y);
         float e = 1.0e-10;
         return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
       }
       vec3 hsv2rgb(vec3 c) {
         vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
         vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
         return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
       }
       ` +
      shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           vec3 hsv = rgb2hsv(diffuseColor.rgb);
           hsv.x = uHue;
           diffuseColor.rgb = hsv2rgb(hsv);
         }`,
      );
  };
  material.needsUpdate = true;
}

function fitByMaxDimension(object3d, target) {
  const box = new THREE.Box3().setFromObject(object3d);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const max = Math.max(size.x, size.y, size.z);
  const scale = max > 0 ? target / max : 1;
  object3d.scale.setScalar(scale);
  object3d.position.sub(center.multiplyScalar(scale));
}

// Projector-legible: big canvas, white fill with a dark stroke so the callsign
// reads over any ship tint and over the grid.
function makeLabel(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const label = '@' + text.slice(0, 15);
  ctx.font = '700 52px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.lineWidth = 10; ctx.strokeStyle = PALETTE.labelOutline;
  ctx.strokeText(label, 256, 64);
  ctx.fillStyle = PALETTE.labelText;
  ctx.fillText(label, 256, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(1.7, 0.42, 1);
  return sprite;
}
