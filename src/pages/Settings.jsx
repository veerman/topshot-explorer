import { formatDateISO } from "../utils/display.utils";
import { useState, useEffect } from "react";
import { getSyncStatsDB } from "../services/db.service";
import { forceFullSync, recompileDatabase, getCurrentOverridesHash } from "../services/sync.coordinator";
import { areOverridesDisabled, setOverridesDisabled } from "../services/overrides.service";
import { isRemainingSupply, setRemainingSupply, burnsAsOf } from "../services/supply.service";
import { useSyncStatus, useReloadOnSyncComplete } from "../hooks/useSyncStatus";

// Fetch offline db stats safely (also re-fetched when a sync completes)
function fetchDBStats(setCachedStats) {
  getSyncStatsDB()
    .then((stats) => {
      if (stats) {
        setCachedStats({
          lastSyncTime: stats.lastSyncTime || null,
          nextPlayID: stats.nextPlayID || 1,
          nextSetID: stats.nextSetID || 1,
          totalSupply: stats.totalSupply || 0
        });
      }
    })
    .catch((err) => {
      console.warn("Failed to load local database sync stats:", err);
    });
}

export function Settings() {
  // The overrides flag is owned by overrides.service; areOverridesDisabled
  // reads the same cached value the appliers use
  const [disableOverrides, setDisableOverrides] = useState(areOverridesDisabled);
  const [remainingSupply, setRemainingSupplyChoice] = useState(isRemainingSupply);
  const [saveStatus, setSaveStatus] = useState(false);

  // Safe stats state initialization to prevent null-reference crashes
  const [cachedStats, setCachedStats] = useState({
    lastSyncTime: null,
    nextPlayID: 1,
    nextSetID: 1,
    totalSupply: 0
  });

  const syncState = useSyncStatus();

  // Load stats on mount and clean up retired settings' leftover keys
  useEffect(() => {
    try {
      // Retired settings (wallet address, image resizer): drop their
      // leftover keys from browsers that saved them
      localStorage.removeItem("topshot_wallet_address");
      localStorage.removeItem("topshot_image_resizer");
    } catch (e) {
      console.warn("Failed to clean localStorage:", e);
    }
    fetchDBStats(setCachedStats);
  }, []);

  // A completed sync pass changes the stats card; refresh it then
  useReloadOnSyncComplete(() => fetchDBStats(setCachedStats));

  const handleSave = (e) => {
    e.preventDefault();
    const oldDisable = areOverridesDisabled();
    setOverridesDisabled(disableOverrides);

    if (oldDisable !== disableOverrides) {
      recompileDatabase(getCurrentOverridesHash()).catch((err) => {
        console.warn("Failed to trigger recompile on settings change:", err);
      });
    }

    // Supply numbers are computed inside every page's memos, so a change
    // takes effect on the next load; reload so it is immediate
    const oldRemaining = isRemainingSupply();
    setRemainingSupply(remainingSupply);
    if (oldRemaining !== remainingSupply) setTimeout(() => window.location.reload(), 400);

    setSaveStatus(true);
    setTimeout(() => {
      setSaveStatus(false);
    }, 2500);
  };

  const handleForceFullSync = () => {
    if (window.confirm("Are you sure you want to perform a Force Full Database Sync? This will completely clear all local tables (plays, sets, editions, and IPFS data) and pull a full update from Flow mainnet. This takes around 30 seconds.")) {
      forceFullSync();
    }
  };

  // Safe date parsing to avoid range exceptions
  let formattedSyncTime = "Never";
  if (cachedStats.lastSyncTime) {
    try {
      const parsedDate = new Date(cachedStats.lastSyncTime);
      if (!isNaN(parsedDate.getTime())) {
        formattedSyncTime = `${formatDateISO(parsedDate)}, ${parsedDate.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
      }
    } catch (e) {
      console.warn("Invalid sync date encountered:", e);
    }
  }

  const playCount = Math.max(0, Number(cachedStats.nextPlayID) - 1);
  const setCount = Math.max(0, Number(cachedStats.nextSetID) - 1);
  const supplyCount = Number(cachedStats.totalSupply) || 0;

  return (
    <div className="settings-container">
      <div className="glass-panel info-banner">
        <h2>Settings</h2>
        <p className="text-muted mt-8" style={{ fontSize: "0.95rem" }}>
          How the data is shown, and your local copy of the chain data.
        </p>
      </div>

      <div className="settings-content-grid mt-20">
        {/* Core Configs */}
        <form onSubmit={handleSave} className="glass-panel settings-form">
          <h3>Data</h3>

          {/* Both switches read in the affirmative and default to on: a
              reader unchecks to turn something off.
              The stored flag stays disable_overrides; only the label flips */}
          <div className="form-group mt-25 d-flex align-center gap-10 flex-row">
            <input
              type="checkbox"
              id="applyCorrectionsCheckbox"
              style={{ width: "18px", height: "18px", cursor: "pointer" }}
              checked={!disableOverrides}
              onChange={(e) => setDisableOverrides(!e.target.checked)}
            />
            <div>
              <label htmlFor="applyCorrectionsCheckbox" className="form-label" style={{ cursor: "pointer" }}>
                Apply corrections to the chain data
              </label>
              <p className="form-help text-muted" style={{ margin: "2px 0 0" }}>
                Every correction on the Corrections page, layered over the Flow Blockchain record. Off: every value
                exactly as it is on chain.
              </p>
            </div>
          </div>

          {/* Remaining supply vs original mint counts */}
          <div className="form-group mt-25 d-flex align-center gap-10 flex-row">
            <input
              type="checkbox"
              id="remainingSupplyCheckbox"
              style={{ width: "18px", height: "18px", cursor: "pointer" }}
              checked={remainingSupply}
              onChange={(e) => setRemainingSupplyChoice(e.target.checked)}
            />
            <div>
              <label htmlFor="remainingSupplyCheckbox" className="form-label" style={{ cursor: "pointer" }}>
                Show remaining supply instead of original mints
              </label>
              <p className="form-help text-muted" style={{ margin: "2px 0 0" }}>
                Minted minus burned, everywhere a count of moments appears. Burn counts come from Dapper Labs'
                catalogue{burnsAsOf() ? `, last read ${formatDateISO(new Date(burnsAsOf()))}` : ""}. Off: the original mint counts from the Flow Blockchain, which
                never go down.
              </p>
            </div>
          </div>

          <div className="d-flex align-center gap-10 mt-30">
            <button type="submit" className="btn-primary" disabled={syncState.isSyncing}>
              Save
            </button>
            {saveStatus && (
              <span className="save-success-badge">
                ✓ Settings Saved!
              </span>
            )}
          </div>
        </form>

        {/* Database Cache controls */}
        <div className="glass-panel database-panel">
          <h3>Local database</h3>
          <p className="text-muted mt-8" style={{ fontSize: "0.9rem", lineHeight: "1.4" }}>
            Plays, sets, editions and media CIDs are copied from the Flow Blockchain into your browser's database (IndexedDB).
            After the first sync, every page loads from there, offline included.
          </p>

          <div className="cache-stats-box mt-20">
            <div className="d-flex justify-between" style={{ fontSize: "0.85rem", marginBottom: "8px" }}>
              <span className="text-muted">Last sync:</span>
              <span style={{ fontWeight: "600", color: syncState.isSyncing ? "var(--primary-hover)" : "var(--status-success)" }}>
                {syncState.isSyncing ? "Syncing..." : "Up to date"}
              </span>
            </div>
            <div className="d-flex justify-between" style={{ fontSize: "0.85rem", marginBottom: "8px" }}>
              <span className="text-muted">Last Sync Timestamp:</span>
              <span style={{ fontWeight: "600", fontFamily: "var(--font-sans)" }}>
                {formattedSyncTime}
              </span>
            </div>
            <div className="d-flex justify-between" style={{ fontSize: "0.85rem", marginBottom: "8px" }}>
              <span className="text-muted">Play Metadata Count:</span>
              <span style={{ fontWeight: "600" }} className="font-mono">
                {playCount} entries
              </span>
            </div>
            <div className="d-flex justify-between" style={{ fontSize: "0.85rem", marginBottom: "8px" }}>
              <span className="text-muted">Set Mappings:</span>
              <span style={{ fontWeight: "600" }} className="font-mono">
                {setCount} sets
              </span>
            </div>
            <div className="d-flex justify-between" style={{ fontSize: "0.85rem", marginBottom: "8px" }}>
              <span className="text-muted">Cached Supply Mints:</span>
              <span style={{ fontWeight: "600" }} className="font-mono">
                {supplyCount.toLocaleString()} NFTs
              </span>
            </div>
          </div>

          {syncState.isSyncing && (
            <div className="mt-20">
              <div className="d-flex justify-between" style={{ fontSize: "0.8rem", marginBottom: "4px" }}>
                <span className="text-muted">{syncState.stage}</span>
                <span>{syncState.progressPercent}%</span>
              </div>
              <div className="sync-bar-container">
                <div className="sync-bar-fill" style={{ width: `${syncState.progressPercent}%` }}></div>
              </div>
            </div>
          )}

          <div className="mt-20 d-flex flex-column gap-10">
            <button
              onClick={handleForceFullSync}
              className="btn-primary"
              disabled={syncState.isSyncing}
              style={{ width: "100%", justifyContent: "center", background: "linear-gradient(135deg, var(--status-danger) 0%, #dc2626 100%)", boxShadow: "0 4px 12px rgba(239, 68, 68, 0.25)" }}
            >
              ⚠️ Force Full Database Re-Sync
            </button>
            
            <p className="text-muted" style={{ fontSize: "0.75rem", textAlign: "center", margin: "2px 0 0" }}>
              The escape hatch for a corrupted local database: wipes every store and pulls everything fresh from Flow.
            </p>
          </div>
        </div>
      </div>

      <style>{`
        .settings-container {
          max-width: 1200px;
          margin: 0 auto;
          width: 100%;
        }
        .settings-content-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(400px, 100%), 1fr));
          gap: 24px;
        }
        .settings-form {
          margin: 0;
        }
        .database-panel {
          margin: 0;
        }
        .form-group {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .form-group.flex-row {
          flex-direction: row;
          align-items: flex-start;
        }
        .form-label {
          font-size: 0.9rem;
          font-weight: 600;
          color: #fff;
        }
        .form-help {
          font-size: 0.8rem;
        }
        .mt-25 {
          margin-top: 25px;
        }
        .mt-30 {
          margin-top: 30px;
        }
        .save-success-badge {
          background: rgba(16, 185, 129, 0.15);
          color: var(--status-success);
          font-size: 0.85rem;
          padding: 6px 12px;
          border-radius: 6px;
          font-weight: 600;
          animation: popIn 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        @keyframes popIn {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
        .cache-stats-box {
          background: rgba(0,0,0,0.3);
          border: 1px solid rgba(255,255,255,0.05);
          border-radius: 8px;
          padding: 14px;
        }
        .flex-column {
          display: flex;
          flex-direction: column;
        }
      `}</style>
    </div>
  );
}
