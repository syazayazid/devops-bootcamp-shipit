export function parse(raw) {
  try { const m = JSON.parse(raw); return (m && typeof m === 'object') ? m : null; }
  catch { return null; }
}
export const rosterMsg = (ships) => JSON.stringify({ t: 'roster', ships });

// Enrich race positions with each ship's roster appearance (color/shipModel).
export const raceMsg = (snap, view, clients, roster) => JSON.stringify({
  t: 'race', view, clients,
  phase: snap.phase, total: snap.total, prompts: snap.prompts,
  ships: snap.ships.map((s) => {
    const r = roster.get(s.callsign);
    return { ...s, color: r?.color, shipModel: r?.shipModel };
  }),
});
