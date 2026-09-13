// Bounded-concurrency worker pool: fn(item, index) over items with n
// workers pulling from a shared cursor. The one loop seven scripts each
// wrote for themselves.
export async function runPool(items, concurrency, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}
