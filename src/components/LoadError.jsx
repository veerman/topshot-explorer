/**
 * The shared load-failure panel (styling matches the account page's):
 * a silent catch that leaves an empty table tells the visitor nothing,
 * this says what broke and offers a retry. `title` and `retryLabel`
 * customize the heading and button; `children` render under the message
 * (e.g. a back link).
 */
export function LoadError({ message, onRetry, title = "⚠️ Load Error", retryLabel = "Retry", children }) {
  return (
    <div className="glass-panel" style={{ borderColor: "var(--status-danger)", color: "var(--status-danger)", textAlign: "center", padding: "40px 20px" }}>
      <h3>{title}</h3>
      <p style={{ marginTop: "8px" }}>{message}</p>
      {onRetry && <button onClick={onRetry} className="btn-primary mt-20">{retryLabel}</button>}
      {children}
    </div>
  );
}
