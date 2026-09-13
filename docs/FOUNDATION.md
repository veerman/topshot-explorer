# Building on Top Shot Explorer

This document is for a developer or an AI agent who wants to take this
repository and build something else on it: a collection manager, a game, a
bot, a different explorer. It describes the solved problems, in the order
you meet them, with the file that solves each one. The pages and the way
this app organises its screens are not the point; the plumbing is.

It complements, and links to, the longer records:

- `../README.md`: features, npm scripts, deployment contract.
- `DATA-CORRECTIONS-PLAYBOOK.md`: the field-by-field rulebook for fixing
  chain metadata, with the source-verification protocol.
- `IPFS-ANALYSIS.md`: what the media files measurably are.
- `MEDIA-PIPELINE.md`: the hosting and thumbnail pipeline decisions.
- `../AGENTS.md`: the short conventions file for coding agents.

Everything below was verified against the code on 2026-09-10. Line
references drift; names do not.

---

## 0. Vocabulary (use it exactly)

Top Shot's own words, used precisely. Blurring them is the fastest way to
build the wrong thing.

| Word | Meaning | Chain identity |
|---|---|---|
| **Play** | One video highlight, a historical event: player, game, date. | `playID` (UInt32) on the `TopShot` contract, immutable metadata once minted |
| **Set** | A collection of plays released under one name, in one series, with one tier. | `setID` (UInt32); `locked` once closed to new plays |
| **Edition** | A play inside a set, plus an optional subedition. The same play in another set is a different edition. **Only editions are minted.** | `setID_playID`, optionally `setID_playID_subeditionID` |
| **Moment** | One minted copy of an edition, with a serial number, owned by one account. The collectible. | `momentID` (UInt64) NFT id, plus `serialNumber` |
| **Subedition / parallel** | A variant of an edition (Metallic Gold, Holo). Subedition 0 is Standard. | `subeditionID` from `TopShot.getAllSubeditions()` |
| **Series** | Top Shot's season of releases. Every set belongs to one series. | `series` on the set |
| **Tier** | Common, Fandom, Rare, Legendary, Ultimate. Not on chain. | `data/additions/sets.json` |

Media (video and artwork) belongs to the **edition**, never to the play or
the set. Badges are computed per play, except reward badges and
commentary, which are edition facts.

In user-facing copy the chain is always "the Flow Blockchain" in full.

---

## 1. Sources of truth, ranked

1. **The Flow Blockchain.** Plays, sets, editions, mint counts, retired
   flags, subeditions, locks, listings, offers, media CIDs, account
   contents, HybridCustody links, EVM bridge state. Read directly from a
   public access node with Cadence scripts and REST event queries.
   Everything in section 2.
2. **IPFS through Dapper's gateway.** Every edition's video and artwork,
   addressed by CID. Section 4.
3. **This repository's `data/` folder.** Our own facts: corrections to
   chain metadata, off-chain context (tiers, arenas, championships,
   rookie seasons), and derived indexes. Section 3.
4. **Atlas**, Dapper's API behind nbatopshot.com. **A check, never a
   source.** The shipped app reads nothing from it. Offline scripts
   compare our data against it and a human decides what to absorb; what is
   absorbed is written into `data/additions/` as our own fact. Section 8.
5. **nbatopshot.com profile pages.** Used for one thing: username to
   address, through a server-rendered public page. Section 7.

Two hard rules follow from this ranking. Chain data is never edited, only
layered over (the original is kept under `_raw` on every record). And
nothing from Dapper's identity system (their `dapperId`) is ever stored.

---

## 2. Reading the chain

### 2.1 Addresses

| Contract | Address | Used for |
|---|---|---|
| `TopShot` | `0x0b2a3299cc857e29` | plays, sets, editions, every minted moment |
| `TopShotLocking` | `0x0b2a3299cc857e29` | moments locked for rewards programs |
| `PackNFT` | `0x0b2a3299cc857e29` | pack mints and openings |
| `TopShotIPFSResolver` | `0x0b2a3299cc857e29` | each edition's IPFS media CIDs |
| `Market`, `TopShotMarketV3` | `0xc1e4f4f4c4257510` | the old peer-to-peer markets (winding down) |
| `NFTStorefrontV2` | `0x4eb8a10cb9f87357` | the generic storefront newer sales ride on |
| `OffersV2`, `DapperOffersV2` | `0xb8ea91944fd51c43` | Dapper's offer system |
| `NonFungibleToken` | `0x1d7e57aa55817448` | the NFT standard |
| `HybridCustody` | `0xd8a7e05a7ac670c0` | parent/child account links |
| `EVM` | `0xe467b9dd11fa00df` | Cadence-owned EVM accounts and dry calls |
| `FlowEVMBridgeUtils`, `FlowEVMBridgeNFTEscrow` | `0x1e4aa0b87d10b141` | the VM bridge and its escrow |
| Bridge ERC721 "NBA-Top-Shot" | `0x50ab3a827ad268e9d5a24d340108fad5c25dad5f` | held entirely by the wrapper; `totalSupply()` = ever bridged |
| Dapper wrapper ERC721 "NBA Top Shot" (TOPSHOT) | `0x84c6a2e6765e88427c41bb38c82a78b570e24709` | the user-facing EVM token, same id as the moment, ERC721Enumerable |
| TSHOT vault (Vaultopolis) | `0x05b67ba314000b2d` | any transfer touching it is a TSHOT swap leg |

All constants live at the top of `src/services/fcl.service.js`; the event
types are in `src/services/flowEvents.service.js`.

### 2.2 Access node and the caching proxy

One build-time knob, `VITE_FLOW_ACCESS_NODE`, defaulting to
`https://rest-mainnet.onflow.org`. Both transports read it: FCL for
scripts (`fcl.service.js`) and plain `fetch` for events
(`flowEvents.service.js`). The `typeof import.meta.env` guard exists so
the same modules run under Node in the maintenance scripts.

A personal instance can talk to the public node directly. A public
instance should not: v1 was reworked precisely because every visitor
hammering the access node hit rate and computation limits. The cure is a
same-origin reverse proxy that caches script results by request body:

- Proxy `/flow/*` to the access node.
- Cache only `POST /v1/scripts` against the latest block (search string
  empty, `?block_height=final` or `?block_height=sealed`). A pinned
  numeric height passes through uncached.
- Key = SHA-256 of the exact request body. Script bodies are
  deterministic, so every visitor after the first hits the cache.
- TTL 300 s, except scripts whose body contains `struct PlayInfo` (the
  play-metadata batch, immutable once minted) which cache for a week.
- Store only HTTP 200. REST errors arrive as real statuses, unlike the
  v1 gRPC-web transport.

`deploy/cloudflare/worker.js` is one implementation (Cloudflare Worker
plus static assets); nginx `proxy_cache` or any CDN can do the same. The
app never knows which host it is on. Note that addresses are interpolated
into script text rather than passed as arguments, so each account produces
its own cache key; that is fine, account scripts are not the hot path.

### 2.3 The Cadence scripts

All scripts are inline template literals in `src/services/fcl.service.js`,
in Cadence 1.0 syntax (`access(all)`, capabilities, entitlements). The
ones you will reuse, with the batch sizes measured on mainnet:

| Function | Returns | Batch and notes |
|---|---|---|
| `getTopshotStats()` | `{ totalSupply, nextPlayID, nextSetID, currentSeries }` | One call, under 100 ms. The change detector for everything. |
| `getSetsOverview()` | `[{ id, setName, playIDs[], series, locked }]` | One call. `playIDs` order is the edition `playOrder`. |
| `fetchPlayBatch(playIDs)` | `[{ playID, metadata {String:String} }]` | 200 per call. Immutable; safe to cache forever. |
| `getMintCounts(setIDs)` | `{ setID: { playID: { minted, retired } } }` | 10 sets per call. Wire shape is `[minted, retired01]` per play. |
| `getSetCIDs(setID, playIDs)` | `{ playID: { FIELD: CID } }` | 150 plays per call, resolver only. |
| `getSetDetails(setID)` | everything above for one set, plus `ipfsGateway` | **Blows the 100,000-unit computation limit on sets 27 and 52** (Platinum Ice; set 27 fails at 100,002). Never use it for a bulk walk. |
| `getSubeditions()` | `{ id: { id, name, mintCount } }` | Names from chain; per-subedition mint counts are **not on chain** (they live on Dapper's SubeditionAdmin resource) and come from a hand-kept table cross-checked against Atlas. |
| `getCollectionIDs(address)` | `[momentID]` | One call. |
| `getCollectionData(address, ids)` | `[[momentID, setID, playID, serial, subeditionID]]` | About 2,000 moments per call. Panics if the collection capability is missing. |
| `getMomentsByOwner(address, ids)` | same tuples; ids the owner does not expose are simply absent | Used by the live feed at 50 per call. |
| `getAccountMoments(address, ids)` | rich detail: set name, subedition name, `lockExpiry`, `salePrice`, `playMetadata`, `onEVM` | 100 per call. Falls through MomentCollection, sale V3, sale V1, bridge escrow. |
| `getSaleData(address, ids, useV3)` | tuples from the **sale** collection | 2,000 per call. V1 listings escrow the moment out of MomentCollection. |
| `getLockData(ids)` | `[[momentID, expirySeconds]]`, locked ids only | About 10,000 ids per call in 1.6 s. **20,000 fails.** Reads `TopShotLocking.getExpiry` directly, so no owner or borrow is needed. Never cache across sessions. |
| `getOffersMadeBy(address)` | the buyer's standing offers | A 2,777-offer book enumerates in about 2 s in one call; the ceiling is roughly 8,900 `borrowOffer` per call; fallback reads details in 5,000-id chunks. |
| `getAccountGraph(address)` | `{ address, evm, dapper, parents[], children[] }` | Script-only (uses `getAuthAccount`). See 6.2. |
| `getEvmCollectionIDs(evmHex)` | `[momentID]` | `tokenOfOwnerByIndex` dry calls, pages of 1,000, gas limit 1,000,000 each. |
| `getEscrowMomentData(ids)` | tuples for moments parked on EVM | Borrows the bridge escrow Locker. |
| `getBridgeStats()` | `{ current, allTime }` | Escrow Locker length, plus an optional unproxied `eth_call` for `totalSupply()`. |

Semantics worth keeping:

- Subedition 0 means Standard.
- `lockExpiry` null means unlocked; a past expiry means the lock ran out
  and the owner has not unlocked yet ("unlockable").
- `salePrice` null means not listed.
- The contract never decrements `numberMintedPerPlay` on burn, so burned
  sets (the four Platinum Ice sets) carry an off-chain `burned` flag.
- **FCL decodes every integer as a string.** Coerce with `Number()`
  before comparing; a strict `includes()` on numeric ids matches nothing.
  `UFix64` is kept as a string on purpose so no precision is invented.
- Address arguments want bare hex without `0x`.

### 2.4 The seed and the sync loop

The browser owns a full copy of the catalogue in IndexedDB and every page
renders from it. Getting that copy has two paths.

**Seed.** `npm run seed` (`scripts/build-seed.mjs`) walks the chain once
and writes `public/seed/topshot-seed.json` (about 14 MB, a few MB
compressed): `{ generatedAt, stats, playsRaw, setsOverview, setDetails }`.
It is built from `getSetsOverview` plus `getMintCounts` plus `getSetCIDs`,
never `getSetDetails`, so the big sets never fail. Plays are reused from
the previous seed (immutable), locked sets skip the chain entirely, open
sets always refetch. `--if-stale` skips the walk when the file is under
24 hours old, so UI-only deploys cost nothing. The file is optional: a
build without it full-syncs identically.

**Browser.** `src/services/sync.coordinator.js` runs once per app load
(no timer):

1. `getTopshotStats()` plus the stored counters.
2. If the corrections hash changed, recompile the database from `_raw`
   (no chain access).
3. No local data: load the seed if the host serves it (the content type
   must contain `json`, because SPA hosting answers missing files with the
   app shell as HTTP 200), else a phased full sync: sets overview, plays
   in batches of 200, then per-set details.
4. Otherwise diff the contract's `nextPlayID` / `nextSetID` against the
   stored ones and fetch only the new range. New plays and sets are
   detected purely by those counters, never by scanning events.
5. Compare `playIDs` on every unlocked set against the live overview; an
   expanded open set is re-detailed. This is the only way a play added
   to an existing set is noticed.
6. On every pass re-read mint counts and retired flags for every edition
   (10 sets per call) and write back only the rows that changed. Open
   editions keep minting; counts are never allowed to go stale.

Self-heals run in the "nothing new" branch: empty teams store, empty
editions store, prototype-era fake CIDs (any CID shorter than 46
characters; real ones are 46 for `Qm...` or 59 for `bafy...`), missing
edition placeholders, and a one-shot IPFS backfill gated by a
localStorage flag.

### 2.5 The IndexedDB shape

Database `TopShotExplorerDB`, version 6, in `src/services/db.service.js`.

| Store | Key | Record |
|---|---|---|
| `plays` | `playID` (int) | compiled play plus `_raw` (the untouched chain metadata) |
| `sets` | `id` (int) | `{ id, setName, series, locked, playIDs[], _raw }` |
| `editions` | `"setID_playID"` | `{ id, setID, playID, momentCount, retired, playOrder }` |
| `ipfs` | `"setID_playID"` | `{ id, setID, playID, cids: { FIELD: CID } }`; no row means no media registered |
| `sync_stats` | `"current_stats"` | `{ nextPlayID, nextSetID, totalSupply, currentSeries, overridesHash, lastSyncTime }` |
| `teams` | `TeamAtMomentNBAID` (out-of-line) | `{ TeamName, TeamID }` |
| `account_collections` | address (lowercase) | `{ address, fetchedAt, moments: [[momentID, setID, playID, serial, subID, 1-if-on-EVM]] }`, plus `"<address>:locks"` rows |

Two version knobs: `DB_VERSION` for schema, and the corrections hash
(section 3.2) for content. Edition additions are applied on the read path,
so a caller that bypasses the DB must apply them itself. The IndexedDB
learnings that cost real time: never reject on `onblocked` (multi-tab
reads silently resolve empty), wrap every `onsuccess` body in its own
try/catch (a throw there leaves the promise pending forever), and
invalidate RAM caches after the write lands, not before.

### 2.6 Minimum recipe for a new app

1. Point FCL at an access node (or your proxy).
2. Poll `getTopshotStats()` for the two counters.
3. `getSetsOverview()` once; it gives names, series, `locked`, and the
   ordered play list.
4. `fetchPlayBatch` in 200s for play metadata; keep the results forever.
5. `getMintCounts` in 10s and `getSetCIDs` in 150s. Never `getSetDetails`
   for a bulk walk.
6. Re-read mint counts every pass; write back diffs.
7. Compare `playIDs` on unlocked sets.
8. Accounts: `getCollectionIDs`, then `getCollectionData` in 2,000s;
   cache per address, fetch only unknown ids (moments are immutable).
   `getLockData` in 10,000s, never cached across sessions.
9. `Number()` every id FCL hands you.
10. Put a body-hash cache in front of `POST /v1/scripts` before going
    public.

---

## 3. The correction layer

Chain metadata is riddled with errors: hometowns filed as birthplaces,
modern franchise names backfilled onto historical drafts, a wrong
player's whole bio on a play, typos, timezone-shifted dates, garbage in
enum fields, and format drift between mint batches. The chain cannot be
edited, so corrections are layered on. Rule of thumb: **overrides fix
mistakes, additions add knowledge, exclusions remove noise.**

### 3.1 The `data/` folder

| File | Holds | Curation |
|---|---|---|
| `overrides/plays.json` | `{ "<playID>": { Field: value } }`: fixes for wrong chain values (DraftTeam, Birthplace, FullName, Birthdate, NbaSeason...). 568 plays. | hand-verified |
| `overrides/sets.json`, `overrides/series.json` | display names | hand |
| `additions/plays.json` | `{ "<playID>": { tags, NbaSeason, DateOfMoment, tags_suppress, note } }`: context that never existed on chain. `tags_suppress` withholds a derived badge from one play and `note` says why; the Corrections page shows the pair as "badge withheld". 936 plays. | Atlas import, then auto-pruned |
| `additions/editions.json` | `{ "setID_playID": { tags, tier } }`: reward badges are edition facts. | generated by `atlas:editions` |
| `additions/sets.json` | `{ "<setID>": { tier, burned, mismint } }` | hand |
| `additions/teams.json` | per NBA team id: `name, emoji, color, historical_names, championships, cups, arenas[]` with date ranges and coordinates. Sole source for Championship Year and Cup Year. | hand |
| `additions/seasons.json` | per league and season: `preseason, regular, allstar, playin, playoffs, commissioners_cup, suspended, cup` date windows | hand, from season records |
| `additions/rookie_seasons.json` | players whose first season is not their draft year (redshirts, draft-and-stash, undrafted) | seeded from Atlas comparison, hand-confirmed |
| `plays_exclude.json` | flat array of misminted play ids | hand |
| `sets_parallels.json` | `{ "<setID>": [subeditionIDs] }` | generated by `atlas:parallels` (the one thing the chain cannot answer) |
| `leagues.json` | NBA and WNBA team names for league detection | hand |
| `commentary.json` | 74 narrated cuts from the original site, hotlinked to Dapper's CDN | archived |
| `autographs.json` | `{ "setID_playID": [subeditionIDs] }`: the signed parallels of an edition. The chain flags an autograph on the play, one value for every parallel, so the Autograph badge follows this file per parallel (`src/services/autograph.service.js`); the chain flag is a check on the Corrections page. | generated by `atlas:autographs` |
| `burns.json` | `{ "setID_playID": burned }` (or `{ "<subeditionID>": n }` when a parallel carries burns; the edition count is the sum): moments destroyed, the only source of a remaining supply since the chain never decrements a mint count. `src/services/supply.service.js` subtracts it everywhere a count is shown; Settings can switch back to mint counts. Serial logic keeps the mint count. | generated by `atlas:burns` |
| `awards/*.json` | Hall of Fame (feeds a badge), MVP, ROY | generated by `npm run awards` |
| `ipfs_media.json`, `ipfs_dead.json`, `ipfs_media_summary.json` | what every CID measurably is; see 4.2 | generated by the probe |
| `logos.json` | the recipe for cutting badges and team logos out of set art | hand-tuned |
| `dapper/*.json` | Dapper's own ids beside ours (`playUUID`, `legacyEditionUUID`, `atlasEditionID`, `legacySetUUID`). Loaded only by the Legacy page, by dynamic import. | generated |
| `atlas/editions.json` | the latest Atlas snapshot, not committed, read only by the comparison scripts | generated |

Set-level exclusions are deliberately not in `plays_exclude.json`:
Platinum Ice reuses Base Set play ids, so `burned` and `mismint` are set
facts in `additions/sets.json`.

### 3.2 Mechanics (`src/services/overrides.service.js`)

`compilePlayMetadata(raw)` stashes the untouched record under `_raw`,
then applies, in order:

1. key standardisation (mixed `fullName` / `FullName` casing is tolerated);
2. overrides;
3. additions;
4. the canonical-name alias, unless the play has its own name override;
5. normalisation, **unconditional**, even when corrections are switched
   off: sentinel blanking (`"N/A"`, `"<invalid Value>"`), birthdate to
   `YYYY-MM-DD`, moment date to Eastern time, birthplace to house format,
   the one team-name rewrite (Los Angeles Clippers to LA Clippers);
6. WNBA season repair and the "Play Coming Soon" scrub.

Steps 2 to 4 are what the Settings switch bypasses; normalisation is not a
correction.

**Recompile trigger.** `getCurrentOverridesHash()` in
`sync.coordinator.js` hashes the seven bundled JSON files plus
`NORMALIZATION_VERSION`. On mismatch the database recompiles every play
and set from `_raw`, locally, in the background; no resync. **Bump
`NORMALIZATION_VERSION` whenever normalisation logic changes**, or cached
browsers keep the old output.

**Name aliases.** When an override corrects a `FullName`, the raw spelling
it replaced maps to the canonical name for every play, including future
mints with the same variant. One correction per player is enough; an
ambiguous spelling (mapped to two names) is dropped.

**Birthplace house format** (`src/services/birthplace.normalizer.js`):
`City, ST, USA`, `City, PR, CAN`, `City, ISO3` or `City, Region, ISO3`.
Only recognised tokens are rewritten; anything unknown passes through, so
the normaliser can never invent a fact. It cannot catch factual slips
(a hometown recorded as a birthplace); those are Corrections-page judgments.

**Dates.** `normalizeDateOfMoment` produces `YYYY-MM-DD HH:MM:SS EST|EDT`.
Never feed that string to `new Date()` (Safari returns Invalid Date); use
`parseMomentDate`.

### 3.3 Derived badges

Six badges are computed, never stored, and any stored Dapper copy is
stripped before build so a wrong Dapper tag can never display:

| Badge | Rule |
|---|---|
| Top Shot Debut | the player's lowest play id; a one-of-one yields to a numbered play from the same game; a twin of the debut (same game, same play category) shares the badge. Chain data alone; 1,415 of 1,415 Atlas badges reproduced, five extras withheld by `tags_suppress` |
| Rookie Year | `NbaSeason` starts in the player's rookie season |
| Rookie Mint | the edition was **minted** during the rookie season, using the mint clock |
| Championship Year, Cup Year | `teams.json` lists that season for the team at the moment, and the moment is not a cross-league cameo |
| Hall of Fame | the player is in `awards/hall_of_fame.json` |

Rookie season is the draft year unless `rookie_seasons.json` says
otherwise. Two tempting signals were tested and rejected:
`TotalYearsExperience` (it records experience at **mint** time) and
"first moment on Top Shot" (Top Shot skips many early seasons).

**The mint clock.** The chain has no mint date. Play ids are creation
order, so the running maximum of `DateOfMoment` by ascending play id
approximates mint time. A jump of more than 45 days must be confirmed by
3 of the next 60 plays. The offseason belongs to the season just finished
until the next season tips off per `seasons.json`. This also classifies
every edition as **In season** or **Historical** (archive drops, Run It
Back, Anthology).

Non-computable Dapper badges (Rookie Premiere, MVP Year, Rookie of the
Year) display from storage as external context. Reward badges (Challenge
Reward and the like) are edition facts. Autograph is a fact of one
parallel: it comes from `data/autographs.json` (the signed subeditions per
edition, from Atlas) and `editionBadges()` narrows a play's badges to one
edition or parallel; the chain's play-level `PlayerAutographType` is only
a check (Corrections page). Every badge emoji must be in the shipped font
subset (`src/dev/subset-text.txt`) or it silently falls back to the
system font.

Serial coincidences (serial 1, jersey number, last serial, draft year,
moment year, birth year, draft pick, 75 in the anniversary series) are in
`src/utils/serials.utils.js`. Note that marketing "Series 3" is data
series 4.

### 3.4 Keeping the files lean

`npm run reconcile` (`scripts/reconcile-tags.mjs`, also the `prebuild`
step) strips every stored tag the derivation reproduces. It imports the
real `getCalculatedPlayTags` through the Node JSON hook, so the script and
the Corrections page can never disagree. A stored tag the derivation does
**not** produce is a disagreement and stays as a marker until a human
resolves it. The same script reports overrides that are unnecessary (raw
already right) or ineffective; deleting those is a human decision.

### 3.5 Finding and fixing errors

`src/services/audit.service.js` runs six detectors over compiled plays:
name spelling conflicts (diacritics and nickname drift, with a twin guard),
profile conflicts (draft and birth facts differing across one player's
plays), tag mismatches, out-of-bounds values (scores, height, weight,
draft fields, epoch dates), team-name versus team-id mismatches
(validated against `teams.json`, not majority vote, because the majority
is wrong for era names), and moments outside every window of their
season. Every finding carries a patch shaped exactly like an entry for its
target file, a one-line context, and, for tags, a machine-computed
premise so a human judges only what the machine could not.

The Corrections page (`/corrections`; called Errors until 2026-09-12:
"Errors" sounds like the site is broken, "Corrections" says what the almanac
did) shows the findings (Open Issues) and a before/after
ledger of every applied correction (Corrections), tiered as factual,
routine or context. Triage queues one fix per finding in localStorage;
Export merges the queue into one JSON block per target file; on the next
load the hash differs and the database recompiles itself.

The pipeline is deliberately agent-shaped: structured findings in, JSON
patches out, a reviewable diff at the end. **Do not wire AI calls into
the app**; run an agent next to the files instead. The full workflow is
the "For contributors" tab on the Corrections page.

**Source verification protocol** (from the playbook, after a retracted
flag): two independent references, Wikipedia infobox plus
Basketball-Reference preferred; ESPN is a tiebreaker at most because it
substitutes hometown for birthplace; distrust any birthplace equal to the
player's high school city; when solid sources split, do not fix, record
as ambiguous; cite the winning sources. Fix all of a player's plays in one
pass anchored on the verified fact, and search for the wrong value
everywhere before fixing it once (one on-chain typo had been copied into
four overrides).

---

## 4. Media

### 4.1 Where the files are

`TopShotIPFSResolver.getCIDs(setID:, playID:, subeditionID:)` returns a
dictionary of field name to CID per **edition**. The resolver also
exposes a `gateway` string, which the app reads but does not use: every
URL is `https://ipfs.dapperlabs.com/ipfs/<cid>`, the only gateway
referenced anywhere. Dapper moved every edition's media to IPFS in June
2026 (`https://blog.nbatopshot.com/posts/authentic-permanent`).

What the fields measurably are (full census in `IPFS-ANALYSIS.md`):

| Field | Reality |
|---|---|
| `VIDEO` | the moment master, 1080x1920 portrait h264, median 35 s |
| `VIDEO_SQUARE` | the social crop, 1080x1080, median 21 s |
| `HERO` | the square art card, 98% are 2880x2880, 71% PNG. This is the cube render: player card on the left face, **set art on the right face** |
| `PLAYER` | the player cutout, mostly 2880x2880 |
| `VIDEO_TALL` | two things under one key: a second full-res master (often 40 MB+) or a 540x960 preview |
| `VIDEO_VERTICAL`, `IMAGE_PLAYER` | series 0 to 4 only |

There is **no set-art, logo or badge file on chain**. Set art is the right
cube face of a hero render; team logos and event badges are cut out of
set art. Those recipes are the scripts in 4.5.

The app queries only `subeditionID: 0`. Parallels have their own CIDs on
chain (about 3,590 distinct, none identical to standard) and the app does
not show them yet; the fix is to key media records `setID_playID_subID`.

### 4.2 The probe distillate

`data/ipfs_media.json` (about 5.7 MB, 62,868 CIDs, lazy-loaded, never in
the main bundle) records what each CID is without holding the file:

```
image: ["jpg"|"png"|"mpo", width, height, bytes|null, author?, camera?, photoDate?, silhouette?, fullBleed?]
video: ["mp4", width, height, bytes|null, durationSeconds, videoKbps|null, audioKbps]   0 = silent
dead:  0
```

It is built by `npm run ipfs:probe` (`scripts/probe-missing.mjs`): one
ranged GET of the first 128 KB per image (dimensions, EXIF, total size
from `Content-Range`) and an `ffprobe` of the gateway URL per video (the
moov atom only). A CID is content-addressed, so a probed entry is never
re-probed. A 404 or a `text/html` answer marks the CID dead; transient
failures stay unknown and block the merge, which is all-or-nothing. Every
video is h264 in mp4 at about 30 fps; when bytes are unknown, estimate
`duration x (videoKbps + audioKbps) x 125`. 61% of videos carry audio.

`data/ipfs_media_summary.json` is a few hundred bytes for the homepage,
written by `scripts/build-ipfs-summary.mjs` at the end of every probe.
"Missing files" on the homepage is the count of dead CIDs: registered on
chain, nothing at the gateway.

### 4.3 Hosting layers

- **Layer 0, always works:** hotlink gateway originals and generate
  derived images in the browser (`src/services/ipfs.generate.js`). No
  Cloudflare, no bucket, no build step.
- **Layer 1, optional:** derived static files on a public bucket
  (`cache.topshotexplorer.com`, an R2 bucket). One knob,
  `VITE_MEDIA_BASE`; unset it and every helper in
  `src/services/media.service.js` returns null and the UI keeps its
  no-media look.
- **Layer 2, deliberately empty:** no image transformation service, no
  resizing workers, nothing in `src/` that knows Cloudflare exists.

Bucket layout mirrors the local `assets/` tree exactly, so the dev
middleware at `/assets/...` and the bucket share one path scheme:

```
derived/thumbs/v1/512/<cid>.jpg    hero thumbs, immutable, 1 year
derived/setart/512/<file>.jpg      set-art squares for chips, 1 day
sets/<...>.jpg                     full-res set art (1024), 1 day
logos/teams/<league>/<...>.png     1 day
logos/badges/<...>.png             1 day
manifest.json                      tree listing, 5 min, uploaded last
offers/*.json                      marketplace data (section 5)
```

Thumb spec: every live 2880x2880 image, border-trimmed (sharp `trim`,
threshold 10; skipped for full-bleed photos; full frame if the trim
degenerates), longest side 512, jpg quality 92, mozjpeg. About 30 to 60 KB
each, under a gigabyte for the catalogue. **There is exactly one derived
size**; the browser scales it. Media never costs a Worker invocation; the
bucket's custom domain serves it directly. When a CID goes dead at
Dapper's gateway, its thumb is deleted from the bucket on the next sync,
so Dapper's removals propagate. There is no purge operation anywhere.

Fallback order in the UI: bucket thumb, then a glyph or a name-drawn
placeholder (`components/SetArt.jsx`), then in-browser generation for set
art. Dead CIDs short-circuit before any URL is built.

### 4.4 The cube

`src/services/cube.service.js` builds the config; `components/MomentCube.jsx`
and `CubeOverlay.jsx` host it. The renderer is `mediacube`, vendored under
`packages/mediacube/` (MIT, its own README documents the config, layers
and settings) and linked as a `file:` dependency, so a fresh clone installs
it with everything else. It is dynamic-imported on first open and is
DOM/CSS, no three.js. The **Cube Lab** page (`/cube`,
`src/pages/CubeLab.jsx`) is the test bench: filter to an edition, see the
cube the tables would build, change every library setting live, and copy
the resulting config. Its "Hologram pyramid" link
(`src/components/HoloDisplay.jsx`) turns the edition into a full-screen
source display for a four-sided hologram pyramid: four panels on a black
grid, rotated to face each side and mirrored. In video mode the clip plays
four times in sync, looping on the cube's trim. In cube mode four MediaCube
instances show the same thing at the same time: a master spins and plays,
and the three followers copy its `rotX` and `rotY` every frame and play
the same face's video on its clock. The strip along the top of the screen is a touch pad:
a horizontal drag there is forwarded to the master as pointer events with the vertical
coordinate frozen, so the cube spins as a drag on it would, without a finger over the
panel the pyramid sits on. `?holo=video` or `?holo=cube` on a Cube Lab link opens it
directly on a phone.

Front face, in order: live `VIDEO_SQUARE`; else a live non-silhouette
`PLAYER`; else a reconstruction of the player card from the hero (series
7 and up, when the player image is a silhouette); else a full-bleed photo
hero; else no cube. Team colour and emoji come from `teams.json`; glow
escalates by tier (legendary breathes, ultimate gets a quiet shine).
Videos are trimmed 1 s at the front and 6.8 s at the back, keeping at
least 6 s.

In-browser generation (`ipfs.generate.js`, pure canvas): `generateSetArt`
unwarps the right cube face of a hero; `reconstructPlayer` unwarps the
left face. The face geometry is fixed per era in
`src/services/hero-quads.js` (pure data shared with the scripts): one
quad for series up to 5, another from series 6. Gateways send
`Access-Control-Allow-Origin: *`, so canvas work on gateway images is
fine.

### 4.5 Scripts, in the order they run when new sets drop

```
npm run seed  ->  scripts/download-ipfs-images.mjs  ->  npm run media  ->  npm run media:sync
```

- `download-ipfs-images.mjs`: images only (videos never download), about
  46 GB, to drives listed in the local `ipfs_dirs.json`; completeness
  checked against probe byte sizes; `.part` then rename.
- `media-derive.mjs` (`npm run media`): thumbs and set-art squares,
  idempotent and resumable; a 404 is fatal and not retried.
- `extract-set-art.mjs`: the right cube face is the set art; core sets
  fan out per team; raw-photo heroes are skipped.
- `extract-set-badges.mjs`: cuts badges and logos using `data/logos.json`
  rectangles measured in 1024 set-art space.
- `media-sync.mjs` (`npm run media:sync`): wrangler has no bucket listing
  or bulk upload, so state lives in `scratch/media-sync-state.json` and
  each object is one `wrangler r2 object put`. Thumbs are signed by size
  (content-addressed), everything else by md5. Manifest goes last, so it
  never advertises files still uploading.

The hard-won learning in `scripts/lib/hero-split.mjs`: on an image with an
alpha channel, sharp's `greyscale().raw()` emits two channels per pixel,
so single-channel indexing reads interleaved garbage. `flatten()` first.
This silently wrecked every transparent-PNG hero until 2026-09-05.

---

## 5. Marketplace and live events

### 5.1 Events

Plain REST, no FCL, so the same module runs in a Worker:
`GET /v1/blocks?height=sealed` for the tip, then
`GET /v1/events?type=...&start_height=...&end_height=...`. **The API caps a
range at 250 heights per request** (about four minutes of chain). Payloads
are base64 JSON-Cadence and are decoded by hand.

The catalogue (`EVENT_GROUPS` in `flowEvents.service.js`) and the streams
on by default:

| Stream | Event | Default |
|---|---|---|
| Transfer | `TopShot.Withdraw` + `TopShot.Deposit`, merged | on |
| Minted, Destroyed | `TopShot.MomentMinted`, `TopShot.MomentDestroyed` | off |
| Listing | `NFTStorefrontV2.ListingAvailable` | on |
| Sold, Delisted | `NFTStorefrontV2.ListingCompleted`, split by its `purchased` flag | on |
| Offer Made | `OffersV2.OfferAvailable` | on |
| Offer Accepted, Offer Cancelled | `OffersV2.OfferCompleted`, split by `purchased` | on |
| Pack Opened, Pack Minted | `PackNFT.Opened`, `PackNFT.Minted` | off |
| Locked, Unlocked | `TopShotLocking.MomentLocked`, `MomentUnlocked` | off |

The old markets (`Market`, `TopShotMarketV2`, `TopShotMarketV3`) were
retired from the feed on 2026-09-03: everything migrated to
`NFTStorefrontV2` and their only traffic was cleanup noise. The decoder
still understands them.

Polling every 10 s, one request per distinct event type (two chips over
one stream cost one request), resuming from the last height or
backfilling the full 250 window for a fresh stream; hidden tabs skip.
"Older events" under the table first pages through what is collected,
then walks every enabled stream one 250-block window further back per
click (one request per stream); pages fetched that way are never dropped
by the in-memory cap, which only trims live rows. A
Withdraw and a Deposit of the same moment in one transaction become one
Transfer row; a sale, offer or pack opening absorbs the mechanical moves
of its own moment. A delisting names no address in its event, so the
storefront owner comes from the transaction's authorizers. A storefront
sale or delist of another collection's NFT (packs, NFL All Day, MFL,
Pinnacle) resolves the same way from one request per row, seller and
buyer from the standard NonFungibleToken Withdrawn and Deposited events
of the transaction, and never a collection script. Moment
identity (which edition, which serial) is resolved by borrowing the moment
from candidate owners, at most three lookups in flight, batched 50 per
script when rows share an owner, and cached in localStorage; refetching
identities after every reload was the main source of request bursts.

### 5.2 Offers

Offers live in each **buyer's** account. There is no on-chain index by
target moment or by owner, and offers never expire. The architecture that
follows, in `src/services/offers.core.js` (runtime-agnostic, runs in the
browser, in a Worker cron and in a Node script):

- An `OfferAvailable` event carries the whole offer; an `OfferCompleted`
  event carries the id and whether it was bought or cancelled. So a
  correct book at height H stays correct by applying the events after H.
- Enumerating buyers' books (the expensive part) is only for building the
  base and for occasional verification. `OfferAvailable` reveals **who**
  makes offers; a buyer whose last offer predates every folded window
  stays invisible until they touch an offer again, so the registry
  converges over time.

The book: `{ format, height, time, offers: { edition, subedition, nft }, other, purchasedInBooks }`,
each bucket holding `[amount, buyer, offerId, createdAtMs]` arrays sorted
highest first, keyed `setID_playID`, `setID_playID_subID` or `momentID`.
Non-Top-Shot offers go to `other`, which is why the app can show other
collections without naming them.

Three runtimes: `npm run offers` (`scripts/scan-offers.mjs`) builds or
rebases the book, verifies against every known buyer's live collection,
writes `public/seed/topshot-offers.json` and uploads to the bucket; the
Worker cron folds every 30 minutes (up to 400 windows, about 20 hours);
the browser folds the last few minutes on load (up to 120 windows, then
gives up rather than cost every visitor a long scan). Invariants: the
fold never advances the state height, the persister does; `state.json` is
written after the book it matches, with `no-store`; events are sorted
(height, available before completed, index) before applying; adding an
offer is idempotent by id, so overlapping windows are safe.

The window banner on the Offers page states the semantics exactly: the
window discovers buyers; their standing offers are read live and can be
far older than it; only the accepted history is bounded by it.

An account's own offers need no snapshot: `getOffersMadeBy` reads the
buyer's public `DapperOffersV2` collection live.

---

## 6. Accounts

### 6.1 Reading a collection

Browsing as an account is a lens, not a login (`src/services/account.context.js`).
The moment list is `getCollectionIDs` plus, when the account has a
Cadence-owned EVM address, `getEvmCollectionIDs`; then tuples for unknown
ids only, 2,000 per call (moments are immutable, so a refresh only re-reads
the id list). Cached per address in IndexedDB, refreshed when older than
ten minutes. Locks come separately from `getLockData` in 10,000s with a
24-hour cache. V1 sale listings escrow the moment out of the collection,
so `getAccountDetails.saleMomentIDs` are fetched through `getSaleData`.
HybridCustody parents and children the user checks into the context have
their moments merged in.

### 6.2 The account graph

`getAccountGraph(address)`, verified on mainnet on 2026-09-08 against a
real Dapper-wallet / Flow-wallet pair:

- **Dapper custodial wallet**: carries `/storage/dapperUtilityCoinReceiver`
  or `/storage/privateForwardingStorage`; other wallets never do.
- **Parents**: HybridCustody parents that confirmed the link (pending
  invitations excluded).
- **Children**: accounts controlled through a HybridCustody Manager
  (a Dapper wallet linked to a wallet shows up here).
- **EVM**: the Cadence-owned EVM account (COA) from `/storage/evm`.

### 6.3 Flow EVM

The bridge's own ERC721 (`0x50ab...`) is held entirely by Dapper's
wrapper contract (`0x84c6...`), which issues the user-facing token with
**the same id as the moment**, implements ERC721Enumerable, and points
`tokenURI` at Dapper's metadata API. So an EVM owner's moment ids read
straight from the chain with dry calls: no gateway account, no RPC.
Bridging back parks the ERC721 with the bridge instead of burning it, so
the escrow Locker's count is "currently on EVM" and the ERC721
`totalSupply()` is "ever bridged". While a moment is on EVM its Cadence
resource sits in the bridge escrow, which `getEscrowMomentData` can read.

---

## 7. Identity and old links

### 7.1 Username to address

Dapper's Atlas API allows only nbatopshot.com as a browser origin and
puts a managed challenge in front of every non-browser client, a
Cloudflare Worker included. The public profile page
`https://nbatopshot.com/collection/<name>` is server-rendered, allowed by
robots.txt, and carries the address in its `og:image` tag
(`/og/user/0x...`); an unknown user gets the site's generic image, which
is the miss signal. `deploy/cloudflare/lookup.js` implements exactly that
and is shared by the Worker (`GET /lookup/user/<name>`, hits cached a day,
misses an hour) and the Vite dev server. The client
(`src/services/username.lookup.js`) treats a non-JSON answer as "this host
has no lookup route" and degrades to addresses only. Only username,
address and the lookup date are kept.

The other direction, address to username, has no public source: the
profile page by address echoes the address back. The hosted site answers
`GET /lookup/address/<addr>` from a lookup table in Cloudflare D1: the
username, the wallet kind, and the account-linking parents and children
with their names. One address per request, cached a day at the edge and
rate limited per client, so pages get the names they show and nobody
gets the table. The table is loaded from a private collector census that
is not part of this repository and never will be; the username route
writes every name it resolves into it. `src/services/usernames.service.js`
asks for the addresses a page shows, caches answers for the session, and
layers the browser's own resolved names on top; Offers, Live, the leader
boards and the account header show `@username`, or `@username · parent`
for a wallet a named Dapper wallet is linked to, with the full
address in the hover, and the address itself wherever the table is
silent. A host without the route shows addresses.

Names are for signed-in readers. `deploy/cloudflare/auth.js` (shared by
the Worker and the dev server) implements a wallet sign-in with no
account behind it: `GET /auth/challenge` hands out a short message whose
nonce the host can recompute, the wallet signs it (FCL `signUserMessage`,
no transaction), `POST /auth/verify` asks FCLCrypto.verifyUserSignatures
on chain whether the signature is the address's own, and the answer is a
signed cookie (`ts_session`, 30 days) holding only the address. The
address lookup answers 401 without it, checked before its edge cache;
the client (`usernames.service`) then shows addresses and Live and
Offers carry one line whose "sign in with your wallet" connects and
signs. Signed in is the whole condition (never the wall). There
is no sign-in page. Connecting asks for the one signature right away;
an extension wallet signs in place, while a popup wallet may refuse a
window that long after the click, so the connection stands and the next
"sign in" click (Live, Offers, or the wall page's "Sign the message")
asks again inside its own click (`wallet.service` connectWallet /
signIn; stepOf says where the reader is). The Worker needs the
`SESSION_SECRET` secret; without it sign-in answers 503 and names stay
closed. A D1 table `denied(address)` flags a session at sign-in; a
flagged session works everywhere except the gated lookup, which treats
it as anonymous.

The same sign-in signs the **Early Adopters wall** (`/about/early-adopters`,
a tab of About): one row per address in a D1 table
(`deploy/cloudflare/wall.js`, shared with the dev server over a local
SQLite file). Who may sign is read from the chain at signing
(`deploy/cloudflare/graph.js`, the account graph the app also reads in
the browser): a Dapper wallet, or a wallet that is the confirmed
parent of one; any other wallet is turned away in words. The row holds
the address, which of the two it was, the choice to show the username
(a parent's username is its Dapper child's), the linked addresses (a
Dapper wallet's parents, a parent's Dapper children), the sealed block
and the time; nothing free-form. In the navbar the corner is a "Look
up" button and a "Sign in" button (the
address box beside nine links was 70px). Look up hides the links on
desktop and gives the box the bar, with Go, Sign in and Close; Esc,
Close, navigating or landing on an account puts the links back; the
lookup history drops under the box. The mobile column keeps the links
and shows the box in place. "Sign in" means connect a wallet (Flow
Wallet or Dapper Wallet; the picker hides Blocto and NuFi through
`discovery.authn.exclude`). The connected wallet becomes
the account in view: the address box gives way to the chip (✓ marks the
wallet's own address) and the account menu's single address row carries
the wallet kind and a "signed in" mark when the wallet is the account in
view (a wallet browsing someone else gets its own row above); FCL
remembers the wallet across loads and the session mirrors it. The menu
holds nothing about the wall, no recent addresses (those live under the
address box alone), and never lists the browsed address twice: Linked
accounts shows the others only. Under Linked accounts the menu lists the
account's Cadence-owned EVM accounts (COAs), one row each: `fcl.service`
getAccountGraph walks every storage path by type, the standard
`/storage/evm` first (a COA is one resource per path, so an account
could hold several). Each row is the address shortened to its ends with
the full one on hover and an arrow to the collection filtered to Held on
EVM; their Top Shot holdings join the collection, marked EVM
(getEvmCollectionIDsAll). The account page shows the same addresses as
chips that toggle the Held on filter. Nothing is ever added by hand and
nothing is stored: an ordinary EVM account (one made from the same
recovery phrase, say) leaves no trace on a Cadence account, so it is
browsed on its own instead. The Look up box accepts an EVM address (0x
and forty hex characters, `account.context` isEvmAddress) and the app
shows what the bridge's ERC721 says it holds, every moment marked EVM,
with no Cadence account, graph, marketplace items or creation date
behind it (the metadata script takes an optional holder and reads the
escrow alone). EVM addresses are the one kind the UI shortens. Menus open on hover only where hover
exists (`(hover: hover)`), so a phone opens them in one tap. One "Exit account" button at the bottom serves
both ways in: a pasted address just leaves; a connected wallet is signed
out of as well (cookie dropped, FCL disconnected). "Sign the message"
(the proof behind usernames and the wall) is a button on the early
adopters page only, never in the navbar.
`npm run wall:fold` (`scripts/wall-fold.mjs`) pulls the rows, adds each
collection's moment count from the chain, and writes
`data/early_adopters.json`, the permanent record that ships with the app;
the page shows the file plus the rows since the last fold as pending
(`GET /wall/pending`, ten seconds at the edge), and the account page
carries "Early Adopter #N" for a folded address. Sequence numbers are
signing order and never change; a row removed from the file on purpose
is listed under `dropped` so a fold does not bring it back. It confers
nothing.

The same census yields three aggregates that do ship, in `data/`:
`flow_account_clock.json` (creation number to date: Flow mainnet hands
addresses out in creation order, and an address decodes to its number,
`src/services/flow.address.js`), `collection_sizes.json` (collection-size
percentiles across every holder) and `census_stats.json` (headline
counts). They drive the "Collecting since", size-rank and "Last new
moment" chips on the account page and the Collectors card on the home
page. All three are approximations and say so on hover.

### 7.2 Old nbatopshot.com links

The old site addressed everything by Dapper UUIDs; Atlas replaced most
with numbers. `data/dapper/*.json` keeps both beside our Flow ids, and
`src/services/legacy.service.js` maps an old edition, listing (with
`?parallel=<subeditionID>`), set or current-site `/edition/<n>` link to a
page here. Atlas set ids equal Flow set ids. Moment and pack UUIDs were
assigned in Dapper's database and never published beside a Flow id, so
those links are recognised and explained, never resolved. There is also
no moment-id to edition index on chain, which is why serial-level offers
link out to nbatopshot.com.

---

## 8. Atlas, the secondary source

`https://api.production.atlas.dapperlabs.com/public/atlas.v1.EditionService/SearchEditions`
(Connect-RPC JSON, header `connect-protocol-version: 1`) is what
nbatopshot.com runs on. It is Cloudflare-gated for plain HTTP, so
`npm run atlas:harvest` calls it from inside a real Chrome page on
nbatopshot.com (puppeteer-core, no login) and writes a local
snapshot: about 139 pages of 100 (Atlas caps the page size), a few
minutes, the only Atlas traffic in the repo. The sweep asks for no sort:
Atlas then serves ids descending, an order that cannot move while the
sweep runs. Under the site's default order (30-day dollar volume) a row
slid across a page boundary and each sweep came back one edition short,
a different one each time. The comparison scripts then report differences:

| Script | Question it answers |
|---|---|
| `atlas:parallels` | which subeditions each set carries (the one fact the chain cannot answer; `--apply` writes `sets_parallels.json`) |
| `atlas:tags` | Atlas badges, seasons and dates versus ours (`--import` copies badges into additions, then `reconcile` strips the ones we derive) |
| `atlas:editions` | Atlas's edition number per edition, and reward badges (`--apply`) |
| `atlas:burns` | moments destroyed per edition, into `data/burns.json` (remaining supply = minted minus burned) |
| `atlas:autographs` | which parallels of an edition are signed, into `data/autographs.json` (the chain flags only the play) |
| `atlas:refresh` | the routine: harvest once, apply burns and autographs, report the three checks. The harvest is the only Atlas call; refresh on data deploys, weekly at most |

Atlas has said "2010-12" about a 2011 game. Every difference is a
judgment, not a fix; a new Atlas-only Rookie Year is the signal to confirm
a late debut and grow `rookie_seasons.json`. Cup Year is ours alone. The
Atlas-derived values that reach runtime are `sets_parallels.json` and the
hand-kept per-subedition mint counts, which `atlas:parallels`
cross-checks, `burns.json`, the destroyed count per edition that no chain
script can answer, and `autographs.json`, the signed parallels per
edition that the chain's play-level flag cannot express.

---

## 9. Running it

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server with dev twins for `/assets` and `/lookup/user` |
| `npm run build` | `reconcile` (prebuild), then `vite build` to `dist/` |
| `npm run seed` | rebuild `public/seed/topshot-seed.json` (`--if-stale`, `--full`) |
| `npm run offers` | build, verify and publish the offers book |
| `npm run ipfs:probe` | probe media of editions newer than the last run |
| `npm run media`, `npm run media:sync` | derive thumbs and set art; upload to the bucket |
| `npm run atlas:*`, `npm run reconcile` | section 8 and 3.4 |
| `npm run deploy:cloudflare` | seed if stale, offers, build, `wrangler deploy` |
| `node scripts/dev/cdp-smoke.mjs <url>` | headless Chrome check: console errors, `EVAL`, `SCREENSHOT`, `PRESET_LS`, `DESKTOP_WIDTH` / `MOBILE_WIDTH` |

Two pieces of glue every script relies on. `scripts/node-json-hook.mjs`
(`node --import`) adds `type: "json"` to JSON imports and resolves
extensionless relative imports, so the app's service modules run unchanged
in Node; that is how the scripts and the pages share one derivation.
`scripts/lib/json-file.mjs` writes every shared JSON file to a temp file
and renames it, and `readJsonPreservingEol` keeps a hand-edited file's
line endings so a rewrite is a minimal diff. Use both for any new script.

Build-time environment knobs: `VITE_FLOW_ACCESS_NODE`, `VITE_MEDIA_BASE`
(`.env.cloudflare` sets `/flow` and the bucket domain). Nothing in `src/`
references a hosting provider; deleting `deploy/` leaves a working app.

What is optional: the seed, the caching proxy, the username route, the
media bucket, the offers cron. What is not in the repo: the Atlas
snapshot, the 46 GB image mirror and its `ipfs_dirs.json`, the media-sync
state.

---

## 10. Reuse map

Portable as they are, no chain or UI coupling: `birthplace.normalizer.js`,
`name-norm.js`, `parallel.groups.js`, `set.status.js`, `hero-quads.js`,
`scripts/lib/json-file.mjs`, `scripts/node-json-hook.mjs`, the whole
`data/` tree.

Portable with the data files: `overrides.service.js` (its only
environment dependency is `localStorage` for the disable flag; a two-line
shim makes it run in Node), `flowEvents.service.js`, `offers.core.js`,
`legacy.service.js`, `deploy/cloudflare/lookup.js`.

Needs equivalent plumbing in a new app: the hash-changed-then-recompile
loop and the name-alias pass in `sync.coordinator.js`, the IndexedDB
layer. The cube is portable as `packages/mediacube` plus
`cube.service.js`, which needs only a play record, a tier and a media URL.

Invariants to keep whatever you build:

1. Never mutate chain data; keep `_raw`.
2. Bump `NORMALIZATION_VERSION` when normalisation changes.
3. Never store what is computable; run the reconciler before build.
4. Atlas is a check; what you absorb becomes your own reviewed fact.
5. Every shared JSON write goes through the atomic writer.
6. Media is an edition fact. Badges are play facts, except rewards and
   commentary.
7. `Number()` every id from FCL.

---

## 11. Known gaps

Honest list, as of 2026-09-10:

- Parallel media is on chain and not shown (the app queries subedition 0
  only).
- The resolver's `gateway` field is read and ignored; the gateway URL is
  hard-coded.
- A broken bucket thumb falls back to a glyph, not to the gateway
  original (the pipeline doc says otherwise).
- No HTTP 429 handling anywhere; mitigation is caching, concurrency caps
  and retries with linear backoff.
- A canonical player registry (one record per player for bio facts) is
  the biggest lever left in the data layer and does not exist yet.
- The audio-track bitrate distribution suggests three tiers (silent,
  ambient, full commentary) but nothing in the repo names or uses them.
