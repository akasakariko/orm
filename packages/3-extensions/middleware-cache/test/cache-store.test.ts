import { describe, expect, it } from 'vitest';
import { type CachedEntry, type CacheStore, createInMemoryCacheStore } from '../src/cache-store';

function entry(rows: ReadonlyArray<Record<string, unknown>>): CachedEntry {
  return { rows };
}

function controlledClock(start = 0) {
  let now = start;
  return {
    clock: () => now,
    advanceTo(time: number) {
      now = time;
    },
  };
}

describe('createInMemoryCacheStore', () => {
  describe('options', () => {
    it.each([
      ['ttlMs', { ttlMs: 0 }],
      ['ttlMs', { ttlMs: -1 }],
      ['ttlMs', { ttlMs: Number.NaN }],
      ['maxEntries', { maxEntries: 0 }],
      ['maxEntries', { maxEntries: -1 }],
      ['maxEntries', { maxEntries: 1.5 }],
      ['maxEntries', { maxEntries: Number.NaN }],
      ['maxEntries', { maxEntries: Number.POSITIVE_INFINITY }],
    ])('rejects an invalid %s (%o)', (argument, options) => {
      expect(() => createInMemoryCacheStore(options)).toThrow(
        expect.objectContaining({
          code: 'RUNTIME.ARGUMENT_INVALID',
          meta: {
            helper: 'createInMemoryCacheStore',
            argument,
            received: Object.values(options)[0],
          },
        }),
      );
    });

    it('accepts ttlMs: Infinity and a positive integer maxEntries', () => {
      expect(() =>
        createInMemoryCacheStore({ ttlMs: Number.POSITIVE_INFINITY, maxEntries: 1 }),
      ).not.toThrow();
    });
  });

  describe('get and set', () => {
    it('returns undefined for a missing key', async () => {
      const store = createInMemoryCacheStore();
      expect(await store.get('absent')).toBeUndefined();
    });

    it('round-trips a stored entry by key', async () => {
      const store = createInMemoryCacheStore();
      const stored = entry([{ id: 1 }, { id: 2 }]);

      await store.set({ key: 'k', meta: undefined, entry: stored });

      expect(await store.get('k')).toEqual({ rows: [{ id: 1 }, { id: 2 }] });
    });

    it('overwrites an existing entry on repeated set with the same key', async () => {
      const store = createInMemoryCacheStore();
      await store.set({ key: 'k', meta: undefined, entry: entry([{ v: 1 }]) });
      await store.set({ key: 'k', meta: undefined, entry: entry([{ v: 2 }]) });

      expect(await store.get('k')).toEqual({ rows: [{ v: 2 }] });
    });

    it('ignores meta', async () => {
      const store = createInMemoryCacheStore();

      await store.set({ key: 'k', meta: { tags: ['users'] }, entry: entry([{ v: 1 }]) });

      expect(await store.get('k')).toEqual({ rows: [{ v: 1 }] });
    });

    it('satisfies the CacheStore interface', () => {
      const store: CacheStore = createInMemoryCacheStore();
      expect(store).toMatchObject({
        get: expect.any(Function),
        set: expect.any(Function),
        unset: expect.any(Function),
      });
    });
  });

  describe('unset', () => {
    it('removes the named keys and keeps the rest', async () => {
      const store = createInMemoryCacheStore();
      await store.set({ key: 'a', meta: undefined, entry: entry([{ v: 'A' }]) });
      await store.set({ key: 'b', meta: undefined, entry: entry([{ v: 'B' }]) });
      await store.set({ key: 'c', meta: undefined, entry: entry([{ v: 'C' }]) });

      await store.unset({ keys: ['a', 'c'], meta: undefined });

      expect(await store.get('a')).toBeUndefined();
      expect(await store.get('b')).toEqual({ rows: [{ v: 'B' }] });
      expect(await store.get('c')).toBeUndefined();
    });

    it('does nothing for missing keys', async () => {
      const store = createInMemoryCacheStore();
      await store.set({ key: 'a', meta: undefined, entry: entry([{ v: 'A' }]) });

      await store.unset({ keys: ['absent'], meta: undefined });

      expect(await store.get('a')).toEqual({ rows: [{ v: 'A' }] });
    });

    it('does nothing when neither keys nor meta is given', async () => {
      const store = createInMemoryCacheStore();
      await store.set({ key: 'a', meta: undefined, entry: entry([{ v: 'A' }]) });

      await store.unset({ keys: undefined, meta: undefined });

      expect(await store.get('a')).toEqual({ rows: [{ v: 'A' }] });
    });

    it.each([
      ['an object', { tags: ['users'] }],
      ['null', null],
    ])('rejects when meta is %s, and removes nothing', async (_label, meta) => {
      const store = createInMemoryCacheStore();
      await store.set({ key: 'a', meta: undefined, entry: entry([{ v: 'A' }]) });

      await expect(store.unset({ keys: ['a'], meta })).rejects.toMatchObject({
        code: 'RUNTIME.CACHE_STORE_META_UNSUPPORTED',
      });
      expect(await store.get('a')).toEqual({ rows: [{ v: 'A' }] });
    });
  });

  describe('LRU eviction at maxEntries', () => {
    it('evicts the least recently used entry once maxEntries is exceeded', async () => {
      const store = createInMemoryCacheStore({ maxEntries: 2 });
      await store.set({ key: 'a', meta: undefined, entry: entry([{ v: 'A' }]) });
      await store.set({ key: 'b', meta: undefined, entry: entry([{ v: 'B' }]) });
      await store.set({ key: 'c', meta: undefined, entry: entry([{ v: 'C' }]) });

      expect(await store.get('a')).toBeUndefined();
      expect(await store.get('b')).toEqual({ rows: [{ v: 'B' }] });
      expect(await store.get('c')).toEqual({ rows: [{ v: 'C' }] });
    });

    it('counts a get as a use', async () => {
      const store = createInMemoryCacheStore({ maxEntries: 2 });
      await store.set({ key: 'a', meta: undefined, entry: entry([{ v: 'A' }]) });
      await store.set({ key: 'b', meta: undefined, entry: entry([{ v: 'B' }]) });
      await store.get('a');

      await store.set({ key: 'c', meta: undefined, entry: entry([{ v: 'C' }]) });

      expect(await store.get('a')).toEqual({ rows: [{ v: 'A' }] });
      expect(await store.get('b')).toBeUndefined();
    });

    it('counts an overwrite as a use', async () => {
      const store = createInMemoryCacheStore({ maxEntries: 2 });
      await store.set({ key: 'a', meta: undefined, entry: entry([{ v: 'A' }]) });
      await store.set({ key: 'b', meta: undefined, entry: entry([{ v: 'B' }]) });
      await store.set({ key: 'a', meta: undefined, entry: entry([{ v: 'A2' }]) });

      await store.set({ key: 'c', meta: undefined, entry: entry([{ v: 'C' }]) });

      expect(await store.get('a')).toEqual({ rows: [{ v: 'A2' }] });
      expect(await store.get('b')).toBeUndefined();
    });

    it('keeps 1000 entries by default', async () => {
      const store = createInMemoryCacheStore();
      for (let i = 0; i <= 1000; i++) {
        await store.set({ key: `k${i}`, meta: undefined, entry: entry([{ i }]) });
      }

      expect(await store.get('k0')).toBeUndefined();
      expect(await store.get('k1')).toEqual({ rows: [{ i: 1 }] });
      expect(await store.get('k1000')).toEqual({ rows: [{ i: 1000 }] });
    });
  });

  describe('expiry', () => {
    it('expires an entry once ttlMs has passed since set, on the injected clock', async () => {
      const time = controlledClock(1_000);
      const store = createInMemoryCacheStore({ ttlMs: 500, clock: time.clock });
      await store.set({ key: 'k', meta: undefined, entry: entry([{ v: 1 }]) });

      time.advanceTo(1_499);
      expect(await store.get('k')).toEqual({ rows: [{ v: 1 }] });

      time.advanceTo(1_500);
      expect(await store.get('k')).toBeUndefined();
    });

    it('expires entries after 60 seconds by default', async () => {
      const time = controlledClock();
      const store = createInMemoryCacheStore({ clock: time.clock });
      await store.set({ key: 'k', meta: undefined, entry: entry([{ v: 1 }]) });

      time.advanceTo(59_999);
      expect(await store.get('k')).toEqual({ rows: [{ v: 1 }] });

      time.advanceTo(60_000);
      expect(await store.get('k')).toBeUndefined();
    });

    it('never expires an entry when ttlMs is Infinity', async () => {
      const time = controlledClock();
      const store = createInMemoryCacheStore({
        ttlMs: Number.POSITIVE_INFINITY,
        clock: time.clock,
      });
      await store.set({ key: 'k', meta: undefined, entry: entry([{ v: 1 }]) });

      time.advanceTo(Number.MAX_SAFE_INTEGER);

      expect(await store.get('k')).toEqual({ rows: [{ v: 1 }] });
    });

    it('frees the slot of an expired entry', async () => {
      const time = controlledClock();
      const store = createInMemoryCacheStore({ maxEntries: 2, ttlMs: 100, clock: time.clock });
      await store.set({ key: 'old', meta: undefined, entry: entry([{ v: 'old' }]) });
      time.advanceTo(50);
      await store.set({ key: 'live', meta: undefined, entry: entry([{ v: 'live' }]) });
      time.advanceTo(100);
      expect(await store.get('old')).toBeUndefined();

      await store.set({ key: 'new', meta: undefined, entry: entry([{ v: 'new' }]) });

      expect(await store.get('live')).toEqual({ rows: [{ v: 'live' }] });
      expect(await store.get('new')).toEqual({ rows: [{ v: 'new' }] });
    });
  });
});
