# Media hosting and thumbnail pipeline

How derived media (thumbnails, set art, logos) is generated, hosted and
displayed, and the rules that keep it optional, immutable and free.

## Constraints (non-negotiable)

1. **No licensed pixels in git, ever.** The repository ships code, recipes
   (numbers), and per-CID metadata only. Generated imagery stays in
   uncommitted trees (`assets/`, `ipfs_cache/`).
2. **The app must run without Cloudflare.** Hosted media is an optional
   enhancement layer; every deployment has a working floor without it.
3. **$0 hosting target.** Free tiers only; no metered image products.
4. **Deploys never invalidate media caches.** No purge step exists
   anywhere; every media URL is immutable by construction.

## The three layers

- **Layer 0, the floor (every deployment):** the browser hotlinks
  originals from Dapper's own gateway (`ipfs.dapperlabs.com`, read from
  the on-chain `TopShotIPFSResolver.gateway`), and
  `src/services/ipfs.generate.js` can derive set art and reconstructed
  player photos in the browser, on demand, from recipes alone.
- **Layer 1, optional static media (this pipeline):** derived files
  (thumbnails, set art, logos) served as plain static objects from
  `cache.topshotexplorer.com` (an R2 bucket behind a public custom
  domain). Any other deployer can host the same tree on any static host
  and point the app at it.
- **Layer 2, Cloudflare-specific:** deliberately empty. No Image
  Transformations, no resizing Workers, nothing in `src/` that knows
  Cloudflare exists.

## The pieces

- `scripts/download-ipfs-images.mjs`: local mirror of every IPFS image
  (videos excluded), ~46 GB, multi-drive via the local `ipfs_dirs.json`,
  idempotent and resumable. Built precisely so thumbnails can be derived
  offline without re-touching the gateway.
- `scripts/extract-set-art.mjs` + `scripts/extract-set-badges.mjs` +
  `data/logos.json`: recipe-driven extraction into the local
  `assets/` tree (251 set-art squares at 1024 as jpg q92 mozjpeg; team
  logos and event badges as png with transparency). ~435 files, ~96 MB.
- `data/ipfs_media.json` + `data/ipfs_dead.json`: the distilled per-CID
  probe (type, dimensions, bytes; dead CIDs tracked, 219 today).
- `scripts/media-derive.mjs` (`npm run media`): the 512 thumbnails and
  set-art squares, incremental; gap-fetches are saved to
  `ipfs_cache/originals`.
- `scripts/media-sync.mjs` (`npm run media:sync`): pooled uploads to the
  bucket, state in `scratch/media-sync-state.json`, manifest build and
  upload last, dead-CID deletion.
- `src/services/media.service.js`: the `VITE_MEDIA_BASE` knob (dev falls
  back to `/assets`), `heroThumbUrl`, `setArtThumbUrl`,
  `fetchMediaManifest`. `.env.cloudflare` sets the bucket domain.
- Surfaces: 40x40 set-art chips on the Sets page (boxes reserved, no
  layout shift; missing art keeps the empty box); the 96x96 hero thumb on
  each set page's cube trigger, falling back to the 🧊 glyph when media is
  off or the thumb 404s; the Assets page reads the manifest and file URLs
  from `MEDIA_BASE`, and in dev renders the local tree through a vite
  middleware.
- Bucket: `topshot-explorer-cache` on R2 with CORS from
  `deploy/cloudflare/r2-cors.json`, attached to `cache.topshotexplorer.com`
  (`wrangler r2 bucket domain add ... --min-tls 1.2`).

## Decisions

- **Domain:** `cache.topshotexplorer.com`, an R2 bucket with a public
  custom domain. One bucket for all derived media.
- **Hero thumbnails:** one per hero CID (18,355 today; every parallel has
  its own), **border-trimmed, largest side 512, jpg quality 92, mozjpeg**
  (the encode `extract-set-art.mjs` already uses). The hero originals pad
  the cube render heavily (png generations with transparency, jpg
  generations with black), so the detected padding is cropped FIRST
  (sharp trim, top-left reference, threshold 10) and the result is
  usually not square (512 is the dimension
  that is the largest side). fullBleed heroes (raw photographs, border
  census flag at ipfs_media index 8) skip the trim; a degenerate trim
  falls back to the full frame. Trimmed thumbs spot-check at ~30 to 60 KB
  (content fills the frame, so above the full-frame measurements below);
  total on the order of 0.7 to 0.9 GB. 512 chosen over 384 for headroom
  on card-style grids (crisp up to ~256 css px on 2x screens).
- **Recipe tree ships to the bucket at full resolution:** set art as the
  generated 1024 jpgs, logos and badges as png (transparency preserved).
  This makes the Assets page live in production.
- **Display rule:** there is exactly ONE derived size, 512,
  whatever the on-screen box; the browser scales it down. First surfaces:
  40x40 set-art chips beside the set names on /sets, and a 96x96 hero
  thumbnail replacing the 🧊 glyph on each set page's cube trigger. A
  512px version of each set-art square exists for the chips (the full-res
  1024s also ship, for the Assets page and anything larger later).
- **Player-image thumbs: deferred** until a concrete surface needs them.
  Same rule for any additional size: a size class is generated only when
  a real UI surface displays it, and later additions are additive paths,
  never overwrites.
- **Origin-respect rule:** when a CID goes dead at Dapper's gateway (the
  probe pipeline detects this), its thumb is deleted from the bucket on
  the next sync. Dapper's removals propagate to us automatically.

## Bucket layout and caching rules

Bucket keys mirror the local `assets/` tree exactly, so the dev middleware
(`/assets/...`) and the bucket serve the same relative paths and the app
needs one base URL, not two path schemes:

```
cache.topshotexplorer.com/
  derived/thumbs/v1/512/<cid>.jpg   one per live hero CID; immutable, 1y
  derived/setart/512/<file>.jpg     512 set-art squares (Sets page chips); 1 day
  sets/<...>.jpg                    full-res set art, as generated; 1 day
  logos/teams/<league>/<...>.png    1 day
  logos/badges/<...>.png            1 day
  manifest.json                     tree listing + setArt covers; 5 min
  offers/book.json                  the Top Shot offers book (active offers per
                                    edition/subedition/moment + counts); 2 min
  offers/other.json                 offers on other collections, purchased-in-book; 2 min
  offers/stats.json                 accepted-offer aggregates + newest 5,000 rows; 2 min
  offers/accepted-YYYY-MM.json      accepted-offer archive, one per month, append only; 1 h
  offers/state.json                 the fold's working state (height, buyer registry,
                                    creation times, retained history); no-store
```

The `offers/` objects are not media: they are the marketplace offers book,
kept current by the Worker cron fold every half hour
(deploy/cloudflare/worker.js, design in src/services/offers.core.js) and
re-based by `npm run offers` at deploy time, which verifies the book against
every buyer's live offer collection. The Offers page reads book/other/stats
from here first and folds the last few minutes of events itself; the
bundled public/seed/topshot-offers.json is only the fallback for builds
with no bucket.

- Thumbs are content-addressed by source CID and derivation-versioned by
  path (`v1`). If the derivation ever changes (crop, quality, encoder), a
  `v2/` tree is added alongside; `v1` objects are never rewritten.
- Recipe-tree files (set art, logos, the setart thumbs) keep their human
  names and can change content on a recipe rerun, so they serve with
  `max-age=86400` instead of immutable: a regenerated file is picked up
  within a day, and nothing ever needs a purge. (Simpler than the
  `?v=<hash>` seed pattern originally sketched; revisit only if a same-day
  recipe fix ever matters.)
- Thumbs upload with `Cache-Control: public, max-age=31536000, immutable`.
- Bucket CORS (deploy/cloudflare/r2-cors.json): `GET`/`HEAD` from
  anywhere. Plain `<img>` needs none, but it keeps canvas pixel reads and
  third-party deployments possible.
- Because nothing generated ships inside `dist/`, the deploy pipeline and
  the `public/_headers` rules for `/assets/*` (vite's hashed bundles) are
  untouched by any of this.

## Runtime contract

- One knob in the `VITE_FLOW_ACCESS_NODE` mould: `VITE_MEDIA_BASE`.
  - Unset: gateway originals, in-browser generation, Assets page
    dev-only.
  - Set (production sets `https://cache.topshotexplorer.com`): a helper
    returns the thumb URL first with `onerror` fallback to the gateway
    original; known-dead CIDs skip straight to their existing dead-CID
    handling. The Assets page fetches `manifest.json` from the base.
- `loading="lazy"` on every thumbnail: a 100-row page fetches only the
  viewport (~10 to 20 images, well under 1 MB), not all 100.
- No Cloudflare reference anywhere in `src/`.

## Generation and sync

- `npm run media`: incremental derivation. Walk live hero CIDs from
  `data/ipfs_media.json` (the 2880 squares, plus every CID the seed's
  chain records name as HERO, since raw photo heroes come at 2048 and
  smaller), skip dead CIDs and outputs that already exist,
  read sources from the mirror (`ipfs_dirs.json` search dirs), fetch any
  mirror gaps from the gateway one-off, write
  `assets/derived/thumbs/v1/512/<cid>.jpg`. Idempotent, resumable, in the
  mould of `probe-missing.mjs`.
- `npm run media:sync`: list the bucket, upload missing objects with
  their Cache-Control metadata, upload a freshly built `manifest.json`,
  and delete thumbs whose CID is now in `data/ipfs_dead.json` (the
  origin-respect rule). Never overwrites an existing object.
- Cadence when new sets drop (unchanged habits, two new steps):
  `npm run seed` -> `download-ipfs-images` -> `media` -> `media:sync`.
  Each step only touches what is new.
- Other deployers: run the same scripts against their own bucket or
  static host, or host nothing and ride the Layer 0 fallback. The 46 GB
  mirror itself never uploads anywhere.

## Measured sizing data

20 heroes sampled across the byte-size distribution, encoded with sharp
(`jpeg({ quality: 92, mozjpeg: true })`, black-flattened). Measured on
FULL-FRAME downscales, before the border-trim decision: a trimmed 512
runs ~1.5 to 2x these bytes because the content fills the frame. The
relative comparisons between sizes still hold:

| size | per image (median) | 100 images | all 18,355 heroes |
|---|---|---|---|
| 128px | 3.8 KB | 0.4 MB | 0.07 GB |
| 192px | 7.1 KB | 0.7 MB | 0.12 GB |
| 256px | 11 KB | 1.1 MB | 0.19 GB |
| 384px | 21 KB | 2.0 MB | 0.36 GB |
| **512px (chosen)** | **32 KB** | **3.2 MB** | **0.57 GB** |
| 720px | 55 KB | 5.4 MB | 0.97 GB |
| original | 1.7 MB | 201 MB | 36 GB |

webp 80 and jpg 80 at 256px measured 6 and 7.5 KB; rejected in favour of
one consistent jpg 92 encode (the absolute savings are negligible).

## Cost accounting

- R2 free tier: 10 GB storage (plan uses ~0.7 GB), 10M reads/month,
  free egress. Serving from the custom domain costs zero Worker
  invocations.
- No Cloudflare Images / Image Transformations (free tier is 5,000 unique
  transformations per month; the catalog is 18,355+, so on-the-fly
  resizing would meter unpredictably and tie display to Cloudflare).
- No purge operations exist in the design, so redeploys cost nothing and
  break nothing.

## Posture and reversibility

- The repository is clean: recipes and code only.
- Everything served is derived from media the rights holder publishes on
  its own public gateway, at reduced resolution, on a site that links
  every moment back to nbatopshot.com.
- Removals at the origin propagate: dead CIDs are dropped from the bucket
  on sync.
- Kill switch: unset `VITE_MEDIA_BASE` and empty the bucket; the site
  degrades gracefully to Layer 0 (hotlinking), which is the pre-pipeline
  posture.
