// Canonical edge key for node pairs. Used by the canvas, selection context,
// and partitions state so `(a, b)` and `(b, a)` always resolve to the same
// key. Mirrors the ordering in `src/rules.rs::proximity_key` for node pairs.

export function edgeKey(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`
}

/** Return `[lo, hi]` where lo <= hi lexicographically. */
export function canonicalPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a]
}
