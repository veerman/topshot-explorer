import { useEffect, useMemo, useState } from "react";
import { subscribeAccountContext, getAccountContext } from "../services/account.context";

/*
 * Subscribes a page to the account context (the address being browsed as)
 * and derives the lookup maps the pages annotate themselves with. Returns
 * null when no address is set, so `const owned = useAccountCollection();`
 * followed by `if (owned) ...` is the whole integration.
 *
 * index shape (all keys numeric or "setID_playID" strings):
 *   total                     moments owned
 *   byPlay:    Map(playID -> count)
 *   byEdition: Map("set_play" -> count)            (parallels included)
 *   bySet:     Map(setID -> { count, editions: Set(playID) })
 *   serials:   Map("set_play_sub" -> [serialNumber, ...])
 */
export function useAccountCollection() {
  const [ctx, setCtx] = useState(getAccountContext);

  useEffect(() => subscribeAccountContext(setCtx), []);

  // Linked accounts checked into the context (account menu) contribute
  // their moments; the merged list is what every page sees as "owned"
  const linkedMoments = useMemo(() => {
    const parts = Object.values(ctx.linked || {}).map((l) => l.moments).filter(Array.isArray);
    return parts.length > 0 ? parts.flat() : null;
  }, [ctx.linked]);
  const moments = useMemo(
    () => (Array.isArray(ctx.moments) && linkedMoments ? ctx.moments.concat(linkedMoments) : ctx.moments),
    [ctx.moments, linkedMoments]
  );

  const index = useMemo(() => {
    if (!ctx.address || !Array.isArray(moments)) return null;
    const byPlay = new Map();
    const byEdition = new Map();
    const bySet = new Map();
    const serials = new Map();
    const ids = new Map(); // same keys and order as serials: the momentIDs
    let evmCount = 0; // sixth tuple element: held on Flow EVM
    moments.forEach(([momentID, setID, playID, serial, sub, evm]) => {
      if (evm === 1) evmCount++;
      byPlay.set(playID, (byPlay.get(playID) || 0) + 1);
      const edKey = `${setID}_${playID}`;
      byEdition.set(edKey, (byEdition.get(edKey) || 0) + 1);
      let s = bySet.get(setID);
      if (!s) bySet.set(setID, (s = { count: 0, editions: new Set() }));
      s.count++;
      s.editions.add(playID);
      const subKey = `${edKey}_${sub}`;
      let list = serials.get(subKey);
      if (!list) serials.set(subKey, (list = []));
      list.push(serial);
      let idList = ids.get(subKey);
      if (!idList) ids.set(subKey, (idList = []));
      idList.push(Number(momentID));
    });
    return { total: moments.length, evmCount, byPlay, byEdition, bySet, serials, ids };
  }, [ctx.address, moments]);

  // The wrapper must keep a stable identity between renders: pages put
  // the whole return value in useMemo dep arrays, and a fresh literal
  // every render would defeat all of them
  const owned = useMemo(
    () => ({ address: ctx.address, addresses: [ctx.address, ...(ctx.included || [])], status: ctx.status, progress: ctx.progress, error: ctx.error, graph: ctx.graph, index }),
    [ctx.address, ctx.included, ctx.status, ctx.progress, ctx.error, ctx.graph, index]
  );
  if (!ctx.address) return null;
  return owned;
}
