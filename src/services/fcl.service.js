import * as fcl from "@onflow/fcl";

// Configuration for Flow mainnet
export const TOPSHOT_ADDRESS = "0b2a3299cc857e29";
export const MARKET_ADDRESS = "c1e4f4f4c4257510";
export const NONFUNGIBLETOKEN_ADDRESS = "1d7e57aa55817448";
export const IPFS_RESOLVER_ADDRESS = "0b2a3299cc857e29";

export function initFCL() {
  // The access node is a build-time knob so a deployment can route Flow
  // reads through a same-origin caching proxy (any host can implement it;
  // deploy/cloudflare/ is one implementation). The default build talks
  // straight to Flow and depends on no particular host. The typeof guard
  // keeps this importable from plain Node (the maintenance scripts), where
  // import.meta.env does not exist and the default always applies.
  const accessNode =
    (typeof import.meta.env !== "undefined" && import.meta.env.VITE_FLOW_ACCESS_NODE) ||
    "https://rest-mainnet.onflow.org";
  fcl.config({
    "accessNode.api": accessNode
  });
}

// Mint count per subedition (parallel). Not readable from the chain (the
// per-subedition counters live in Dapper's storage); every value here
// matches the maxMintSize Atlas reports for that parallel, and
// `npm run atlas:parallels` flags any that drift.
export const SUBEDITION_MINT_COUNTS = {
  1: 500,
  2: 1000,
  3: 2500,
  4: 4000,
  5: 25,
  6: 100,
  7: 250,
  8: 10,
  9: 50,
  10: 5,
  11: 75,
  12: 0,
  13: 100,
  14: 25,
  15: 5,
  16: 99,
  17: 99,
  18: 50,
  19: 25,
  20: 10,
  21: 5,
  22: 1
};

// On-chain subedition names (TopShot.getAllSubeditions, 2026-09-01), for
// pages that only need labels and should not wait on a chain call (the home
// parallels chart). The detail pages still read the live list.
export const SUBEDITION_NAMES = {
  1: "Explosion",
  2: "Torn",
  3: "Vortex",
  4: "Rippled",
  5: "Coded",
  6: "Halftone",
  7: "Bubbled",
  8: "Diced",
  9: "Bit",
  10: "Vibe",
  11: "Astra",
  12: "Diamond",
  13: "Voltage",
  14: "Livewire",
  15: "Championship",
  16: "Club Collection",
  17: "Blockchain",
  18: "Hardcourt",
  19: "Hexwave",
  20: "Jukebox",
  21: "Galactic",
  22: "Omega"
};

// Cadence Address arguments want the bare hex, whatever prefix came in
const stripHexPrefix = (address) => (address.startsWith("0x") ? address.slice(2) : address);

/** Display name for a subedition id (0 = Standard). */
export const subeditionLabel = (sub) =>
  (Number(sub) === 0 ? "Standard" : (SUBEDITION_NAMES[sub] || `Subedition ${sub}`));

// 1. Get TopShot contract metadata (Total Supply, nextPlayID, nextSetID, currentSeries)
export async function getTopshotStats() {
  const resp = await fcl.query({
    cadence: `
      import TopShot from 0x${TOPSHOT_ADDRESS}
      access(all) struct Stats {
        access(all) let totalSupply: UInt64
        access(all) let nextPlayID: UInt32
        access(all) let nextSetID: UInt32
        access(all) let currentSeries: UInt32
        init() {
          self.totalSupply = TopShot.totalSupply
          self.nextPlayID = TopShot.nextPlayID
          self.nextSetID = TopShot.nextSetID
          self.currentSeries = TopShot.currentSeries
        }
      }
      access(all) fun main(): Stats {
        return Stats()
      }
    `
  });
  return resp;
}

// 2. Get all subeditions from smart contract
export async function getSubeditions() {
  const resp = await fcl.query({
    cadence: `
      import TopShot from 0x${TOPSHOT_ADDRESS}
      access(all) struct Sub {
        access(all) let id: UInt32
        access(all) let name: String
        init(id: UInt32, name: String) {
          self.id = id
          self.name = name
        }
      }
      access(all) fun main(): [Sub] {
        let subs = TopShot.getAllSubeditions()
        var res: [Sub] = []
        for sub in subs {
          res.append(Sub(id: sub.subeditionID, name: sub.name))
        }
        return res
      }
    `
  });
  
  // Map standard subedition mint counts onto the on-chain subedition names
  const subeditionMap = {};
  resp.forEach(sub => {
    subeditionMap[sub.id] = {
      id: sub.id,
      name: sub.name,
      mintCount: SUBEDITION_MINT_COUNTS[sub.id] ?? 0
    };
  });
  return subeditionMap;
}

// 3. Get all sets (names, series, locked status, and playIDs in them)
export async function getSetsOverview() {
  const resp = await fcl.query({
    cadence: `
      import TopShot from 0x${TOPSHOT_ADDRESS}
      access(all) struct SetPlays {
        access(all) let id: UInt32
        access(all) let setName: String
        access(all) let playIDs: [UInt32]
        access(all) let series: UInt32
        access(all) let locked: Bool
        init(setID: UInt32) {
          self.id = setID
          self.setName = TopShot.getSetName(setID: setID) ?? ""
          self.playIDs = TopShot.getPlaysInSet(setID: setID) ?? []
          self.series = TopShot.getSetSeries(setID: setID) ?? 0
          self.locked = TopShot.isSetLocked(setID: setID) ?? false
        }
      }
      access(all) fun main(): [SetPlays] {
        var sets: [SetPlays] = []
        var id = UInt32(1)
        while id < TopShot.nextSetID {
          if TopShot.getSetName(setID: id) != nil {
            sets.append(SetPlays(setID: id))
          }
          id = id + 1
        }
        return sets
      }
    `
  });
  return resp;
}

// 4. Fetch metadata for a batch of specific Play IDs
export async function fetchPlayBatch(playIDs) {
  if (!playIDs || playIDs.length === 0) return [];
  const resp = await fcl.query({
    cadence: `
      import TopShot from 0x${TOPSHOT_ADDRESS}
      access(all) struct PlayInfo {
        access(all) let playID: UInt32
        access(all) let metadata: {String: String}?
        init(playID: UInt32) {
          self.playID = playID
          self.metadata = TopShot.getPlayMetaData(playID: playID)
        }
      }
      access(all) fun main(playIDs: [UInt32]): [PlayInfo] {
        var res: [PlayInfo] = []
        for id in playIDs {
          res.append(PlayInfo(playID: id))
        }
        return res
      }
    `,
    args: (arg, t) => [arg(playIDs.map(String), t.Array(t.UInt32))]
  });
  return resp;
}

// 5. Get detailed info of a single set (Creation order, Play IDs, retired status, play mint sizes, and play metadata)
export async function getSetDetails(setID) {
  const resp = await fcl.query({
    cadence: `
      import TopShot from 0x${TOPSHOT_ADDRESS}
      import TopShotIPFSResolver from 0x${IPFS_RESOLVER_ADDRESS}

      access(all) struct Edition {
        access(all) let playID: UInt32
        access(all) let retired: Bool
        access(all) let momentCount: UInt32
        access(all) let playOrder: UInt32
        access(all) let ipfsCIDs: {String: String}

        init(playID: UInt32, retired: Bool, momentCount: UInt32, playOrder: UInt32, ipfsCIDs: {String: String}) {
          self.playID = playID
          self.retired = retired
          self.momentCount = momentCount
          self.playOrder = playOrder
          self.ipfsCIDs = ipfsCIDs
        }
      }

      access(all) struct MyPlay {
        access(all) let playID: UInt32
        access(all) let metadata: {String: String}

        init(playID: UInt32, metadata: {String: String}) {
          self.playID = playID
          self.metadata = metadata
        }
      }

      access(all) struct SetDetails {
        access(all) let id: UInt32
        access(all) let setName: String
        access(all) let series: UInt32
        access(all) let locked: Bool
        access(all) let editions: [Edition]
        access(all) let plays: [MyPlay]
        access(all) let ipfsGateway: String

        init(setID: UInt32) {
          self.id = setID
          self.setName = TopShot.getSetName(setID: setID) ?? ""
          self.series = TopShot.getSetSeries(setID: setID) ?? 0
          self.locked = TopShot.isSetLocked(setID: setID) ?? false
          self.editions = []
          self.plays = []
          self.ipfsGateway = TopShotIPFSResolver.gateway
          
          if let setData = TopShot.getSetData(setID: setID) {
            let playIDs = setData.getPlays()
            var playOrder = UInt32(1)

            let retiredEditions = setData.getRetired()
            let numberMintedPerPlay = setData.getNumberMintedPerPlay()

            for playID in playIDs {
              let retired = retiredEditions[playID] ?? false
              let momentCount = numberMintedPerPlay[playID] ?? 0
              let cids = TopShotIPFSResolver.getCIDs(setID: setID, playID: playID, subeditionID: 0) ?? {}
              
              self.editions.append(Edition(playID: playID, retired: retired, momentCount: momentCount, playOrder: playOrder, ipfsCIDs: cids))
              
              if let md = TopShot.getPlayMetaData(playID: playID) {
                self.plays.append(MyPlay(playID: playID, metadata: md))
              }
              
              playOrder = playOrder + 1
            }
          }
        }
      }

      access(all) fun main(setID: UInt32): SetDetails {
        return SetDetails(setID: setID)
      }
    `,
    args: (arg, t) => [arg(String(setID), t.UInt32)]
  });
  return resp;
}

// Lightweight mint-count query: numberMintedPerPlay and retired flags for a
// batch of sets, without the IPFS resolver work getSetDetails does. Mint
// counts keep changing while an edition is open, so the sync refreshes them
// on every pass with this instead of refetching full set details.
// Returns { setID: { playID: { minted, retired } } }.
export async function getMintCounts(setIDs) {
  const resp = await fcl.query({
    cadence: `
      import TopShot from 0x${TOPSHOT_ADDRESS}
      access(all) fun main(ids: [UInt32]): {UInt32: {UInt32: [UInt32]}} {
        let out: {UInt32: {UInt32: [UInt32]}} = {}
        for id in ids {
          if let setData = TopShot.getSetData(setID: id) {
            let minted = setData.getNumberMintedPerPlay()
            let retired = setData.getRetired()
            let inner: {UInt32: [UInt32]} = {}
            for playID in setData.getPlays() {
              inner[playID] = [minted[playID] ?? 0, (retired[playID] ?? false) ? 1 : 0]
            }
            out[id] = inner
          }
        }
        return out
      }
    `,
    args: (arg, t) => [arg(setIDs.map(String), t.Array(t.UInt32))]
  });
  const out = {};
  Object.entries(resp || {}).forEach(([setID, plays]) => {
    out[setID] = {};
    Object.entries(plays).forEach(([playID, arr]) => {
      out[setID][playID] = { minted: Number(arr[0]) || 0, retired: Number(arr[1]) === 1 };
    });
  });
  return out;
}

// Lightweight IPFS CID query: resolver lookups only, for a batch of plays
// in one set. getSetDetails carries CIDs too, but it blows the Cadence
// computation limit on the biggest sets (27 and 52, Platinum Ice), so the
// sync self-heal and the seed generator read CIDs through this instead.
export async function getSetCIDs(setID, playIDs) {
  return fcl.query({
    cadence: `
      import TopShotIPFSResolver from 0x${IPFS_RESOLVER_ADDRESS}
      access(all) fun main(setID: UInt32, playIDs: [UInt32]): {UInt32: {String: String}} {
        let out: {UInt32: {String: String}} = {}
        for playID in playIDs {
          if let cids = TopShotIPFSResolver.getCIDs(setID: setID, playID: playID, subeditionID: 0) {
            out[playID] = cids
          }
        }
        return out
      }
    `,
    args: (arg, t) => [arg(String(setID), t.UInt32), arg(playIDs.map(String), t.Array(t.UInt32))]
  });
}

// 6. Get Account details: moment IDs, active listing IDs, and whether it has Market v3 capability
export async function getAccountDetails(address) {
  // Normalize address (remove 0x prefix if exists, fcl needs it with 0x inside cadence though)
  const cleanAddr = stripHexPrefix(address);
  const resp = await fcl.query({
    cadence: `
      import TopShot from 0x${TOPSHOT_ADDRESS}
      import Market from 0x${MARKET_ADDRESS}
      
      access(all) struct AccountSummary {
        access(all) let momentIDs: [UInt64]
        access(all) let saleMomentIDs: [UInt64]
        access(all) let hasV3: Bool
        
        init(momentIDs: [UInt64], saleMomentIDs: [UInt64], hasV3: Bool) {
          self.momentIDs = momentIDs
          self.saleMomentIDs = saleMomentIDs
          self.hasV3 = hasV3
        }
      }
      
      access(all) fun main(): AccountSummary {
        let acct = getAccount(0x${cleanAddr})
        
        var momentIDs: [UInt64] = []
        if let collectionRef = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection) {
          momentIDs = collectionRef.getIDs()
        }
        
        var saleMomentIDs: [UInt64] = []
        var hasV3: Bool = false
        if let marketV3CollectionRef = acct.capabilities.borrow<&{Market.SalePublic}>(/public/topshotSalev3Collection) {
          saleMomentIDs = marketV3CollectionRef.getIDs()
          hasV3 = true
        } else if let saleCollectionRef = acct.capabilities.borrow<&{Market.SalePublic}>(/public/topshotSaleCollection) {
          saleMomentIDs = saleCollectionRef.getIDs()
        }
        
        return AccountSummary(momentIDs: momentIDs, saleMomentIDs: saleMomentIDs, hasV3: hasV3)
      }
    `
  });
  return resp;
}

// 6b. Get every moment ID in an address's collection (IDs only, one call)
export async function getCollectionIDs(address) {
  const cleanAddr = stripHexPrefix(address);
  const resp = await fcl.query({
    cadence: `
      import TopShot from 0x${TOPSHOT_ADDRESS}
      access(all) fun main(): [UInt64] {
        let acct = getAccount(0x${cleanAddr})
        if let ref = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection) {
          return ref.getIDs()
        }
        return []
      }
    `
  });
  return (resp || []).map(Number);
}

// 6c. Data-only borrow for a batch of moment IDs: no metadata, no set names,
// just the ownership facts [momentID, setID, playID, serialNumber,
// subeditionID]. Light enough for ~2,000 moments per call, which is how the
// account context fetches whole collections.
export async function getCollectionData(address, momentIDs) {
  if (!momentIDs || momentIDs.length === 0) return [];
  const cleanAddr = stripHexPrefix(address);
  const resp = await fcl.query({
    cadence: `
      import TopShot from 0x${TOPSHOT_ADDRESS}
      access(all) fun main(ids: [UInt64]): [[UInt64]] {
        let ref = getAccount(0x${cleanAddr}).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
          ?? panic("Could not borrow capability from public collection")
        let out: [[UInt64]] = []
        for id in ids {
          if let nft = ref.borrowMoment(id: id) {
            var sub = UInt64(0)
            if let s = TopShot.getMomentsSubedition(nftID: id) {
              sub = UInt64(s)
            }
            out.append([id, UInt64(nft.data.setID), UInt64(nft.data.playID), UInt64(nft.data.serialNumber), sub])
          }
        }
        return out
      }
    `,
    args: (arg, t) => [arg(momentIDs.map(String), t.Array(t.UInt64))]
  });
  return (resp || []).map((row) => row.map(Number));
}

// 6d. Single-moment identity lookup for the Marketplace stream: which
// play, set, serial and parallel a moment ID is, read from a known
// owner's public collection. Nil-safe (no panic): returns null when the
// owner does not expose the moment, so callers can try other candidates.
export async function getMomentByOwner(address, momentID) {
  const cleanAddr = stripHexPrefix(address);
  const resp = await fcl.query({
    cadence: `
      import TopShot from 0x${TOPSHOT_ADDRESS}
      access(all) fun main(id: UInt64): [UInt64]? {
        if let ref = getAccount(0x${cleanAddr}).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection) {
          if let nft = ref.borrowMoment(id: id) {
            var sub = UInt64(0)
            if let s = TopShot.getMomentsSubedition(nftID: id) {
              sub = UInt64(s)
            }
            return [id, UInt64(nft.data.setID), UInt64(nft.data.playID), UInt64(nft.data.serialNumber), sub]
          }
        }
        return nil
      }
    `,
    args: (arg, t) => [arg(String(momentID), t.UInt64)]
  });
  return resp ? resp.map(Number) : null;
}

// 6d-batch. The same lookup for MANY moment ids in ONE script call. A
// batch transaction can put 50 transfers on screen at once, all held by
// the same account; resolving them one script per moment is pure waste.
// Returns [id, setID, playID, serial, sub] rows for the ids the owner
// exposes; ids the owner does not expose are simply absent.
export async function getMomentsByOwner(address, momentIDs) {
  const cleanAddr = stripHexPrefix(address);
  const resp = await fcl.query({
    cadence: `
      import TopShot from 0x${TOPSHOT_ADDRESS}
      access(all) fun main(ids: [UInt64]): [[UInt64]] {
        let out: [[UInt64]] = []
        if let ref = getAccount(0x${cleanAddr}).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection) {
          for id in ids {
            if let nft = ref.borrowMoment(id: id) {
              var sub = UInt64(0)
              if let s = TopShot.getMomentsSubedition(nftID: id) {
                sub = UInt64(s)
              }
              out.append([id, UInt64(nft.data.setID), UInt64(nft.data.playID), UInt64(nft.data.serialNumber), sub])
            }
          }
        }
        return out
      }
    `,
    args: (arg, t) => [arg(momentIDs.map(String), t.Array(t.UInt64))]
  });
  return (resp || []).map((row) => row.map(Number));
}

// 6e. TopShot moments on Flow EVM. A moment bridged to EVM is locked in
// the VM bridge's Cadence escrow (0x1e4aa0b87d10b141) while a mirrored
// ERC721 (0x50ab3a827ad268e9d5a24d340108fad5c25dad5f) lives on the EVM
// side; bridging back parks the ERC721 with the bridge instead of
// burning it (verified 2026-09-02: balanceOf(bridgeCOA) equals
// totalSupply minus the escrow count). So the escrow Locker's counter is
// "currently on EVM" and the ERC721's totalSupply is "ever bridged".
export async function getBridgeStats() {
  const current = Number(
    await fcl.query({
      cadence: `
        import TopShot from 0x${TOPSHOT_ADDRESS}
        import FlowEVMBridgeUtils from 0x1e4aa0b87d10b141
        import FlowEVMBridgeNFTEscrow from 0x1e4aa0b87d10b141

        access(all) fun main(): Int? {
          if let path = FlowEVMBridgeUtils.deriveEscrowStoragePath(fromType: Type<@TopShot.NFT>()) {
            let acct = getAuthAccount<auth(Storage) &Account>(0x1e4aa0b87d10b141)
            if let locker = acct.storage.borrow<&FlowEVMBridgeNFTEscrow.Locker>(from: path) {
              return locker.getLength()
            }
          }
          return nil
        }
      `
    })
  );
  if (!Number.isFinite(current)) throw new Error("bridge escrow count unavailable");

  // All-time count via the ERC721's totalSupply(), straight from the
  // public EVM RPC (not proxied; optional, the card degrades without it)
  let allTime = null;
  try {
    const res = await fetch("https://mainnet.evm.nodes.onflow.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: "0x50ab3a827ad268e9d5a24d340108fad5c25dad5f", data: "0x18160ddd" }, "latest"]
      })
    });
    const body = await res.json();
    if (body.result && body.result !== "0x") allTime = Number(BigInt(body.result));
  } catch { /* EVM RPC unreachable; current alone still renders */ }

  return { current, allTime };
}


// 6f. Account graph: what kind of account an address is and what it
// controls. Verified on mainnet 2026-09-08 against a known pair (a Dapper
// wallet and the wallet it is linked to).
// - dapper: Dapper custodial wallets carry /storage/dapperUtilityCoinReceiver
//   or /storage/privateForwardingStorage; other wallets never do.
// - parents: HybridCustody parents that CONFIRMED the link (the OwnedAccount
//   public capability; pending invitations excluded).
// - children: accounts this address controls through a HybridCustody
//   Manager (Dapper wallets linked to this wallet show up here).
// - evms: every Cadence-owned EVM account (COA) in the address's storage,
//   0x-prefixed, the standard /storage/evm one first. A COA is a resource
//   at a storage path, one per path, and nothing stops an account from
//   holding more than one at other paths, so storage is walked by type
//   (the same walk the Dapper test makes); /public/evm is the fallback
//   for an account whose storage holds none. `evm` is the first, for the
//   callers that want one.
// getAuthAccount reads storage, so this is script-only (fine: it is one).
export async function getAccountGraph(address) {
  const cleanAddr = stripHexPrefix(address);
  const resp = await fcl.query({
    cadence: `
      import HybridCustody from 0xd8a7e05a7ac670c0
      import EVM from 0xe467b9dd11fa00df

      access(all) struct Profile {
        access(all) let address: Address
        access(all) let evms: [String]
        access(all) let dapper: Bool
        init(address: Address, evms: [String], dapper: Bool) { self.address = address; self.evms = evms; self.dapper = dapper }
      }
      access(all) fun coas(_ addr: Address): [String] {
        let acct = getAuthAccount<auth(BorrowValue) &Account>(addr)
        let coaType = Type<@EVM.CadenceOwnedAccount>()
        var out: [String] = []
        for p in acct.storage.storagePaths {
          if let t = acct.storage.type(at: p) {
            if t == coaType {
              if let c = acct.storage.borrow<&EVM.CadenceOwnedAccount>(from: p) {
                let hex = "0x".concat(c.address().toString())
                if p.toString() == "/storage/evm" { out.insert(at: 0, hex) } else { out.append(hex) }
              }
            }
          }
        }
        if out.length == 0 {
          if let c = getAccount(addr).capabilities.get<&EVM.CadenceOwnedAccount>(/public/evm).borrow() { out.append("0x".concat(c.address().toString())) }
        }
        return out
      }
      access(all) fun dapper(_ addr: Address): Bool {
        let acct = getAuthAccount<auth(BorrowValue) &Account>(addr)
        for p in acct.storage.storagePaths {
          let s = p.toString()
          if s == "/storage/dapperUtilityCoinReceiver" || s == "/storage/privateForwardingStorage" { return true }
        }
        return false
      }
      access(all) fun profile(_ a: Address): Profile { return Profile(address: a, evms: coas(a), dapper: dapper(a)) }
      access(all) fun parents(_ addr: Address): [Address] {
        let cap = getAccount(addr).capabilities.get<&{HybridCustody.OwnedAccountPublic}>(HybridCustody.OwnedAccountPublicPath)
        if let owned = cap.borrow() {
          let st = owned.getParentStatuses()
          return st.keys.filter(view fun (p: Address): Bool { return st[p] == true })
        }
        return []
      }
      access(all) fun main(): {String: AnyStruct} {
        let address: Address = 0x${cleanAddr}
        let acct = getAuthAccount<auth(BorrowValue) &Account>(address)
        var children: [Address] = []
        if let m = acct.storage.borrow<&HybridCustody.Manager>(from: HybridCustody.ManagerStoragePath) { children = m.getChildAddresses() }
        let ps: [Profile] = []
        for p in parents(address) { ps.append(profile(p)) }
        let cs: [Profile] = []
        for c in children { cs.append(profile(c)) }
        return { "self": profile(address), "parents": ps, "children": cs }
      }
    `
  });
  const prof = (x) => {
    const evms = (x.evms || []).map((e) => String(e).toLowerCase());
    return { address: String(x.address).toLowerCase(), evms, evm: evms[0] || null, dapper: Boolean(x.dapper) };
  };
  const me = prof(resp.self);
  return { ...me, parents: (resp.parents || []).map(prof), children: (resp.children || []).map(prof) };
}

// 6g. Top Shot on Flow EVM, as users hold it. The bridge's own ERC721
// (0x50ab..., "NBA-Top-Shot", the type the bridge associates with
// TopShot.NFT) is held entirely by Dapper's wrapper contract below, which
// issues the user-facing "NBA Top Shot" (TOPSHOT) token with THE SAME id
// as the moment. Verified 2026-09-08: ownerOf on the bridge ERC721 returns
// the wrapper for every escrowed sample; the wrapper's ownerOf returns
// user EVM addresses; its tokenURI is Dapper's metadata API by moment id;
// and it implements ERC721Enumerable, so an owner's ids read straight
// from the chain with dry calls (no gateway account, no RPC).
export const TOPSHOT_EVM_ADDRESS = "0x84c6a2e6765e88427c41bb38c82a78b570e24709";

// All Top Shot moment ids an EVM address holds (paged; ~1,000 dry calls
// per script). balanceOf alone is trusted when the enumeration ever
// fails, which for this contract it does not.
/** The union of getEvmCollectionIDs over several EVM addresses (COAs and
 *  any the reader added), in order, without repeats */
export async function getEvmCollectionIDsAll(evmHexes) {
  const seen = new Set();
  const out = [];
  for (const hex of evmHexes || []) {
    const ids = await getEvmCollectionIDs(hex);
    ids.forEach((id) => { if (!seen.has(id)) { seen.add(id); out.push(id); } });
  }
  return out;
}

export async function getEvmCollectionIDs(evmHex, { pageSize = 1000 } = {}) {
  const out = [];
  let from = 0;
  for (;;) {
    const page = await fcl.query({
      cadence: `
        import EVM from 0xe467b9dd11fa00df
        import FlowEVMBridgeUtils from 0x1e4aa0b87d10b141
        access(all) fun main(ownerHex: String, erc721Hex: String, from: Int, max: Int): {String: AnyStruct} {
          let owner = EVM.addressFromString(ownerHex)
          let erc = EVM.addressFromString(erc721Hex)
          let balance = FlowEVMBridgeUtils.balanceOf(owner: owner, evmContractAddress: erc)
          let ids: [UInt256] = []
          var enumerable = true
          var i = UInt256(from)
          let cap = UInt256(from) + UInt256(max)
          while i < balance && i < cap {
            let res = EVM.dryCallWithSigAndArgs(from: owner, to: erc, signature: "tokenOfOwnerByIndex(address,uint256)", args: [owner, i], gasLimit: 1_000_000, value: 0, resultTypes: [Type<UInt256>()])
            if res.status != EVM.Status.successful { enumerable = false; break }
            ids.append(res.results[0] as! UInt256)
            i = i + 1
          }
          return { "balance": balance, "enumerable": enumerable, "ids": ids }
        }
      `,
      args: (arg, t) => [arg(evmHex, t.String), arg(TOPSHOT_EVM_ADDRESS, t.String), arg(String(from), t.Int), arg(String(pageSize), t.Int)]
    });
    const ids = (page.ids || []).map(Number);
    out.push(...ids);
    if (!page.enumerable) throw new Error("Top Shot EVM contract stopped enumerating");
    from += ids.length;
    if (ids.length === 0 || from >= Number(page.balance)) break;
  }
  return out;
}

// Data-only tuples [momentID, setID, playID, serialNumber, subeditionID]
// for moments currently ON EVM: the Cadence NFT sits in the VM bridge's
// escrow Locker while the wrapper token circulates, and the Locker lends
// it out by id. Same shape as getCollectionData, so the account tuple
// cache can merge both.
export async function getEscrowMomentData(momentIDs) {
  if (!momentIDs || momentIDs.length === 0) return [];
  const resp = await fcl.query({
    cadence: `
      import TopShot from 0x${TOPSHOT_ADDRESS}
      import FlowEVMBridgeUtils from 0x1e4aa0b87d10b141
      import FlowEVMBridgeNFTEscrow from 0x1e4aa0b87d10b141
      access(all) fun main(ids: [UInt64]): [[UInt64]] {
        let out: [[UInt64]] = []
        if let path = FlowEVMBridgeUtils.deriveEscrowStoragePath(fromType: Type<@TopShot.NFT>()) {
          let acct = getAuthAccount<auth(Storage) &Account>(0x1e4aa0b87d10b141)
          if let locker = acct.storage.borrow<&FlowEVMBridgeNFTEscrow.Locker>(from: path) {
            for id in ids {
              if let nft = locker.borrowNFT(id) {
                let m = nft as! &TopShot.NFT
                var sub = UInt64(0)
                if let s = TopShot.getMomentsSubedition(nftID: id) { sub = UInt64(s) }
                out.append([id, UInt64(m.data.setID), UInt64(m.data.playID), UInt64(m.data.serialNumber), sub])
              }
            }
          }
        }
        return out
      }
    `,
    args: (arg, t) => [arg(momentIDs.map(String), t.Array(t.UInt64))]
  });
  return (resp || []).map((row) => row.map(Number));
}

// 7. Get Moments' detailed metadata for a list of momentIDs, including
// the real subedition (id + on-chain name), the TopShotLocking state
// (lockExpiry null = unlocked; a PAST expiry means the lock ran out but
// the owner has not unlocked yet), and the marketplace listing price
// (salePrice null = not listed). Moments a V1 sale escrows out of the
// MomentCollection are still found via the sale collections, so this one
// query covers the whole account. Verified against mainnet 2026-09-06.
export async function getAccountMoments(address, momentIDs) {
  if (!momentIDs || momentIDs.length === 0) return [];
  // An EVM address browsed on its own has no Cadence account to borrow
  // from: every one of its moments is in the bridge escrow, so the holder
  // is left out and only the escrow is searched
  const cleanAddr = stripHexPrefix(address);
  const holderHex = /^[0-9a-f]{16}$/i.test(cleanAddr) ? `0x${cleanAddr}` : null;
  const resp = await fcl.query({
    cadence: `
      import TopShot from 0x${TOPSHOT_ADDRESS}
      import Market from 0x${MARKET_ADDRESS}
      import NonFungibleToken from 0x${NONFUNGIBLETOKEN_ADDRESS}
      import TopShotLocking from 0x${TOPSHOT_ADDRESS}
      import FlowEVMBridgeUtils from 0x1e4aa0b87d10b141
      import FlowEVMBridgeNFTEscrow from 0x1e4aa0b87d10b141

      access(all) struct MomentDetail {
        access(all) let momentID: UInt64
        access(all) let playID: UInt32
        access(all) let setID: UInt32
        access(all) let setName: String
        access(all) let serialNumber: UInt32
        access(all) let subeditionID: UInt32
        access(all) let subeditionName: String
        access(all) let lockExpiry: UFix64?
        access(all) let salePrice: UFix64?
        access(all) let playMetadata: {String: String}
        /// Held on Flow EVM: the Cadence NFT is in the bridge escrow
        access(all) let onEVM: Bool

        init(nft: &TopShot.NFT, subeditionID: UInt32, subeditionName: String, lockExpiry: UFix64?, salePrice: UFix64?, onEVM: Bool) {
          self.momentID = nft.id
          self.playID = nft.data.playID
          self.setID = nft.data.setID
          self.setName = TopShot.getSetName(setID: nft.data.setID) ?? ""
          self.serialNumber = nft.data.serialNumber
          self.subeditionID = subeditionID
          self.subeditionName = subeditionName
          self.lockExpiry = lockExpiry
          self.salePrice = salePrice
          self.playMetadata = TopShot.getPlayMetaData(playID: nft.data.playID) ?? {}
          self.onEVM = onEVM
        }
      }

      access(all) fun main(momentIDs: [UInt64], holder: Address?): [MomentDetail] {
        let subNames: {UInt32: String} = {}
        for sub in TopShot.getAllSubeditions() {
          subNames[sub.subeditionID] = sub.name
        }
        var collectionRef: &{TopShot.MomentCollectionPublic}? = nil
        var saleV3: &{Market.SalePublic}? = nil
        var saleV1: &{Market.SalePublic}? = nil
        if let h = holder {
          let acct = getAccount(h)
          collectionRef = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
          saleV3 = acct.capabilities.borrow<&{Market.SalePublic}>(/public/topshotSalev3Collection)
          saleV1 = acct.capabilities.borrow<&{Market.SalePublic}>(/public/topshotSaleCollection)
        }
        // Moments the account holds on EVM live in the bridge escrow
        var locker: &FlowEVMBridgeNFTEscrow.Locker? = nil
        if let path = FlowEVMBridgeUtils.deriveEscrowStoragePath(fromType: Type<@TopShot.NFT>()) {
          locker = getAuthAccount<auth(Storage) &Account>(0x1e4aa0b87d10b141).storage.borrow<&FlowEVMBridgeNFTEscrow.Locker>(from: path)
        }

        var res: [MomentDetail] = []
        for id in momentIDs {
          var nftOpt: &TopShot.NFT? = nil
          if let c = collectionRef { nftOpt = c.borrowMoment(id: id) }
          if nftOpt == nil {
            if let s = saleV3 { nftOpt = s.borrowMoment(id: id) }
          }
          if nftOpt == nil {
            if let s = saleV1 { nftOpt = s.borrowMoment(id: id) }
          }
          var onEVM = false
          if nftOpt == nil {
            if let l = locker {
              if let base = l.borrowNFT(id) { nftOpt = base as! &TopShot.NFT; onEVM = true }
            }
          }
          if let nft = nftOpt {
            var price: UFix64? = nil
            if let s = saleV3 { price = s.getPrice(tokenID: id) }
            if price == nil {
              if let s = saleV1 { price = s.getPrice(tokenID: id) }
            }
            var subID: UInt32 = 0
            if let s = TopShot.getMomentsSubedition(nftID: id) {
              subID = s
            }
            let base: &{NonFungibleToken.NFT} = nft
            var expiry: UFix64? = nil
            if TopShotLocking.isLocked(nftRef: base) {
              expiry = TopShotLocking.getLockExpiry(nftRef: base)
            }
            res.append(MomentDetail(
              nft: nft,
              subeditionID: subID,
              subeditionName: subID == 0 ? "Standard" : (subNames[subID] ?? "Subedition ".concat(subID.toString())),
              lockExpiry: expiry,
              salePrice: price,
              onEVM: onEVM
            ))
          }
        }
        return res
      }
    `,
    args: (arg, t) => [arg(momentIDs.map(String), t.Array(t.UInt64)), arg(holderHex, t.Optional(t.Address))]
  });
  return resp;
}

// 7b. Data-only borrow for a batch of LISTED moment IDs (the sale
// collection, not MomentCollection): just the ownership facts
// [momentID, setID, playID, serialNumber, subeditionID], so the listings
// page can sort its full ID list before paging, like the account page.
export async function getSaleData(address, momentIDs, useV3) {
  if (!momentIDs || momentIDs.length === 0) return [];
  const cleanAddr = stripHexPrefix(address);
  const collectionPath = useV3 ? "topshotSalev3Collection" : "topshotSaleCollection";
  const resp = await fcl.query({
    cadence: `
      import TopShot from 0x${TOPSHOT_ADDRESS}
      import Market from 0x${MARKET_ADDRESS}
      access(all) fun main(ids: [UInt64]): [[UInt64]] {
        let out: [[UInt64]] = []
        if let ref = getAccount(0x${cleanAddr}).capabilities.borrow<&{Market.SalePublic}>(/public/${collectionPath}) {
          for id in ids {
            if let nft = ref.borrowMoment(id: id) {
              var sub = UInt64(0)
              if let s = TopShot.getMomentsSubedition(nftID: id) {
                sub = UInt64(s)
              }
              out.append([id, UInt64(nft.data.setID), UInt64(nft.data.playID), UInt64(nft.data.serialNumber), sub])
            }
          }
        }
        return out
      }
    `,
    args: (arg, t) => [arg(momentIDs.map(String), t.Array(t.UInt64))]
  });
  return (resp || []).map((row) => row.map(Number));
}

// 7c. Data-only TopShotLocking state for a batch of moment IDs: rows of
// [momentID, lockExpiry] for the LOCKED moments only (unlocked ids are
// simply absent). Reads the locking contract's own registry by token id
// (TopShotLocking.getExpiry),
// so no owner address or collection borrow is needed: ~10,000 ids per
// call in ~1.6s verified on mainnet (20,000 fails), agreeing exactly
// with the borrowMoment/isLocked path it replaced. Lock state changes
// over time, so callers should not cache this across sessions.
export async function getLockData(momentIDs) {
  if (!momentIDs || momentIDs.length === 0) return [];
  const resp = await fcl.query({
    cadence: `
      import TopShotLocking from 0x${TOPSHOT_ADDRESS}
      access(all) fun main(ids: [UInt64]): [[UFix64]] {
        let out: [[UFix64]] = []
        for id in ids {
          if let expiry = TopShotLocking.getExpiry(tokenID: id) {
            out.append([UFix64(id), expiry])
          }
        }
        return out
      }
    `,
    args: (arg, t) => [arg(momentIDs.map(String), t.Array(t.UInt64))]
  });
  return (resp || []).map(([id, expiry]) => [Math.round(Number(id)), Number(expiry)]);
}

// 7d. Active Top Shot offers MADE BY an account, from its public
// DapperOffersV2 collection (offers live in the buyer's account; a
// 2,777-offer book enumerates in ~2s in one call, verified on mainnet).
// Books too large for one call (~8,900 borrowOffer per call, measured
// on v1) fall back to two-phase: the id list, then
// details in chunks. Rows: { offerId, amount, level ("NFT"|
// "TopShotEdition"|"TopShotSubedition"), setID, playID, subID, nftID }
// with the id fields null where the level does not carry them.
const OFFER_DETAILS_BODY = `
        for offerId in ids {
          if let offer = ref.borrowOffer(offerId: offerId) {
            let d = offer.getDetails()
            if d.purchased { continue }
            if d.nftType.identifier != "A.0b2a3299cc857e29.TopShot.NFT" { continue }
            let p = d.offerParamsString
            out.append([
              offerId.toString(),
              d.offerAmount.toString(),
              p["_type"] ?? "",
              p["setId"] ?? "",
              p["playId"] ?? "",
              p["subeditionId"] ?? "",
              p["nftId"] ?? ""
            ])
          }
        }
`;

export async function getOffersMadeBy(address) {
  const cleanAddr = stripHexPrefix(address);
  let resp;
  try {
    resp = await fcl.query({
      cadence: `
        import OffersV2 from 0xb8ea91944fd51c43
        import DapperOffersV2 from 0xb8ea91944fd51c43

        access(all) fun main(): [[String]] {
          let out: [[String]] = []
          if let ref = getAccount(0x${cleanAddr}).capabilities.borrow<&{DapperOffersV2.DapperOfferPublic}>(DapperOffersV2.DapperOffersPublicPath) {
            let ids = ref.getOfferIds()
            ${OFFER_DETAILS_BODY}
          }
          return out
        }
      `
    });
  } catch {
    // Two-phase fallback for oversized books
    const ids = await fcl.query({
      cadence: `
        import DapperOffersV2 from 0xb8ea91944fd51c43
        access(all) fun main(): [UInt64] {
          if let ref = getAccount(0x${cleanAddr}).capabilities.borrow<&{DapperOffersV2.DapperOfferPublic}>(DapperOffersV2.DapperOffersPublicPath) {
            return ref.getOfferIds()
          }
          return []
        }
      `
    });
    resp = [];
    for (let i = 0; i < ids.length; i += 5000) {
      resp.push(...await fcl.query({
        cadence: `
          import OffersV2 from 0xb8ea91944fd51c43
          import DapperOffersV2 from 0xb8ea91944fd51c43

          access(all) fun main(ids: [UInt64]): [[String]] {
            let out: [[String]] = []
            if let ref = getAccount(0x${cleanAddr}).capabilities.borrow<&{DapperOffersV2.DapperOfferPublic}>(DapperOffersV2.DapperOffersPublicPath) {
              ${OFFER_DETAILS_BODY}
            }
            return out
          }
        `,
        args: (arg, t) => [arg(ids.slice(i, i + 5000).map(String), t.Array(t.UInt64))]
      }));
    }
  }
  return (resp || []).map(([offerId, amount, level, setId, playId, subId, nftId]) => ({
    offerId,
    amount: Number(amount),
    level,
    setID: setId ? Number(setId) : null,
    playID: playId ? Number(playId) : null,
    subID: subId ? Number(subId) : null,
    nftID: nftId ? Number(nftId) : null
  }));
}
