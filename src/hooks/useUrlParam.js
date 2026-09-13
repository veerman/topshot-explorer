import { useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { toQuery } from "../utils/query";

/**
 * A piece of page UI state (a tab, a league filter) mirrored in the URL
 * query string, so it survives navigating away and back, reloads, and can
 * be shared as a link. Only values in `allowed` are accepted; anything else
 * reads as the default. Choosing the default removes the key again, so the
 * canonical URL stays clean. Writes replace the history entry rather than
 * pushing one: switching tabs should not pile up Back button stops.
 */
export function useUrlParam(key, defaultValue, allowed) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const raw = searchParams.get(key);
  const normalized = raw === null ? null : raw.toLowerCase();
  const value = normalized !== null && (!allowed || allowed.includes(normalized)) ? normalized : defaultValue;

  const setValue = useCallback((next) => {
    // Build from the LIVE location, not the router's copy: DataTable and
    // the offer pages write their own params via history.replaceState,
    // which the router never sees; merging from its stale search string
    // would silently drop those params on the next tab/filter change
    const params = new URLSearchParams(window.location.search);
    if (next === null || next === undefined || next === defaultValue) params.delete(key);
    else params.set(key, String(next));
    // navigate with a ready-made search string (setSearchParams would
    // re-encode the facet commas, see toQuery)
    const qs = toQuery(params);
    navigate({ pathname: window.location.pathname, search: qs ? `?${qs}` : "", hash: window.location.hash }, { replace: true });
  }, [key, defaultValue, navigate]);

  return [value, setValue];
}
