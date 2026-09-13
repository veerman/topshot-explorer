/**
 * Clickable sort heading with the ▼/▲ marker, shared by the pages that
 * hand-roll their tables (the DataTable pages have their own header).
 * Pages pass their own tooltip text so wording stays page-specific.
 */
export function SortableTh({ label, sortKey, sort, onSort, title }) {
  return (
    <th
      title={title || `Sort by ${label}`}
      onClick={() => onSort(sortKey)}
      style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
    >
      {label}{sort.key === sortKey ? (sort.dir === "desc" ? " ▼" : " ▲") : ""}
    </th>
  );
}
