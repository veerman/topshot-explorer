# Data Corrections Playbook

Written 2026-08-30. A forensic analysis of every manual fix in `data/overrides/plays.json`
(534 entries, 576 field changes), `data/additions/plays.json`, and `data/plays_exclude.json`
(73 mismints), replayed against the raw on-chain values, with a sample externally verified.
The goal: state the rules the existing corrections follow so future corrections
(human or AI agent) follow the same logic.

## Ground truth philosophy

On-chain metadata is the source of record but is riddled with errors; it is never edited,
only layered over. The corrected value should be what an authoritative basketball
reference (NBA.com / WNBA.com rosters, Basketball-Reference, team media guides) says,
rendered in this project's house format. Overrides fix wrong facts; additions add facts
that never existed on-chain; exclusions remove mismints from stats.

**Lean-files principle**: anything computable downstream does not belong in
overrides or additions. If a stored value equals what a later step derives
(a Championship Year tag derivable from teams.json, a format a normalizer
produces), delete the stored copy. Keep only data that carries information the
pipeline cannot compute; a stored value that DISAGREES with the derivation is
such information (a correction marker), so it stays until the disagreement is
resolved.

## Source verification protocol (adopted 2026-08-30)

Before changing any factual value, or aligning a player's plays for consistency:

1. **Require agreement between at least two independent references**, preferring
   Wikipedia's infobox and Basketball-Reference. NBA.com / WNBA.com official bios
   count when reachable.
2. **Treat ESPN bios as a tiebreaker at most.** They routinely substitute hometown
   for birthplace (observed twice in one session: Horston, Kornet).
3. **Distrust any birthplace that equals the player's high school or hometown city.**
   That substitution is the number one error, on-chain AND in references.
4. **When solid sources split, do not fix.** Record the finding as ambiguous with
   links and decide later (Michael Porter Jr. is the standing example).
5. **Cite the winning sources** alongside the applied fix.

## Fix mechanics

- **Surgical**: if the raw on-chain value is already correct, REMOVE the override
  rather than rewriting it. Overrides exist only where raw is wrong.
- **Search for the wrong value everywhere before fixing it**, in raw data and in the
  overrides themselves: the Rivers "New Orlean" typo originated on-chain (play 3175)
  and had been copied into four overrides.
- **Fix all of a player's plays in one pass**, anchored on the verified fact.
  Consistency-alignment without verification propagates errors: the Kornet
  overrides aligned six older plays to the newer mints' (wrong) hometown value.
- **When one bio field is wrong, audit the whole record** (the wrong-person bio
  class: Jaylen Brown's bio under Marcus Smart, Justin Holiday's under Aaron
  Holiday).

## Observed on-chain error classes (what Top Shot actually gets wrong)

1. **Hometown instead of birthplace** (very common): Tyler Herro "Greenfield" (raised)
   vs Milwaukee (born); Zion "Spartanburg" vs Salisbury, NC; Marcus Smart "Marietta"
   vs Flower Mound, TX; Candace Parker "Naperville" vs St. Louis.
2. **Modern franchise name backfilled onto historical drafts**: "Oklahoma City Thunder"
   for players drafted by Seattle, "New Orleans Pelicans" for Hornets-era picks,
   "Brooklyn" for New Jersey, "Las Vegas Aces" for San Antonio Stars picks.
3. **Wrong person's bio attached wholesale**: play 221 carried Jaylen Brown's entire bio
   under Marcus Smart's name; play 1139 carried Justin Holiday's bio under Aaron
   Holiday. When ONE bio field is wrong, audit every bio field on that play.
4. **Typos and encoding damage in proper nouns**: "Ljublijan,,", "Doula,,", "Wurzburg,,",
   "Chiacgo", "Elmhurt", "Suwnaee", "Kinshasha", double commas from a blank state slot.
5. **Off-by-a-bit dates**: one day off (timezone artifacts: Ty Jerome, Johnny Furphy,
   Jase Richardson), month or year typos (Zach Edey 03->05, Jaden Hardy 2003->2002).
6. **Garbage in enum-ish fields**: NbaSeason "2024025", "2007-8", "1997-1998";
   empty or "N/A" draft fields; missing TeamAtMomentNBAID on special-event plays.
7. **Format drift between mint batches**: newer mints (play IDs ~8700+) spell out
   states ("Akron, Ohio") where older mints used "Akron, OH, USA". Expect every new
   drop to reintroduce class 1, 2, and 7.

## The rulebook, field by field

Fields marked DETERMINISTIC can be fixed by rule without research. Fields marked
FACTUAL require a lookup against a basketball reference.

### FullName (92 overrides)
- **Canonical name = how the player is professionally listed and known**, preferring
  the roster/common name over the legal-formal one: "Steph Curry" (not Stephen),
  "Bub Carrington", "Nic Claxton", "Alex Sarr", "Rob Dillingham", "Jimmy Butler"
  (drops III), "OG Anunoby" (no periods), "DeMar DeRozan" (casing).
  "Steph Curry" is a standing decision (confirmed 2026-08-30): new mints arriving as
  "Stephen Curry" get overridden to "Steph Curry". If the canonical pick ever changes,
  it changes everywhere at once.
- Keep suffixes that are part of the listing: "Lonnie Walker IV", "GG Jackson II",
  "Kevin Knox II", "Marcus Morris Sr.", "Ronald Holland II".
- **Restore diacritics** to the official spelling: Dončić, Şengün, Ginóbili, Schröder,
  Vučević, Johannès, Fágbénlé. (FACTUAL once per player, then DETERMINISTIC.)
- **One canonical name per person, latest known**, applied to ALL their plays:
  "Skylar Diggins" (reverted post-2024), "Betnijah Laney-Hamilton" (married name).
- **One override is enough (DETERMINISTIC since 2026-08-31)**: the raw spelling an
  override replaces becomes an alias for the canonical name (`buildNameAliases`),
  applied at compile time to every play carrying that spelling, future mints
  included. A new "Stephen Curry" mint needs no new override. A play's own
  override still wins; a spelling corrected to two different names is ignored
  as ambiguous. So for a name finding: pick the spelling once, on one play.

### Birthplace (150 overrides)
- **The literal city of birth**, never hometown, high school city, or where raised. (FACTUAL)
- House format (DETERMINISTIC):
  - US: `City, ST, USA` with the 2-letter state code.
  - Canada: `City, ON, CAN` (province kept).
  - Everywhere else: `City, CCC` with ISO 3166-1 **alpha-3** country code
    (DOM, SVN, CMR, JAM, NGA, DEU, BEL, COD, LTU...). Not IOC codes (NGR), not
    alpha-2 (CA, DO, CG).
  - **Enforced by a normalizer since 2026-08-31** (`src/services/birthplace.normalizer.js`,
    run inside normalizeBirthplace at compile time): state and province names or
    legacy abbreviations become codes, country names and IOC/alpha-2 codes become
    alpha-3, "US" becomes "USA". Unknown tokens pass through untouched, so format
    drift never needs an override again; only facts do (wrong city, COD vs COG).
  - Official city casing/spelling: "Havre de Grace", "The Bronx", "St. Louis"
    (spaced), "Upper Marlboro", "New Orleans".
- **Per-player consistency beats global uniformity**: all 10 Kyle Anderson plays say
  "New York City, NY, USA", so the odd one out was aligned to those, even though other
  players use "New York, NY, USA".

### Birthdate (19 overrides)
- FACTUAL lookup. Watch for the wrong-person class (see error class 3) and
  off-by-one-day timezone artifacts. Format `YYYY-MM-DD`.

### Draft fields (254 DraftTeam + 21 DraftYear + round/selection)
- **DraftTeam = the franchise that made the selection, under its name at the time.**
  Two sub-rules, both consistently applied:
  - Era-accurate franchise name: Seattle SuperSonics (through 2007), New Orleans
    Hornets (2002-2013 drafts), Charlotte Bobcats (2004-2013) vs Charlotte Hornets
    (2014+ and pre-2002), New Jersey Nets (through 2012), Vancouver Grizzlies
    (through 2000), San Antonio Stars / Silver Stars / Utah Starzz eras, Los Angeles
    Sparks for Lisa Leslie (1997), Chicago Sky for Shey Peddy (2012).
  - Draft-night trades: credit the team that made the pick, not where the player
    ended up: Biyombo -> Kings, Bertāns -> Pacers, Brandon Roy -> Timberwolves,
    Isaiah Stewart -> Trail Blazers, R.J. Hampton -> Bucks, Ziaire Williams ->
    Pelicans, Trey Murphy III -> Grizzlies, Santi Aldama -> Jazz, Şengün -> Thunder.
- Canonical spellings: "Seattle SuperSonics" (capital S), "Portland Trail Blazers"
  (two words), "Detroit Pistons".
- These are FACTUAL once per player, and the era-name half becomes DETERMINISTIC if
  franchise-name date ranges are added to `data/additions/teams.json`.
- **DraftYear for undrafted players: OPEN POLICY QUESTION.** The overrides are split:
  most use the player's draft-class year (Caruso 2016, Kleber 2014, Theis 2013,
  Tate 2018, O'Neale 2015, Landale 2018, Waters 2020), but some use the debut/rookie
  season instead (Duop Reath 2023, Julie Vanloo 2024, Sevgi Uzun 2024). This choice
  drives the Rookie Year tag logic (DraftYear == season start year) and, since
  2026-08-31, the Rookie Mint logic (DraftYear == the season the play was MINTED
  in, per the mint clock; see buildMintClock in overrides.service.js), which is
  probably why the debut-year variant exists. Pick one and document it.

### NbaSeason (14 overrides)
- DETERMINISTIC: NBA format `YYYY-YY` ("2007-08"); WNBA format single year ("2024").
- When raw is garbage ("2024025"), derive from DateOfMoment (verified: play 7680's
  game date 2025-12-16 confirms "2025-26").

### TeamAtMomentNBAID (5 overrides)
- Must be the franchise ID of the team the player represented in that moment.
  All-Star / special-event sides get their own IDs (e.g. 1610616852, 1610616860)
  matching the special entries in `data/additions/teams.json`. Watch for upstream
  ID mixups (plays 8620/8920: San Antonio Stars plays stamped with the Fever's ID).

### Game facts (1 play)
- Special-event plays may need HomeTeamName/score fixes (play 6364: OGs vs Rising
  Stars, 42-35). FACTUAL, rare.

### Additions (`data/additions/plays.json`)
- `playID_dapper` and `tags` both come from the external Dapper API import; they
  are source data, not our assertions. Do not hand-edit them as if they were ours.
- **Computable tags are derived, and the derivation is authoritative (2026-08-30)**:
  Top Shot Debut (lowest play ID per player, plus same-game siblings),
  Rookie Year (DraftYear == season start), Rookie Mint (mint clock date falls
  in the draft season), Championship Year (team + season in teams.json
  championships; not for a cross-league cameo, a WNBA player at the NBA
  All-Star weekend, since that moment sits outside her own league's season:
  #4888 Ionescu, matches Dapper), and Cup Year (team +
  season in teams.json cups: NBA Cup and Commissioner's Cup winners; ours
  alone, no Dapper counterpart) are computed by `getCalculatedPlayTags`.
  Dapper's reward badges (Challenge Reward, Crafting Challenge Reward,
  Leaderboard Reward) are EDITION facts: stored as `tags` on
  data/additions/editions.json by `npm run atlas:editions -- --apply`
  (Atlas owns that vocabulary) and merged into a moment's badges by the
  pages (`editionTags`); they never enter the play tags.
  Stored Dapper copies of the computables are excluded from display: a wrong Dapper tag never renders, a Dapper omission
  costs nothing, and nothing needs approving. Stored vs derived is reconciled
  under the lean-files principle:
  - AGREEMENT: the stored copy is redundant and is stripped automatically by
    `npm run reconcile` (`scripts/reconcile-tags.mjs`, also the prebuild step).
    Hard rule, no approval, never a finding. The Dapper import re-pushes these
    tags, so run reconcile after every import (or just build).
  - DISAGREEMENT: surfaces on the Corrections page; either side could be wrong.
    Check ours first (missing season, wrong DraftYear or team ID, championship
    absent from teams.json; teams.json can also simply be missing the latest
    title). Fixing our data turns it into an agreement (the reconciler
    then strips it); concluding Dapper is wrong makes removal the fix. Per
    group, never bulk.
- Non-computable Dapper tags display from storage as external context:
  Rookie Premiere (354), MVP Year (92), Rookie of the Year (41),
  Conference Finals (7).
- **Negative tag semantics (2026-08-31)**: a `tags_suppress` array on a play's
  additions entry removes a derived tag the rules wrongly produce for that
  one play (e.g. `"tags_suppress": ["Top Shot Debut"]`). It is the per-play
  exception valve; a pattern of suppressions means the rule itself is wrong
  and should be fixed instead. No entries exist yet.
- teams.json `championships` arrays are the sole source of truth for
  Championship Year, and the `cups` arrays for Cup Year (in-season cup
  winners: NBA Cup, WNBA Commissioner's Cup; a season can carry both,
  e.g. Knicks 2025-26); keep them verified.
- seasons.json (data/additions/seasons.json, added 2026-08-31) is the sole
  source of truth for season calendars: per league and season, the real
  date windows (preseason, regular, allstar, playin, playoffs,
  commissioners_cup, suspended), researched from Wikipedia season articles,
  plus the NBA Cup as `cup: { group_nights, knockout }` (2023-24 onward):
  group play happens on exclusive Cup Nights, so those dates alone decide;
  the seven bracket games are listed with date, round and both clubs, and
  a moment matches only when its date AND both teams do. `momentContext(play)`
  classifies a moment against it ("NBA Cup" carries the round in `detail`),
  and the "Season Calendar Mismatches" Corrections section flags dated moments
  outside every window of their own season (date wrong, season wrong, or
  calendar entry incomplete; verify by hand). New seasons need a new entry
  here, including the Cup Nights and bracket once the league announces them.
  Summer Leagues ("2021 Summer League") stay their own calendar entries but
  are FILED under the season they precede (2021-22) by `parentSeason`.
- additions/plays.json may also carry `NbaSeason` and `DateOfMoment` for
  plays whose on-chain metadata lacks them (team reels, mostly), sourced
  from the Atlas API's editionTemplate.metadata (2026-08-31: 185 seasons,
  19 dates). Atlas is a source, not an oracle: every imported season must
  agree with the play's game date (`seasonStartYearForDate`), WNBA seasons
  are stored as single years, and Atlas oddities get corrected on the way
  in (#2920 "2010-12" -> 2011-12). Dates are stored in the on-chain string
  format ("YYYY-MM-DD HH:MM:SS +0000 UTC") so they parse identically.

### Sets / series overrides
- Naming only (3 set names, 8 series names). No metadata corrections.

### Tiers (off-chain, additions only)
- Tier is not on-chain. Rule: when every edition in a
  set carries one tier, the tier lives at the SET level
  (`data/additions/sets.json` `tier`); when a set mixes tiers (the
  Anthology sets, The Champion's Path 2024, 2024 WNBA Playoffs, Fresh
  Threads, NBA Cup) the tier lives on each EDITION
  (`data/additions/editions.json`, key `setID_playID`, `tier`). Readers
  check the edition first, then the set. Source: Atlas edition `tier`
  (harvest scratchpad harvest-atlas-tiers.js); Genesis and Platinum Ice are
  Ultimate by the record (1/1 and 3-of sets that were never sold; Atlas does
  not list them). Values are Title case: Common, Fandom, Rare, Legendary,
  Ultimate. The Sets page shows the whole-set tier, "Mixed" when the
  editions differ (`getSetTier` in src/services/set.status.js); "Anthology"
  was the older label for exactly that case and is retired.

### Set status flags (`data/additions/sets.json`)
- `burned: "YYYY-MM-DD"`: Top Shot destroyed every moment in the set on
  that date. The contract never decrements numMinted, so the chain still
  reports the original counts; the app strikes them through and leaves them
  out of every total (home cards and matrices, series IPFS baselines). The
  set and its media stay viewable. Platinum Ice (sets 3, 27, 42, 52; three
  per play, never sold): 7,962 moments burned 2023-01-11 per Dapper's post
  (blog.nbatopshot.com/posts/burning-platinum-ice-moments), matching the
  on-chain 2,654 editions x 3 exactly. Genesis (set 1, 150 one-of-ones) was
  NOT burned and stays counted: it may be released one day.
- `mismint: true`: an empty duplicate set the contract created by mistake
  (155, 156, 158: Series 6 Run It Back twins with zero plays). Hidden from
  the Sets page and the set count; reachable by URL with a banner.
- These are facts about a SET, so they live here and not in
  plays_exclude.json: Platinum Ice reuses the same play IDs as Base Set and
  friends, and a play-level exclusion would erase the real moments.
- Helpers: `src/services/set.status.js` (getSetStatus, isBurnedSet,
  isMismintSet, getSetTier).

### Atlas answer sheet (scripts, 2026-09-01)
- `npm run atlas:harvest` snapshots every Atlas edition (one per set, play
  and parallel) into `data/atlas/editions.json`: play GUID, set, tier,
  parallel name, badges, mint counts, and the play facts worth
  cross-checking. Headless Chrome on nbatopshot.com, no login.
- `npm run atlas:parallels` derives `data/sets_parallels.json` from it. The
  chain cannot: per-subedition mint counts live on the SubeditionAdmin
  resource in Dapper's storage, which scripts cannot read. Atlas's
  `parallel` name joins `TopShot.getAllSubeditions()` for the id; Atlas sets
  join Flow sets through play GUIDs (or a numeric `setID_dapper`). Dry run
  by default; `--apply` writes, `--prune` drops parallels Atlas no longer
  lists.
- `npm run atlas:tags` compares Atlas badges with our derived tags (TSD, RY,
  CY, RM) and stored tags (Rookie Premiere, MVP Year, ...), plus NbaSeason
  and moment dates. `--import` copies Atlas badges into additions `tags`;
  run `npm run reconcile` after, so agreeing copies are stripped and only
  disagreements reach the Corrections page. Plays without a `playID_dapper` link
  are listed as unjoined, not guessed.

## Out-of-bounds repairs (2026-08-31)

37 of the 39 out-of-bounds findings were repaired with overrides after
multi-source verification (Wikipedia + a second source per fact; deterministic
values computed from verified career facts). The old validator had auto-blanked
these instead of correcting them, which is why they looked "already fixed".

- **Column swaps**: Bird #5306 Height/Weight 220/81 -> 81/220 and Wilkins
  #9027 230/80 -> 80/230 (every sibling play agrees; Wikipedia confirms
  6'9"/220 and 6'8"/230).
- **Mangled years**: Robertson #7533/#7535 Birthdate 2038 -> 1938-11-24;
  Reeves #5473 2024 -> 1973-06-08; Coleman #7026 DraftYear 1900 -> 1990
  (No. 1 pick, Nets; round/pick fields already said 1/1).
- **Starks #7373**: DraftSelection "1988" is his undrafted draft-class year in
  the pick column; blanked (his other play correctly has N/A).
- **Negative TotalYearsExperience (24 plays)**: garbage on legends/flashback
  mints. Overridden with experience at the moment, computed from verified
  rookie seasons (redshirts checked: Embiid debut 2016-17 -> 0, Chelsea Gray
  drafted 2014 debut 2015 -> 0; WNBA rookies all 0).
- **Truncated scores**: LeBron #6366 -> 136-115 (Lakers-Pelicans 2025-03-05,
  ESPN/AP); Tatum #8052 -> 120-100 (Celtics-Mavs 2026-03-06, ESPN/StatMuse).
- **NOT errors**: the 2025 All-Star mini-tournament plays (#6355/56/61) have
  target-score finals (first to 40), so tiny scores are real; the bounds
  detector now skips score checks on ⭐ entities. Still open: #6362 (Trae
  Young) and #6363 (Jaylen Brown), the same event but stamped with franchise
  team names, no DateOfMoment, and a missing away-team name; incomplete
  upstream data needing a judgment on how to represent mini-tournament games.

## Verification results (2026-08-30)

Internal consistency across all 576 changes plus external spot-checks. Overall
quality is high: roughly 1% of changed values are questionable. Nothing was changed;
these are findings only.

**Verified correct (sample)**: Jase Richardson (born 2005-10-16, Berkeley, CA),
Hal Greer (1936-06-26), Ty Jerome (1997-07-08), Ibaka drafted by Seattle, Brunson
NbaSeason 2025-26, Kyle Anderson NYC consistency, the Jaylen Brown / Justin Holiday
wrong-bio repairs, and the era-name DraftTeam system throughout.
Also **Jordan Horston "Dallas, TX, USA": correct** (initially flagged here, then
retracted 2026-08-30). Wikipedia's infobox, Basketball-Reference, and draft coverage
say born Dallas, raised Columbus; ESPN's bio lists "Columbus, OH", which is the
hometown-as-birthplace substitution (error class 1) on ESPN's side. The new play
9006 carrying Columbus is the on-chain error. Lesson: even reference sites commit
error class 1; prefer Wikipedia infobox + Basketball-Reference agreement over a
single league/media bio, and treat "birthplace equals high school city" claims
with suspicion.

**Flagged as likely errors (4), all confirmed and FIXED 2026-08-30:**
1. **Austin Rivers: DraftTeam "New Orlean Hornets"** (missing the s). The typo turned
   out to originate ON-CHAIN: play 3175's raw value carries it, and the 4 override
   values were copied from it. Fixed the 4 overrides and added an override for 3175.
2. **Dalen Terry: overridden to "Tempe, AZ, USA"; born in Phoenix, AZ** (Wikipedia,
   ESPN, Basketball-Reference agree; his first high school, Corona del Sol, is in
   Tempe). Removed the 3 Tempe overrides (raw Phoenix was correct) and added a
   Phoenix override for play 4043, whose raw value is Tempe.
3. **Luke Kornet: overridden to "Lantana, TX, USA" (hometown); born Lexington, KY**
   (Wikipedia, Wikidata, Basketball-Reference agree; ESPN alone says Lantana, its
   usual hometown substitution). Removed the 6 Lantana overrides (raw Lexington was
   correct) and added Lexington overrides for plays 7870/8226/8612/8817, whose raw
   values are Lantana. Instructive failure: Top Shot's newer Kornet mints switched
   to Lantana, and aligning older plays to them achieved per-player consistency
   anchored on the wrong fact. Verify the fact BEFORE aligning for consistency.
4. **Serge Ibaka: "Brazzaville, COD" -> "Brazzaville, COG"** (Brazzaville is Republic
   of the Congo; COD is DR Congo). Fixed play 4220's override and added Birthplace
   to his 6 other override entries, whose raw values say COD.

All four were applied per the Fix mechanics rules above (overrides removed where raw
was correct: 534 entries became 531) and verified in the recompiled database.

**Ambiguous (1):** Michael Porter Jr. birthplace: most references say Columbia, MO
(as overridden); Wikipedia's infobox says Indianapolis, IN. Needs a primary-source call.

**Policy inconsistency (1):** undrafted DraftYear (see rulebook above); Duop Reath
2023 vs Landale/Caruso/Kleber draft-class style.

**Detector blind spot (CLOSED 2026-08-30):** the name audit originally caught only
accent/case drift, so the 3 new-mint "Stephen Curry" plays coexisted invisibly with
the canonical "Steph Curry" (75 plays), and worse, play 8723 earned a FALSE computed
TSD (the split name looked like a new player's debut). The audit now also clusters
by birthdate + last name with a first-name prefix guard (twins would otherwise
false-positive), and tag findings are blocked from bulk actions while their player
has an open name finding. The general lesson stands: tags are derived data; fix
names and bios first, tags last.

## Recommendations for automating this

1. **Make era-names deterministic**: add year ranges to `historical_names` in
   `data/additions/teams.json` so "franchise name at draft year X" is computable.
2. **Make birthplace format deterministic**: state-abbreviation plus ISO alpha-3
   tables would auto-catch "CA"->"CAN", "DO"->"DOM", "NGR"->"NGA", "FLA"->"FL",
   "Akron, Ohio"->"Akron, OH, USA". (It cannot catch COD vs COG; that is knowledge.)
3. **Canonical-name registry**: one record per player (canonical FullName, birthdate,
   birthplace, draft facts) instead of per-play overrides. Most of the 576 changes
   are the same fact repeated across a player's plays; a registry would collapse them
   and end the whack-a-mole with new mints. The per-play override layer would remain
   for genuinely per-play facts (TeamAtMomentNBAID, game scores, seasons).
4. **Wrong-bio tripwire**: when any bio field on a play disagrees with the player's
   other plays, flag the whole record, not the single field (error class 3).
5. **Agent loop for the factual residue**: with 1-4 in place, what is left per mint
   drop is a handful of lookups (new players' bios, name spellings), which is the
   slice suited to an AI agent run with sources cited, reviewed via the Applied
   Corrections ledger.

## Sources for the flagged items

- Jordan Horston: https://www.espn.com/wnba/player/bio/_/id/4432830/jordan-horston , https://en.wikipedia.org/wiki/Jordan_Horston
- Dalen Terry: https://en.wikipedia.org/wiki/Dalen_Terry , https://www.basketball-reference.com/players/t/terryda01.html
- Luke Kornet: https://en.wikipedia.org/wiki/Luke_Kornet , https://www.sportskeeda.com/basketball/luke-kornet-nationality
- Michael Porter Jr.: https://en.wikipedia.org/wiki/Michael_Porter_Jr. , https://www.espn.com/nba/player/bio/_/id/4278104/michael-porter-jr
- Serge Ibaka: https://en.wikipedia.org/wiki/Serge_Ibaka , https://www.olympedia.org/athletes/125049
- Jase Richardson: https://en.wikipedia.org/wiki/Jase_Richardson
- Hal Greer: https://wvpublic.org/june-26-1936-nba-hall-of-famer-hal-greer-born-in-huntington/
- Ty Jerome: https://www.basketball-reference.com/players/j/jeromty01.html
