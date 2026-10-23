/*
 * Query strings the way people read them. URLSearchParams percent-encodes
 * the comma the multi-value facets join on (?sub=1%2C2%2C3), which is
 * legal but ugly in a shared link; a comma is safe in a query string, so
 * every writer serializes through here and gets ?sub=1,2,3 back
 * Reading is unaffected: both forms parse the same.
 */
export function toQuery(params) {
  return params.toString().replace(/%2C/gi, ",");
}

/**
 * Writes the page's own query string in place: no history entry, no router
 * render. Keeps window.history.state, where the router stores its entry
 * key; the scroll restore on Back finds a page's saved position by that
 * key, and a null state turned every such entry into the router's
 * "default" key, so Back to a list page opened at the top.
 */
export function replaceQuery(params) {
  const qs = toQuery(params);
  const next = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
  if (next !== window.location.pathname + window.location.search + window.location.hash) {
    window.history.replaceState(window.history.state, "", next);
  }
}

/** One multi-value facet parameter: values encoded, joined on a plain comma */
export function facetParam(key, values) {
  return `${key}=${values.map((v) => encodeURIComponent(v)).join(",")}`;
}
