// Decoy selection: 15 decoys + the real output, sorted ascending so the position leaks nothing.
// Mix of recent outputs (where real spends usually come from) and the whole history.
export function pickRing(realGidx, eligibleCount, size = 16, rand = Math.random) {
  if (eligibleCount < size) throw new Error(`need at least ${size} mature outputs on chain (have ${eligibleCount})`);
  if (realGidx >= eligibleCount) throw new Error("output not mature yet");
  const set = new Set([realGidx]);
  const recentSpan = Math.max(size * 3, Math.floor(eligibleCount * 0.25));
  let guard = 0;
  while (set.size < size && guard++ < 10_000) {
    const g = rand() < 0.6
      ? eligibleCount - 1 - Math.floor(rand() * Math.min(recentSpan, eligibleCount))
      : Math.floor(rand() * eligibleCount);
    set.add(g);
  }
  if (set.size < size) throw new Error("could not fill ring");
  return [...set].sort((a, b) => a - b);
}
