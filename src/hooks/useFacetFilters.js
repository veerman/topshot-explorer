import { useState, useCallback, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/*
 * The facet-filter machinery Account, AccountOffers and Offers each used
 * to carry a full copy of: URL read/write for comma-joined multi facets
 * (and single string values), the filters-in-state hook, click-to-sort
 * state in both of the app's models, and the cascade rule itself.
 *
 * URL formats are unchanged: multi facets are comma-joined under their
 * key, singles are plain values, and only non-empty entries are written.
 */

/** Read filters from params (defaults to the live location) into a fresh
 *  copy of emptyFilters; array-valued keys split on commas. */
export function readFilters(emptyFilters, params = new URLSearchParams(window.location.search)) {
  const f = { ...emptyFilters };
  Object.keys(emptyFilters).forEach((k) => {
    const v = params.get(k);
    if (!v) return;
    f[k] = Array.isArray(emptyFilters[k]) ? v.split(",").filter(Boolean) : v;
  });
  return f;
}

/** Write the non-empty filters into params (the page adds its own extras
 *  like sort/tab and does the replaceState). */
export function writeFilters(params, filters, emptyFilters) {
  Object.keys(emptyFilters).forEach((k) => {
    if (Array.isArray(emptyFilters[k])) {
      if (filters[k].length > 0) params.set(k, filters[k].join(","));
    } else if (filters[k]) {
      params.set(k, filters[k]);
    }
  });
}

/** Filters in state, initialized from the URL. onChange fires after any
 *  change (pages reset their pagination there). */
export function useFacetFilters(emptyFilters, { onChange } = {}) {
  const [filters, setFilters] = useState(() => readFilters(emptyFilters));
  // A navigation to the same page with a new query (the account menu's
  // links while already on the account page, a badge chip on a detail
  // page) must take effect: the page stays mounted, so the initial read
  // above never runs again. The pages write their own filter changes
  // with replaceState, which the router does not see, so a change in the
  // router's search is always someone navigating here: re-read from it.
  const location = useLocation();
  const seenSearch = useRef(location.search);
  useEffect(() => {
    if (location.search === seenSearch.current) return;
    seenSearch.current = location.search;
    setFilters(readFilters(emptyFilters, new URLSearchParams(location.search)));
    if (onChange) onChange();
  }, [location.search, emptyFilters, onChange]);
  const setFilter = useCallback((key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    if (onChange) onChange();
  }, [onChange]);
  const clearFilters = useCallback(() => {
    setFilters(emptyFilters);
    if (onChange) onChange();
  }, [emptyFilters, onChange]);
  const anyFilter = Object.values(filters).some((v) => (Array.isArray(v) ? v.length > 0 : v !== ""));
  return { filters, setFilters, setFilter, clearFilters, anyFilter };
}

/** Sort state read from the URL under keyParam/dirParam. */
export function readSort(defaultSort, { keyParam = "sort", dirParam = "dir", validKeys = null } = {}) {
  const params = new URLSearchParams(window.location.search);
  const key = params.get(keyParam) || defaultSort.key;
  if (validKeys && !validKeys[key] && key !== defaultSort.key) return { ...defaultSort };
  return { key, dir: params.get(dirParam) === "asc" ? "asc" : (params.get(dirParam) === "desc" ? "desc" : defaultSort.dir) };
}

/**
 * Click-to-sort in the app's two models:
 * - default (two-state): first click sorts desc, a second flips.
 * - naturalDirs given (three-state, the account pages): first click uses
 *   the key's natural direction, a second flips it, a third returns to
 *   the default order (key "").
 */
export function useSortState(initial, { naturalDirs = null, onChange } = {}) {
  const [sort, setSort] = useState(initial);
  const sortBy = useCallback((key) => {
    setSort((prev) => {
      if (naturalDirs) {
        if (prev.key !== key) return { key, dir: naturalDirs[key] };
        if (prev.dir === naturalDirs[key]) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
        return { key: "", dir: "desc" };
      }
      return prev.key === key ? { key, dir: prev.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" };
    });
    if (onChange) onChange();
  }, [naturalDirs, onChange]);
  return { sort, sortBy };
}

/**
 * THE cascade rule, single-sourced: a record matches when it fails no
 * facet, and a facet may OFFER a value from a record that fails only that
 * one facet (so picking Series 1 narrows Sets to series-1 sets while
 * Series itself keeps offering the alternatives).
 */
export function cascadeOf(passMap, keys) {
  const failed = keys.filter((k) => !passMap[k]);
  return {
    matched: failed.length === 0,
    offer: (k) => failed.every((x) => x === k)
  };
}
