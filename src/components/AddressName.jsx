import { introOf } from "../services/usernames.service";

/**
 * An address as people know it: "@username" when the lookup knows the
 * address, "@username · parent" for a wallet that a named Dapper
 * wallet is linked to, the full address otherwise. Never shortened; the
 * caller's link carries the full address in its title.
 */
export function AddressName({ address }) {
  const intro = introOf(address);
  return intro ? <span className="addr-name">{intro.text}</span> : <>{address}</>;
}
