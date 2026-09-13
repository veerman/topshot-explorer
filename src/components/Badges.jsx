import { Link } from "react-router-dom";
import { badgesForTags } from "../services/overrides.service";

/**
 * A row of circular badges for a play's tags, meant to sit directly under
 * the player's name. Renders nothing when the play has no known tags, so it
 * costs no height on plain rows. Styles live in index.css (.play-badge-row,
 * .play-badge) since several pages share them. `titles` overrides the hover
 * per tag (a reward badge naming the edition that earned it). `linkOf(tag)`
 * returns where a badge leads (a filtered collection or catalogue page),
 * or null to leave it plain.
 */
export function Badges({ tags, size = "sm", titles, linkOf }) {
  const badges = badgesForTags(tags);
  if (badges.length === 0) return null;
  return (
    <span className={`play-badge-row play-badge-row-${size}`} aria-label="Badges">
      {badges.map((b) => {
        const to = linkOf ? linkOf(b.tag) : null;
        const Tag = to ? Link : "span";
        const title = (titles && titles[b.tag]) || b.title || b.tag;
        return (
          <Tag
            key={b.tag}
            to={to || undefined}
            className={`play-badge ${b.tristar ? "play-badge-tristar" : b.text ? "play-badge-text" : "play-badge-emoji"}${to ? " play-badge-link" : ""}`}
            role="img"
            aria-label={title}
            title={to ? `${title}; click to see moments with this badge` : title}
            style={{ "--badge-gradient": b.gradient }}
          >
            {b.tristar ? (
              <>
                <span className="tri-star tri-star-1">⭐</span>
                <span className="tri-star tri-star-2">⭐</span>
                <span className="tri-star tri-star-3">⭐</span>
              </>
            ) : (
              b.text || b.emoji
            )}
          </Tag>
        );
      })}
    </span>
  );
}
