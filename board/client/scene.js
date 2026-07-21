// board/client/scene.js
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { createShip, setEmissiveBoost, setTrail, setGrounded, setLive, preloadShipTemplates, disposeShip, disposeObject3D } from './ship-mesh.js';
import { placement } from './placement.js';
import { orbitAngle } from './orbit.js';
import { launchPhase, isComplete, easeInCubic, easeInOutCubic } from './launch.js';
import { PALETTE, LAYOUT, BLOOM, LAUNCH, DAMP_K } from './theme.js';

const { PAD_Y, ORBIT_Y, ORBIT_R, GRID_SIZE, GRID_DIV, ASCEND_COLS, ASCEND_GAP } = LAYOUT;

export function createScene(container, { onLiftoff, onPreloadError } = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.bg);
  scene.fog = new THREE.FogExp2(PALETTE.bg, 0.02);

  const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 100);
  const CAM = new THREE.Vector3(0, 6.5, 10);
  const LOOK = new THREE.Vector3(0, 2.2, 0);
  camera.position.copy(CAM); camera.lookAt(LOOK);

  const renderer = new THREE.WebGLRenderer({ antialias: true }); // opaque — bloom needs it
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.append(renderer.domElement);

  scene.add(new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, 0.6));
  const key = new THREE.DirectionalLight(PALETTE.dir, 0.8); key.position.set(3, 6, 4); scene.add(key);

  const grid = new THREE.GridHelper(GRID_SIZE, GRID_DIV, PALETTE.grid, PALETTE.gridDim);
  grid.material.transparent = true; grid.material.opacity = 0.3; scene.add(grid);
  const pad = new THREE.Mesh(new THREE.CircleGeometry(3.4, 48),
    new THREE.MeshBasicMaterial({ color: PALETTE.bg, transparent: true, opacity: 0.55 }));
  pad.rotation.x = -Math.PI / 2; pad.position.y = 0.001; scene.add(pad);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(ORBIT_R, 0.02, 12, 96),
    new THREE.MeshBasicMaterial({ color: PALETTE.ring })); // bright → blooms into a halo
  ring.position.y = ORBIT_Y; ring.rotation.x = Math.PI / 2; scene.add(ring);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(container.clientWidth, container.clientHeight),
    BLOOM.strength, BLOOM.radius, BLOOM.threshold);
  composer.addPass(bloom);
  composer.setSize(container.clientWidth, container.clientHeight);

  const ships = new Map(); // callsign -> { group, data, index, pos, lastZone, launch }
  let templates = null;      // id -> template Object3D, once preloaded
  let pendingList = null;    // roster that arrived before templates were ready
  let disposed = false;      // guards the in-flight preload promise against a torn-down scene
  let angle = 0;
  let elapsedMs = 0;
  const clock = new THREE.Clock();
  const tmp = new THREE.Vector3();

  function update(list) {
    if (!templates) { pendingList = list; return; }   // buffer until preloaded
    const seen = new Set();
    list.forEach((s, i) => {
      seen.add(s.callsign);
      let rec = ships.get(s.callsign);
      if (!rec || rec.data.color !== s.color || rec.data.shipModel !== s.shipModel) {
        if (rec) { scene.remove(rec.group); disposeShip(rec.group); }
        const template = templates.get(s.shipModel) || templates.get('fighter');
        const group = createShip({ callsign: s.callsign, color: s.color, shipModel: s.shipModel, template });
        scene.add(group);
        rec = { group, pos: null, lastZone: undefined, launch: null };
        ships.set(s.callsign, rec);
      }
      rec.data = s; rec.index = i;
      setLive(rec.group, s.live); // green halo when the real Pages site is reachable

      const zone = placement(s).zone;
      if (zone !== rec.lastZone) setGrounded(rec.group, zone === 'grounded');
      // Launch ONLY on a live observed transition into orbit (rec.pos set = we
      // saw it before). A ship first seen already in orbit snaps in (pos===null).
      if (rec.pos && rec.lastZone && rec.lastZone !== 'orbit' && zone === 'orbit' && !rec.launch) {
        rec.launch = { startMs: elapsedMs, from: rec.pos.clone(), toasted: false };
      }
      // Interruption mid-launch (abort, or a re-run dropping back to pad/ascending)
      // → cancel the beat. When the new zone is grounded, the setGrounded() above
      // already applied the red glow, so only restore the base emissive otherwise.
      if (rec.launch && zone !== 'orbit') {
        rec.launch = null;
        setTrail(rec.group, false);
        if (zone !== 'grounded') setEmissiveBoost(rec.group, rec.group.userData.baseEmissive);
      }
      rec.lastZone = zone;
    });
    for (const [callsign, rec] of ships) {
      if (!seen.has(callsign)) { scene.remove(rec.group); disposeShip(rec.group); ships.delete(callsign); }
    }
  }

  // Orbiting ships, ordered stably by callsign → deterministic even-spacing slots.
  function orbitingIndex() {
    const orbiting = [...ships.values()]
      .filter((r) => placement(r.data).zone === 'orbit')
      .sort((a, b) => (a.data.callsign < b.data.callsign ? -1 : 1));
    const map = new Map();
    orbiting.forEach((r, i) => map.set(r.data.callsign, i));
    return { map, count: orbiting.length };
  }

  function targetFor(rec, orbitIdx, orbitingCount, out) {
    const { zone, t } = placement(rec.data);
    if (zone === 'orbit') {
      const a = orbitAngle(orbitIdx, orbitingCount, angle);
      return out.set(Math.cos(a) * ORBIT_R, ORBIT_Y, Math.sin(a) * ORBIT_R);
    }
    const col = rec.index % ASCEND_COLS, row = Math.floor(rec.index / ASCEND_COLS);
    const x = (col - (ASCEND_COLS - 1) / 2) * ASCEND_GAP, z = row * ASCEND_GAP - 1;
    if (zone === 'grounded') return out.set(x, PAD_Y + 0.15, z);
    return out.set(x, PAD_Y + t * (ORBIT_Y - PAD_Y), z);
  }

  // The launch beat: charge (dip + glow + ignite) → thrust (rise past orbit) →
  // arc (over into the orbit slot). `slot` is the ship's even-spaced orbit target.
  function applyLaunch(rec, slot) {
    const le = elapsedMs - rec.launch.startMs;
    const ph = launchPhase(le);
    const from = rec.launch.from;
    const base = rec.group.userData.baseEmissive;
    if (ph.phase === 'charge') {
      rec.pos.set(from.x, from.y - LAUNCH.CROUCH_Y * Math.sin(ph.f * Math.PI), from.z);
      setEmissiveBoost(rec.group, base + ph.f * 1.2);
      setTrail(rec.group, true, 0.3 + ph.f * 0.4);
    } else if (ph.phase === 'thrust') {
      if (!rec.launch.toasted) { onLiftoff?.(rec.data.callsign, rec.data.color); rec.launch.toasted = true; }
      rec.pos.set(from.x, from.y + (LAUNCH.APEX_Y - from.y) * easeInCubic(ph.f), from.z);
      setEmissiveBoost(rec.group, base + 1.4);
      setTrail(rec.group, true, 1);
    } else if (ph.phase === 'arc') {
      const e = easeInOutCubic(ph.f);
      rec.pos.set(
        from.x + (slot.x - from.x) * e,
        LAUNCH.APEX_Y + (slot.y - LAUNCH.APEX_Y) * e,
        from.z + (slot.z - from.z) * e,
      );
      setEmissiveBoost(rec.group, base + (1 - ph.f) * 1.4);
      setTrail(rec.group, true, 1 - ph.f);
    }
    if (isComplete(le)) { rec.launch = null; setTrail(rec.group, false); setEmissiveBoost(rec.group, base); }
  }

  let raf = 0;
  function tick() {
    const dt = clock.getDelta();
    elapsedMs += dt * 1000;
    angle += dt * 0.15;
    camera.position.set(CAM.x + Math.sin(elapsedMs * 0.00005) * 0.35, CAM.y, CAM.z); // slow idle drift
    camera.lookAt(LOOK);

    const { map, count } = orbitingIndex();
    const damp = 1 - Math.exp(-DAMP_K * dt);
    const livePulse = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(elapsedMs * 0.004)); // ~0.35→0.70
    for (const rec of ships.values()) {
      targetFor(rec, map.get(rec.data.callsign) ?? 0, count, tmp);
      if (!rec.pos) rec.pos = tmp.clone();          // snap on first sight
      else if (rec.launch) applyLaunch(rec, tmp);   // scripted beat overrides damping
      else rec.pos.lerp(tmp, damp);                 // ease toward target — no teleports
      rec.group.position.copy(rec.pos);
      if (rec.group.userData.live) rec.group.userData.liveRing.material.opacity = livePulse;
    }
    composer.render();
    raf = requestAnimationFrame(tick);
  }
  tick();

  function onResize() {
    const w = container.clientWidth, h = container.clientHeight;
    camera.aspect = w / h;
    camera.zoom = Math.min(1, Math.max(0.6, camera.aspect / 1.4)); // narrow-viewport safety
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h); bloom.setSize(w, h);
  }
  window.addEventListener('resize', onResize);
  onResize();

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  function onClick(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects([...ships.values()].map((r) => r.group), true);
    if (!hits.length) return;
    let o = hits[0].object;
    while (o && !o.userData.callsign) o = o.parent;
    const rec = o && ships.get(o.userData.callsign);
    if (rec && rec.data.siteUrl && placement(rec.data).zone === 'orbit') window.open(rec.data.siteUrl, '_blank', 'noopener');
  }
  renderer.domElement.addEventListener('click', onClick);

  preloadShipTemplates().then((t) => {
    if (disposed) return;
    templates = t;
    if (pendingList) { const l = pendingList; pendingList = null; update(l); }
  }).catch((err) => {
    if (disposed) return;
    console.error('ship model preload failed', err);
    onPreloadError?.(err);
  });

  return {
    update,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      renderer.domElement.removeEventListener('click', onClick);
      for (const rec of ships.values()) { scene.remove(rec.group); disposeShip(rec.group); }
      if (templates) for (const tpl of templates.values()) disposeObject3D(tpl);
      ships.clear();
      grid.geometry.dispose(); grid.material.dispose();
      pad.geometry.dispose(); pad.material.dispose();
      ring.geometry.dispose(); ring.material.dispose();
      composer.dispose();
      bloom.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
