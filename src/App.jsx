import { useEffect, useRef, lazy, Suspense } from "react";

// Dev-only emoji lab: the guard is a build-time constant, so the page, its
// fonts and manifest are excluded from production bundles entirely
const EmojiLab = import.meta.env.DEV ? lazy(() => import("./dev/EmojiLab")) : null;
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation, useNavigationType } from "react-router-dom";
import { initFCL } from "./services/fcl.service";
import { runSmartSync } from "./services/sync.coordinator";
import { Navbar } from "./components/Navbar";

// Only the landing page ships in the entry bundle. Every other page is
// its own chunk, loaded on first visit; the idle prefetch below then
// warms EVERY chunk right after startup, so in-app navigation never
// waits on the network (the split only lightens the first paint).
import { Home } from "./pages/Home";

const loadPlays = () => import("./pages/Plays");
const loadPlayDetail = () => import("./pages/PlayDetail");
const loadSets = () => import("./pages/Sets");
const loadSetDetail = () => import("./pages/SetDetail");
const loadAccount = () => import("./pages/Account");
const loadAccountOffers = () => import("./pages/AccountOffers");
const loadOffers = () => import("./pages/Offers");
const loadSettings = () => import("./pages/Settings");
const loadPlayers = () => import("./pages/Players");
const loadPlayerDetail = () => import("./pages/PlayerDetail");
const loadTeams = () => import("./pages/Teams");
const loadTeamDetail = () => import("./pages/TeamDetail");
const loadAbout = () => import("./pages/About");
const loadArenas = () => import("./pages/Arenas");
const loadSeasons = () => import("./pages/Seasons");
const loadCalendar = () => import("./pages/Calendar");
const loadLive = () => import("./pages/Live");
const loadCorrections = () => import("./pages/Corrections");
const loadEditionDetail = () => import("./pages/EditionDetail");
const loadArenaDetail = () => import("./pages/ArenaDetail");
const loadAnnotate = () => import("./pages/Annotate");
const loadAssets = () => import("./pages/Assets");
const loadLegacy = () => import("./pages/Legacy");
const loadGlossary = () => import("./pages/Glossary");
const loadCubeLab = () => import("./pages/CubeLab");
const loadEarlyAdopters = () => import("./pages/EarlyAdopters");

const PAGE_LOADERS = [
  loadPlays, loadPlayDetail, loadSets, loadSetDetail, loadAccount,
  loadAccountOffers, loadOffers, loadSettings, loadPlayers, loadPlayerDetail,
  loadTeams, loadTeamDetail, loadAbout, loadArenas, loadSeasons, loadCalendar,
  loadLive, loadCorrections, loadEditionDetail, loadArenaDetail, loadAnnotate, loadAssets, loadLegacy, loadGlossary, loadCubeLab, loadEarlyAdopters
];

// Pages export named components; lazy() wants a default
const page = (load, name) => lazy(() => load().then((m) => ({ default: m[name] })));

const Plays = page(loadPlays, "Plays");
const PlayDetail = page(loadPlayDetail, "PlayDetail");
const Sets = page(loadSets, "Sets");
const SetDetail = page(loadSetDetail, "SetDetail");
const Account = page(loadAccount, "Account");
const AccountOffers = page(loadAccountOffers, "AccountOffers");
const Offers = page(loadOffers, "Offers");
const Settings = page(loadSettings, "Settings");
const EarlyAdopters = page(loadEarlyAdopters, "EarlyAdopters");
const Players = page(loadPlayers, "Players");
const PlayerDetail = page(loadPlayerDetail, "PlayerDetail");
const Teams = page(loadTeams, "Teams");
const TeamDetail = page(loadTeamDetail, "TeamDetail");
const About = page(loadAbout, "About");
const Arenas = page(loadArenas, "Arenas");
const Seasons = page(loadSeasons, "Seasons");
const Calendar = page(loadCalendar, "Calendar");
const Live = page(loadLive, "Live");
const Corrections = page(loadCorrections, "Corrections");
const EditionDetail = page(loadEditionDetail, "EditionDetail");
const ArenaDetail = page(loadArenaDetail, "ArenaDetail");
const Annotate = page(loadAnnotate, "Annotate");
const Assets = page(loadAssets, "Assets");
const Legacy = page(loadLegacy, "Legacy");
const Glossary = page(loadGlossary, "Glossary");
const CubeLab = page(loadCubeLab, "CubeLab");

// Initialize FCL immediately on load to prevent child components from querying before FCL is ready
initFCL();

/**
 * Scroll on navigation. Forward (PUSH) starts at the top: a link clicked
 * halfway down the plays list must not open the play page halfway down
 * too. Back and forward (POP) return to where the reader was on that
 * history entry: the browser's own restoration fires before a page's data
 * has rendered, when the page is still short, so the position is kept
 * per history key here and restored once the page is tall enough.
 */
const scrollPositions = new Map();
function ScrollToTop() {
  const location = useLocation();
  const type = useNavigationType();
  const lastY = useRef(0);
  const prevKey = useRef(location.key);
  useEffect(() => {
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
    const onScroll = () => { lastY.current = window.scrollY; };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    // The entry just left keeps the position it was scrolled to
    if (prevKey.current !== location.key) scrollPositions.set(prevKey.current, lastY.current);
    prevKey.current = location.key;
    if (type === "POP") {
      const target = scrollPositions.get(location.key) || 0;
      if (target > 0) {
        // Wait for the page to grow back to the height it had; give up
        // after two seconds and settle for what is there
        let tries = 0;
        const attempt = () => {
          const max = document.documentElement.scrollHeight - window.innerHeight;
          if (max >= target || tries >= 20) { window.scrollTo(0, Math.min(target, Math.max(0, max))); return; }
          tries++;
          setTimeout(attempt, 100);
        };
        attempt();
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [location.key, type]);
  return null;
}

function App() {
  // Initialize database sync on startup
  useEffect(() => {
    runSmartSync();
  }, []);

  // Warm every page chunk once the browser is idle: first paint stays
  // light, later navigation is served from cache
  useEffect(() => {
    const warm = () => PAGE_LOADERS.forEach((load) => load().catch(() => { /* offline: the route loads on demand */ }));
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 2500);
    return () => clearTimeout(id);
  }, []);

  return (
    <Router>
      <ScrollToTop />
      {/* Premium Glassmorphic Header */}
      <Navbar />

      {/* Main Pages Content Container */}
      <main className="app-main">
        <Suspense fallback={<div className="loader-container"><div className="spinner"></div></div>}>
        <Routes>
          {import.meta.env.DEV && EmojiLab && (
            <Route path="/dev/emoji" element={<Suspense fallback={null}><EmojiLab /></Suspense>} />
          )}
          <Route path="/" element={<Home />} />
          <Route path="/plays" element={<Plays />} />
          <Route path="/plays/:playID" element={<PlayDetail />} />
          <Route path="/sets" element={<Sets />} />
          <Route path="/sets/:setID" element={<SetDetail />} />
          <Route path="/editions/:editionKey" element={<EditionDetail />} />
          <Route path="/corrections" element={<Corrections />} />
          <Route path="/account/:address" element={<Account />} />
          <Route path="/account/:address/offers" element={<AccountOffers />} />
          <Route path="/offers" element={<Offers />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/about/early-adopters" element={<EarlyAdopters />} />
          <Route path="/early-adopters" element={<Navigate to="/about/early-adopters" replace />} />
          <Route path="/players" element={<Players />} />
          <Route path="/players/:playerName" element={<PlayerDetail />} />
           <Route path="/teams" element={<Teams />} />
          <Route path="/teams/:teamID" element={<TeamDetail />} />
          <Route path="/seasons" element={<Seasons />} />
          <Route path="/arenas" element={<Arenas />} />
          <Route path="/arenas/:arenaName" element={<ArenaDetail />} />
          <Route path="/about" element={<About />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/calendar/:date" element={<Calendar />} />
          <Route path="/live" element={<Live />} />
          {/* Experimental frame annotator; no nav link yet */}
          <Route path="/annotate" element={<Annotate />} />
          <Route path="/assets" element={<Assets />} />
          {/* Old nbatopshot.com links: a paste box, and the old path mirrored
              under /legacy/ redirects straight through when it resolves */}
          <Route path="/legacy" element={<Legacy />} />
          <Route path="/legacy/*" element={<Legacy />} />
          <Route path="/glossary" element={<Glossary />} />
          <Route path="/cube" element={<CubeLab />} />
          {/* The page shipped as /marketplace for a day; keep old links alive */}
          <Route path="/marketplace" element={<Navigate to="/live" replace />} />
          <Route
            path="*"
            element={
              <div className="glass-panel text-center" style={{ padding: "60px 20px" }}>
                <h2>Page not found</h2>
                <p className="text-muted mt-8">There is nothing at this address.</p>
                <a href="/" className="btn-primary mt-20" style={{ display: "inline-flex" }}>Home</a>
              </div>
            }
          />
        </Routes>
        </Suspense>
      </main>

      {/* Embedded Global Styles for Layout structure */}
      <style>{`
        .app-main {
          padding: 0 24px 60px;
          width: 100%;
          min-width: 0;
          box-sizing: border-box;
        }
      `}</style>
    </Router>
  );
}

export default App;
