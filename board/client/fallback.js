export function detectWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
  } catch { return false; }
}

export function shouldUseFallback({ gl, reducedMotion }) { return !gl || reducedMotion; }

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Same interface as createScene: { update(ships), dispose() }.
export function createFallback(container) {
  const el = document.createElement('div');
  el.className = 'roster';
  container.append(el);
  return {
    update(ships) {
      el.innerHTML = ships.map((s) => `
        <div class="row">
          <span class="chip" style="background:${escapeHtml(s.color)};color:${escapeHtml(s.color)}"></span>
          <span class="cs">@${escapeHtml(s.callsign)}</span>
          <span class="st st-${escapeHtml(s.status)}">${escapeHtml(s.stage)} · ${escapeHtml(s.status)}</span>
          <span class="model">${escapeHtml(s.shipModel || '')}</span>
          ${s.live ? '<span class="live">LIVE</span>' : ''}
        </div>`).join('');
    },
    dispose() { el.remove(); },
  };
}
