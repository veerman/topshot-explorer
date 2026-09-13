import React, { useState, useMemo, useEffect, useLayoutEffect, useRef } from "react";
import { Pagination } from "./Pagination";
import { toQuery } from "../utils/query";

function extractTextFromReact(node) {
  if (!node) return "";
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractTextFromReact).join("");
  }
  if (React.isValidElement(node)) {
    return extractTextFromReact(node.props?.children);
  }
  return "";
}

// Renders any cell value (strings, numbers, arrays, {id, name} objects,
// React elements) down to plain text. Search, filters, and sorting all run
// against text precomputed with this ONCE per dataset, instead of walking
// React trees on every keystroke or comparison.
function searchableText(val) {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number") return String(val);
  if (Array.isArray(val)) return val.map(searchableText).join(" ");
  if (React.isValidElement(val)) return extractTextFromReact(val);
  if (typeof val === "object") {
    return [val.id, val.name].filter((v) => v !== undefined && v !== null).join(" ");
  }
  return String(val);
}

// First number found in a cell's value (commas stripped, so "1,234" and
// "98.2%" both work); null when the cell holds no number
function extractNumber(val) {
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  if (val === null || val === undefined) return null;
  let text;
  if (React.isValidElement(val)) {
    text = extractTextFromReact(val);
  } else if (Array.isArray(val)) {
    text = val.map(extractTextFromReact).join(" ");
  } else {
    text = String(val);
  }
  const m = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// Numeric value(s) a filter comparison runs against: the column's explicit
// filterValue (may return an array, e.g. every set ID in a cell), else its
// sortValue, else the first number in the rendered text.
function numericCandidates(val, colDef, rec) {
  let source = val;
  if (colDef?.filterValue) source = colDef.filterValue(val, rec);
  else if (colDef?.sortValue) source = colDef.sortValue(val, rec);
  if (Array.isArray(source)) {
    return source.map((s) => extractNumber(s)).filter((n) => n !== null);
  }
  const num = extractNumber(source);
  return num === null ? [] : [num];
}

// Column filters: a plain number matches the cell's numeric value EXACTLY
// (so "0"/"1" cleanly filter icon columns like ✅/❌ and 🔒/OPEN), operator
// forms compare (> 50, >= 50, < 50, <= 50, = 100, != 0), and anything else
// is a substring match on the precomputed cell text.
function matchesColumnFilter(val, rawNeedle, colDef, rec, cellText) {
  const needle = rawNeedle.trim();
  const opMatch = needle.match(/^(>=|<=|!=|>|<|=)\s*(-?\d+(?:\.\d+)?)$/);
  const isPureNumber = !opMatch && /^-?\d+(?:\.\d+)?$/.test(needle);
  if (opMatch || isPureNumber) {
    const op = opMatch ? opMatch[1] : "=";
    const target = parseFloat(opMatch ? opMatch[2] : needle);
    const nums = numericCandidates(val, colDef, rec);
    if (nums.length === 0) return false;
    return nums.some((num) => {
      switch (op) {
        case ">": return num > target;
        case "<": return num < target;
        case ">=": return num >= target;
        case "<=": return num <= target;
        case "=": return num === target;
        case "!=": return num !== target;
        default: return false;
      }
    });
  }
  return (cellText || "").includes(needle.toLowerCase());
}

// Rows render in chunk groups, each group its own memoized <tbody> (HTML
// allows several per table). When a chunked commit appends a group, the
// existing groups are skipped by reference, so a commit costs one chunk,
// not the whole table so far; a keyed child diff over 9k rows per chunk
// made the streaming quadratic.
const TbodyChunk = React.memo(function TbodyChunk({ recs, columns, columnAlign, mismints, mismintKey, keyColumn, onRowClick }) {
  return (
    <tbody>
      {recs.map((rec, rIdx) => (
        <TableRow
          key={rec[keyColumn] || rIdx}
          rec={rec}
          columns={columns}
          columnAlign={columnAlign}
          isMismint={mismints.includes(String(rec[mismintKey]))}
          onRowClick={onRowClick}
        />
      ))}
    </tbody>
  );
});

const TableRow = React.memo(function TableRow({ rec, columns, columnAlign, isMismint, onRowClick }) {
  const clickable = onRowClick && rec._clickable;
  return (
    <tr
      className={[isMismint ? "mismint-row" : "", rec._rowClass || "", clickable ? "clickable-row" : ""].filter(Boolean).join(" ")}
      onClick={clickable ? (e) => {
        // Links inside the row keep their own behaviour
        if (e.target.closest("a, button, input, select")) return;
        onRowClick(rec);
      } : undefined}
    >
      {columns.map((col) => (
        <td
          key={col.key}
          style={{ textAlign: columnAlign[col.key] }}
        >
          {col.render
            ? col.render(rec[col.key], rec)
            : (rec[col.key] !== undefined && rec[col.key] !== null
              ? rec[col.key]
              : "")}
        </td>
      ))}
    </tr>
  );
});

export function DataTable({
  columns = [],
  records = [],
  keyColumn = "id",
  defaultSortColumn = "",
  defaultSortOrder = "asc",
  pageSizeOptions = [100, "All"],
  defaultPageSize = 100,
  mismints = [], // Array of playIDs/ids that are misminted to highlight them
  mismintKey = "playID", // key in records to check against mismints
  hidePageSizeSelector = false,
  onRowClick = null,
  // Prefix for the table's URL params when a page hosts several tables
  // (e.g. "nba" -> ?nba_q=...); a single table uses the bare names
  urlPrefix = ""
}) {
  // Search, filters, sort and page live in the URL (house rule: a
  // filtered view is shareable and survives refresh). Read once on
  // mount; a debounced effect below writes changes back, merging with
  // whatever other params the page owns.
  const urlKeyed = (name) => (urlPrefix ? `${urlPrefix}_${name}` : name);
  const readParam = (name) => new URLSearchParams(window.location.search).get(urlKeyed(name));
  const defaultSortKey = defaultSortColumn || (columns[0]?.key || "");
  const filtersFromUrl = () => {
    const params = new URLSearchParams(window.location.search);
    const prefix = urlKeyed("f_");
    const out = {};
    for (const [k, v] of params.entries()) {
      if (k.startsWith(prefix) && v) out[k.slice(prefix.length)] = v;
    }
    return out;
  };

  // Typed input is immediate; the applied term is debounced so a fast typer
  // pays for one filter-plus-render, not one per keystroke
  const [searchInput, setSearchInput] = useState(() => readParam("q") || "");
  const [searchTerm, setSearchTerm] = useState(searchInput);
  const [columnFilterInputs, setColumnFilterInputs] = useState(filtersFromUrl);
  const [columnFilters, setColumnFilters] = useState(columnFilterInputs);
  // Filters restored from a shared link start visible
  const [showFilters, setShowFilters] = useState(() => Object.keys(columnFilterInputs).length > 0);
  const [sortColumn, setSortColumn] = useState(() => readParam("sort") || defaultSortKey);
  const [sortOrder, setSortOrder] = useState(() => {
    const d = readParam("dir");
    return d === "asc" || d === "desc" ? d : defaultSortOrder;
  });
  const [currentPage, setCurrentPage] = useState(() => Math.max(1, Number(readParam("page")) || 1));
  const [pageSize, setPageSize] = useState(() => {
    const raw = readParam("size");
    if (!raw) return defaultPageSize;
    if (raw.toLowerCase() === "all") return "All";
    return Number(raw) > 0 ? Number(raw) : defaultPageSize;
  });

  // Mirror the table state into the URL: only non-default values are
  // written, other params on the page pass through untouched
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const filterPrefix = urlKeyed("f_");
    for (const k of [...params.keys()]) {
      if (k.startsWith(filterPrefix)) params.delete(k);
    }
    Object.entries(columnFilters).forEach(([k, v]) => {
      if (v && v.trim() !== "") params.set(`${filterPrefix}${k}`, v);
    });
    const setOrDelete = (name, value, isDefault) => {
      if (isDefault) params.delete(urlKeyed(name));
      else params.set(urlKeyed(name), value);
    };
    setOrDelete("q", searchTerm, !searchTerm.trim());
    setOrDelete("sort", sortColumn, sortColumn === defaultSortKey);
    setOrDelete("dir", sortOrder, sortOrder === defaultSortOrder);
    setOrDelete("page", String(currentPage), currentPage === 1);
    setOrDelete("size", String(pageSize), pageSize === defaultPageSize);
    const qs = toQuery(params);
    const next = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
    if (next !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.replaceState(null, "", next);
    }
    // urlKeyed/defaultSortKey derive from stable props
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, columnFilters, sortColumn, sortOrder, currentPage, pageSize]);

  useEffect(() => {
    if (searchInput === searchTerm) return;
    const t = setTimeout(() => {
      setSearchTerm(searchInput);
      setCurrentPage(1);
    }, 200);
    return () => clearTimeout(t);
  }, [searchInput, searchTerm]);

  useEffect(() => {
    if (columnFilterInputs === columnFilters) return;
    const t = setTimeout(() => {
      setColumnFilters(columnFilterInputs);
      setCurrentPage(1);
    }, 200);
    return () => clearTimeout(t);
  }, [columnFilterInputs, columnFilters]);

  // [key, needle, colDef] triples: the column definition is resolved here
  // ONCE, not once per row inside the filter loop (which was ~120k linear
  // scans per keystroke on the biggest table with two filters active)
  const activeColumnFilters = useMemo(
    () => Object.entries(columnFilters)
      .filter(([, v]) => v && v.trim() !== "")
      .map(([key, needle]) => [key, needle, columns.find((c) => c.key === key)]),
    [columnFilters, columns]
  );

  // Plain-text mirror of every cell, computed once per dataset: search and
  // filters become string.includes over these instead of React-tree walks
  const textIndex = useMemo(() => {
    const idx = new Map();
    records.forEach((rec) => {
      const byKey = {};
      let all = "";
      columns.forEach((col) => {
        const t = searchableText(rec[col.key]).toLowerCase();
        byKey[col.key] = t;
        all += t + String.fromCharCode(31); // unit separator: a match never spans two cells
      });
      idx.set(rec, { all, byKey });
    });
    return idx;
  }, [records, columns]);

  // 1. Filtering: the global search term AND every active per-column filter
  const filteredRecords = useMemo(() => {
    let out = records;

    const lowerSearch = searchTerm.trim().toLowerCase();
    if (lowerSearch) {
      out = out.filter((rec) => textIndex.get(rec).all.includes(lowerSearch));
    }

    if (activeColumnFilters.length > 0) {
      out = out.filter((rec) =>
        activeColumnFilters.every(([key, needle, colDef]) =>
          matchesColumnFilter(rec[key], needle, colDef, rec, textIndex.get(rec).byKey[key])
        )
      );
    }

    return out;
  }, [records, searchTerm, activeColumnFilters, textIndex]);

  // Rows may be grouped: a parent row plus the child rows it expands into,
  // tagged with a shared _groupId and a _groupOrder (0 for the parent).
  const groupParents = useMemo(() => {
    const parents = new Map();
    records.forEach((rec) => {
      if (rec._groupId !== undefined && rec._groupOrder === 0) parents.set(rec._groupId, rec);
    });
    return parents;
  }, [records]);

  // 2. Sorting. Each row's sort key is computed ONCE (Schwartzian
  // transform): extracting text from React elements inside the comparator
  // made large sorts cost n�log(n) tree walks.
  const sortedRecords = useMemo(() => {
    if (!sortColumn) return filteredRecords;

    const colDef = columns.find((c) => c.key === sortColumn);
    // Every row in a group sorts by its parent's value, so re-sorting the
    // table never scatters an expanded row's children away from it.
    const sortRec = (rec) =>
      (rec._groupId !== undefined && groupParents.get(rec._groupId)) || rec;

    const keyed = filteredRecords.map((orig) => {
      const parent = sortRec(orig);
      let val = colDef?.sortValue ? colDef.sortValue(parent[sortColumn], parent) : parent[sortColumn];
      if (React.isValidElement(val)) val = extractTextFromReact(val);
      if (val === undefined || val === null) val = "";
      const str = String(val);
      // Strip commas and hash symbols for clean number parsing
      const clean = str.replace(/[#,]/g, "").trim();
      const num = clean === "" ? NaN : Number(clean);
      return { orig, parent, str, num, order: orig._groupOrder || 0 };
    });

    keyed.sort((a, b) => {
      if (a.parent === b.parent) return a.order - b.order;
      if (!isNaN(a.num) && !isNaN(b.num)) {
        return sortOrder === "asc" ? a.num - b.num : b.num - a.num;
      }
      // Natural string sort: numeric runs inside strings compare as numbers,
      // so "1_2" sorts before "1_10" (edition ids, versions, etc.)
      const cmp = a.str.localeCompare(b.str, undefined, { numeric: true, sensitivity: "base" });
      if (cmp !== 0) return sortOrder === "asc" ? cmp : -cmp;
      return a.order - b.order;
    });

    return keyed.map((k) => k.orig);
  }, [filteredRecords, sortColumn, sortOrder, columns, groupParents]);

  // 3. Pagination Math
  const totalRecords = sortedRecords.length;
  const isShowAll = pageSize === "All" || pageSize <= 0;
  const actualPageSize = isShowAll ? totalRecords : Number(pageSize);
  const totalPages = isShowAll ? 1 : (Math.ceil(totalRecords / actualPageSize) || 1);

  // When the results fit inside even the smallest offered page size, no choice
  // in the selector would split them, so the paging UI has nothing to do and is
  // dropped for a plain count. Deliberately keyed off the smallest OPTION and
  // not the current page size: on a big set that the user has switched to
  // "All", the selector must stay so they can switch back.
  const smallestPageSize = pageSizeOptions
    .filter((o) => o !== "All" && Number(o) > 0)
    .reduce((min, o) => Math.min(min, Number(o)), Infinity);
  const fitsOnOnePage = totalRecords <= smallestPageSize;
  // Clamp to both bounds: filtering can shrink totalPages below the stored page
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);
  
  const paginatedRecords = useMemo(() => {
    if (isShowAll) return sortedRecords;
    const startIndex = (safeCurrentPage - 1) * actualPageSize;
    return sortedRecords.slice(startIndex, startIndex + actualPageSize);
  }, [sortedRecords, safeCurrentPage, isShowAll, actualPageSize]);

  // Sorting Handler
  const handleSort = (columnKey) => {
    if (sortColumn === columnKey) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortColumn(columnKey);
      setSortOrder("asc");
    }
    setCurrentPage(1);
  };

  // Findable mode. A page beyond FINDABLE_THRESHOLD rows (the 1000 and
  // "All" sizes) renders EVERY row, so browser find-in-page (Ctrl+F)
  // searches the whole dataset, but with each row carrying
  // content-visibility: auto: offscreen rows exist in the DOM and are
  // findable, yet cost no layout or paint until scrolled to (or revealed
  // by a find match). Containment is ignored on real table rows, so in
  // this mode CSS switches the rows to fixed-track grids; the tracks come
  // from the auto-laid first window, measured once (the table's one
  // deliberate JS measurement) and expressed in fr so they keep filling
  // the panel on resize. Rows mount in chunks per frame: with fixed
  // tracks, appending rows never re-lays-out earlier ones, so the page
  // stays interactive while thousands of rows stream in.
  const FINDABLE_THRESHOLD = 300;
  const CHUNK = 1000;
  const totalToRender = paginatedRecords.length;
  const findable = totalToRender > FINDABLE_THRESHOLD;
  const tableRef = useRef(null);
  // The measurement is stored WITH what it was measured for, so a new
  // dataset or column shape reads as "not measured yet" by itself: no
  // reset effect, no extra render pass
  const [measured, setMeasured] = useState(null);
  const current = measured && measured.records === records && measured.columns === columns && measured.findable === findable ? measured : null;
  const colWidths = current ? current.widths : null;
  const rowH = current ? current.rowH : 56;
  // Same for the chunk stream: the limit belongs to the row set it grew
  // on, so a sort or filter (a new row set) restarts it at one chunk
  const [limitFor, setLimitFor] = useState({ rows: null, limit: CHUNK });
  const renderLimit = limitFor.rows === paginatedRecords ? limitFor.limit : CHUNK;

  // Measure column tracks and average row height from the first window
  // while it is still a native auto-laid table. setState here re-renders
  // before paint, so the measurement pass itself is never visible.
  useLayoutEffect(() => {
    if (!findable || colWidths) return;
    const table = tableRef.current;
    const headRow = table?.tHead?.rows?.[0];
    const body = table?.tBodies?.[0];
    if (!headRow || !body || body.rows.length < 2) return;
    const first = body.rows[0].getBoundingClientRect();
    const last = body.rows[body.rows.length - 1].getBoundingClientRect();
    const h = (last.bottom - first.top) / body.rows.length;
    setMeasured({ records, columns, findable, widths: [...headRow.cells].map((c) => c.getBoundingClientRect().width), rowH: h > 10 ? h : 56 });
  }, [findable, colWidths, paginatedRecords, records, columns]);

  // Stream the remaining rows in, one chunk per frame
  useEffect(() => {
    if (!findable || !colWidths || renderLimit >= totalToRender) return;
    const id = requestAnimationFrame(() => {
      setLimitFor({ rows: paginatedRecords, limit: Math.min(renderLimit + CHUNK, totalToRender) });
    });
    return () => cancelAnimationFrame(id);
  }, [findable, colWidths, renderLimit, totalToRender, paginatedRecords]);

  // Stable chunk slices: each keeps its identity while renderLimit grows,
  // so already-rendered TbodyChunks skip their re-render by reference
  const chunkList = useMemo(() => {
    const out = [];
    for (let i = 0; i < paginatedRecords.length; i += CHUNK) {
      out.push(paginatedRecords.slice(i, i + CHUNK));
    }
    return out;
  }, [paginatedRecords]);

  const visibleChunks = !findable
    ? chunkList
    : colWidths
      ? chunkList.slice(0, Math.max(1, Math.ceil(renderLimit / CHUNK)))
      : [paginatedRecords.slice(0, 100)]; // measurement window
  const renderedCount = visibleChunks.reduce((n, c) => n + c.length, 0);

  // A column whose visible values are all numeric right-aligns (digits line
  // up); everything else left-aligns. col.align overrides either way.
  const columnAlign = useMemo(() => {
    const out = {};
    const sample = sortedRecords.slice(0, 40);
    columns.forEach((col) => {
      if (col.align) { out[col.key] = col.align; return; }
      let sawValue = false;
      const numeric = sample.every((rec) => {
        const raw = rec[col.key];
        if (raw === null || raw === undefined || raw === "") return true;
        const text = (extractTextFromReact(raw) || String(raw)).trim();
        // A lone "-" is a placeholder, not a value: without this a text
        // column whose sampled rows were all "-" flipped right-aligned
        // (and could flip back on re-sort)
        if (text === "" || text === "-") return true;
        sawValue = true;
        return /^[#\d.,%\s-]+$/.test(text);
      });
      out[col.key] = sawValue && numeric ? "right" : "left";
    });
    return out;
  }, [columns, sortedRecords]);

  const renderPaginationInfo = () => {
    const start = totalRecords === 0 ? 0 : (isShowAll ? 1 : (safeCurrentPage - 1) * actualPageSize + 1);
    const end = isShowAll ? totalRecords : Math.min(safeCurrentPage * actualPageSize, totalRecords);

    const startFormatted = start.toLocaleString();
    const endFormatted = end.toLocaleString();
    const totalFormatted = totalRecords.toLocaleString();

    const rangeText = totalRecords === 0 
      ? "Results 0 of 0"
      : `Results ${startFormatted}-${endFormatted} of ${totalFormatted}`;

    // Everything is on screen, so a range reads as noise: just say how many.
    if (fitsOnOnePage) {
      return (
        <div className="text-muted" style={{ fontSize: "0.85rem" }}>
          {totalFormatted} {totalRecords === 1 ? "result" : "results"}
        </div>
      );
    }

    // If the selector is hidden, render plain text range
    if (hidePageSizeSelector) {
      return (
        <div className="text-muted" style={{ fontSize: "0.85rem" }}>
          {rangeText}
        </div>
      );
    }

    // Inline dropdown selector to merge and remove repetitive words
    const sizeSelector = (
      <select
        className="form-control inline-select"
        style={{
          display: "inline-block",
          padding: "2px 8px",
          width: "auto",
          fontSize: "0.85rem",
          margin: "0 6px",
          height: "auto",
          background: "rgba(255, 255, 255, 0.05)",
          border: "1px solid rgba(255, 255, 255, 0.15)",
          color: "#fff",
          borderRadius: "4px",
          cursor: "pointer"
        }}
        value={pageSize}
        onChange={(e) => {
          const val = e.target.value;
          setPageSize(val === "All" ? "All" : Number(val));
          setCurrentPage(1);
        }}
      >
        {pageSizeOptions.map((opt) => (
          <option key={opt} value={opt} style={{ background: "#1a1a1a" }}>
            {opt}
          </option>
        ))}
      </select>
    );

    return (
      <div className="text-muted d-flex align-center" style={{ fontSize: "0.85rem", flexWrap: "wrap" }}>
        {rangeText}
        <span style={{ margin: "0 8px", opacity: 0.4 }}>|</span>
        {sizeSelector} per page
      </div>
    );
  };

  // The shared Pagination widget (this used to be a verbatim 55-line copy)
  const renderPaginationControls = () => {
    if (fitsOnOnePage) return null;
    return <Pagination page={safeCurrentPage} totalPages={totalPages} onChange={setCurrentPage} />;
  };

  return (
    <div className="datatable-container">
      {/* Table Top Controls */}
      <div className="table-controls" style={{ justifyContent: "flex-end", gap: "10px" }}>
        {activeColumnFilters.length > 0 && (
          <button
            className="filter-toggle-btn"
            onClick={() => {
              setColumnFilterInputs({});
              setColumnFilters({});
              setCurrentPage(1);
            }}
            title="Clear all column filters"
          >
            ✕ Clear
          </button>
        )}
        <button
          className={`filter-toggle-btn ${showFilters || activeColumnFilters.length > 0 ? "active" : ""}`}
          onClick={() => setShowFilters((s) => !s)}
          title="Toggle per-column filter inputs"
        >
          Filters{activeColumnFilters.length > 0 ? ` (${activeColumnFilters.length})` : ""} {showFilters ? "▴" : "▾"}
        </button>
        <div className="table-search">
          <input
            type="text"
            className="form-control"
            placeholder="Search all columns..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={{ width: "100%", paddingLeft: "12px" }}
          />
        </div>
      </div>

      {/* Table Top Pagination */}
      <div className="table-controls mb-20" style={{ justifyContent: "space-between" }}>
        {renderPaginationInfo()}
        {renderPaginationControls()}
      </div>

      {/* Premium Table Content */}
      <div className="table-wrapper">
        {/* Native table: the browser's auto layout sizes columns to their
            content and wraps text under pressure. Only findable huge pages
            pin the tracks (see above). */}
        <table
          className={`premium-table${findable && colWidths ? " findable" : ""}`}
          ref={tableRef}
          style={findable && colWidths ? {
            "--pg-cols": colWidths.map((w) => `${w.toFixed(2)}fr`).join(" "),
            "--pg-row-h": `${Math.round(rowH)}px`
          } : undefined}
        >
          <thead>
            <tr>
              {columns.map((col) => {
                const isSorted = sortColumn === col.key;
                // Headers sit over their column's data: same alignment as
                // the cells (auto left/right, or the column's explicit align)
                const align = columnAlign[col.key] || "left";
                return (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    style={{ textAlign: align, cursor: "pointer", alignContent: "center" }}
                  >
                    <div style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                      justifyContent: align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start",
                      width: "100%"
                    }}>
                      <span style={{ lineHeight: "1.2" }}>
                        {col.text}
                      </span>
                      <span style={{
                        fontSize: "0.85em",
                        color: isSorted ? "var(--primary-hover)" : "rgba(255, 255, 255, 0.25)",
                        userSelect: "none"
                      }}>
                        {isSorted ? (sortOrder === "asc" ? "▴" : "▾") : "↕"}
                      </span>
                      {col.headerControl && (
                        <span onClick={(e) => e.stopPropagation()}>{col.headerControl}</span>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
            {(showFilters || activeColumnFilters.length > 0) && (
              <tr className="filter-row">
                {columns.map((col) => (
                  <th key={col.key} onClick={(e) => e.stopPropagation()} style={{ cursor: "default" }}>
                    <input
                      type="text"
                      className="column-filter-input"
                      placeholder="Filter..."
                      title={col.filterTitle || "Text match. A plain number matches exactly. Icon columns are yes/no: 1 = yes (✅/🔒 closed), 0 = no (❌/open). Comparisons: >50, <=10, !=0"}
                      value={columnFilterInputs[col.key] || ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        setColumnFilterInputs((prev) => ({ ...prev, [col.key]: v }));
                      }}
                    />
                  </th>
                ))}
              </tr>
            )}
          </thead>
          {renderedCount > 0 ? (
            visibleChunks.map((recs, i) => (
              <TbodyChunk
                key={i}
                recs={recs}
                columns={columns}
                columnAlign={columnAlign}
                mismints={mismints}
                mismintKey={mismintKey}
                keyColumn={keyColumn}
                onRowClick={onRowClick}
              />
            ))
          ) : (
            <tbody>
              <tr>
                <td colSpan={columns.length} className="text-center text-muted" style={{ padding: "40px" }}>
                  No data available!
                </td>
              </tr>
            </tbody>
          )}
        </table>
      </div>

      {findable && colWidths && renderLimit < totalToRender && (
        <div className="text-muted" style={{ fontSize: "0.8rem", padding: "6px 2px" }}>
          Rendering {renderLimit.toLocaleString()} of {totalToRender.toLocaleString()} rows...
        </div>
      )}

      {/* Table Footer / Pagination. Skipped when everything fits on one page,
          so the count is not printed twice. */}
      {!fitsOnOnePage && (
        <div className="table-controls mt-20" style={{ justifyContent: "space-between" }}>
          {renderPaginationInfo()}
          {renderPaginationControls()}
        </div>
      )}
    </div>
  );
}
