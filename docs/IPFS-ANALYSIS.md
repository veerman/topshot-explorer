# IPFS Media Field Analysis

Research snapshot: 2026-08-28. Data pulled live from Flow mainnet (rest-mainnet.onflow.org) via `getSetsOverview()` + `getSetDetails()` per set, reading the `TopShotIPFSResolver` contract (`0x0b2a3299cc857e29`).

## In one page (read this first)

Everything below this section is the supporting evidence; this is the shape of it.

**What each slot actually is** (measured across all 59,481 assets; Dapper publishes no spec):

| Slot | Our UI label | What the data says it is | Consistent? |
|---|---|---|---|
| VIDEO | Video | The moment master: 1080x1920 portrait, h264, 30fps, median 35s | Yes. One resolution across 12,205 files |
| VIDEO_SQUARE | Video Square | The social crop: 1080x1080, a shorter cut (median 21s) | Yes. One resolution |
| HERO | Hero | The square art card: 2880x2880 (98%), 71% PNG | Yes |
| PLAYER | Player | The player cutout: 2880x2880 is the mode (54%) but 1,656 distinct sizes exist; 88% JPEG | Mostly |
| VIDEO_TALL | Video LQ | Two different things under one key: 63% a SECOND full-res master (the highest bitrates in the system), 37% a 540x960 preview; both in every series | No |
| VIDEO_VERTICAL | Video HQ | A higher-bitrate copy of the master (~2.3x); S0-S4 only, then discontinued | Within its era |
| IMAGE_PLAYER | Player HQ | The un-normalized source cutout: 1,449 sizes in 1,937 files; S0-S4 only | No |

**Their de facto minimum standard** (never stated anywhere, but unmistakable in the data): **two images + two videos** (HERO, PLAYER, VIDEO, VIDEO_SQUARE). Whenever an edition has any media at all, it has those four 95%+ of the time. Everything else is best-effort.

**The three numbers that matter:**

1. **1 in 4 editions has NO media registered at all** (73.9% coverage and falling). This dwarfs every per-field gap.
2. **WNBA coverage is 35% vs NBA's 80%**; every Series 8 WNBA set shipped unregistered while the S8 NBA sets are registered.
3. **218 registered CIDs are dead at the gateway**, unnoticed since the Series 1 era.

**Is it "a directory they uploaded once, with no QC"?** Half true. The video pipeline is real: one resolution, one codec, one framerate across 26,000+ core video files does not happen by accident. The image side and VIDEO_TALL show no pipeline at all (arbitrary sizes, two roles under one key). And nothing anywhere shows verification: dead CIDs sat for years, new sets ship with nothing. Best summary: **automated production, zero monitoring.**

**What the app does with this** (implemented 2026-09-01): the Sets page IPFS % scores the core four only ("share of the standard four media files present"), dead CIDs count as missing, and every other field is an EXTRA: never expected, shown as a muted "+N" beside the percentage (breakdown in the tooltip) and as "+" chips on the set page. Era-gating the extras was dropped: VIDEO_TALL's split identity means no series can honestly "expect" it.

**Questions for the Flow/Dapper conversation, in order:**

1. **Definitions.** What do the seven resolver slots mean to you, exactly? Here is what we measured them to be (table above). Is there a written spec?
2. **Standard.** Is the core four (two images, two videos) the intended minimum per edition? What does "complete" mean internally?
3. **Coverage.** 1 in 4 editions has nothing registered. Is resolver registration part of the release pipeline or a separate manual step? And why does it skip WNBA (35% vs 80%)?
4. **VIDEO_TALL.** Which of its two personalities is the spec: full-res second master, or 540x960 preview? Was the preview rendition abandoned?
5. **QC.** 218 registered CIDs resolve to nothing (we have the list). Does anything monitor resolvability? Re-pin them or deregister them?
6. **Deprecations.** IMAGE_PLAYER and VIDEO_VERTICAL stop after S4. Formally deprecated, or lost in a pipeline change?
7. **Parallels.** Sets 256-265 (plus 152, 213, 214, 217) inherit standard media while 3,590 parallel slots elsewhere have their own art. Unfinished backfill or policy?

## Scope and methodology

- 269 sets queried; 1 set failed all retries (set 52, Platinum Ice) and is excluded.
- 10,280 editions analyzed after excluding mismints (`data/plays_exclude.json`).
- An edition "has" a field when the resolver returns a non-empty CID for it.
- Percentages of field presence use editions-with-at-least-one-CID as the denominator unless stated otherwise.

## Headline findings

- **11.5% of all editions (1,183) have ZERO IPFS media registered.** This is the largest gap category by far.
- **24 entire sets have no IPFS data for any edition** (245 of 269 sets have at least some data).
- Four fields are effectively universal; two fields are era-bound and stop existing after series 4.

## Global field frequency

9,097 editions have at least one CID (88.5% of all editions).

| Field | Count | % of editions w/ CIDs | % of all editions | Sets absent entirely |
|---|---|---|---|---|
| VIDEO_SQUARE | 8,878 | 97.6% | 86.4% | 0 |
| PLAYER | 8,740 | 96.1% | 85.0% | 1 |
| HERO | 8,664 | 95.2% | 84.3% | 0 |
| VIDEO | 8,656 | 95.2% | 84.2% | 0 |
| VIDEO_TALL (Video LQ) | 6,966 | 76.6% | 67.8% | 6 |
| VIDEO_VERTICAL (Video HQ) | 2,163 | 23.8% | 21.0% | 183 |
| IMAGE_PLAYER (Player HQ) | 1,937 | 21.3% | 18.8% | 189 |

## Per-series frequency

Percentages are of that series' editions-with-CIDs. Contract series numbers; note that no set on-chain reports series 1.

| Series | Editions | w/ CIDs | HERO | IMAGE_PLAYER | PLAYER | VIDEO | VIDEO_SQUARE | VIDEO_TALL | VIDEO_VERTICAL |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 1,373 | 1,316 | 78.6% | 27.0% | 80.7% | 79.6% | 95.6% | 46.4% | 32.6% |
| 2 | 1,105 | 1,105 | 100.0% | 80.1% | 100.0% | 100.0% | 100.0% | 67.4% | 93.9% |
| 3 | 482 | 357 | 61.6% | 67.2% | 81.2% | 61.6% | 60.8% | 66.4% | 67.2% |
| 4 | 930 | 930 | 100.0% | 49.1% | 100.0% | 100.0% | 100.0% | 38.4% | 49.0% |
| 5 | 1,648 | 1,435 | 99.9% | 0.0% | 99.1% | 99.7% | 99.7% | 92.3% | 0.0% |
| 6 | 1,411 | 1,200 | 98.9% | 0.0% | 98.3% | 97.7% | 98.8% | 90.0% | 0.0% |
| 7 | 1,678 | 1,374 | 100.0% | 0.0% | 100.0% | 100.0% | 100.0% | 91.8% | 0.0% |
| 8 | 1,653 | 1,380 | 100.0% | 0.0% | 99.9% | 99.8% | 99.9% | 97.8% | 0.0% |

Observations:

- **IMAGE_PLAYER and VIDEO_VERTICAL exist only in series 0 through 4 and are exactly 0.0% in series 5 through 8.** Dapper evidently discontinued these formats. Within their era they peak in series 2 (80% / 94%) and sit near half-coverage in series 4 (49% each).
- **VIDEO_TALL exists in every series** but is split: 90 to 98% in series 5 through 8 versus 38 to 67% in the older series.
- **HERO, PLAYER, VIDEO, VIDEO_SQUARE are effectively universal**: flat 100% in series 2, 4, 7 and 99%+ in 5, 6, 8. The real gaps live in series 0 (79 to 96%) and especially series 3, the messiest series in the data (61 to 81%).

## Field combination signatures (top)

| Editions | Share | Series | Combination |
|---|---|---|---|
| 5,527 | 60.8% | all | HERO + PLAYER + VIDEO + VIDEO_SQUARE + VIDEO_TALL |
| 1,049 | 11.5% | all | HERO + PLAYER + VIDEO + VIDEO_SQUARE |
| 982 | 10.8% | 0,2,3,4 | all seven fields |
| 734 | 8.1% | 0,2,3,4 | all seven minus VIDEO_TALL |
| 201 | 2.2% | 0,2,4 | HERO + PLAYER + VIDEO + VIDEO_SQUARE + VIDEO_TALL + VIDEO_VERTICAL |

The long tail (~35 further combinations, each under 1.5%) is mostly series 0 and 3 editions with partial media.

## Per-field set-level completeness

Of the 245 sets with any IPFS data:

| Field | Complete in all editions | Partial | Absent from set |
|---|---|---|---|
| HERO | 200 | 45 | 0 |
| PLAYER | 184 | 60 | 1 |
| VIDEO | 196 | 49 | 0 |
| VIDEO_SQUARE | 196 | 49 | 0 |
| VIDEO_TALL | 73 | 166 | 6 |
| IMAGE_PLAYER | 10 | 46 | 189 |
| VIDEO_VERTICAL | 11 | 51 | 183 |

VIDEO_TALL is the leakiest field by volume: 166 sets have it only partially.

## Recommended grouping

- **Core (always expected; any absence is a reportable gap): HERO, PLAYER, VIDEO, VIDEO_SQUARE.** Present on 95%+ of media-bearing editions, absent from at most 1 of 245 sets.
- **Standard (expected, lower severity): VIDEO_TALL.** Exists in every era; near-complete in modern series, patchy in old ones. A missing LQ video on a series 0 set is less clearly a defect than a missing core field.
- **Extra (era-gated, series 0 through 4 only): IMAGE_PLAYER, VIDEO_VERTICAL.** Expecting them in series 5+ would be pure noise. Within series 0 through 4, coverage near 50% makes them worth flagging as a separate conversation with Dapper ("was this format supposed to be complete?").
- **Editions with zero CIDs are their own category** and the top of the fix list: 1,183 editions where the resolver has nothing at all.

## Implementation note (app coverage metric)

Implemented 2026-09-01 in `src/services/ipfs.analysis.js`: the headline percentage scores the CORE_MEDIA_FIELDS (HERO, PLAYER, VIDEO, VIDEO_SQUARE) only; a CID in `data/ipfs_dead.json` counts as missing; all other fields are extras, surfaced but never expected (a "+N" beside the Sets-page percentage, "+" chips on SetDetail). This replaced the earlier inferred series-peer baseline (a field expected when present on 50%+ of a series' editions), whose knife-edge cases (VIDEO_TALL at 46.4% in S0, the HQ fields at ~49% in S4) made percentages hard to explain. The grouping section above predates this decision and describes VIDEO_TALL as "standard"; the shape analysis later showed it has no single identity, so it ended up an extra.

---

# Parallel (Subedition) Media Analysis

Research snapshot: 2026-08-28, same methodology. The resolver supports per-subedition CIDs (`TopShotIPFSResolver.getCIDs(setID, playID, subeditionID)`); the app's sync only ever queries `subeditionID: 0`, so parallel rows currently always display the standard edition's media regardless of what the chain holds.

## Scope

All 53 parallel sets from `data/sets_parallels.json` (105 set + subedition combos, 4,139 parallel edition slots, mismints excluded). Every slot was classified against the standard (subedition 0) CIDs:

- **none**: resolver returns nothing for the parallel; media is inherited/borrowed from standard.
- **identical**: registered, but the exact same CIDs as standard.
- **distinct**: registered with at least one different CID (its own assets).

## Headline findings

| Classification | Slots | Share |
|---|---|---|
| Distinct parallel media | 3,590 | 86.7% |
| None (inherits standard) | 549 | 13.3% |
| Identical copy of standard | 0 | 0.0% |

- **When a parallel has media registered, it is always genuinely different assets.** There is not a single identical-copy case on chain, so "registered" can be treated as synonymous with "has its own art".
- **Parallels only ever register the four core fields: HERO, PLAYER, VIDEO, VIDEO_SQUARE.** No parallel anywhere registers VIDEO_TALL, VIDEO_VERTICAL, or IMAGE_PLAYER.
- HERO, VIDEO, and VIDEO_SQUARE virtually always differ from standard. PLAYER differs only part of the time (roughly half in older sets); the player cutout image is often shared with standard while the hero art and video treatments carry the parallel skin. Jukebox (sub 20) in particular reuses the standard PLAYER image in most sets.

## Where parallel media is missing (inherits standard entirely)

Whole set + subedition combos with nothing registered:

| Set | Subeditions with no parallel media | Slots |
|---|---|---|
| 152 | Diced | 25 |
| 213 | Voltage | 34 |
| 214 | Livewire | 12 |
| 217 | Championship | 8 |
| 256 | Hexwave, Jukebox | 30 |
| 257 | Blockchain, Hardcourt | 94 |
| 258 | Club Collection | 82 |
| 259 | all six (Blockchain, Hardcourt, Hexwave, Jukebox, Galactic, Omega) | 42 |
| 264 | Hexwave, Jukebox | 30 |
| 265 | Galactic, Omega | 10 |

Partial gaps: set 124 Explosion (180 of 270 slots missing), set 138 Astra (1 of 10), set 218 Club Collection (1 of 390).

Note the cluster at sets 256 through 265: the newest parallel sets are mostly unregistered while 261, 262, 263 in the same range are fully registered, so this looks like an unfinished backfill rather than a policy change. Together with the older stragglers (152, 213, 214, 217) this is a clean, actionable list for Dapper.

## Implications for the app

1. The sync never fetches parallel CIDs, so the ~3,590 distinct parallel assets that exist on chain are currently invisible in the explorer. Fetching `getCIDs` per (setID, playID, subeditionID) for the 53 parallel sets and storing records keyed `setID_playID_subID` would surface them.
2. Proposed flag/score: on SetDetail parallel rows, badge each subedition edition as "own media" vs "inherits standard" (with zero identical-copies on chain, registered = own). At the set level, a parallel media coverage percentage: distinct slots / total parallel slots.

---

# Per-league coverage

Research snapshot: 2026-09-01, from the app's IndexedDB after the fabricated-CID self-heal (9,162 real records, 275 sets; mismint editions excluded). Note: until 2026-09-01 the app's ipfs store held only prototype placeholder CIDs; every number in this document was researched live against the chain and was never affected.

| League | Editions | With any CID | Coverage |
|---|---|---|---|
| NBA | 10,523 | 8,462 | 80.4% |
| WNBA | 1,790 | 634 | 35.4% |

- **26 sets have zero IPFS data; 21 of them are pure WNBA sets** (the other 5 are the burned Platinum Ice pair and three mixed WNBA-flavoured sets). They span S5 through S8, so this is not recency: series 8 NBA sets are registered (S8 overall sits at 83% with-CIDs) while the S8 WNBA sets (Base Set, Rookie Debut, Metallic Gold LE, Holo Icon, ...) have nothing.
- Inside partially-covered sets, 782 further editions have zero media: 678 WNBA vs 104 NBA.
- When a WNBA edition IS registered, its field profile matches the NBA one (core four at 92-94%, VIDEO_TALL 79%), so the gap is registration, not format policy.
- Overall coverage fell from 88.5% (2026-08-28 snapshot) to 73.9% because the new S8 WNBA sets all launched unregistered.

---

# Asset shapes per field

Source: the full ipfs-probe dataset (`scratch/ipfs-probe/results.jsonl`, local working data: 59,481 unique CIDs, ffprobe-level detail, parallel media included; distilled into `data/ipfs_media.json` on 2026-09-01). An earlier draft of this section was based on ~85 gateway samples; these are the full-population numbers, which corrected two of its claims (marked below).

| Field | UI label today | Measured (whole population) | Verdict on the label |
|---|---|---|---|
| HERO | Hero | 98% are 2880x2880; 71% PNG, 29% JPEG | Accurate |
| PLAYER | Player | Mode 2880x2880 (54%), then 1200/2048/2000...; 1,656 distinct sizes; 88% JPEG | Mostly consistent with a long tail |
| IMAGE_PLAYER | Player HQ | 1,449 distinct sizes across 1,937 assets: pure scatter, no spec | **Wrong.** It is the un-normalized source cutout, not an HQ version |
| VIDEO | Video | Always 1080x1920; median 35s, median 5,618 kbps | Accurate (note: the "plain" video IS tall/vertical) |
| VIDEO_SQUARE | Video Square | Always 1080x1080; median 21s, median 3,693 kbps | Accurate |
| VIDEO_TALL | Video LQ | **A mix in every series**: 63% are full 1080x1920 at median 12,851 kbps (the highest-bitrate assets in the system), 37% are the 540x960 preview; the split trends full-res over time (S8: 93% full) but both variants exist from S0 onward | Wrong for the majority. (Corrects the sampled draft's "role changed at S6": there is no clean boundary) |
| VIDEO_VERTICAL | Video HQ | 1080x1920 at median 13,024 kbps, ~2.3x VIDEO; S0-S4 only | Defensible ("higher-bitrate encode") |

The "LQ"/"HQ" names are our own inventions (nothing on chain calls them that); the chain keys are VIDEO_TALL and VIDEO_VERTICAL.

Other findings from the full dataset:

- **61% of videos carry an audio track** (20,403 of 33,567; the rest are silent). Stored per CID in ipfs_media.json (audioKbps, 0 = silent); a natural pre-click indicator.
- Every video is h264 in mp4 at ~30fps; images are JPEG/PNG (plus 6 MPO oddities, a stereo-camera JPEG variant).
- **Dead CID census: 218 registered CIDs serve no media at the gateway** (all NBA, none WNBA). By field: VIDEO_VERTICAL 74, VIDEO_TALL 67, VIDEO_SQUARE 60, VIDEO 16, HERO 1. Concentrated in the oldest sets (set 3 Platinum Ice 62, set 1 Genesis 33, set 2 31, set 5 24) with a few modern stragglers (140, 196, 143, 153, 159, 160, 178, 194). A further 86 CIDs had transient probe failures and are status-unknown.
- The full-res VIDEO_TALL files (often 40MB+) are the biggest assets in the system, a real cost for any player that naively prefers them.

Open questions for the Dapper/Flow conversation (superseded by the sharper list in "In one page" at the top; kept here for the supporting detail):

1. WNBA registration gap: 35.4% coverage vs NBA's 80.4%; 21 whole WNBA sets with zero media, including every S8 WNBA set while S8 NBA sets are registered. Is WNBA registration simply not part of the release pipeline?
2. 1,183+ editions with zero media registered (11.5% at the last full count, worse now), the single biggest gap category.
3. What is VIDEO_TALL supposed to be? 63% of them are a second full-res master (at the highest bitrates in the system) and 37% a 540x960 preview, mixed within every series. Is there a spec, and which variant is intended going forward?
4. IMAGE_PLAYER has no size spec (1,449 distinct sizes). Is it deprecated in favour of PLAYER (it disappears after S4 along with VIDEO_VERTICAL)?
5. Parallel media backfill: sets 256-265 cluster plus stragglers (152, 213, 214, 217) inherit standard media while 3,590 parallel slots elsewhere have their own assets.
6. 218 registered-but-dead CIDs (list above, mostly S1-era video renditions): can these be re-pinned, or should the registrations be removed?

---

# Cross-set media reuse

Research snapshot: 2026-09-01, from the healed store + data/ipfs_media.json (mismints and burned sets excluded).

**Hash-level reuse is exactly zero.** Every one of the 59,481 probed CIDs has one reference (the probe's own ref_count), and the app store's 46,315 CIDs are likewise never shared between editions. IPFS is content-addressed, so this means no two editions anywhere carry byte-identical files: Dapper re-uploads (at minimum re-encodes) per edition, parallels included.

**Play-level reuse exists**: 307 plays appear in 2 or more sets (up to 7). Could a sibling edition's media hypothetically fill gaps?

- **Field-level gaps: mostly yes.** Of 1,081 cells where an edition lacks a field that the same play carries alive elsewhere, 971 have a live sibling donor. Concentrated where expected: VIDEO_TALL (455), IMAGE_PLAYER (186), VIDEO_VERTICAL (184), and by set almost entirely S0 (Base Set 289, Genesis 147, Holo MMXX 62, Lace 'Em Up 58, Metallic Gold LE 50) plus 2023-24 Honors Diced #152 (95, whose whole registration is missing while plain Honors #149 is complete).
- **Dead CIDs: partially.** 45 of the 155 dead CIDs on multi-set plays have a live sibling (VIDEO_SQUARE 20/43, VIDEO_TALL 20/51, VIDEO_VERTICAL 4/57).
- **The big problem: no.** Of the 1,009 zero-media editions (non-mismint, non-burned), only 9 have any sibling with media. The zero-media sets (the 21 WNBA sets above all) hold plays that exist nowhere else, so cross-set fallback cannot touch the largest gap category.

**Same source material, not the same cut**: among 614 cross-set VIDEO pairs of the same play, only 22.6% share a duration (within 0.2s); the rest differ (median 0.7s, max 11s). So sibling media is the same play but usually a different edit with set-specific treatment; a fallback would be an approximation, worth labeling as borrowed if ever shown.
