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

/** One multi-value facet parameter: values encoded, joined on a plain comma */
export function facetParam(key, values) {
  return `${key}=${values.map((v) => encodeURIComponent(v)).join(",")}`;
}
