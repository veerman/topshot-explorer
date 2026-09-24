// Short team codes. The first three letters of the name read right for most
// franchises (TORonto, BOSton, MIAmi); the map covers the ones where that
// misreads or collides. The cube's score face prints them, and plays minted
// with a code for the team at the moment ("LVA") are resolved against them.
const TEAM_CODE_OVERRIDES = {
  "los angeles lakers": "LAL",
  "los angeles clippers": "LAC",
  "la clippers": "LAC",
  "los angeles sparks": "LAS",
  "las vegas aces": "LVA",
  "golden state warriors": "GSW",
  "oklahoma city thunder": "OKC",
  "new york knicks": "NYK",
  "new york liberty": "NYL",
  "new orleans pelicans": "NOP",
  "new orleans hornets": "NOH",
  "new jersey nets": "NJN",
  "san antonio spurs": "SAS",
  "phoenix suns": "PHX",
  "brooklyn nets": "BKN"
};

export const teamCode = (name) => {
  const clean = String(name || "").trim();
  if (!clean) return "";
  return TEAM_CODE_OVERRIDES[clean.toLowerCase()] || clean.slice(0, 3).toUpperCase();
};
