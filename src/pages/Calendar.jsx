import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { getAllPlaysDB, getAllSetsDB, getAllTeamsDB } from "../services/db.service";
import { harmonizePlayerProfiles } from "../services/relationship.service";
import { DataTable } from "../components/DataTable";
import playsExclude from "../../data/plays_exclude.json";
import { isMismintPlay } from "../services/overrides.service";
import { buildTeamNameMap, isNbaTeam, isWnbaTeam, scrubSentinels, blankZeroedFields, buildMatchupSides, renderMatchupCell, playerPath, calendarKey } from "../utils/display.utils";
import { useUrlParam } from "../hooks/useUrlParam";
import { LoadError } from "../components/LoadError";
import { Loader } from "../components/Loader";
import { toQuery } from "../utils/query";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const CURRENT_YEAR = new Date().getFullYear();
const TODAY_MONTH = new Date().getMonth();
const TODAY_DAY = new Date().getDate();
// Valid ?month= values, "1".."12"
const MONTH_PARAMS = Array.from({ length: 12 }, (_, i) => String(i + 1));

// Day links carry the current query along (?month/?year), so "Back to
// Calendar" returns to the same view instead of the current month/year
const dayLink = (dateKey) => `/calendar/${dateKey}${window.location.search || ""}`;

/**
 * One day's detail view (birthdays + historical moments). A real component
 * instead of the 200-line JSX blob the page used to build inside a useMemo;
 * the set mapping now only rebuilds when the sets actually change, not on
 * every date/year navigation.
 */
function CalendarDayDetail({ date, getDayEvents, sets, selectedYear, teamNameMap }) {
  const parts = date.split("-");
  const monthName = MONTH_NAMES[parseInt(parts[0]) - 1] || "Unknown";
  const dayVal = parseInt(parts[1]) || 0;

  // Same day-event resolution (incl. leap-year folding) as the grid view
  const { games: matchedPlays, birthdays: birthdayPlayers } = getDayEvents(parts[0], parts[1]);

  // Build play to sets mappings (depends only on the sets store)
  const playToSetsMap = useMemo(() => {
    const map = {};
    sets.forEach((set) => {
      if (set.playIDs) {
        set.playIDs.forEach((pID) => {
          if (!map[pID]) map[pID] = [];
          map[pID].push({
            id: set.id,
            name: set.setName,
            series: set.series,
            locked: set.locked
          });
        });
      }
    });
    return map;
  }, [sets]);

  const playsColumns = [
    { key: "playID", text: "Play ID" },
    { key: "SetIDs", text: "Set IDs", filterValue: (_val, rec) => rec.SetIDs_ids || [] },
    { key: "FullName", text: "Player Name" },
    { key: "PlayCategory", text: "Category" },
    { key: "DateOfMomentLocal", text: "Year" },
    { key: "matchup", text: "Matchup", align: "center", sortValue: (val, rec) => rec.AwayTeamName || "" }
  ];

  const playsRecords = matchedPlays.map((play) => {
    const playID = play.playID;
    const isMismint = isMismintPlay(playID);

    // Normalization fixes
    const metadata = blankZeroedFields(
      scrubSentinels(play),
      ["HomeTeamScore", "AwayTeamScore", "DraftYear", "Weight"]
    );

    // Stacked matchup cell (same convention as the Plays page)
    const matchupCell = renderMatchupCell(buildMatchupSides(metadata, teamNameMap));

    // Format Date cell to Year only and link to /calendar/mm-dd. Year and
    // key come straight from the stored "YYYY-MM-DD ..." string, no Date
    // parsing needed (and none of the cross-browser parsing pitfalls)
    let dateOfMomentCell = "-";
    const dateKey = calendarKey(metadata.DateOfMoment);
    if (dateKey) {
      const year = String(metadata.DateOfMoment).slice(0, 4);
      metadata.DateOfMomentLocal = year;
      dateOfMomentCell = (
        <Link to={dayLink(dateKey)} className="date-calendar-link">
          {year}
        </Link>
      );
    } else {
      metadata.DateOfMomentLocal = "";
    }

    // Generate Set Links cell: each set id opens THIS play's edition in
    // that set (set + play = edition), not the whole set
    const matchingSets = playToSetsMap[playID] || [];
    const setLinks = matchingSets.length > 0 ? (
      <div className="set-links-cell">
        {matchingSets.map((s, idx) => (
          <React.Fragment key={s.id}>
            {idx > 0 && ", "}
            <Link
              to={`/editions/${Number(s.id)}_${Number(playID)}`}
              className="set-link"
              title={`${s.name} (Series ${s.series}); opens edition ${Number(s.id)}_${Number(playID)}`}
            >
              {s.id}
            </Link>
          </React.Fragment>
        ))}
      </div>
    ) : (
      <span className="text-muted">-</span>
    );

    // Player name link; a team moment is named after its team and links to
    // the team page instead
    const playerName = metadata.FullName && metadata.FullName.trim() !== "" ? metadata.FullName.trim() : "";
    const teamMomentName = metadata.TeamAtMoment && metadata.TeamAtMoment.trim() !== "" ? metadata.TeamAtMoment.trim() : "";
    const displayName = playerName || teamMomentName || "Team Moment";
    const teamMomentId = !playerName && teamMomentName ? teamNameMap[teamMomentName.toLowerCase()] : null;
    const nameTarget = playerName
      ? playerPath(playerName)
      : (teamMomentId ? `/teams/${teamMomentId}` : null);

    const nameInner = (
      <>
        {displayName}
        {isMismint && <span className="mini-badge-mismint" title="This play is a mismint!">Mismint ⚠️</span>}
      </>
    );
    const fullNameCell = nameTarget ? (
      <Link to={nameTarget} className="player-detail-link font-hover-glow">{nameInner}</Link>
    ) : (
      <span className="player-detail-link">{nameInner}</span>
    );

    const playIDCell = (
      <Link to={`/plays/${playID}`} className="font-mono team-id-badge" style={{ display: "inline-block" }}>
        {playID}
      </Link>
    );

    return {
      ...metadata,
      playID_raw: Number(playID),
      playID: playIDCell,
      FullName: fullNameCell,
      DateOfMomentLocal: dateOfMomentCell,
      SetIDs: setLinks,
      SetIDs_ids: matchingSets.map((s) => Number(s.id)),
      matchup: matchupCell
    };
  });

  return (
    <>
      <div className="glass-panel info-banner">
        <h2>{monthName} {dayVal}</h2>
      </div>

      <div className="glass-panel" style={{ marginTop: "20px" }}>
        <h3 style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: "10px" }}>Player Birthdays</h3>
        <div className="birthdays-cards-container mt-20">
          {birthdayPlayers.length === 0 ? (
            <p className="text-muted text-center" style={{ padding: "20px", width: "100%" }}>
              No player birthdays registered on this day.
            </p>
          ) : (
            birthdayPlayers.map((p) => {
              const age = selectedYear - p.birthYear;
              return (
                <div key={p.name} className="birthday-profile-card glass-panel" style={{ background: "rgba(255,255,255,0.01)" }}>
                  <h3 style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                    <Link to={playerPath(p.name)} className="player-detail-link font-hover-glow">
                      {p.name}
                    </Link>
                    {p.league && (
                      <span style={{ fontSize: "0.7rem", padding: "2px 8px" }} className={`badge ${p.league === "NBA" ? "badge-nba" : "badge-wnba"}`}>
                        {p.league}
                      </span>
                    )}
                  </h3>
                  <p className="text-muted mt-6" style={{ fontSize: "0.95rem" }}>
                    Born:{" "}
                    <Link to={dayLink(calendarKey(p.birthdate))} className="date-calendar-link">
                      {p.birthdate}
                    </Link>
                    , turns <strong style={{ color: "var(--primary-hover)" }}>{age} years old</strong>
                  </p>
                  <p className="text-muted mt-4" style={{ fontSize: "0.85rem" }}>
                    Birthplace: <strong>{p.birthplace}</strong>
                  </p>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="glass-panel" style={{ marginTop: "24px" }}>
        <h3 style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: "10px", marginBottom: "20px" }}>Historical Moments</h3>
        {playsRecords.length === 0 ? (
          <p className="text-muted text-center" style={{ padding: "20px", width: "100%" }}>
            No game moments registered on this day in history.
          </p>
        ) : (
          <DataTable
            columns={playsColumns}
            records={playsRecords}
            keyColumn="playID_raw"
            defaultSortColumn="playID_raw"
            defaultSortOrder="desc"
            defaultPageSize={1000}
            hidePageSizeSelector={true}
            mismints={playsExclude}
            mismintKey="playID_raw"
          />
        )}
      </div>
    </>
  );
}

export function Calendar() {
  const { date } = useParams(); // MM-DD format
  const navigate = useNavigate();
  const [plays, setPlays] = useState([]);
  const [sets, setSets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  // The month tab lives in the URL (?month=1..12) so it survives a trip into
  // a day's detail page and back; it defaults to the current month
  const [monthParam, setMonthParam] = useUrlParam("month", null, MONTH_PARAMS);
  const selectedMonth = monthParam ? Number(monthParam) - 1 : TODAY_MONTH;
  const setSelectedMonth = useCallback((idx) => setMonthParam(String(idx + 1)), [setMonthParam]);
  // The year rides in the URL too (?year=), else the "Back to Calendar"
  // link from a day page would land on the right month of the wrong year
  const [yearParam, setYearParam] = useUrlParam("year", null);
  const selectedYear = yearParam ? Number(yearParam) : CURRENT_YEAR;
  const setSelectedYear = useCallback((y) => setYearParam(Number(y) === CURRENT_YEAR ? null : String(y)), [setYearParam]);
  const [teamNameMap, setTeamNameMap] = useState({});

  useEffect(() => {
    const loadData = async () => {
      try {
        const [dbPlays, dbSets, dbTeams] = await Promise.all([
          getAllPlaysDB(),
          getAllSetsDB(),
          getAllTeamsDB()
        ]);

        // Apply player profile harmonization across plays to fix empty birthplace/birthdates
        const harmonized = harmonizePlayerProfiles(dbPlays);

        setPlays(harmonized);
        setSets(dbSets);
        setTeamNameMap(buildTeamNameMap(dbTeams));
        setLoadError("");
      } catch (err) {
        console.error("Failed to load calendar data:", err);
        setLoadError("Could not read the calendar data from the local database.");
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, []);

  // Shortcut: /calendar/today redirects to the current date's page
  useEffect(() => {
    if (date === "today") {
      const key = `${String(TODAY_MONTH + 1).padStart(2, "0")}-${String(TODAY_DAY).padStart(2, "0")}`;
      navigate(`/calendar/${key}`, { replace: true });
    }
  }, [date, navigate]);

  // Set the correct month tab if date param changes in detail view
  useEffect(() => {
    if (date && date !== "today") {
      const parts = date.split("-");
      const mIdx = parseInt(parts[0]) - 1;
      if (mIdx >= 0 && mIdx < 12) {
        setSelectedMonth(mIdx);
      }
    }
  }, [date, setSelectedMonth]);

  // Plain arithmetic, no memos needed
  const isLeapYear = (selectedYear % 4 === 0 && selectedYear % 100 !== 0) || (selectedYear % 400 === 0);
  const totalDaysInSelectedMonth = selectedMonth === 1 ? (isLeapYear ? 29 : 28) : DAYS_IN_MONTH[selectedMonth];
  // Grid offsets math (first day of week: Sunday = 0)
  const firstDayOfWeekOffset = new Date(selectedYear, selectedMonth, 1).getDay();

  // Dynamic grouping logic de-duplicated per player/game date MM-DD
  const calendarData = useMemo(() => {
    const gamesByDate = {};
    const birthdaysByDate = {};

    plays.forEach((play) => {
      // 1. Group Games by DateOfMoment (Anniversaries)
      if (play.DateOfMoment) {
        // Format: YYYY-MM-DD HH:MM:SS EST
        const datePart = play.DateOfMoment.split(" ")[0];
        const parts = datePart.split("-");
        if (parts.length === 3) {
          const mm = parts[1];
          const dd = parts[2];
          const key = `${mm}-${dd}`;
          
          if (!gamesByDate[key]) gamesByDate[key] = [];
          gamesByDate[key].push(play);
        }
      }

      // 2. Group Birthdays by Birthdate
      if (play.Birthdate) {
        // Format: YYYY-MM-DD
        const parts = play.Birthdate.split("-");
        if (parts.length === 3) {
          const mm = parts[1];
          const dd = parts[2];
          const key = `${mm}-${dd}`;

          if (!birthdaysByDate[key]) birthdaysByDate[key] = new Map();
          
          const cleanName = play.FullName;
          if (cleanName) {
            // Store player info, using merged birthplace if conflict arose in harmonizer
            const birthplace = play.Birthplace_merged || play.Birthplace || "Unknown";
            const birthYear = parseInt(parts[0]);
            
            // Capture player league using TeamAtMoment
            const team = play.TeamAtMoment || "";
            const leagueName = isNbaTeam(team) ? "NBA" : isWnbaTeam(team) ? "WNBA" : "";
            
            birthdaysByDate[key].set(cleanName.toLowerCase(), {
              name: cleanName,
              birthplace,
              birthdate: play.Birthdate,
              birthYear,
              league: leagueName
            });
          }
        }
      }
    });

    return { gamesByDate, birthdaysByDate };
  }, [plays]);

  // Helper to fetch day events with active leap-year merging logic:
  // in a non-leap year, Feb 29 items are folded into Feb 28
  const getDayEvents = useCallback((mm, dd) => {
    const key = `${mm}-${dd}`;
    let games = calendarData.gamesByDate[key] || [];
    let birthdaysMap = calendarData.birthdaysByDate[key] || new Map();

    if (!isLeapYear && mm === "02" && dd === "28") {
      const feb29Games = calendarData.gamesByDate["02-29"] || [];
      games = [...games, ...feb29Games];

      const mergedMap = new Map(birthdaysMap);
      (calendarData.birthdaysByDate["02-29"] || new Map()).forEach((val, k) => {
        mergedMap.set(k, val);
      });
      birthdaysMap = mergedMap;
    }

    return { games, birthdays: Array.from(birthdaysMap.values()) };
  }, [calendarData, isLeapYear]);

  const showDayDetail = Boolean(date && date !== "today");


  if (loadError && !loading) {
    return <LoadError message={loadError} onRetry={() => window.location.reload()} />;
  }

  if (loading) {
    return (
      <Loader message={<>Structuring anniversary calendars and birthday schedules...</>} />
    );
  }

  return (
    <div className="calendar-page-container">
      {/* Dynamic Subroute View */}
      {showDayDetail ? (
        <div className="calendar-detail-section">
          <div className="d-flex align-center gap-10" style={{ marginBottom: "20px" }}>
            <Link
              to={(() => {
                const params = new URLSearchParams();
                if (monthParam) params.set("month", monthParam);
                if (yearParam) params.set("year", yearParam);
                const qs = toQuery(params);
                return `/calendar${qs ? `?${qs}` : ""}`;
              })()}
              className="text-muted"
            >← Back to Calendar</Link>
          </div>

          <CalendarDayDetail
            date={date}
            getDayEvents={getDayEvents}
            sets={sets}
            selectedYear={selectedYear}
            teamNameMap={teamNameMap}
          />
        </div>
      ) : (
        /* Annual Calendar Grid Overview */
        <div className="calendar-grid-section">
          <div className="glass-panel info-banner">
            <h2>Calendar</h2>
            <p className="text-muted mt-8" style={{ fontSize: "0.95rem" }}>
              Every day of the year: the moments that happened on it (🎥) and the players born on it (🎂). Click a
              count to see the list.
            </p>
          </div>

          {/* Year and Month controls row */}
          <div className="calendar-controls mt-20">
            <div className="glass-panel year-selector-panel">
              <span className="control-label">Calendar Year Context:</span>
              <div className="year-input-group">
                <button className="year-nav-btn" onClick={() => setSelectedYear(prev => Math.max(2000, prev - 1))}>◀</button>
                <input
                  type="number"
                  className="year-input"
                  value={selectedYear}
                  onChange={(e) => setSelectedYear(parseInt(e.target.value) || CURRENT_YEAR)}
                  min="2000"
                  max="2100"
                />
                <button className="year-nav-btn" onClick={() => setSelectedYear(prev => Math.min(2100, prev + 1))}>▶</button>
              </div>
              {isLeapYear ? (
                <span className="leap-year-tag">🌟 Leap year, so February has 29 days</span>
              ) : (
                <span className="leap-year-tag" style={{ background: "rgba(255,255,255,0.05)", color: "var(--text-muted)", borderColor: "rgba(255,255,255,0.08)" }}>Not a leap year, so February has 28 days</span>
              )}
            </div>

            {/* Month selector Tabs */}
            <div className="month-tabs flex-1">
              {MONTH_NAMES.map((mName, idx) => (
                <button
                  key={mName}
                  onClick={() => setSelectedMonth(idx)}
                  className={`month-tab-btn ${selectedMonth === idx ? "active" : ""}`}
                >
                  {mName}
                </button>
              ))}
            </div>
          </div>

          {/* Render Calendar Grid for the Selected Month */}
          <div className="glass-panel month-calendar-wrapper mt-20">
            <h3 className="month-title">{MONTH_NAMES[selectedMonth]} {selectedYear}</h3>
            
            {/* Weekday Headers starting with Sunday */}
            <div className="calendar-week-headers mt-20">
              <div>Sun</div>
              <div>Mon</div>
              <div>Tue</div>
              <div>Wed</div>
              <div>Thu</div>
              <div>Fri</div>
              <div>Sat</div>
            </div>

            {/* Calendar Days Weekly Grid */}
            <div className="month-calendar-grid">
              {/* Padding offset empty blocks for preceding weekday columns */}
              {Array.from({ length: firstDayOfWeekOffset }).map((_, idx) => (
                <div key={`empty-${idx}`} className="calendar-day-box empty-day-box"></div>
              ))}

              {/* Render month days */}
              {Array.from({ length: totalDaysInSelectedMonth }, (_, dayIdx) => {
                const dayNum = dayIdx + 1;
                const mm = String(selectedMonth + 1).padStart(2, "0");
                const dd = String(dayNum).padStart(2, "0");
                const dateKey = `${mm}-${dd}`;

                const { games, birthdays } = getDayEvents(mm, dd);
                const gamesCount = games.length;
                const birthdaysCount = birthdays.length;

                const handleClickDay = () => {
                  if (gamesCount > 0 || birthdaysCount > 0) {
                    navigate(dayLink(dateKey));
                  }
                };

                const isToday = selectedMonth === TODAY_MONTH && dayNum === TODAY_DAY;

                return (
                  <div
                    key={dayNum}
                    className={`calendar-day-box ${gamesCount > 0 || birthdaysCount > 0 ? "has-events" : ""} ${isToday ? "is-today" : ""}`}
                    onClick={handleClickDay}
                    title={isToday ? "Today" : undefined}
                    style={{ cursor: (gamesCount > 0 || birthdaysCount > 0) ? "pointer" : "default" }}
                  >
                    <span className="day-number">{dayNum}</span>
                    <div className="day-badges mt-8">
                      {gamesCount > 0 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(dayLink(dateKey));
                          }}
                          className="day-badge-btn badge-games"
                          title={`${gamesCount} game anniversaries`}
                        >
                          🎥 {gamesCount}
                        </button>
                      )}
                      {birthdaysCount > 0 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(dayLink(dateKey));
                          }}
                          className="day-badge-btn badge-birthdays"
                          title={`${birthdaysCount} player birthdays`}
                        >
                          🎂 {birthdaysCount}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <style>{`
        .calendar-page-container {
          max-width: 1250px;
          margin: 0 auto;
          width: 100%;
        }
        .calendar-controls {
          display: flex;
          align-items: center;
          gap: 16px;
          flex-wrap: wrap;
        }
        .year-selector-panel {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px 16px;
          margin: 0;
          background: rgba(10, 11, 16, 0.4);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 12px;
        }
        .control-label {
          font-size: 0.85rem;
          color: var(--text-muted);
          font-weight: 600;
        }
        .year-input-group {
          display: flex;
          align-items: center;
          background: rgba(0, 0, 0, 0.3);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 6px;
          padding: 2px;
        }
        .year-nav-btn {
          background: transparent;
          border: none;
          color: var(--text-muted);
          cursor: pointer;
          padding: 4px 8px;
          font-size: 0.8rem;
          transition: var(--transition-smooth);
        }
        .year-nav-btn:hover {
          color: #fff;
        }
        .year-input {
          width: 60px;
          border: none;
          background: transparent;
          text-align: center;
          color: #fff;
          font-weight: 700;
          font-family: var(--font-mono);
          font-size: 0.95rem;
          padding: 2px;
          outline: none;
        }
        .year-input::-webkit-outer-spin-button,
        .year-input::-webkit-inner-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        .leap-year-tag {
          font-size: 0.75rem;
          font-weight: 700;
          background: rgba(139, 92, 246, 0.12);
          color: var(--primary-hover);
          padding: 4px 8px;
          border-radius: 6px;
          border: 1px solid rgba(139, 92, 246, 0.2);
          white-space: nowrap;
        }
        .month-tabs {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
          background: rgba(10, 11, 16, 0.4);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 12px;
          padding: 6px;
        }
        .month-tab-btn {
          background: transparent;
          border: none;
          color: var(--text-muted);
          padding: 8px 12px;
          border-radius: 6px;
          font-weight: 600;
          font-size: 0.85rem;
          cursor: pointer;
          transition: var(--transition-smooth);
        }
        .month-tab-btn:hover, .month-tab-btn.active {
          color: #fff;
          background: var(--primary);
          box-shadow: 0 4px 12px var(--primary-glow);
        }
        .month-calendar-wrapper {
          padding: 24px;
        }
        .month-title {
          font-size: 1.5rem;
          font-weight: 700;
          color: #fff;
          border-left: 4px solid var(--primary);
          padding-left: 12px;
        }
        .calendar-week-headers {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 12px;
          text-align: center;
          font-weight: 700;
          color: var(--text-muted);
          text-transform: uppercase;
          font-size: 0.8rem;
          margin-bottom: 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          padding-bottom: 8px;
        }
        .month-calendar-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 12px;
        }
        .calendar-day-box {
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.04);
          border-radius: 10px;
          padding: 12px;
          min-height: 100px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          transition: var(--transition-smooth);
        }
        .calendar-day-box.empty-day-box {
          background: transparent !important;
          border: none !important;
          cursor: default !important;
          pointer-events: none;
        }
        .calendar-day-box.has-events {
          background: rgba(255,255,255,0.03);
          border-color: rgba(255,255,255,0.08);
        }
        .calendar-day-box.has-events:hover {
          transform: translateY(-2px);
          border-color: var(--primary);
          box-shadow: 0 4px 15px rgba(139, 92, 246, 0.08);
        }
        .calendar-day-box.is-today {
          border-color: var(--primary);
          background: rgba(139, 92, 246, 0.14);
          box-shadow: 0 0 14px rgba(139, 92, 246, 0.3);
        }
        .calendar-day-box.is-today .day-number {
          color: var(--primary-hover);
        }
        .day-number {
          font-size: 1rem;
          font-weight: 700;
          color: var(--text-muted);
        }
        .calendar-day-box.has-events .day-number {
          color: #fff;
        }
        .day-badges {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .day-badge-btn {
          border: none;
          font-size: 1.2rem;
          font-weight: 700;
          padding: 8px 10px;
          width: 100%;
          border-radius: 6px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          transition: var(--transition-smooth);
          justify-content: center;
        }
        .badge-games {
          background: rgba(59, 130, 246, 0.08);
          color: var(--accent-nba);
          border: 1px solid rgba(59, 130, 246, 0.2);
        }
        .badge-games:hover {
          background: var(--accent-nba);
          color: #fff;
          box-shadow: 0 2px 8px rgba(59, 130, 246, 0.3);
        }
        .badge-birthdays {
          background: rgba(139, 92, 246, 0.08);
          color: var(--primary-hover);
          border: 1px solid rgba(139, 92, 246, 0.2);
        }
        .badge-birthdays:hover {
          background: var(--primary);
          color: #fff;
          box-shadow: 0 2px 8px rgba(139, 92, 246, 0.3);
        }
        .birthdays-cards-container {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(min(360px, 100%), 1fr));
          gap: 20px;
        }
        @media (max-width: 768px) {
          .month-calendar-grid,
          .calendar-week-headers {
            gap: 4px;
          }
          .calendar-day-box {
            padding: 6px;
            min-height: 74px;
            border-radius: 6px;
          }
          .day-badge-btn {
            font-size: 0.95rem;
            padding: 4px 5px;
            gap: 3px;
          }
          .month-tab-btn {
            padding: 6px 8px;
            font-size: 0.75rem;
          }
          .year-selector-panel {
            width: 100%;
            flex-wrap: wrap;
          }
        }
        .birthday-profile-card {
          margin: 0;
          padding: 24px;
          border: 1px solid rgba(255,255,255,0.05);
          position: relative;
        }
      `}</style>
    </div>
  );
}
