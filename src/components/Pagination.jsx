import React from "react";

/**
 * The shared page control: first/prev, a window of numbered pages with
 * ellipsis gaps, next/last. Renders nothing when there is one page.
 * (No extra margin class: .pagination-controls already carries the
 * 20px top margin in index.css.)
 */
export function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null;
  return (
    <div className="pagination-controls">
      <button className="page-btn" disabled={page === 1} onClick={() => onChange(1)} title="First Page">«</button>
      <button className="page-btn" disabled={page === 1} onClick={() => onChange(page - 1)} title="Previous Page">‹</button>
      {Array.from({ length: totalPages }, (_, i) => i + 1)
        .filter((p) => Math.abs(p - page) <= 2 || p === 1 || p === totalPages)
        .map((p, idx, arr) => {
          const prev = arr[idx - 1];
          return (
            <React.Fragment key={p}>
              {prev && p - prev > 1 && <span className="text-muted" style={{ margin: "0 4px" }}>...</span>}
              <button className={`page-btn ${p === page ? "active" : ""}`} onClick={() => onChange(p)}>{p}</button>
            </React.Fragment>
          );
        })}
      <button className="page-btn" disabled={page === totalPages} onClick={() => onChange(page + 1)} title="Next Page">›</button>
      <button className="page-btn" disabled={page === totalPages} onClick={() => onChange(totalPages)} title="Last Page">»</button>
    </div>
  );
}
