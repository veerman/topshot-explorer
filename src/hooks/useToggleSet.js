import { useState, useCallback } from "react";

/**
 * A Set in state plus a stable toggle(key): the expand/collapse pattern
 * three pages each wrote for themselves.
 */
export function useToggleSet() {
  const [set, setSet] = useState(() => new Set());
  const toggle = useCallback((key) => {
    setSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  return [set, toggle, setSet];
}
