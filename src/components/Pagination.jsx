/**
 * The shared page control: first/prev, a window of numbered pages with
 * ellipsis gaps, next/last. Renders nothing when there is one page.
 * (No extra margin class: .pagination-controls already carries the
 * 20px top margin in index.css.)
 *
 * The gaps and buttons are flat keyed siblings on purpose. Wrapping each
 * gap-plus-button in a keyed Fragment let Preact's diff put the next and
 * last buttons in the middle of the numbers whenever the page window
 * moved and the page count changed at once (page 4 of 53 to page 54 of
 * 91, for one).
 */
export function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null;
  const shown = Array.from({ length: totalPages }, (_, i) => i + 1)
    .filter((p) => Math.abs(p - page) <= 2 || p === 1 || p === totalPages);
  return (
    <div className="pagination-controls">
      <button key="first" className="page-btn" disabled={page === 1} onClick={() => onChange(1)} title="First Page">«</button>
      <button key="prev" className="page-btn" disabled={page === 1} onClick={() => onChange(page - 1)} title="Previous Page">‹</button>
      {shown.flatMap((p, idx) => [
        idx > 0 && p - shown[idx - 1] > 1
          ? <span key={`gap-${p}`} className="text-muted" style={{ margin: "0 4px" }}>...</span>
          : null,
        <button key={p} className={`page-btn ${p === page ? "active" : ""}`} onClick={() => onChange(p)}>{p}</button>
      ])}
      <button key="next" className="page-btn" disabled={page === totalPages} onClick={() => onChange(page + 1)} title="Next Page">›</button>
      <button key="last" className="page-btn" disabled={page === totalPages} onClick={() => onChange(totalPages)} title="Last Page">»</button>
    </div>
  );
}
