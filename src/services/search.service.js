/*
 * Quick search behind the magnifying glass in the navbar. One index over
 * the names a fan would type (players, teams with their historical names,
 * sets, arenas), each entry knowing the page it opens, so a query funnels
 * straight to the right place: "lebron" is the player page, "garden" the
 * arena, "metallic" the set. A bare number or an edition key is looked up
 * as an id (play, set, edition) on top of the names.
 *
 * The index is built once from the local database and reused; a sync pass
 * that changes the plays or sets drops it (see resetSearchIndex).
 */
import { getAllPlaysDB, getAllSetsDB, getAllTeamsDB } from "./db.service";
import { isMismintPlay } from "./overrides.service";
import { normPlayerName } from "./name-norm";
import { playerPath, isWnbaTeam } from "../utils/display.utils";
import teamsAdditions from "../../data/additions/teams.json";

export const SEARCH_LIMIT = 8;
const KIND_ORDER = { Player: 0, Team: 1, Set: 2, Arena: 3 };

// Diacritics, periods and apostrophes fold away on both sides, so "dončić",
// "doncic" and "d'angelo" all land (normPlayerName does exactly this)
export const foldSearch = (s) => normPlayerName(s);

const arenaPath = (arena) => `/arenas/${encodeURIComponent(String(arena).trim().replace(/\s+/g, "_"))}`;

let indexPromise = null;

export function resetSearchIndex() {
  indexPromise = null;
}

/** The index, built on first use: { entries, playById, setById }. */
export function loadSearchIndex() {
  if (!indexPromise) {
    indexPromise = Promise.all([getAllPlaysDB(), getAllSetsDB(), getAllTeamsDB()])
      .then(([plays, sets, teams]) => buildIndex(plays, sets, teams))
      .catch((err) => {
        indexPromise = null;
        throw err;
      });
  }
  return indexPromise;
}

function entry(kind, name, detail, href, aliases = []) {
  return {
    kind,
    name,
    detail,
    href,
    folded: foldSearch(name),
    aliases: aliases.map((a) => ({ text: a, folded: foldSearch(a) })).filter((a) => a.folded)
  };
}

function buildIndex(plays, sets, teams) {
  const entries = [];

  // Players: one entry per name, with how many plays carry it
  const playerPlays = new Map();
  const playerWnba = new Set();
  const playById = new Map();
  plays.forEach((p) => {
    playById.set(Number(p.playID), p);
    if (isMismintPlay(p.playID)) return;
    const name = p.FullName && String(p.FullName).trim();
    if (!name) return;
    playerPlays.set(name, (playerPlays.get(name) || 0) + 1);
    if (isWnbaTeam(p.TeamAtMoment)) playerWnba.add(name);
  });
  playerPlays.forEach((n, name) => {
    const league = playerWnba.has(name) ? "WNBA" : "NBA";
    entries.push(entry("Player", name, `${league} · ${n} ${n === 1 ? "play" : "plays"}`, playerPath(name)));
  });

  // Teams: the synced store names them; the curated file adds historical
  // names (St. Louis Hawks finds the Atlanta Hawks) and the plays add any
  // spelling the chain used
  const teamNames = new Map();
  const addTeamName = (id, name, primary) => {
    if (!id || !name) return;
    const key = String(id);
    const t = teamNames.get(key) || { name: null, aliases: new Set() };
    const clean = String(name).trim();
    if (!clean) return;
    if (primary && !t.name) t.name = clean;
    else t.aliases.add(clean);
    teamNames.set(key, t);
  };
  teams.forEach((t) => addTeamName(t.TeamAtMomentNBAID, t.TeamName || t.TeamAtMoment, true));
  Object.entries(teamsAdditions).forEach(([id, t]) => {
    if (t.name) addTeamName(id, t.name, !teamNames.has(id));
    (t.historical_names || []).forEach((n) => addTeamName(id, n, false));
  });
  plays.forEach((p) => addTeamName(p.TeamAtMomentNBAID, p.TeamAtMoment, false));
  teamNames.forEach((t, id) => {
    if (!t.name) return;
    t.aliases.delete(t.name);
    entries.push(entry("Team", t.name, isWnbaTeam(t.name) ? "WNBA" : "NBA", `/teams/${id}`, [...t.aliases]));
  });

  // Sets
  const setById = new Map();
  sets.forEach((s) => {
    setById.set(Number(s.id), s);
    if (!s.setName) return;
    entries.push(entry("Set", s.setName, `Series ${s.series}`, `/sets/${Number(s.id)}`));
  });

  // Arenas: every venue the curated file names, keyed the way the Arenas
  // page and the arena route key them (the historical name when there is
  // one, the current name otherwise)
  const seenArenas = new Set();
  Object.values(teamsAdditions).forEach((t) => {
    (t.arenas || []).forEach((a) => {
      const name = a.name || a.arena;
      if (!name) return;
      const key = foldSearch(name);
      if (!key || seenArenas.has(key)) return;
      seenArenas.add(key);
      const where = [a.city, a.state].filter(Boolean).join(", ");
      entries.push(entry("Arena", name, where, arenaPath(name)));
    });
  });

  return { entries, playById, setById };
}

// How well an entry answers the query: exact name, then the name starting
// with it, then a word of the name starting with it (every word of a
// multi-word query must start a word), then the query anywhere inside
function scoreText(folded, q, qWords) {
  if (folded === q) return 0;
  if (folded.startsWith(q)) return 1;
  const words = folded.split(" ");
  if (qWords.every((w) => words.some((x) => x.startsWith(w)))) return 2;
  if (folded.includes(q)) return 3;
  return -1;
}

/** Results for a query, best first, at most SEARCH_LIMIT of them. */
export function searchIndex(index, query) {
  const raw = String(query || "").trim();
  const q = foldSearch(raw);
  if (!q || !index) return [];
  const qWords = q.split(" ");
  const out = [];

  // Ids first: a play id, a set id, or an edition key
  const idMatch = raw.match(/^(\d+)(?:_(\d+))?$/);
  if (idMatch) {
    const a = Number(idMatch[1]);
    const b = idMatch[2] === undefined ? null : Number(idMatch[2]);
    if (b === null) {
      const play = index.playById.get(a);
      if (play) out.push({ kind: "Play", name: String(a), detail: [play.FullName, play.TeamAtMoment].filter(Boolean).join(" · "), href: `/plays/${a}`, score: 0 });
      const set = index.setById.get(a);
      if (set) out.push({ kind: "Set", name: String(a), detail: set.setName, href: `/sets/${a}`, score: 0 });
    } else {
      const set = index.setById.get(a);
      const play = index.playById.get(b);
      if (set && play && (set.playIDs || []).some((p) => Number(p) === b)) {
        out.push({ kind: "Edition", name: `${a}_${b}`, detail: [play.FullName, set.setName].filter(Boolean).join(" · "), href: `/editions/${a}_${b}`, score: 0 });
      }
    }
  }

  index.entries.forEach((e) => {
    let score = scoreText(e.folded, q, qWords);
    let via = null;
    e.aliases.forEach((a) => {
      const s = scoreText(a.folded, q, qWords);
      if (s >= 0 && (score < 0 || s < score)) { score = s; via = a.text; }
    });
    if (score < 0) return;
    out.push({ kind: e.kind, name: e.name, detail: via ? `also ${via}` : e.detail, href: e.href, score });
  });

  out.sort((x, y) =>
    x.score - y.score
    || (KIND_ORDER[x.kind] ?? -1) - (KIND_ORDER[y.kind] ?? -1)
    || x.name.length - y.name.length
    || x.name.localeCompare(y.name));
  return out.slice(0, SEARCH_LIMIT);
}
