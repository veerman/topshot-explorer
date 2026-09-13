/**
 * The shared loading spinner block: sixteen pages used to hand-roll this
 * exact three-element markup. `children` render under the message (e.g. a
 * progress line).
 */
export function Loader({ message, children }) {
  return (
    <div className="loader-container">
      <div className="spinner"></div>
      {message && <p>{message}</p>}
      {children}
    </div>
  );
}
