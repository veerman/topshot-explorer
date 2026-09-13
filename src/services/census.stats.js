import sizes from "../../data/collection_sizes.json";
import stats from "../../data/census_stats.json";

/**
 * Aggregates from the collector census: how collection sizes are
 * distributed across every account holding at least one moment, and the
 * headline counts (collectors, linked wallets). Nothing per account ships;
 * these are curves and totals.
 */
export const censusStats = stats;
export const collectionSizesAsOf = sizes.asOf;
export const holdersCounted = sizes.holders;

/**
 * Where a collection of `count` moments sits among holders: the share of
 * collections it is at least as large as, 1..100. A count of 0 is not a
 * holder and returns null.
 */
export function sizePercentile(count) {
  const n = Number(count) || 0;
  if (n <= 0 || !Array.isArray(sizes.percentiles) || sizes.percentiles.length === 0) return null;
  let p = 0;
  while (p < sizes.percentiles.length && sizes.percentiles[p] <= n) p++;
  return Math.max(1, Math.min(100, p));
}
