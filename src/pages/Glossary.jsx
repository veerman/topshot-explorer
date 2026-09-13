import { Link } from "react-router-dom";
import { Badges } from "../components/Badges";
import { TAG_BADGES, EDITION_BADGES } from "../services/overrides.service";
import { TIER_ORDER, TIER_COLORS } from "../utils/display.utils";

/**
 * Definitions for the terms the app uses, one or two sentences each. The
 * badge section renders every badge the app can show, in the canonical
 * order, so a glyph seen anywhere can be looked up here. Definitions are
 * text only; the badge list itself comes from the badge tables, so a new
 * badge appears here the day it is added there (with its tag as the text
 * until a definition is written below).
 */

// What each badge means, by tag. Derived badges (the app works them out
// from the chain data) say so; the rest are Dapper's own.
const BADGE_MEANING = {
  "Top Shot Debut": "The player's first play on Top Shot: their lowest play ID. A one-of-one gives way to a numbered play from the same game, and a twin of the debut (same game, same play category, re-created for a companion set) carries the badge too. Derived.",
  "Rookie Mint": "The play was first minted during the player's rookie season. The offseason counts toward the season just finished. Derived from the mint date.",
  "Rookie Year": "The play happened in the player's rookie season: the draft year, or the first season played for those who arrived later. Derived from the game date.",
  "Rookie Premiere": "Dapper Labs' badge for a player's first Top Shot play from their rookie season.",
  "Rookie of the Year": "The player won Rookie of the Year for that season.",
  "MVP Year": "The player won the league's Most Valuable Player award for that season.",
  "Championship Year": "The player's team won the championship that season. Every play by that team from that season carries it. Derived.",
  "Cup Year": "The team won its league's in-season cup that season (NBA Cup, Commissioner's Cup). Every play by that team from that season carries it. Derived; this badge is ours, Dapper Labs has none for it.",
  "Hall of Fame": "The player is enshrined in the Naismith Basketball Hall of Fame. A career honour, so every play of the player carries it. Derived from the enshrinee list.",
  "Autograph": "The moment carries the player's printed autograph. A signature belongs to one parallel: in a set with parallels usually only the rarest one is signed, and the badge shows only there.",
  "Commentary": "A narrated cut of this edition from the original nbatopshot.com. Belongs to the edition, not the play.",
  "Challenge Reward": "The edition was the reward for completing a Top Shot challenge (collecting specific moments within a window). Belongs to the edition, not the play.",
  "Crafting Challenge Reward": "The edition was minted by crafting: burning moments to mint a new one. Belongs to the edition.",
  "Leaderboard Reward": "The edition was earned by finishing on a Top Shot leaderboard. Belongs to the edition."
};
const BADGE_LIST = [...TAG_BADGES.filter((b) => !b.reward), ...EDITION_BADGES, ...TAG_BADGES.filter((b) => b.reward)];

const TIER_MEANING = {
  Ultimate: "The scarcest tier, at the top of a series.",
  Legendary: "The second scarcest tier: short runs of a series' signature plays.",
  Rare: "Shorter runs than Common, above Fandom.",
  Fandom: "A tier between Common and Rare, used for team and event themed sets.",
  Common: "The open tier: the largest runs, where most collections start.",
  Unknown: "A set whose tier is not on file yet."
};

// Sections of plain terms: [term, definition]
const SECTIONS = [
  {
    title: "The catalogue",
    terms: [
      ["Play", "One highlight: a player, a game, a date and a clip. Plays are numbered on the Flow Blockchain in the order they were created."],
      ["Set", "A themed collection of plays, such as Base Set or Metallic Gold LE. A set belongs to one series and has one tier."],
      ["Series", "A Top Shot season of releases, beginning with Series 1 in 2020. Every set belongs to one series."],
      ["Edition", "A play inside a set, written as set id, underscore, play id (for example 2_133), with an optional subedition. The same play in another set is a different edition. Only editions are minted; every moment is a copy of one."],
      ["Moment", "One copy of an edition, with its own serial number, owned by one account on the Flow Blockchain. The collectible itself."],
      ["Serial", "The copy number of a moment within its edition, from 1 upward. The lowest serials are prized."],
      ["Subedition, parallel", "A variant of an edition minted with different artwork, such as Metallic Gold or Holo. Standard is the plain edition; parallels are numbered separately."],
      ["Minted", "Created on the Flow Blockchain. The mint count of an edition is how many copies exist; some editions are still open to more."],
      ["Burned", "Destroyed on the Flow Blockchain. A burned set's moments no longer exist and are left out of totals."],
      ["Mismint", "An edition or set created by mistake and never released. Hidden from the catalogue and left out of every count."],
      ["Locked", "Held in Top Shot's locking contract for a period, shown with 🔒 and the unlock date. 🔑 means the lock has expired and the owner has not unlocked it yet."],
      ["Listed", "For sale on the Top Shot marketplace at a fixed price."],
      ["Offer", "A bid on an edition (any serial, or a specific parallel) that a seller can accept. The Offers page tracks them."]
    ]
  },
  {
    title: "Special serials",
    terms: [
      ["Serial #1", "The first copy of an edition."],
      ["Jersey number", "The serial equals the number the player wore in the play."],
      ["Last serial", "The highest serial of the run."],
      ["Draft year", "The serial equals the year the player was drafted."],
      ["Moment year", "The serial equals the year the play happened."],
      ["Birth year", "The serial equals the player's birth year."],
      ["Draft pick", "The serial equals the player's overall draft position."],
      ["NBA at 75", "Serial 75 from the NBA's 75th anniversary season, the 2021-22 releases."]
    ]
  },
  {
    title: "Mint eras",
    terms: [
      ["In season", "The edition was minted during the season its play happened in, the normal case."],
      ["Historical", "An edition of a play from an earlier season, minted later: archive drops, Run It Back and the Anthology sets."]
    ]
  },
  {
    title: "Accounts",
    terms: [
      ["Address", "An account on the Flow Blockchain, written as 0x and sixteen hex digits. This app never shortens one."],
      ["Dapper wallet", "An account created and held by Dapper Labs for a Top Shot user. Most collectors' moments live here. Any other wallet is one the collector holds directly, in a wallet app of their choosing."],
      ["Linked accounts", "A parent account that controls a child account through hybrid custody on the Flow Blockchain. Checking a linked account in the account menu counts its moments as yours everywhere in the app."],
      ["EVM address", "The account's address on the EVM side of the Flow Blockchain. Moments held there are part of the collection and marked EVM."],
      ["Username", "The name a collector uses on nbatopshot.com. The navbar box accepts one and finds its address."]
    ]
  },
  {
    title: "Media",
    terms: [
      ["IPFS", "The public storage network Dapper Labs moved every edition's video and artwork to in 2026. Files are addressed by content, so they can be served by anyone."],
      ["CID", "The permanent id of one file on IPFS, derived from its content. The same file always has the same CID, wherever it is served from."],
      ["Hero", "The tall artwork of an edition: the video still framed in the cube, or a raw photograph for some sets."],
      ["Player image", "The cut-out player photo used on the cube's front when an edition has no square video."],
      ["Cube", "The interactive 3D moment cube. Click a thumbnail on the set or collection page to spin one: square video in front, game facts on the other faces."]
    ]
  },
  {
    title: "This app",
    terms: [
      ["Correction layer", "Version-controlled fixes applied on top of the chain data: misspelt names, missing accents, wrong venues. Nothing on chain is edited, and Settings can switch the layer off."],
      ["Additions", "Facts that never existed on chain, kept beside the corrections: tiers, badges Dapper Labs published, team emoji and colours, arena history."],
      ["Remaining supply", "Minted minus burned: the moments of an edition that still exist. The chain never lowers a mint count, so the burned counts come from Dapper Labs' catalogue. Every count in the app is remaining supply unless Settings switches back to the original mints."],
      ["Burned", "A moment destroyed on the Flow Blockchain, by Top Shot or by its owner. Its serial number is gone for good."],
      ["Corrections page", "Every correction shown beside the raw chain value, so any fix can be checked at the source."],
      ["Legacy links", "Links from the original nbatopshot.com, which used Dapper Labs' ids, resolved to the same set, play or edition here."]
    ]
  }
];

export function Glossary() {
  return (
    <div className="about-page-container glossary-page">
      <div className="glass-panel info-banner">
        <h2>Glossary</h2>
        <p className="text-muted mt-8" style={{ fontSize: "0.95rem" }}>
          What the words and badges in this app mean. Badges marked derived are worked out from the chain data and our
          own tables; the rest are Dapper Labs'. More detail on where the data comes from is on the{" "}
          <Link to="/about">About</Link> page.
        </p>
      </div>

      <div className="glass-panel mt-20 glossary-panel">
        <h3>Badges</h3>
        <dl className="glossary-list">
          {BADGE_LIST.map((b) => (
            <div className="glossary-row" key={b.tag}>
              <dt>
                <Badges tags={[b.tag]} size="lg" />
                <span>{b.tag}</span>
              </dt>
              <dd>{BADGE_MEANING[b.tag] || b.title || b.tag}</dd>
            </div>
          ))}
        </dl>

        <h3>Tiers</h3>
        <dl className="glossary-list">
          {TIER_ORDER.map((t) => (
            <div className="glossary-row" key={t}>
              <dt>
                <span className="glossary-tier-dot" style={{ background: TIER_COLORS[t] }} aria-hidden="true" />
                <span>{t}</span>
              </dt>
              <dd>{TIER_MEANING[t]}</dd>
            </div>
          ))}
        </dl>

        {SECTIONS.map((s) => (
          <div key={s.title}>
            <h3>{s.title}</h3>
            <dl className="glossary-list">
              {s.terms.map(([term, def]) => (
                <div className="glossary-row" key={term}>
                  <dt>{term}</dt>
                  <dd>{def}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>

      <style>{`
        .about-page-container {
          max-width: 860px;
          margin: 0 auto;
          width: 100%;
        }
        .glossary-panel {
          padding: 8px 28px 20px;
        }
        .glossary-panel h3 {
          margin: 22px 0 8px;
          font-size: 0.85rem;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--text-muted);
        }
        .glossary-list {
          margin: 0;
          display: grid;
          grid-template-columns: minmax(150px, 220px) 1fr;
          column-gap: 18px;
          row-gap: 10px;
        }
        .glossary-row {
          display: contents;
        }
        .glossary-list dt {
          display: flex;
          align-items: center;
          gap: 10px;
          font-weight: 600;
          color: #fff;
          font-size: 0.92rem;
        }
        .glossary-list dd {
          margin: 0;
          font-size: 0.92rem;
          line-height: 1.55;
          color: var(--text-muted);
        }
        .glossary-tier-dot {
          display: inline-block;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          flex: none;
        }
        @media (max-width: 600px) {
          .glossary-list {
            grid-template-columns: 1fr;
            row-gap: 4px;
          }
          .glossary-list dd {
            margin-bottom: 10px;
          }
        }
      `}</style>
    </div>
  );
}
