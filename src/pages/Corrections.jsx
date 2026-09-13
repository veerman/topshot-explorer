import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { DataTable } from "../components/DataTable";
import { getAllPlaysDB, getAllPlaysRawDB } from "../services/db.service";
import { useSyncStatus, useReloadOnSyncComplete } from "../hooks/useSyncStatus";
import { useLoad } from "../hooks/useLoad";
import { LoadError } from "../components/LoadError";
import { Loader } from "../components/Loader";
import { runDataAudits, buildCorrectionLedger, summarizeLedger } from "../services/audit.service";
import { useUrlParam } from "../hooks/useUrlParam";

const QUEUE_KEY = "errors_fix_queue_v1";
const IGNORED_KEY = "errors_ignored_findings_v1";

// Ledger tier pills, in URL order; every combination is a valid ?tiers= value
const TIER_KEYS = ["factual", "routine", "context"];
const TIER_COMBOS = ["none", ...Array.from({ length: 7 }, (_, i) => TIER_KEYS.filter((_, j) => (i + 1) & (1 << j)).join(","))];
const DEFAULT_TIERS = "factual,routine";

function loadStored(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function saveStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable; queue lives for the session only */
  }
}

function CopyButton({ text, label = "Copy JSON" }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn-primary copy-json-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable; the JSON is still selectable */
        }
      }}
    >
      {copied ? "Copied!" : label}
    </button>
  );
}

// Play ID link with its one-line context (team · date · season · category)
function PlayRef({ id, context }) {
  return (
    <span className="finding-play-ref">
      <Link to={`/plays/${id}`} className="finding-row-play font-mono">#{id}</Link>
      {context && <span className="chip-context"> {context}</span>}
    </span>
  );
}

// Plays behind a finding, per candidate value, capped so a 40-play conflict
// does not swallow the page
const MAX_PLAY_REFS = 6;
function FindingPlays({ finding }) {
  if (!finding.contexts || finding.values.length === 0) return null;
  return (
    <div className="finding-plays">
      {finding.values.map((v) => (
        <div key={v.value} className="finding-plays-row">
          {finding.values.length > 1 && <span className="finding-plays-value font-mono">"{v.value}"</span>}
          {v.playIDs.slice(0, MAX_PLAY_REFS).map((id) => <PlayRef key={id} id={id} context={finding.contexts[id]} />)}
          {v.playIDs.length > MAX_PLAY_REFS && <span className="text-muted">+{v.playIDs.length - MAX_PLAY_REFS} more</span>}
        </div>
      ))}
    </div>
  );
}

// One compact finding row. Conflict findings render their candidate values as
// chips: clicking a chip queues "standardize on this value". Single-fix
// findings (tag mismatches) render one queue button.
function FindingRow({ finding, queuedFix, ignored, onQueue, onUnqueue, onIgnore, onRestore }) {
  const isConflict = finding.values.length > 0;

  return (
    <div className={`finding-row${ignored ? " ignored" : ""}${queuedFix ? " queued" : ""}`}>
      <div className="finding-row-main">
        <span className="finding-row-title">{finding.title}</span>
        {finding.field && <span className="finding-row-field font-mono">{finding.field}</span>}
        {!isConflict && (
          <PlayRef id={finding.playIDs[0]} context={finding.contexts && finding.contexts[finding.playIDs[0]]} />
        )}
        {finding.detail && <span className="finding-row-detail text-muted">{finding.detail}</span>}
        {finding.premise && (
          <span className="finding-row-premise">
            {finding.premise}
            {finding.premisePlayID && (
              <>
                {" "}
                <Link to={`/plays/${finding.premisePlayID}`} className="finding-row-play font-mono">view</Link>
              </>
            )}
          </span>
        )}
        {finding.blocked && (
          <span className="blocked-badge" title={finding.blockedReason}>⚠ fix upstream first</span>
        )}

        {isConflict && (
          <span className="value-chips">
            {finding.values.map((v, i) => {
              const fix = finding.fixes[i];
              // No fix for this value: informational chip, not a button
              if (!fix) {
                return (
                  <span key={v.value} className="value-chip" style={{ cursor: "default" }} title={`Plays: ${v.playIDs.join(", ")}`}>
                    "{v.value}" <span className="chip-count font-mono">x{v.playIDs.length}</span>
                  </span>
                );
              }
              const chosen = queuedFix && queuedFix.label === fix.label;
              return (
                <button
                  key={v.value}
                  className={`value-chip${chosen ? " chosen" : ""}`}
                  disabled={ignored}
                  title={`Plays: ${v.playIDs.join(", ")}`}
                  onClick={() => (chosen ? onUnqueue(finding.key) : onQueue(finding.key, fix))}
                >
                  "{v.value}" <span className="chip-count font-mono">x{v.playIDs.length}</span>
                </button>
              );
            })}
          </span>
        )}
        <FindingPlays finding={finding} />
      </div>

      <div className="finding-row-actions">
        {!isConflict && !ignored && finding.fixes.length > 0 && (
          queuedFix ? (
            <button className="row-btn queued-btn" onClick={() => onUnqueue(finding.key)}>Queued ✓</button>
          ) : (
            <button className="row-btn queue-btn" onClick={() => onQueue(finding.key, finding.fixes[0])}>{finding.fixes[0].label}</button>
          )
        )}
        {isConflict && queuedFix && <span className="queued-note font-mono">queued</span>}
        {ignored ? (
          <button className="row-btn" onClick={() => onRestore(finding.key)}>Restore</button>
        ) : (
          <button className="row-btn ignore-btn" onClick={() => onIgnore(finding.key)}>Ignore</button>
        )}
      </div>
    </div>
  );
}

// A collapsible category. The description lives here, once, not on every row.
function FindingsCategory({ title, intro, hint, findings, queuedMap, ignoredSet, showIgnored, onQueue, onUnqueue, onIgnore, onRestore, allowBulk, startClosed }) {
  const [open, setOpen] = useState(!startClosed && findings.length > 0 && findings.length <= 100);

  const visible = showIgnored ? findings : findings.filter((f) => !ignoredSet.has(f.key));
  const ignoredCount = findings.filter((f) => ignoredSet.has(f.key)).length;
  const queuedCount = findings.filter((f) => queuedMap.has(f.key)).length;
  const openCount = findings.length - ignoredCount - queuedCount;
  const blockedCount = findings.filter((f) => f.blocked && !ignoredSet.has(f.key)).length;

  // Blocked findings never enter bulk actions: their computed side depends on
  // an upstream finding that is still open.
  const bulkTargets = allowBulk
    ? visible.filter((f) => !f.blocked && !ignoredSet.has(f.key) && !queuedMap.has(f.key))
    : [];

  return (
    <details className="findings-category glass-panel mt-20" open={open} onToggle={(e) => setOpen(e.target.open)}>
      <summary>
        <span className="category-title">{title}</span>
        <span className="category-counts font-mono">
          {openCount} {startClosed ? "listed" : "open"}{blockedCount > 0 && ` · ${blockedCount} blocked`}{queuedCount > 0 && ` · ${queuedCount} queued`}{ignoredCount > 0 && ` · ${ignoredCount} ignored`}
        </span>
      </summary>
      <p className="category-intro text-muted">{intro}{hint && <span className="category-hint"> {hint}</span>}</p>

      {bulkTargets.length > 1 && (
        <button
          className="row-btn queue-btn bulk-btn"
          onClick={() => bulkTargets.forEach((f) => onQueue(f.key, f.fixes[0]))}
        >
          Queue all {bulkTargets.length} open fixes
        </button>
      )}

      {visible.length === 0 ? (
        <p className="text-muted mt-10" style={{ fontStyle: "italic", fontSize: "0.85rem" }}>Nothing open here.</p>
      ) : (
        visible.map((f) => (
          <FindingRow
            key={f.key}
            finding={f}
            queuedFix={queuedMap.get(f.key)}
            ignored={ignoredSet.has(f.key)}
            onQueue={onQueue}
            onUnqueue={onUnqueue}
            onIgnore={onIgnore}
            onRestore={onRestore}
          />
        ))
      )}
    </details>
  );
}

// One decision covering one or more plays: a single button queues the same fix
// for every listed play in the group.
function TagGroup({ group, showNames, queuedMap, ignoredSet, showIgnored, onQueue, onUnqueue, onIgnore, onRestore }) {
  const { label, items } = group;
  const visible = showIgnored ? items : items.filter((f) => !ignoredSet.has(f.key));
  if (visible.length === 0) return null;
  const allIgnored = items.every((f) => ignoredSet.has(f.key));
  const live = items.filter((f) => !ignoredSet.has(f.key));
  const actionable = live.filter((f) => !f.blocked);
  const unqueued = actionable.filter((f) => !queuedMap.has(f.key));
  const queuedCount = actionable.length - unqueued.length;
  const hasFix = items[0].fixes.length > 0;
  // Plays in one group can carry different recommendations (each derives its
  // own season from its own date); collapse to one label only when uniform
  const labels = new Set(items.map((f) => f.fixes[0] && f.fixes[0].label).filter(Boolean));
  const fixLabel = labels.size === 1 ? [...labels][0] : "Queue recommended fixes";
  const premises = new Set(items.map((f) => f.premise).filter(Boolean));
  const premise = premises.size === 1 ? items[0].premise : "";

  return (
    <div className={`tag-group${allIgnored ? " ignored" : ""}`}>
      <div className="tag-group-header">
        <span className="tag-group-label">{label}</span>
        {premise && (
          <span className="finding-row-premise">
            {premise}
            {items[0].premisePlayID && (
              <>
                {" "}
                <Link to={`/plays/${items[0].premisePlayID}`} className="finding-row-play font-mono">view</Link>
              </>
            )}
          </span>
        )}
        <span className="tag-group-actions">
          {allIgnored ? (
            <button className="row-btn" onClick={() => items.forEach((f) => onRestore(f.key))}>Restore</button>
          ) : (
            <>
              {hasFix && unqueued.length > 0 && (
                <button className="row-btn queue-btn" onClick={() => unqueued.forEach((f) => onQueue(f.key, f.fixes[0]))}>
                  {fixLabel}{unqueued.length > 1 ? ` (${unqueued.length} plays)` : ""}
                </button>
              )}
              {hasFix && unqueued.length === 0 && queuedCount > 0 && (
                <button className="row-btn queued-btn" onClick={() => actionable.forEach((f) => onUnqueue(f.key))}>Queued ✓</button>
              )}
              <button className="row-btn ignore-btn" onClick={() => live.forEach((f) => onIgnore(f.key))}>Ignore</button>
            </>
          )}
        </span>
      </div>
      <div className={`tag-group-chips${premise ? "" : " tag-group-rows"}`}>
        {visible.map((f) => (
          <span
            key={f.key}
            className={`play-chip${f.blocked ? " blocked" : ""}${queuedMap.has(f.key) ? " queued" : ""}`}
            title={f.blocked ? f.blockedReason : undefined}
          >
            <Link to={`/plays/${f.playIDs[0]}`} className="play-chip-link font-mono">
              {showNames ? `${f.title} ` : ""}#{f.playIDs[0]}
            </Link>
            {/* A team moment's title is its team; do not say it twice */}
            {f.context && <span className="chip-context"> · {showNames && f.context.startsWith(`${f.title} · `) ? f.context.slice(f.title.length + 3) : f.context}</span>}
            {!premise && f.premise && <span className="chip-context"> · {f.premise}</span>}
            {!premise && f.fixes[0] && <span className="chip-fix"> → {f.fixes[0].label}</span>}
            {f.blocked && " ⚠"}
            {queuedMap.has(f.key) && " ✓"}
          </span>
        ))}
      </div>
    </div>
  );
}

// One collapsible section per tag type. Our derivation is authoritative for
// display; stored Dapper tags that agree with it are stripped by the
// reconciler (npm run reconcile, also prebuild) and never shown here. What
// remains are disagreements: correction markers needing judgment. Each
// description appears exactly once; below it, one TagGroup per decision.
function TagSection({ section, queuedMap, ignoredSet, showIgnored, onQueue, onUnqueue, onIgnore, onRestore }) {
  const { shortTag, longTag, disagreements } = section;
  const ignoredCount = disagreements.filter((f) => ignoredSet.has(f.key)).length;
  const queuedCount = disagreements.filter((f) => queuedMap.has(f.key)).length;
  const blockedCount = disagreements.filter((f) => f.blocked && !ignoredSet.has(f.key)).length;
  const openCount = disagreements.length - ignoredCount - queuedCount;

  const groupsOf = (list) => {
    const m = new Map();
    list.forEach((f) => {
      if (!m.has(f.group)) m.set(f.group, { key: f.group, label: f.groupLabel, items: [] });
      m.get(f.group).items.push(f);
    });
    return [...m.values()];
  };
  const disagreementGroups = groupsOf(disagreements);
  const [open, setOpen] = useState(disagreementGroups.length <= 40);

  const handlers = { queuedMap, ignoredSet, showIgnored, onQueue, onUnqueue, onIgnore, onRestore };
  // Team+season groups span players, so chips carry names; player-labeled
  // groups (TSD, RY) only need the play IDs
  const showNames = shortTag === "CY";

  return (
    <details className="findings-category glass-panel mt-20" open={open} onToggle={(e) => setOpen(e.target.open)}>
      <summary>
        <span className="category-title">{longTag} ({shortTag})</span>
        <span className="category-counts font-mono">
          {openCount} open{blockedCount > 0 && ` · ${blockedCount} blocked`}{queuedCount > 0 && ` · ${queuedCount} queued`}{ignoredCount > 0 && ` · ${ignoredCount} ignored`}
        </span>
      </summary>

      <div className="tag-subblock">
        {disagreementGroups.map((g) => <TagGroup key={g.key} group={g} showNames={showNames} {...handlers} />)}
      </div>
    </details>
  );
}

export function Corrections() {
  const [playsCorrected, setPlaysCorrected] = useState([]);
  const [playsRaw, setPlaysRaw] = useState([]);
  const syncState = useSyncStatus();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  // Applied Corrections is the default tab; ?tab=
  // values are unchanged, so old ?tab=ledger and ?tab=findings links both
  // still land where they always did
  const [activeTab, setActiveTab] = useUrlParam("tab", "ledger", ["findings", "ledger", "guide"]);

  // Fix queue & ignored findings, persisted across sessions
  const [queue, setQueue] = useState(() => loadStored(QUEUE_KEY, []));
  const [ignoredKeys, setIgnoredKeys] = useState(() => loadStored(IGNORED_KEY, []));
  const [showIgnored, setShowIgnored] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  useEffect(() => saveStored(QUEUE_KEY, queue), [queue]);
  useEffect(() => saveStored(IGNORED_KEY, ignoredKeys), [ignoredKeys]);

  // Filter States (Applied Corrections ledger). Context additions (dapper IDs,
  // tags) vastly outnumber real corrections, so they are hidden by default.
  // Mismints-only and the tier pills live in the URL (?mismints=1,
  // ?tiers=factual,routine) so the home page can deep-link into the ledger
  const [mismintsParam, setMismintsParam] = useUrlParam("mismints", "0", ["0", "1"]);
  const showOnlyMismints = mismintsParam === "1";
  const setShowOnlyMismints = (on) => setMismintsParam(on ? "1" : "0");
  const [tiersParam, setTiersParam] = useUrlParam("tiers", DEFAULT_TIERS, TIER_COMBOS);
  const tierFilter = useMemo(() => Object.fromEntries(TIER_KEYS.map((k) => [k, tiersParam.split(",").includes(k)])), [tiersParam]);
  const setTierFilter = (updater) => {
    const next = typeof updater === "function" ? updater(tierFilter) : updater;
    const on = TIER_KEYS.filter((k) => next[k]);
    setTiersParam(on.length ? on.join(",") : "none");
  };
  const [minErrors, setMinErrors] = useState(0);
  const [selectedFields, setSelectedFields] = useState([]);

  // 2. Load Raw & Corrected Plays from IndexedDB
  const loadPlaysData = async () => {
    try {
      const [raw, corrected] = await Promise.all([getAllPlaysRawDB(), getAllPlaysDB()]);
      setPlaysRaw(raw);
      setPlaysCorrected(corrected);
      setLoadError("");
    } catch (err) {
      console.error("Failed to load plays for errors audit:", err);
      setLoadError("Could not read the plays from the local database.");
    } finally {
      setLoading(false);
    }
  };

  useLoad(loadPlaysData, []);
  useReloadOnSyncComplete(loadPlaysData);

  // 3. Run automated data-quality audits over the compiled plays
  const audits = useMemo(() => {
    if (playsCorrected.length === 0) return null;
    return runDataAudits(playsCorrected);
  }, [playsCorrected]);

  // Open Issues counts what a correction can close. The autograph
  // disagreements are excluded: the chain flags a play, the catalogue
  // signs a parallel, and no correction reconciles the two, so they show
  // below as known disagreements instead.
  const findingsCount = audits
    ? audits.nameConflicts.length + audits.profileConflicts.length + audits.boundsFindings.length + audits.teamFindings.length + audits.seasonFindings.length + audits.tagCount
    : 0;

  // Queue operations. One queued fix per finding; picking another candidate
  // replaces the previous choice.
  const queueFix = (findingKey, fix) => {
    setQueue((prev) => [
      ...prev.filter((q) => q.findingKey !== findingKey),
      { findingKey, label: fix.label, file: fix.file, patch: fix.patch }
    ]);
  };
  const unqueueFix = (findingKey) => setQueue((prev) => prev.filter((q) => q.findingKey !== findingKey));
  const ignoreFinding = (key) => {
    unqueueFix(key);
    setIgnoredKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
  };
  const restoreFinding = (key) => setIgnoredKeys((prev) => prev.filter((k) => k !== key));

  const queuedMap = useMemo(() => new Map(queue.map((q) => [q.findingKey, q])), [queue]);
  const ignoredSet = useMemo(() => new Set(ignoredKeys), [ignoredKeys]);

  // Deep-merge every queued patch into one JSON block per target file. Tags
  // patches are removals (each drops one tag from the stored array), so when
  // two land on the same play the arrays intersect: both removals apply.
  const mergedByFile = useMemo(() => {
    const files = {};
    queue.forEach(({ file, patch }) => {
      const f = (files[file] = files[file] || {});
      Object.entries(patch).forEach(([id, fields]) => {
        const prev = f[id] || {};
        const merged = { ...prev, ...fields };
        if (Array.isArray(prev.tags) && Array.isArray(fields.tags)) {
          merged.tags = prev.tags.filter((t) => fields.tags.includes(t));
        }
        f[id] = merged;
      });
    });
    return Object.entries(files).map(([file, patchMap]) => {
      const sorted = {};
      Object.keys(patchMap)
        .sort((a, b) => Number(a) - Number(b))
        .forEach((k) => (sorted[k] = patchMap[k]));
      return { file, entryCount: Object.keys(sorted).length, json: JSON.stringify(sorted, null, 2) };
    });
  }, [queue]);

  const handleFieldToggle = (field) => {
    setSelectedFields((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]
    );
  };

  // 5. Match raw vs corrected records and calculate error profiles (shared
  // with the home page, so its counts match this ledger exactly)
  const auditRecords = useMemo(() => buildCorrectionLedger(playsRaw, playsCorrected), [playsRaw, playsCorrected]);

  // Ledger-wide weight distribution, shown above the filters
  const ledgerStats = useMemo(() => summarizeLedger(auditRecords), [auditRecords]);

  // 6a. Every filter except the field pills: tiers, min corrections, mismints.
  // Rows carry only the diffs whose tier is enabled, so switching Context off
  // removes the noise lines everywhere.
  const baseRecords = useMemo(() => {
    const out = [];
    auditRecords.forEach((rec) => {
      if (showOnlyMismints && !rec.isMismint) return;

      const visibleDiffs = rec.diffs.filter((d) => tierFilter[d.tier]);
      if (!rec.isMismint && visibleDiffs.length === 0) return;
      if (visibleDiffs.filter((d) => d.tier !== "context").length < minErrors) return;

      out.push({ ...rec, visibleDiffs });
    });
    return out;
  }, [auditRecords, showOnlyMismints, minErrors, tierFilter]);

  // Field pills come from the diffs that survive every other filter, so no
  // pill can ever match nothing: with Context off, tags do not appear; at
  // min corrections 9, only fields present on 9+ rows do.
  const uniqueFields = useMemo(() => {
    const fields = new Set();
    baseRecords.forEach((rec) => rec.visibleDiffs.forEach((d) => fields.add(d.field)));
    return Array.from(fields).sort();
  }, [baseRecords]);

  // A filter change can make a selected field unavailable; the effective
  // selection is derived rather than pruned in an effect
  const activeFields = useMemo(
    () => selectedFields.filter((f) => uniqueFields.includes(f)),
    [selectedFields, uniqueFields]
  );

  // 6b. Field pills on top
  const filteredRecords = useMemo(() => {
    if (activeFields.length === 0) return baseRecords;
    return baseRecords.filter((rec) => rec.visibleDiffs.some((d) => activeFields.includes(d.field)));
  }, [baseRecords, activeFields]);

  // 7. Map filtered records into DataTable rows
  const tableRecords = useMemo(() => {
    return filteredRecords.map((rec) => {
      const playID = rec.playID;

      const idCell = (
        <Link to={`/plays/${playID}`} className="font-mono set-id-badge" style={{ display: "inline-block" }}>
          {playID}
        </Link>
      );

      const nameCell = (
        <Link to={`/plays/${playID}`} style={{ fontWeight: "600", textDecoration: "none" }} className="player-detail-link">
          {rec.rawFullNameString}
        </Link>
      );

      const mismintCell = rec.isMismint ? (
        <span className="badge badge-danger font-mono" style={{ background: "rgba(239, 68, 68, 0.08)", color: "#ef4444", border: "1px solid rgba(239, 68, 68, 0.2)" }}>
          Mismint
        </span>
      ) : (
        <span className="text-muted">-</span>
      );

      const errorCountCell = (
        <span className="font-mono" style={{ fontWeight: "700", color: rec.errorCount > 0 ? "var(--primary-hover)" : "var(--text-muted)", fontSize: "1rem" }}>
          {rec.errorCount}
        </span>
      );

      // Render before/after visual diffs breakdown list
      const diffsBreakdown = (
        <div className="diffs-breakdown-list">
          {rec.visibleDiffs.length === 0 && !rec.isMismint && <span className="text-muted">No corrections</span>}
          {rec.isMismint && rec.visibleDiffs.length === 0 && <span className="text-muted" style={{ fontSize: "0.85rem", fontStyle: "italic" }}>Play excluded (never distributed on-chain).</span>}

          {rec.visibleDiffs.map((diff, dIdx) => (
            <div key={dIdx} className="diff-item mt-6">
              <span className={`diff-tier-chip font-mono tier-${diff.tier}`}>{diff.label}</span>
              <span className="diff-field font-mono">{diff.field}:</span>{" "}
              <span className="diff-before font-mono">{diff.before}</span>{" "}
              <span className="diff-arrow">➔</span>{" "}
              <span className="diff-after font-mono">{diff.after}</span>
            </div>
          ))}
        </div>
      );

      return {
        id: playID,
        idCell,
        name: nameCell,
        mismint: mismintCell,
        errorCountCell,
        breakdown: diffsBreakdown
      };
    });
  }, [filteredRecords]);

  // Columns definition for DataTable
  const columns = useMemo(() => {
    return [
      { key: "idCell", text: "Play ID" },
      { key: "name", text: "Player / Highlight Name" },
      { key: "mismint", text: "Mismint" },
      { key: "errorCountCell", text: "Corrections" },
      { key: "breakdown", text: "Metadata Corrections & Dynamic Diffs (Before ➔ After)" }
    ];
  }, []);

  if (loadError && !loading) {
    return <LoadError message={loadError} onRetry={() => { setLoading(true); loadPlaysData(); }} />;
  }

  if (loading) {
    return (
      <Loader message={<>Loading the corrections ledger...</>} />
    );
  }

  const totalIgnored = ignoredKeys.length;

  return (
    <div className="errors-explorer-container">
      <div className="glass-panel info-banner">
        <h2>Corrections</h2>
        <p className="text-muted mt-8" style={{ fontSize: "0.95rem", lineHeight: "1.4", maxWidth: "800px" }}>
          Every correction applied on top of the chain data, shown beside the original, and every open question.
            Nothing on chain is ever changed.
        </p>
      </div>

      {/* Tab bar */}
      <div className="errors-tabs mt-20">
        <button className={`tab-btn ${activeTab === "ledger" ? "active" : ""}`} onClick={() => setActiveTab("ledger")}>
          Corrections <span className="tab-count font-mono">{auditRecords.filter((r) => r.errorCount > 0 || r.isMismint).length}</span>
        </button>
        <button className={`tab-btn ${activeTab === "findings" ? "active" : ""}`} onClick={() => setActiveTab("findings")}>
          Open Issues <span className="tab-count font-mono">{findingsCount}</span>
        </button>
        <button className={`tab-btn ${activeTab === "guide" ? "active" : ""}`} onClick={() => setActiveTab("guide")}>
          For contributors
        </button>
      </div>

      {/* ===================== OPEN FINDINGS TAB ===================== */}
      {activeTab === "findings" && (
        audits === null ? (
          <div className="glass-panel mt-20 text-center" style={{ padding: "40px", borderStyle: "dashed" }}>
            <p className="text-muted">Waiting for the plays database to load before running audits...</p>
          </div>
        ) : (
          <>
            {/* Fix queue bar */}
            <div className="glass-panel queue-bar mt-20">
              <div className="queue-bar-status">
                <span className="queue-bar-title">Fix Queue</span>
                <span className="tab-count font-mono">{queue.length}</span>
                {queue.length > 0 && (
                  <span className="text-muted queue-bar-detail">
                    {mergedByFile.map((m) => `${m.entryCount} play${m.entryCount === 1 ? "" : "s"} in ${m.file.split("/").pop()}`).join(", ")}
                  </span>
                )}
              </div>
              <div className="queue-bar-actions">
                {totalIgnored > 0 && (
                  <button className="row-btn" onClick={() => setShowIgnored((v) => !v)}>
                    {showIgnored ? "Hide" : "Show"} ignored ({totalIgnored})
                  </button>
                )}
                {queue.length > 0 && (
                  <>
                    <button className="btn-primary review-btn" onClick={() => setReviewOpen((v) => !v)}>
                      {reviewOpen ? "Hide export" : "Review & export"}
                    </button>
                    <button className="row-btn ignore-btn" onClick={() => { setQueue([]); setReviewOpen(false); }}>Clear</button>
                  </>
                )}
              </div>
            </div>

            {/* Export panels: one merged JSON block per target file */}
            {reviewOpen && mergedByFile.map((m) => (
              <div key={m.file} className="glass-panel mt-20 export-panel">
                <div className="d-flex justify-between align-center flex-wrap gap-10">
                  <div>
                    <span className="fix-file font-mono">{m.file}</span>
                    <span className="text-muted" style={{ fontSize: "0.8rem", marginLeft: "8px" }}>
                      {m.entryCount} play entr{m.entryCount === 1 ? "y" : "ies"}. Merge into the file; if a play ID already exists there, combine the fields.
                    </span>
                  </div>
                  <CopyButton text={m.json} />
                </div>
                <pre className="fix-json font-mono">{m.json}</pre>
              </div>
            ))}

            {findingsCount === 0 && (
              <div className="glass-panel mt-20 text-center" style={{ padding: "40px", borderStyle: "dashed" }}>
                <p className="text-muted">No open findings. Every automated audit passed cleanly. 🎉</p>
              </div>
            )}

            <FindingsCategory
              title="Player Name Spellings"
              intro="One player, several spellings. Click the correct one; the others become aliases, so future mints compile to it too."
              findings={audits.nameConflicts}
              queuedMap={queuedMap}
              ignoredSet={ignoredSet}
              showIgnored={showIgnored}
              onQueue={queueFix}
              onUnqueue={unqueueFix}
              onIgnore={ignoreFinding}
              onRestore={restoreFinding}
            />
            <FindingsCategory
              title="Player Bio Conflicts"
              intro="A player's plays disagree on a permanent fact. Click the correct value to rewrite the others."
              hint="Majority value first."
              findings={audits.profileConflicts}
              queuedMap={queuedMap}
              ignoredSet={ignoredSet}
              showIgnored={showIgnored}
              onQueue={queueFix}
              onUnqueue={unqueueFix}
              onIgnore={ignoreFinding}
              onRestore={restoreFinding}
            />
            <FindingsCategory
              title="Out-of-bounds Values"
              intro="Values outside any physical or historical range (cm heights, kg weights, concatenated scores, epoch dates). Verify from a source and override by hand."
              findings={audits.boundsFindings}
              queuedMap={queuedMap}
              ignoredSet={ignoredSet}
              showIgnored={showIgnored}
              onQueue={queueFix}
              onUnqueue={unqueueFix}
              onIgnore={ignoreFinding}
              onRestore={restoreFinding}
            />
            <FindingsCategory
              title="Season Calendar Mismatches"
              intro="The date falls outside every game window of its season (seasons.json): wrong date, wrong season, or an incomplete calendar entry. Verify by hand."
              findings={audits.seasonFindings}
              queuedMap={queuedMap}
              ignoredSet={ignoredSet}
              showIgnored={showIgnored}
              onQueue={queueFix}
              onUnqueue={unqueueFix}
              onIgnore={ignoreFinding}
              onRestore={restoreFinding}
            />
            <FindingsCategory
              title="Team ID / Name Mismatches"
              intro="The team name is not a current or historical name of its team ID in teams.json: wrong ID or name on the play, or an alias missing from teams.json."
              findings={audits.teamFindings}
              queuedMap={queuedMap}
              ignoredSet={ignoredSet}
              showIgnored={showIgnored}
              onQueue={queueFix}
              onUnqueue={unqueueFix}
              onIgnore={ignoreFinding}
              onRestore={restoreFinding}
            />
            {audits.tagSections.length > 0 && (
              <p className="tags-intro text-muted mt-20">
                <strong>Tags.</strong> Dapper Labs stored a tag our data does not derive. Each row shows what our data says.
                Fix our data first (season, DraftYear, team ID, a title missing from teams.json) and the tag derives itself;
                if the tag is the error, remove it.
              </p>
            )}
            {audits.tagSections.map((section) => (
              <TagSection
                key={section.shortTag}
                section={section}
                queuedMap={queuedMap}
                ignoredSet={ignoredSet}
                showIgnored={showIgnored}
                onQueue={queueFix}
                onUnqueue={unqueueFix}
                onIgnore={ignoreFinding}
                onRestore={restoreFinding}
              />
            ))}
            {audits.reconcilable.length > 0 && (
              <p className="text-muted font-mono reconcile-note">
                Not a decision: {audits.reconcilable.map((r) => `${r.count} stored "${r.longTag}"`).join(", ")} copies agree
                with the derivation; `npm run reconcile` strips them before every build.
              </p>
            )}
            {audits.autographFindings.length > 0 && (
              <>
                <h3 className="known-heading mt-20">Known disagreements</h3>
                <p className="text-muted known-intro">
                  Two sources that cannot be reconciled by a correction. Listed so nobody rediscovers them; not counted above.
                </p>
                <FindingsCategory
                  title="Autograph Flag vs Signed Editions"
                  intro="The chain flags an autograph on the play, one value for every parallel; Dapper Labs' catalogue records which parallel is signed, and the badge follows the catalogue. These plays disagree: flagged with nothing signed, or signed with no flag. Nothing changes here until the chain carries the fact per parallel."
                  findings={audits.autographFindings}
                  queuedMap={queuedMap}
                  ignoredSet={ignoredSet}
                  showIgnored={showIgnored}
                  onQueue={queueFix}
                  onUnqueue={unqueueFix}
                  onIgnore={ignoreFinding}
                  onRestore={restoreFinding}
                  startClosed
                />
              </>
            )}
          </>
        )
      )}

      {/* ===================== APPLIED CORRECTIONS TAB ===================== */}
      {activeTab === "ledger" && (
        <>
          <div className="glass-panel ledger-filterbar mt-20">
            <div className="ledger-stats text-muted">
              <span className="tier-swatch tier-factual">{ledgerStats.factual.toLocaleString()} factual fixes</span>
              <span className="tier-swatch tier-routine">{ledgerStats.routine.toLocaleString()} normalizations</span>
              <span className="tier-swatch tier-context">{ledgerStats.context.toLocaleString()} context additions</span>
              <span className="tier-swatch tier-mismint">{ledgerStats.mismints.toLocaleString()} mismints</span>
            </div>

            <div className="ledger-filter-row">
              <div className="filter-group">
                <span className="filter-label">Show</span>
                {[
                  ["factual", "Factual fixes"],
                  ["routine", "Normalizations"],
                  ["context", "Context additions"]
                ].map(([tier, label]) => (
                  <button
                    key={tier}
                    className={`pill-btn ${tierFilter[tier] ? "active" : ""}`}
                    onClick={() => setTierFilter((prev) => ({ ...prev, [tier]: !prev[tier] }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="filter-group">
                <span className="filter-label">Min corrections</span>
                <input
                  type="range"
                  min="0"
                  max="10"
                  className="range-slider"
                  value={minErrors}
                  onChange={(e) => setMinErrors(Number(e.target.value))}
                />
                <span className="filter-value font-mono">{minErrors}</span>
              </div>
              <label className="filter-check">
                <input
                  type="checkbox"
                  checked={showOnlyMismints}
                  onChange={(e) => setShowOnlyMismints(e.target.checked)}
                />
                Mismints only
              </label>
            </div>

            <div className="ledger-filter-row filter-fields-row">
              <span className="filter-label">Fields</span>
              <div className="fields-pills-container">
                {uniqueFields.map((field) => {
                  const isActive = activeFields.includes(field);
                  return (
                    <button
                      key={field}
                      className={`pill-btn ${isActive ? "active" : ""}`}
                      onClick={() => handleFieldToggle(field)}
                    >
                      {field}
                    </button>
                  );
                })}
              </div>
              {activeFields.length > 0 && (
                <button className="row-btn" onClick={() => setSelectedFields([])}>Clear</button>
              )}
            </div>
          </div>

          {/* Main Datatable Grid */}
          <div className="glass-panel mt-20 table-panel">
            <div className="d-flex justify-between align-center flex-wrap gap-10" style={{ marginBottom: "15px" }}>
              <h3>Corrections ({filteredRecords.length} plays)</h3>
              {syncState.stage === "Syncing..." && <span className="text-muted" style={{ fontSize: "0.85rem" }}>Refreshing on database updates...</span>}
            </div>

            {filteredRecords.length === 0 ? (
              <div className="glass-panel text-center" style={{ padding: "40px", borderStyle: "dashed" }}>
                <p className="text-muted">No plays with corrections match your current filter settings.</p>
              </div>
            ) : (
              <DataTable
                columns={columns}
                records={tableRecords}
                defaultSortColumn="id"
                defaultSortOrder="asc"
              />
            )}
          </div>
        </>
      )}

      {/* ===================== PIPELINE GUIDE TAB ===================== */}
      {activeTab === "guide" && (
        <div className="glass-panel mt-20 pipeline-guide">
          <h3>The Data Correction Pipeline, Start to Finish</h3>
          <p className="text-muted mt-8">
            Raw on-chain metadata is never edited. Every fix lives in a version-controlled JSON file layered on top of it,
            and the app rebuilds itself from those layers automatically.
          </p>

          <ol className="guide-steps mt-15">
            <li>
              <strong>Sync.</strong> Raw play, set, and edition metadata is pulled from the Flow blockchain into IndexedDB.
              The untouched original is always kept under <code>_raw</code> on each record, which is what makes the
              Before ➔ After ledger possible.
            </li>
            <li>
              <strong>Detect.</strong> The <em>Open Issues</em> tab runs automated audits over the compiled data every
              time this page loads: name spelling drift, conflicting player bios, and tag mismatches.
            </li>
            <li>
              <strong>Triage.</strong> For each finding, click the correct value (or the fix button) to queue it, or
              Ignore it if it is intentional. The queue and ignores persist in this browser between sessions.
            </li>
            <li>
              <strong>Export.</strong> Review &amp; export merges everything queued into one JSON block per target file:
              <ul className="mt-6">
                <li><code>data/overrides/plays.json</code>: corrects a value that is <em>wrong on-chain</em>. Keyed by play ID.</li>
                <li><code>data/additions/plays.json</code>: adds context that <em>never existed on-chain</em> (tags, seasons and dates Dapper published off-chain). Keyed by play ID. Dapper's own ids for plays, sets and editions live apart in <code>data/dapper/</code>, loaded only by the <Link to="/legacy">Legacy</Link> page. Tags the app derives itself (Top Shot Debut, Rookie Year, Rookie Mint, Championship Year, Cup Year, Hall of Fame) do not belong here: <code>npm run reconcile</code> strips stored copies that agree with the derivation, automatically, before every build. Only disagreements stay, as correction markers for this page.</li>
                <li><code>data/plays_exclude.json</code>: play IDs of mismints; excluded from debut and stat calculations.</li>
                <li>Sibling files cover sets, series, editions, and teams (emoji, arenas, historical names). <code>data/additions/sets.json</code> also carries set status: <code>burned</code> (the date every moment in the set was destroyed; mints struck through and left out of totals) and <code>mismint</code> (an empty duplicate set; hidden).</li>
              </ul>
              Paste the block into the file; if a play ID already has an entry, combine the fields into the one object.
            </li>
            <li>
              <strong>Recompile happens by itself.</strong> On the next app load, the changed files hash differently and
              the database recompiles from the <code>_raw</code> backups in the background. No resync; at most one refresh.
            </li>
            <li>
              <strong>Verify.</strong> The finding disappears from <em>Open Issues</em>, and the correction shows up in
              the <em>Corrections</em> ledger as a Before ➔ After diff. Then clear the queue.
            </li>
          </ol>

          <p className="text-muted mt-15" style={{ fontSize: "0.85rem" }}>
            Rule of thumb: overrides fix mistakes, additions add knowledge, exclusions remove noise.
          </p>
        </div>
      )}

      <style>{`
        .errors-explorer-container {
          max-width: 1250px;
          margin: 0 auto;
          width: 100%;
        }
        .errors-tabs {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }
        .tab-btn {
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: var(--text-muted);
          padding: 10px 18px;
          border-radius: 10px;
          font-size: 0.9rem;
          font-weight: 600;
          cursor: pointer;
          transition: color 0.2s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.2s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .tab-btn:hover {
          background: rgba(255, 255, 255, 0.08);
          color: #fff;
        }
        .tab-btn.active {
          background: rgba(139, 92, 246, 0.15);
          border-color: rgba(139, 92, 246, 0.5);
          color: #fff;
          box-shadow: 0 0 12px rgba(139, 92, 246, 0.25);
        }
        .tab-count {
          background: rgba(255, 255, 255, 0.08);
          border-radius: 10px;
          padding: 1px 8px;
          font-size: 0.75rem;
          margin-left: 6px;
        }
        .tab-btn.active .tab-count {
          background: rgba(139, 92, 246, 0.35);
        }

        /* ------- Fix queue bar & export ------- */
        .queue-bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px;
          padding: 14px 18px;
        }
        .queue-bar-status {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .queue-bar-title {
          font-weight: 700;
          color: #fff;
        }
        .queue-bar-detail {
          font-size: 0.8rem;
        }
        .queue-bar-actions {
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
        }
        .review-btn {
          padding: 6px 14px;
          font-size: 0.8rem;
          min-height: auto;
        }
        .export-panel .fix-json {
          margin-top: 12px;
        }
        .fix-file {
          font-size: 0.75rem;
          background: rgba(59, 130, 246, 0.15);
          color: var(--primary-hover);
          border: 1px solid rgba(59, 130, 246, 0.25);
          border-radius: 4px;
          padding: 2px 8px;
        }
        .fix-json {
          margin: 0;
          font-size: 0.75rem;
          line-height: 1.45;
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 320px;
          overflow-y: auto;
          color: #34d399;
        }
        .copy-json-btn {
          padding: 5px 12px;
          font-size: 0.75rem;
          min-height: auto;
        }

        /* ------- Findings categories & rows ------- */
        .known-heading {
          margin-top: 36px;
          font-size: 1.05rem;
        }
        .known-intro {
          margin-top: 6px;
          font-size: 0.85rem;
        }
        .findings-category > summary {
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
          font-size: 1.05rem;
          list-style-position: outside;
        }
        .category-title {
          font-weight: 700;
          color: #fff;
        }
        .category-counts {
          font-size: 0.75rem;
          color: var(--text-muted);
          background: rgba(255, 255, 255, 0.05);
          border-radius: 10px;
          padding: 2px 10px;
        }
        .category-intro {
          font-size: 0.82rem;
          line-height: 1.4;
          margin-top: 10px;
          max-width: 900px;
        }
        .category-hint {
          opacity: 0.75;
        }
        .tags-intro {
          font-size: 0.82rem;
          line-height: 1.4;
          max-width: 900px;
          margin-bottom: -10px;
        }
        /* Plays behind a finding: full-width block under the title and chips */
        .finding-plays {
          flex-basis: 100%;
          display: flex;
          flex-direction: column;
          gap: 3px;
          margin-top: 2px;
        }
        .finding-plays-row {
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 4px 14px;
          font-size: 0.75rem;
        }
        .finding-plays-value {
          color: #fff;
          opacity: 0.8;
        }
        .finding-play-ref {
          white-space: nowrap;
        }
        .bulk-btn {
          margin-top: 10px;
        }
        .finding-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
          padding: 9px 0;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
        }
        .finding-row:first-of-type {
          margin-top: 10px;
        }
        .finding-row.ignored {
          opacity: 0.45;
        }
        .finding-row-main {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          min-width: 0;
        }
        .finding-row-title {
          font-weight: 600;
          color: #fff;
          font-size: 0.9rem;
        }
        .finding-row-field {
          font-size: 0.7rem;
          color: var(--primary-hover);
          background: rgba(139, 92, 246, 0.12);
          border: 1px solid rgba(139, 92, 246, 0.3);
          border-radius: 4px;
          padding: 1px 6px;
        }
        .finding-row-play {
          font-size: 0.75rem;
          color: var(--text-muted);
          text-decoration: none;
          border-bottom: 1px dotted rgba(255, 255, 255, 0.25);
        }
        .finding-row-play:hover {
          color: #fff;
        }
        .finding-row-detail {
          font-size: 0.8rem;
        }
        .finding-row-premise {
          font-size: 0.72rem;
          color: var(--text-muted);
          opacity: 0.85;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 4px;
          padding: 1px 7px;
        }
        .blocked-badge {
          font-size: 0.7rem;
          font-weight: 600;
          color: #fbbf24;
          background: rgba(251, 191, 36, 0.08);
          border: 1px solid rgba(251, 191, 36, 0.3);
          border-radius: 4px;
          padding: 1px 7px;
          cursor: help;
        }
        .tag-subblock {
          margin-top: 14px;
          padding-top: 4px;
        }
        .reconcile-note {
          font-size: 0.78rem;
          line-height: 1.5;
          margin: 16px 4px 0;
          opacity: 0.8;
        }
        .tag-subblock + .tag-subblock {
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          margin-top: 20px;
          padding-top: 14px;
        }
        .tag-group {
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          padding: 10px 0;
        }
        .tag-group.ignored {
          opacity: 0.45;
        }
        .tag-group-header {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .tag-group-label {
          font-weight: 600;
          color: #fff;
          font-size: 0.9rem;
        }
        .tag-group-actions {
          display: flex;
          gap: 6px;
          margin-left: auto;
          flex-shrink: 0;
        }
        .tag-group-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 8px;
        }
        .play-chip {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.09);
          border-radius: 14px;
          padding: 2px 10px;
          font-size: 0.75rem;
          color: var(--text-muted);
        }
        .play-chip.blocked {
          border-color: rgba(251, 191, 36, 0.4);
          color: #fbbf24;
        }
        .play-chip.queued {
          border-color: rgba(16, 185, 129, 0.5);
          color: #34d399;
        }
        .play-chip-link {
          color: inherit;
          text-decoration: none;
        }
        .chip-context {
          color: var(--text-muted);
          opacity: 0.85;
        }
        .chip-fix {
          color: #34d399;
        }
        /* Mixed-recommendation groups list one play per line so each play's
           evidence and recommendation read as a sentence */
        .tag-group-rows {
          flex-direction: column;
          align-items: flex-start;
        }
        .tag-group-rows .play-chip {
          border-radius: 6px;
        }
        .play-chip-link:hover {
          color: #fff;
        }
        .value-chips {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .value-chip {
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: var(--text-main, #e5e7eb);
          padding: 4px 10px;
          border-radius: 16px;
          font-size: 0.8rem;
          cursor: pointer;
          transition: border-color 0.15s ease-in-out, background-color 0.15s ease-in-out;
        }
        .value-chip:hover:not(:disabled) {
          border-color: rgba(16, 185, 129, 0.6);
          background: rgba(16, 185, 129, 0.08);
        }
        .value-chip.chosen {
          border-color: rgba(16, 185, 129, 0.7);
          background: rgba(16, 185, 129, 0.15);
          color: #34d399;
          font-weight: 600;
        }
        .value-chip:disabled {
          cursor: default;
        }
        .chip-count {
          font-size: 0.7rem;
          opacity: 0.7;
          margin-left: 3px;
        }
        .finding-row-actions {
          display: flex;
          gap: 6px;
          align-items: center;
          flex-shrink: 0;
          /* Stays on the right even when a wide row wraps it to its own line */
          margin-left: auto;
        }
        .row-btn {
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: var(--text-muted);
          padding: 4px 10px;
          border-radius: 6px;
          font-size: 0.75rem;
          cursor: pointer;
          transition: color 0.15s ease-in-out, border-color 0.15s ease-in-out, background-color 0.15s ease-in-out;
        }
        .row-btn:hover {
          color: #fff;
          border-color: rgba(255, 255, 255, 0.25);
        }
        .queue-btn {
          border-color: rgba(16, 185, 129, 0.35);
          color: #34d399;
        }
        .queue-btn:hover {
          background: rgba(16, 185, 129, 0.12);
          border-color: rgba(16, 185, 129, 0.6);
          color: #34d399;
        }
        .queued-btn {
          background: rgba(16, 185, 129, 0.15);
          border-color: rgba(16, 185, 129, 0.6);
          color: #34d399;
          font-weight: 600;
        }
        .queued-note {
          font-size: 0.7rem;
          color: #34d399;
        }
        .ignore-btn:hover {
          border-color: rgba(239, 68, 68, 0.5);
          color: #f87171;
          background: rgba(239, 68, 68, 0.08);
        }

        /* ------- Applied Corrections filter bar ------- */
        .ledger-filterbar {
          display: flex;
          flex-direction: column;
          gap: 14px;
          padding: 16px 20px;
        }
        /* Named for this page: a bare .filter-row would also style the
           DataTable's column-filter <tr> below and stack its inputs */
        .ledger-filter-row {
          display: flex;
          align-items: center;
          gap: 22px;
          flex-wrap: wrap;
        }
        .filter-label {
          font-size: 0.7rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--text-muted);
          flex-shrink: 0;
        }
        .filter-group {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .filter-group .range-slider {
          width: 150px;
        }
        .filter-value {
          font-weight: 700;
          color: var(--primary-hover);
          min-width: 1.2em;
          text-align: center;
        }
        .filter-check {
          display: flex;
          align-items: center;
          gap: 7px;
          font-size: 0.85rem;
          color: var(--text-muted);
          cursor: pointer;
          user-select: none;
        }
        .filter-check input[type="checkbox"] {
          width: 15px;
          height: 15px;
          accent-color: #8b5cf6;
          cursor: pointer;
          margin: 0;
        }
        .filter-check:hover {
          color: #fff;
        }
        .filter-fields-row {
          align-items: flex-start;
          gap: 14px;
        }
        .filter-fields-row .filter-label {
          padding-top: 5px;
        }
        .fields-pills-container {
          display: flex;
          flex-wrap: wrap;
          gap: 7px;
          flex: 1;
          min-width: 0;
        }
        .pill-btn {
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: var(--text-muted);
          padding: 4px 11px;
          border-radius: 16px;
          font-size: 0.72rem;
          font-family: var(--font-mono);
          cursor: pointer;
          transition: color 0.2s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.2s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .pill-btn:hover {
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(255, 255, 255, 0.15);
          color: #fff;
        }
        .pill-btn.active {
          background: rgba(139, 92, 246, 0.15);
          border-color: rgba(139, 92, 246, 0.5);
          color: #fff;
          font-weight: 600;
        }

        /* ------- Guide ------- */
        .pipeline-guide code {
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 4px;
          padding: 0 5px;
          font-family: var(--font-mono);
          font-size: 0.8em;
        }
        .guide-steps {
          padding-left: 22px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          font-size: 0.9rem;
          line-height: 1.5;
        }
        .guide-steps ul {
          padding-left: 18px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        /* ------- Ledger table (unchanged) ------- */
        .errors-explorer-container table.premium-table td {
          white-space: normal;
          vertical-align: top;
        }
        .diff-before,
        .diff-after {
          word-break: break-word;
          max-width: 480px;
        }
        .ledger-stats {
          display: flex;
          gap: 16px;
          flex-wrap: wrap;
          font-size: 0.8rem;
          padding-bottom: 2px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          padding-bottom: 12px;
        }
        .tier-swatch::before {
          content: "";
          display: inline-block;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          margin-right: 6px;
          vertical-align: 1px;
        }
        .tier-swatch.tier-factual::before { background: #a78bfa; }
        .tier-swatch.tier-routine::before { background: rgba(255, 255, 255, 0.35); }
        .tier-swatch.tier-context::before { background: #60a5fa; }
        .tier-swatch.tier-mismint::before { background: #ef4444; }
        .diff-tier-chip {
          font-size: 0.62rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          border-radius: 4px;
          padding: 1px 6px;
          flex-shrink: 0;
        }
        .diff-tier-chip.tier-factual {
          color: #a78bfa;
          background: rgba(139, 92, 246, 0.12);
          border: 1px solid rgba(139, 92, 246, 0.35);
        }
        .diff-tier-chip.tier-routine {
          color: var(--text-muted);
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.12);
        }
        .diff-tier-chip.tier-context {
          color: #60a5fa;
          background: rgba(59, 130, 246, 0.1);
          border: 1px solid rgba(59, 130, 246, 0.3);
        }
        .diffs-breakdown-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .diff-item {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.8rem;
          flex-wrap: wrap;
        }
        .diff-field {
          font-weight: 600;
          color: var(--primary-hover);
        }
        .diff-before {
          background: rgba(239, 68, 68, 0.1);
          color: #f87171;
          padding: 1px 6px;
          border-radius: 4px;
          text-decoration: line-through;
          border: 1px solid rgba(239, 68, 68, 0.15);
        }
        .diff-after {
          background: rgba(16, 185, 129, 0.1);
          color: #34d399;
          padding: 1px 6px;
          border-radius: 4px;
          border: 1px solid rgba(16, 185, 129, 0.15);
          font-weight: 600;
        }
        .diff-arrow {
          color: var(--text-muted);
          font-size: 0.85rem;
        }
        .mini-badge-addition {
          background: rgba(59, 130, 246, 0.15);
          color: var(--primary-hover);
          font-size: 0.65rem;
          padding: 0 6px;
          border-radius: 4px;
          border: 1px solid rgba(59, 130, 246, 0.25);
          font-weight: 600;
          margin-left: 4px;
        }
        .range-slider {
          -webkit-appearance: none;
          height: 6px;
          border-radius: 3px;
          background: rgba(255, 255, 255, 0.1);
          outline: none;
          padding: 0;
          cursor: pointer;
        }
        .range-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: var(--primary-hover);
          cursor: pointer;
          box-shadow: 0 0 8px var(--primary-glow);
          transition: background-color 0.15s ease-in-out;
        }
        .range-slider::-webkit-slider-thumb:hover {
          background: var(--primary);
        }
      `}</style>
    </div>
  );
}
