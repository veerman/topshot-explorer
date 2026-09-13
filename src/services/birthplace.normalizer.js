/*
 * Deterministic birthplace formatting. House format,
 * derived from the hand-verified overrides:
 *
 *   United States  "City, ST, USA"   two-letter state, then USA
 *   Canada         "City, PR, CAN"   two-letter province, then CAN
 *   Elsewhere      "City, ISO3"      ISO 3166-1 alpha-3 country code
 *                  "City, Region, ISO3" when the source carried a region
 *
 * Only recognized tokens are rewritten (state and province names or legacy
 * abbreviations, country names, non-ISO country codes); anything unknown is
 * left exactly as it came, so this can never invent a fact. It also cannot
 * catch factual slips (COD vs COG, a hometown recorded as a birthplace);
 * those remain Corrections-page judgment calls.
 */

const US_STATES = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
  "colorado": "CO", "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia": "GA",
  "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
  "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS", "missouri": "MO",
  "montana": "MT", "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH",
  "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT",
  "virginia": "VA", "washington": "WA", "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
  "district of columbia": "DC", "washington, d.c.": "DC", "d.c.": "DC", "washington d.c.": "DC"
};
// Legacy and AP-style abbreviations seen in the source data
const US_STATE_FIXES = {
  "fla": "FL", "calif": "CA", "penn": "PA", "mass": "MA", "conn": "CT", "tenn": "TN", "ore": "OR",
  "wis": "WI", "wisc": "WI", "mich": "MI", "minn": "MN", "ill": "IL", "ind": "IN", "kan": "KS",
  "okla": "OK", "tex": "TX", "ariz": "AZ", "colo": "CO", "nev": "NV", "ala": "AL", "ark": "AR",
  "n.c.": "NC", "s.c.": "SC", "n.j.": "NJ", "n.y.": "NY", "n.d.": "ND", "s.d.": "SD", "w.va.": "WV",
  "n.h.": "NH", "n.m.": "NM", "r.i.": "RI", "va.": "VA", "ga.": "GA", "pa.": "PA", "la.": "LA",
  "md.": "MD", "del.": "DE", "vt.": "VT", "wash": "WA", "miss": "MS", "mont": "MT", "neb": "NE", "nebr": "NE"
};
const US_STATE_CODES = new Set(Object.values(US_STATES));

const CA_PROVINCES = {
  "ontario": "ON", "quebec": "QC", "québec": "QC", "british columbia": "BC", "alberta": "AB",
  "manitoba": "MB", "saskatchewan": "SK", "nova scotia": "NS", "new brunswick": "NB",
  "newfoundland and labrador": "NL", "newfoundland": "NL", "prince edward island": "PE",
  "northwest territories": "NT", "yukon": "YT", "nunavut": "NU"
};
const CA_PROVINCE_FIXES = { "pq": "QC", "que": "QC", "ont": "ON", "b.c.": "BC", "alta": "AB", "sask": "SK", "man": "MB", "n.s.": "NS", "n.b.": "NB", "p.e.i.": "PE", "nfld": "NL" };
const CA_PROVINCE_CODES = new Set(Object.values(CA_PROVINCES));

const US_ALIASES = new Set(["usa", "us", "u.s.", "u.s.a.", "u.s.a", "united states", "united states of america", "america"]);
const CA_ALIASES = new Set(["canada", "can"]);

// Country names (and non-ISO codes the source uses) -> ISO 3166-1 alpha-3
const COUNTRIES = {
  "afghanistan": "AFG", "albania": "ALB", "algeria": "DZA", "angola": "AGO", "argentina": "ARG",
  "armenia": "ARM", "australia": "AUS", "austria": "AUT", "azerbaijan": "AZE", "bahamas": "BHS",
  "the bahamas": "BHS", "barbados": "BRB", "belarus": "BLR", "belgium": "BEL", "belize": "BLZ",
  "benin": "BEN", "bermuda": "BMU", "bolivia": "BOL", "bosnia and herzegovina": "BIH", "bosnia": "BIH",
  "bosnia & herzegovina": "BIH", "brazil": "BRA", "bulgaria": "BGR", "burkina faso": "BFA",
  "cameroon": "CMR", "cape verde": "CPV", "cabo verde": "CPV", "central african republic": "CAF",
  "chad": "TCD", "chile": "CHL", "china": "CHN", "colombia": "COL", "congo": "COG",
  "republic of the congo": "COG", "republic of congo": "COG", "congo-brazzaville": "COG",
  "democratic republic of the congo": "COD", "dr congo": "COD", "drc": "COD", "congo-kinshasa": "COD",
  "costa rica": "CRI", "croatia": "HRV", "cuba": "CUB", "curacao": "CUW", "curaçao": "CUW", "cyprus": "CYP",
  "czech republic": "CZE", "czechia": "CZE", "denmark": "DNK", "dominican republic": "DOM", "ecuador": "ECU",
  "egypt": "EGY", "el salvador": "SLV", "england": "GBR", "estonia": "EST", "ethiopia": "ETH",
  "finland": "FIN", "france": "FRA", "french guiana": "GUF", "gabon": "GAB", "gambia": "GMB",
  "germany": "DEU", "ghana": "GHA", "great britain": "GBR", "greece": "GRC", "guadeloupe": "GLP",
  "guatemala": "GTM", "guinea": "GIN", "guyana": "GUY", "haiti": "HTI", "honduras": "HND",
  "hungary": "HUN", "iceland": "ISL", "india": "IND", "indonesia": "IDN", "iran": "IRN", "iraq": "IRQ",
  "ireland": "IRL", "israel": "ISR", "italy": "ITA", "ivory coast": "CIV", "cote d'ivoire": "CIV",
  "côte d'ivoire": "CIV", "jamaica": "JAM", "japan": "JPN", "jordan": "JOR", "kazakhstan": "KAZ",
  "kenya": "KEN", "kosovo": "XKX", "latvia": "LVA", "lebanon": "LBN", "liberia": "LBR", "libya": "LBY",
  "lithuania": "LTU", "luxembourg": "LUX", "macedonia": "MKD", "north macedonia": "MKD",
  "madagascar": "MDG", "mali": "MLI", "malta": "MLT", "martinique": "MTQ", "mexico": "MEX",
  "moldova": "MDA", "monaco": "MCO", "mongolia": "MNG", "montenegro": "MNE", "morocco": "MAR",
  "mozambique": "MOZ", "netherlands": "NLD", "the netherlands": "NLD", "holland": "NLD",
  "new zealand": "NZL", "nicaragua": "NIC", "niger": "NER", "nigeria": "NGA", "norway": "NOR",
  "pakistan": "PAK", "panama": "PAN", "paraguay": "PRY", "peru": "PER", "philippines": "PHL",
  "poland": "POL", "portugal": "PRT", "puerto rico": "PRI", "qatar": "QAT", "romania": "ROU",
  "russia": "RUS", "russian federation": "RUS", "rwanda": "RWA", "saint lucia": "LCA", "st. lucia": "LCA",
  "st lucia": "LCA", "saint vincent and the grenadines": "VCT", "st. vincent and the grenadines": "VCT",
  "saint vincent": "VCT", "saudi arabia": "SAU", "scotland": "GBR", "senegal": "SEN", "serbia": "SRB",
  "serbia and montenegro": "SRB", "yugoslavia": "SRB", "sierra leone": "SLE", "singapore": "SGP",
  "slovakia": "SVK", "slovenia": "SVN", "somalia": "SOM", "south africa": "ZAF", "south korea": "KOR",
  "korea": "KOR", "republic of korea": "KOR", "south sudan": "SSD", "spain": "ESP", "sudan": "SDN",
  "suriname": "SUR", "sweden": "SWE", "switzerland": "CHE", "syria": "SYR", "taiwan": "TWN",
  "tanzania": "TZA", "thailand": "THA", "togo": "TGO", "trinidad and tobago": "TTO", "trinidad": "TTO",
  "tunisia": "TUN", "turkey": "TUR", "türkiye": "TUR", "turkiye": "TUR", "uganda": "UGA", "ukraine": "UKR",
  "united arab emirates": "ARE", "united kingdom": "GBR", "uk": "GBR", "u.k.": "GBR", "uruguay": "URY",
  "uzbekistan": "UZB", "venezuela": "VEN", "vietnam": "VNM", "virgin islands": "VIR",
  "u.s. virgin islands": "VIR", "us virgin islands": "VIR", "united states virgin islands": "VIR",
  "wales": "GBR", "zambia": "ZMB", "zimbabwe": "ZWE",
  // Non-ISO codes (FIFA/IOC style, or plain typos) the source data uses
  "ger": "DEU", "cro": "HRV", "por": "PRT", "ned": "NLD", "ngr": "NGA", "sui": "CHE", "slo": "SVN",
  "lat": "LVA", "lt": "LTU", "do": "DOM", "cg": "COG", "gre": "GRC", "den": "DNK", "bul": "BGR",
  "phi": "PHL", "rsa": "ZAF", "uru": "URY", "chi": "CHL", "tri": "TTO", "nca": "NIC", "mas": "MYS",
  "ina": "IDN", "kor": "KOR", "mne": "MNE", "srb": "SRB", "bih": "BIH", "mkd": "MKD", "cze": "CZE"
};
const ISO3 = new Set(Object.values(COUNTRIES));
["USA", "CAN", "AUS", "FRA", "DEU", "GBR", "COD", "COG", "VIR", "PRI", "GEO", "LCA", "VCT", "GUF", "GLP", "MTQ"]
  .forEach((c) => ISO3.add(c));

const lower = (s) => String(s || "").trim().toLowerCase();

function usState(token) {
  const t = lower(token);
  const upper = String(token || "").trim().toUpperCase();
  if (US_STATE_CODES.has(upper) && upper.length === 2) return upper;
  return US_STATES[t] || US_STATE_FIXES[t] || US_STATE_FIXES[t.replace(/\.$/, "")] || null;
}

function caProvince(token) {
  const t = lower(token);
  const upper = String(token || "").trim().toUpperCase();
  if (CA_PROVINCE_CODES.has(upper) && upper.length === 2) return upper;
  return CA_PROVINCES[t] || CA_PROVINCE_FIXES[t] || null;
}

function country(token) {
  const t = lower(token);
  const upper = String(token || "").trim().toUpperCase();
  if (US_ALIASES.has(t)) return "USA";
  if (CA_ALIASES.has(t)) return "CAN";
  if (upper.length === 3 && ISO3.has(upper)) return upper;
  return COUNTRIES[t] || null;
}

/**
 * parts: the comma-separated pieces, already trimmed and non-empty.
 * Returns the house-format string.
 */
export function toHouseBirthplace(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return "";
  let p = parts.slice();

  // "Las Vegas, NV. USA": a period where the comma should be
  if (p.length === 2) {
    const m = p[1].match(/^([A-Za-z.]{2,6})\.\s+(USA|US|U\.S\.)$/i);
    if (m) p = [p[0], m[1], "USA"];
  }

  if (p.length === 2) {
    const [city, tail] = p;
    const st = usState(tail);
    // A US state name or code (California, Ohio, FLA) implies the country.
    // "Georgia" is read as the state here; Georgian-born players in the
    // data already carry the GEO code, so the collision is theoretical.
    if (st) return `${city}, ${st}, USA`;
    const pr = caProvince(tail);
    if (pr && !/^[A-Z]{2}$/.test(tail.trim())) return `${city}, ${pr}, CAN`;
    const c = country(tail);
    if (c) return `${city}, ${c}`;
    return p.join(", ");
  }

  if (p.length === 3) {
    const [city, region, tail] = p;
    const tailLower = lower(tail);
    const tailCountry = country(tail);
    const regionProvince = caProvince(region);
    const regionState = usState(region);

    // Canada: "Toronto, ON, CAN", "Toronto, ON, CA", "Montreal, PQ, Canada"
    if (regionProvince && (CA_ALIASES.has(tailLower) || tailLower === "ca" || tailCountry === "CAN")) {
      return `${city}, ${regionProvince}, CAN`;
    }
    // United States: "Akron, OH, USA", "Key West, FLA, USA", "Shelby, NC, US"
    if (tailCountry === "USA" || US_ALIASES.has(tailLower)) {
      return `${city}, ${regionState || region}, USA`;
    }
    // Elsewhere with a region: keep the region, code the country
    if (tailCountry) return `${city}, ${region}, ${tailCountry}`;
    return p.join(", ");
  }

  return p.join(", ");
}
