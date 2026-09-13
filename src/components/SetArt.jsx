// Stand-in set art for sets with nothing to extract from (no edition has
// a live hero with a cube render): a dark square carrying the set name,
// drawn in CSS so it sits in the same box as real art and reads like it.
// The full name fits the header frame at any length (the size scales
// with the name, wrapping onto lines); the 40px chips on the Sets page
// take a monogram instead, where a full name would be unreadable.

// Size the name to the box: shorter names larger, and never wider than
// the longest word allows (bold caps run about 0.7em per character, the
// box keeps 82% of its width for text)
function nameScale(name) {
  const words = name.split(/\s+/).filter(Boolean);
  const longest = words.reduce((m, w) => Math.max(m, w.length), 1);
  const len = name.length;
  const byLength = len <= 8 ? 0.2 : len <= 14 ? 0.16 : len <= 24 ? 0.13 : len <= 36 ? 0.105 : 0.088;
  return Math.min(byLength, 1.15 / longest);
}

function monogram(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w[0].toUpperCase())
    .join("");
}

export function SetArtPlaceholder({ name, mono = false, title }) {
  const clean = String(name || "").trim() || "?";
  const text = mono ? monogram(clean) : clean;
  const scale = mono ? (text.length >= 3 ? 0.42 : text.length === 2 ? 0.48 : 0.56) : nameScale(clean);
  return (
    <div
      className={`set-art-placeholder${mono ? " set-art-placeholder-mono" : ""}`}
      style={{ fontSize: `${(scale * 100).toFixed(1)}cqw` }}
      title={title}
      aria-label={mono ? clean : undefined}
    >
      <span>{text}</span>
    </div>
  );
}
