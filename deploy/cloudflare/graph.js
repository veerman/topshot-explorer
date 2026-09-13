// The account graph of one address, read from the chain through the REST
// API: whether it is a Dapper custodial wallet, the HybridCustody parents
// that confirmed a link, and the children it controls, each with its own
// Dapper flag. The same Cadence the app runs in the browser
// (src/services/fcl.service.js getAccountGraph), here for hosts that must
// decide something about an address themselves: the Early Adopters wall
// takes a Dapper wallet or a wallet that is a parent of one.
// Web-standard fetch only, so it runs in the Worker and in Node.

const GRAPH_CADENCE = (address) => `
import HybridCustody from 0xd8a7e05a7ac670c0

access(all) struct Profile {
  access(all) let address: Address
  access(all) let dapper: Bool
  init(address: Address, dapper: Bool) { self.address = address; self.dapper = dapper }
}
access(all) fun dapper(_ addr: Address): Bool {
  let acct = getAuthAccount<auth(BorrowValue) &Account>(addr)
  for p in acct.storage.storagePaths {
    let s = p.toString()
    if s == "/storage/dapperUtilityCoinReceiver" || s == "/storage/privateForwardingStorage" { return true }
  }
  return false
}
access(all) fun profile(_ a: Address): Profile { return Profile(address: a, dapper: dapper(a)) }
access(all) fun parents(_ addr: Address): [Address] {
  let cap = getAccount(addr).capabilities.get<&{HybridCustody.OwnedAccountPublic}>(HybridCustody.OwnedAccountPublicPath)
  if let owned = cap.borrow() {
    let st = owned.getParentStatuses()
    return st.keys.filter(view fun (p: Address): Bool { return st[p] == true })
  }
  return []
}
access(all) fun main(): {String: AnyStruct} {
  let address: Address = ${address}
  let acct = getAuthAccount<auth(BorrowValue) &Account>(address)
  var children: [Address] = []
  if let m = acct.storage.borrow<&HybridCustody.Manager>(from: HybridCustody.ManagerStoragePath) { children = m.getChildAddresses() }
  let ps: [Profile] = []
  for p in parents(address) { ps.append(profile(p)) }
  let cs: [Profile] = []
  for c in children { cs.append(profile(c)) }
  return { "self": profile(address), "parents": ps, "children": cs }
}`;

const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
const fromB64 = (s) => decodeURIComponent(escape(atob(s)));

/** JSON-Cadence to plain values, enough for the shapes the graph returns */
export function decodeCadence(v) {
  if (v === null || v === undefined || typeof v !== "object") return v;
  switch (v.type) {
    case "Optional": return v.value === null || v.value === undefined ? null : decodeCadence(v.value);
    case "Array": return (v.value || []).map(decodeCadence);
    case "Dictionary": {
      const out = {};
      for (const e of v.value || []) out[String(decodeCadence(e.key))] = decodeCadence(e.value);
      return out;
    }
    case "Struct": case "Resource": case "Event": case "Contract": case "Enum": {
      const out = {};
      for (const f of (v.value && v.value.fields) || []) out[f.name] = decodeCadence(f.value);
      return out;
    }
    case "Bool": return Boolean(v.value);
    case "Address": case "String": return String(v.value);
    default: return v.value !== undefined ? v.value : v;
  }
}

const prof = (x) => ({ address: String(x.address).toLowerCase(), dapper: Boolean(x.dapper) });

/**
 * { address, dapper, parents: [{address, dapper}], children: [...] } for
 * a 0x address; throws when the node does not answer.
 */
export async function fetchAccountGraph(restBase, address, fetchImpl = fetch) {
  const a = `0x${String(address).toLowerCase().replace(/^0x/, "")}`;
  if (!/^0x[0-9a-f]{16}$/.test(a)) throw new Error("not a Flow address");
  const res = await fetchImpl(`${restBase}/v1/scripts?block_height=sealed`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ script: b64(GRAPH_CADENCE(a)), arguments: [] })
  });
  if (!res.ok) throw new Error(`account graph ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const decoded = decodeCadence(JSON.parse(fromB64(JSON.parse(await res.text()))));
  const me = prof(decoded.self || { address: a, dapper: false });
  return { ...me, parents: (decoded.parents || []).map(prof), children: (decoded.children || []).map(prof) };
}

/**
 * Who may sign the Early Adopters wall: a Dapper wallet ("dapper"), or a
 * wallet that is the confirmed parent of at least one ("parent").
 * Null otherwise.
 */
export function wallKindOf(graph) {
  if (!graph) return null;
  if (graph.dapper) return "dapper";
  if ((graph.children || []).some((c) => c.dapper)) return "parent";
  return null;
}

export const WALL_NOT_ELIGIBLE = "The wall is for Top Shot collectors: sign with your linked wallet, or your Dapper wallet.";
