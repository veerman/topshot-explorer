import { Link, useLocation } from "react-router-dom";

/** The About section's two pages as tabs: the story, and the Early Adopters wall */
export function AboutTabs() {
  const { pathname } = useLocation();
  const tab = (to, label, on) => (
    <Link to={to} className={`about-tab${on ? " is-on" : ""}`} aria-current={on ? "page" : undefined}>{on ? "✓ " : ""}{label}</Link>
  );
  return (
    <nav className="about-tabs" aria-label="About">
      {tab("/about", "About", pathname === "/about")}
      {tab("/about/early-adopters", "Early Adopters", pathname.startsWith("/about/early-adopters"))}
      <style>{`
        .about-tabs { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
        .about-tab { padding: 7px 16px; border-radius: 9999px; border: 1px solid var(--border-light); color: var(--text-main); text-decoration: none; font-size: 0.9rem; font-weight: 500; }
        .about-tab.is-on { border-color: rgba(255,255,255,0.5); color: #fff; background: rgba(255,255,255,0.05); }
        .about-tab:hover { border-color: var(--primary); }
      `}</style>
    </nav>
  );
}
