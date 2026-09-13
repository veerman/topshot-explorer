import clock from "../../data/flow_account_clock.json";

/**
 * What a Flow address says about when its account was created.
 *
 * Flow mainnet hands addresses out in creation order: the n-th account
 * gets the codeword of n under a fixed [64,45] linear code, so an address
 * decodes back to its creation number with no chain call. The inverse
 * matrix below is Flow's own (onflow/flow-go, model/flow/address.go,
 * Apache 2.0); the service account decodes to 1, the Top Shot contract
 * account to 6. data/flow_account_clock.json turns the number into an
 * approximate date, from a calibration sample; treat it as a month or two
 * either way.
 */
const INVERSE_ROWS = [
  0x14b4ae9336c9n, 0x1a5a57499b64n, 0x0d2d2ba4cdb2n, 0x069695d266d9n, 0x134b4ae9336cn,
  0x09a5a57499b6n, 0x04d2d2ba4cdbn, 0x1269695d266dn, 0x1934b4ae9336n, 0x0c9a5a57499bn,
  0x164d2d2ba4cdn, 0x1b269695d266n, 0x0d934b4ae933n, 0x16c9a5a57499n, 0x1b64d2d2ba4cn,
  0x0db269695d26n, 0x06d934b4ae93n, 0x136c9a5a5749n, 0x19b64d2d2ba4n, 0x0cdb269695d2n,
  0x066d934b4ae9n, 0x1336c9a5a574n, 0x099b64d2d2ban, 0x04cdb269695dn, 0x1266d934b4aen,
  0x09336c9a5a57n, 0x1499b64d2d2bn, 0x1a4cdb269695n, 0x1d266d934b4an, 0x0e9336c9a5a5n,
  0x17499b64d2d2n, 0x0ba4cdb26969n, 0x15d266d934b4n, 0x0ae9336c9a5an, 0x057499b64d2dn,
  0x12ba4cdb2696n, 0x095d266d934bn, 0x14ae9336c9a5n, 0x1a57499b64d2n, 0x0d2ba4cdb269n,
  0x1695d266d934n, 0x0b4ae9336c9an, 0x05a57499b64dn, 0x12d2ba4cdb26n, 0x09695d266d93n
];

/** The creation number of a mainnet address, or null for a malformed one */
export function accountIndexOf(address) {
  const hex = String(address || "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{16}$/.test(hex)) return null;
  let cw = BigInt(`0x${hex}`) >> 19n;
  let w = 0n;
  for (let i = 0; i < 45; i++) {
    if (cw & 1n) w ^= INVERSE_ROWS[i];
    cw >>= 1n;
  }
  return Number(w);
}

const POINTS = (clock.points || []).map(([i, d]) => [i, new Date(`${d}T00:00:00Z`).getTime()]);

/** Approximate creation date (a Date) for an address, or null */
export function approxCreatedAt(address) {
  const n = accountIndexOf(address);
  if (n === null || POINTS.length < 2) return null;
  if (n <= POINTS[0][0]) return new Date(POINTS[0][1]);
  const last = POINTS[POINTS.length - 1];
  if (n >= last[0]) return new Date(last[1]);
  let k = 0;
  while (k + 1 < POINTS.length && POINTS[k + 1][0] <= n) k++;
  const [i0, t0] = POINTS[k];
  const [i1, t1] = POINTS[k + 1];
  return new Date(t0 + (t1 - t0) * (n - i0) / (i1 - i0));
}

export const accountClockAsOf = clock.asOf || null;

/** "Aug 2020" */
export const formatMonth = (d) => (d ? d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : "");
