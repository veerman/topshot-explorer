# Working in this repository

Top Shot Explorer v2: an offline-first, open-source explorer for NBA and
WNBA Top Shot, built with on-chain data and IPFS media alone. Vite,
Preact through react-compat, FCL, IndexedDB, a static build, an optional
Cloudflare edge. Apache 2.0.

Read `docs/FOUNDATION.md` first. It explains every solved problem (how the
chain is read, how corrections are layered, how media is found and served,
how the marketplace and accounts work) with the file that solves each one.
`README.md` has the scripts and the deployment contract. The longer
records are `docs/DATA-CORRECTIONS-PLAYBOOK.md`, `docs/IPFS-ANALYSIS.md`
and `docs/MEDIA-PIPELINE.md`.

## Vocabulary

Play = one highlight. Set = a collection of plays. Edition = a play inside
a set, plus an optional subedition; only editions are minted. Moment = one
minted copy with a serial. Media belongs to editions. Badges are per play,
except reward badges and commentary, which are per edition. Use these
words exactly.

## Hard rules

- Chain data is never edited. Corrections are JSON layers in `data/`; the
  original stays under `_raw`. Bump `NORMALIZATION_VERSION` in
  `src/services/sync.coordinator.js` when normalisation logic changes.
- Never store a value the app can derive (badges, season windows,
  formats). `npm run reconcile` strips them before every build.
- Atlas (Dapper Labs' API) is a check, never a source, for anything the
  chain can answer. The shipped app never calls it. Three facts the chain
  cannot answer come from it as generated files: which parallels a set
  carries (`data/sets_parallels.json`), moments destroyed per edition
  (`data/burns.json`) and which parallels are signed
  (`data/autographs.json`; the chain flags only the play). Never store
  Dapper account ids.
- A count of moments shown anywhere is the remaining supply (minted minus
  burned) through `src/services/supply.service.js`, unless Settings turns
  it off. Serial logic (#1, jersey, last) keeps the mint count: serials
  are positions in the original run.
- Derivable fixes become normalisers or aliases, never repeated
  per-record overrides.
- Every script that writes a shared JSON file uses
  `scripts/lib/json-file.mjs` (atomic write, preserved line endings) and
  runs under `node --import ./scripts/node-json-hook.mjs`.
- Nothing in `src/` may reference a hosting provider. `deploy/` is
  optional and deletable.
- Secrets never enter the repo (the Contentful token used to archive
  commentary stays out).

## Copy and UI conventions

- No em dashes anywhere: code, comments, docs, UI strings, commits.
- "Flow Blockchain" in full in user-facing text. Badges, not tags, in
  the UI.
- Page intros are one or two plain sentences: what the page is for and
  where it leads. No examples, no instructions, no definitions of the
  page's own subject. Detail lives in the Glossary and About pages.
- Keep the product-defining words (Flow Blockchain, IPFS, minted,
  licensed, authentic, open source); simplify mechanics, never pillars.
- A number never appears twice in one view. No reload buttons on pages.
- Never signal state by colour alone, for colour-blind readers: use a
  box, a glyph, a check mark, a text badge.
- No layout shift on load: reserve space for conditional UI; no
  `transition: all`; no `backdrop-filter` on large panels.
- Tables fit their container with native auto layout; never a horizontal
  scrollbar, never JS measurement.
- Never truncate a Flow address or a username; shrink the font instead.
- Emoji used in badges must be in `src/dev/subset-text.txt` or the font
  subset must be regenerated.

## Commands

```
npm run dev              dev server (localhost:5173)
npm run lint             ESLint; must be clean before a build
npm run build            reconcile, then vite build
```
