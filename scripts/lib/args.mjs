// Shared argv helpers: every maintenance script used to hand-roll these.
//   flag("--dry-run")            -> boolean
//   opt("--raw")                 -> next token or null (or given fallback)
//   num("--limit", Infinity)     -> Number(next token) or the fallback
const args = process.argv.slice(2);

export const flag = (name) => args.includes(name);

export const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

export const num = (name, fallback) => {
  const v = opt(name);
  return v === null ? fallback : Number(v);
};
