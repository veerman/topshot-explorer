import { Link } from "react-router-dom";

const REPO_URL = "https://github.com/veerman/topshot-explorer";
const IPFS_POST = "https://blog.nbatopshot.com/posts/authentic-permanent";
const ORIGINAL_REPO = "https://github.com/rrrkren/topshot-explorer";
const V1_URL = "https://v1.topshotexplorer.com";
const V1_REPO = "https://github.com/veerman/topshot-explorer-v1";
const INTANGIBLE_URL = "https://intangible.market";

// The three parts a collectible needs to outlive its maker: the token, the media, and now the app. Drawn as a row of
// three, so the whole stack reads at a glance; the order is the order
// they became permanent.
const PILLARS = [
  { n: 1, part: "The token", word: "Owned", where: "Flow Blockchain, since 2020", what: "The moment itself, on a public ledger no company controls." },
  { n: 2, part: "The media", word: "Permanent", where: "IPFS, since 2026", what: "The video and artwork, addressed by fingerprint: the address never changes, and anyone can host a copy." },
  { n: 3, part: "The app", word: "Open", where: "Open source, 2026", what: "The software that reads them both, on GitHub for anyone to run." }
];

// Every contract the app reads, one row each. Cadence contracts link to
// flowscan (name must be the on-chain contract identifier); rows with
// their own url (the EVM twin) override that.
const flowscanUrl = (name, addr) => `https://www.flowscan.io/contract/A.${addr.replace(/^0x/, "")}.${name}`;
const CONTRACTS = [
  { name: "TopShot", addr: "0x0b2a3299cc857e29", role: "plays, sets, editions and every minted moment" },
  { name: "TopShotLocking", addr: "0x0b2a3299cc857e29", role: "moments locked for rewards programs" },
  { name: "PackNFT", addr: "0x0b2a3299cc857e29", role: "pack mints and openings" },
  { name: "TopShotIPFSResolver", addr: "0x0b2a3299cc857e29", role: "each edition's IPFS media CIDs" },
  { name: "Market", addr: "0xc1e4f4f4c4257510", role: "the original peer-to-peer market" },
  { name: "TopShotMarketV3", addr: "0xc1e4f4f4c4257510", role: "the later peer-to-peer market, now winding down" },
  { name: "NFTStorefrontV2", addr: "0x4eb8a10cb9f87357", role: "the generic storefront newer sales ride on" },
  { name: "OffersV2", addr: "0xb8ea91944fd51c43", role: "Dapper Labs' offer system (with DapperOffersV2)" },
  { name: "NonFungibleToken", addr: "0x1d7e57aa55817448", role: "the Flow NFT standard" },
  { name: "FlowEVMBridgeNFTEscrow", addr: "0x1e4aa0b87d10b141", role: "the VM bridge escrow holding bridged moments" },
  {
    name: "TopShot (ERC721)",
    addr: "0x50ab3a827ad268e9d5a24d340108fad5c25dad5f",
    url: "https://evm.flowscan.io/token/0x50ab3a827ad268e9d5a24d340108fad5c25dad5f",
    role: "the mirrored collection on Flow EVM"
  }
].map((c) => ({ ...c, url: c.url || flowscanUrl(c.name, c.addr) }));

import { AboutTabs } from "../components/AboutTabs";

export function About() {
  // Injected at build time by the define block in vite.config.js
  const version = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
  const buildDate = typeof __BUILD_DATE__ !== "undefined" ? __BUILD_DATE__ : "dev build";

  return (
    <div className="about-page-container">
      <AboutTabs />
      <div className="glass-panel info-banner">
        <h2>About Top Shot Explorer</h2>
        <p className="text-muted mt-8" style={{ fontSize: "0.95rem" }}>
          An open-source explorer for NBA and WNBA Top Shot: licensed highlights, minted on the Flow Blockchain, media
          on IPFS, read straight from public nodes.
        </p>
      </div>

      <div className="about-prose glass-panel mt-20">
        <h3>What it is</h3>
        <p>
          Top Shot moments are NBA and WNBA history one highlight at a time: officially licensed video, minted in a
          fixed count and owned outright on the Flow Blockchain. Top Shot Explorer is the record of all of it. Every
          play, set, edition and mint is read from the Flow Blockchain&apos;s public nodes and assembled in your
          browser, and every video and piece of artwork comes from IPFS. A few counts, like how many moments have been
          burned, are periodic snapshots kept as plain files beside the code; the chain records every burn, and anyone
          can build their own. This copy happens to be hosted by me. Any copy runs the same on any machine, because
          nothing here depends on a server of mine. The aim is technology you never notice: simple for the people here
          for the basketball, exact for the people here for the chain.
        </p>

        <h3>What makes it different</h3>
        <p>
          Top Shot is new in three ways at once. It is a digital collectible. It is secured by a public blockchain,
          where anyone can check any claim without asking permission. And since 2026 its media is permanent in the way
          that matters, addressed on IPFS by its own fingerprint, so the file your moment points to can never be
          swapped, and anyone can keep a copy. Together with officially
          licensed NBA and WNBA highlights, that makes a moment something that did not exist before: a programmable,
          licensed media asset. Software can fetch its video, pull a frame, cut a reel or build a game around it, and
          every program that does is looking at the same file, the one the ledger points to. One reference point, one
          source of truth, and a way to catalogue, timestamp and curate basketball history that anyone can verify.
        </p>

        <h3>Three parts of ownership</h3>
        <p>
          A collectible should outlive its maker in every part: the token, the media, and the software you use to
          look at them. Dapper Labs made the first two permanent. This app is the third.
        </p>
        <ol className="pillars" aria-label="The three parts of ownership">
          {PILLARS.map((p) => (
            <li key={p.n} className="pillar">
              <span className="pillar-part">{p.n}. {p.part}</span>
              <span className="pillar-word">{p.word}</span>
              <span className="pillar-where font-mono">{p.where}</span>
              <span className="pillar-what">{p.what}</span>
            </li>
          ))}
        </ol>
        <p className="pillars-caption">
          With all three in the open, the whole stack is decentralized, and no single company can shut Top Shot down.
        </p>

        <h3>Why 2026</h3>
        <p>
          The tokens have lived on the Flow Blockchain since 2020, so ownership was never in question. The media took
          longer. Dapper Labs said all along that permanent media was on the roadmap; it was a hard problem, and for
          years other features mattered more to more people. To most collectors IPFS looked like a detail for the
          purists, because nobody cares how a video arrives as long as it arrives. In June 2026 it shipped: every
          edition&apos;s video and artwork moved to IPFS
          (<a href={IPFS_POST} target="_blank" rel="noopener noreferrer">their announcement</a>), stored by content,
          so the media no longer depends on any one server. That left the app.
        </p>
        <p className="mt-12">
          Good technology is invisible when it works, and a blockchain is the extreme case: its value shows when
          something is tested. When ownership is tested, when permanence is tested, when a server that used to answer
          no longer does. Everything works in good times. Few systems are designed for the bad ones, and planning for
          them is not predicting them; nobody minds having a backup. Technology is more fragile than we like to admit,
          and ownership is the hardest place to be fragile, because it is where assets and money live. Some
          collectibles take decades to become collectibles, and the plan has to cover that long. Responsible digital
          ownership means the infrastructure carries the plan, not any one company. Now every part of a Top Shot
          moment does.
        </p>

        <h3>The data</h3>
        <p>
          The vast majority of the chain data is spot on. The chain&apos;s gift is also its curse: a record can never be
          edited, so the occasional misspelt name, missing accent, hometown filed as a birthplace or mismint that was
          never released is permanent too. Dapper Labs keeps its own layer of fixes, but it was never opened up. Here,
          nothing on chain gets edited. Corrections live in version-controlled JSON files layered on top, and every
          one is shown beside the raw value on the <Link to="/corrections">Corrections</Link> page. The idea is a shared base
          that anyone building on Top Shot can start from instead of fixing the same typos again: see how the
          pipeline corrects the data and the media, then build your own app or game on it.
        </p>

        <h3>The marketplace</h3>
        <p>
          <Link to="/offers">Offers</Link> and <Link to="/live">Live</Link> read the marketplace straight from the
          chain. Live follows every listing, sale, offer and mint as it lands. Offers watches a window of recent
          blocks to find who is bidding, then reads each buyer&apos;s standing offers live, so active offers can be of any
          age while the accepted history covers only that window. Top Shot is not the only collection trading on
          those contracts, and the filters do not pretend otherwise.
        </p>

        <h3>Glossary</h3>
        <p>
          Every term and badge used in the app is defined on the <Link to="/glossary">Glossary</Link> page, badges
          drawn as they appear under a player&apos;s name.
        </p>

        <h3>The contracts</h3>
        <p>
          Everything here is read from public contracts, so any number on any page can be checked at the source:
        </p>
        <div className="contract-list">
          {CONTRACTS.map((c) => (
            <div key={c.name + c.addr} className="contract-row">
              <a href={c.url} target="_blank" rel="noopener noreferrer" className="font-mono contract-name">{c.name}</a>
              <span className="contract-addr font-mono">{c.addr}</span>
              <span className="contract-role text-muted">{c.role}</span>
            </div>
          ))}
        </div>

        <h3>Lineage</h3>
        <p>
          I have been building third-party Top Shot tools since 2020, starting with some of the first collection
          tools, and I never stopped. Some are still online at{" "}
          <a href={INTANGIBLE_URL} target="_blank" rel="noopener noreferrer">intangible.market</a>; many have been
          retired. This is the fourth or fifth explorer I have built from scratch, and most of the others nobody saw.
          They never felt finished: my eye for the data has always run ahead of my eye for an interface, and I would
          rather ship nothing than ship something unpolished. New AI tooling finally let me finish the polish that
          always stopped me, so this release is six years of iterations. I wanted a great experience from day one, not
          a coming soon. Software is never done, and this is the beginning, not the end.
        </p>
        <p className="mt-12">
          topshotexplorer.com itself began as <a href={ORIGINAL_REPO} target="_blank" rel="noopener noreferrer">Eric
          Ren&apos;s</a> proof of concept. I sent the pull request that carried it through Cadence 1.0, and when Eric was
          done with it he offered me the domain. His repository is still online, an interesting snapshot in time.
          This version keeps the name and nothing else. For posterity, the original is still at{" "}
          <a href={V1_URL} target="_blank" rel="noopener noreferrer">v1.topshotexplorer.com</a>, with its code
          on <a href={V1_REPO} target="_blank" rel="noopener noreferrer">GitHub</a>.
        </p>

        <h3>Open source, yours to keep</h3>
        <p>
          This is not a personal project with my name on it. It belongs to anyone who has ever collected a moment,
          anyone who cares about NBA and WNBA history, and anyone who wants to build something fun with licensed
          basketball media. Fork it, clone it, run it, change it, use it as the starting point for the app you have in
          mind, and when you build something, share it. I want to see it. I plan to keep Top Shot Explorer online for
          a long time, but you do not have to take my word for it: a copy on your own machine is as good as this one.
          Built by a software developer and basketball nerd who loves building things, loves collecting, and loves
          curating NBA history. Steve Veerman.
        </p>
        <div className="developer-links mt-20">
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="dev-link-card glass-panel">
            <span>Source on GitHub</span>
            <span className="dev-link-arrow">→</span>
          </a>
          <a href="https://intangible.medium.com/" target="_blank" rel="noopener noreferrer" className="dev-link-card glass-panel">
            <span>Writing on Medium</span>
            <span className="dev-link-arrow">→</span>
          </a>
          <a href="https://x.com/intangible_eth" target="_blank" rel="noopener noreferrer" className="dev-link-card glass-panel">
            <span>@intangible_eth on X</span>
            <span className="dev-link-arrow">→</span>
          </a>
        </div>

        <p className="text-muted about-build font-mono">
          v{version} · built {buildDate}
        </p>
      </div>

      <style>{`
        .about-page-container {
          max-width: 860px;
          margin: 0 auto;
          width: 100%;
        }
        .about-prose {
          padding: 8px 28px 20px;
        }
        .about-prose h3 {
          margin: 22px 0 6px;
          font-size: 0.85rem;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--text-muted);
        }
        .about-prose p {
          margin: 0;
          text-wrap: pretty;
          font-size: 0.95rem;
          line-height: 1.65;
          color: #fff;
        }
        .about-prose a {
          color: var(--primary);
        }
        .about-prose p.mt-12 {
          margin-top: 12px;
        }
        /* The three parts, one card each. Number, part and word carry the
           meaning; the outline is the same on all three (no state by colour) */
        .pillars {
          list-style: none;
          margin: 14px 0 0;
          padding: 0;
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
        }
        .pillar {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 14px 16px;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(255, 255, 255, 0.03);
          min-width: 0;
        }
        .pillar-part {
          font-size: 0.78rem;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.6px;
        }
        .pillar-word {
          font-size: 1.5rem;
          font-weight: 700;
          line-height: 1.1;
          color: #fff;
        }
        .pillar-where {
          font-size: 0.76rem;
          color: var(--primary-hover);
        }
        .pillar-what {
          margin-top: 6px;
          font-size: 0.88rem;
          line-height: 1.5;
          color: #fff;
        }
        .about-prose .pillars-caption {
          margin-top: 10px;
          font-size: 0.9rem;
          color: var(--text-muted);
        }
        @media (max-width: 640px) {
          .pillars {
            grid-template-columns: 1fr;
          }
        }
        .about-build {
          margin-top: 24px;
          font-size: 0.75rem;
        }
        .contract-list {
          display: flex;
          flex-direction: column;
          gap: 7px;
          margin-top: 10px;
        }
        .contract-row {
          display: flex;
          align-items: baseline;
          gap: 12px;
          flex-wrap: wrap;
          font-size: 0.88rem;
          line-height: 1.4;
        }
        .contract-name {
          font-weight: 600;
          text-decoration: none;
          white-space: nowrap;
        }
        .contract-name:hover {
          text-decoration: underline;
        }
        .contract-addr {
          font-size: 0.76rem;
          color: var(--text-muted);
          overflow-wrap: anywhere;
        }
        .contract-role {
          font-size: 0.85rem;
        }
        .developer-links {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
        }
        .dev-link-card {
          margin: 0;
          padding: 12px 18px;
          display: flex;
          align-items: center;
          gap: 14px;
          border: 1px solid rgba(255,255,255,0.05);
          transition: var(--transition-smooth);
          text-decoration: none;
          color: #fff;
          font-weight: 600;
          font-size: 0.9rem;
        }
        .dev-link-card:hover {
          transform: translateY(-2px);
          border-color: var(--primary);
          background: rgba(139, 92, 246, 0.04);
        }
        .dev-link-arrow {
          color: var(--text-muted);
          transition: var(--transition-smooth);
        }
        .dev-link-card:hover .dev-link-arrow {
          color: #fff;
          text-shadow: 0 0 10px var(--primary-glow);
        }
      `}</style>
    </div>
  );
}
