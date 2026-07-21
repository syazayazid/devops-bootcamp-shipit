// Pure keystroke evaluation for the cockpit's strict terminal line: wrong keys
// never land, so the typed prefix is always correct and backspace has nothing
// to do. Correctness is judged client-side (the server stays authoritative
// over position — see the spec's security note).
//
// advance(target, at, incoming) -> new cursor: consumes incoming characters,
// advancing only while each matches the target at the cursor; the first wrong
// character stops the walk and the rest is dropped.
export function advance(target, at, incoming) {
  let n = at;
  for (const ch of incoming) {
    if (n < target.length && ch === target[n]) n += 1;
    else break;
  }
  return n;
}
