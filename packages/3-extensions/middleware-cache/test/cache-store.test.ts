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
      expect((await store.get('absent')).entry).toBeUndefined();
    });

    it('round-trips a stored entry by key', async () => {
      const store = createInMemoryCacheStore();
      const stored = entry([{ id: 1 }, { id: 2 }]);

      await store.set({ key: 'k', meta: undefined, entry: stored, version: undefined });

      expect((await store.get('k')).entry).toEqual({ rows: [{ id: 1 }, { id: 2 }] });
    });

    it('overwrites an existing entry on repeated set with the same key', async () => {
      const store = createInMemoryCacheStore();
      await store.set({ key: 'k', meta: undefined, entry: entry([{ v: 1 }]), version: undefined });
      await store.set({ key: 'k', meta: undefined, entry: entry([{ v: 2 }]), version: undefined });

      expect((await store.get('k')).entry).toEqual({ rows: [{ v: 2 }] });
    });

    it('ignores meta', async () => {
      const store = createInMemoryCacheStore();

      await store.set({
        key: 'k',
        meta: { tags: ['users'] },
        entry: entry([{ v: 1 }]),
        version: undefined,
      });

      expect((await store.get('k')).entry).toEqual({ rows: [{ v: 1 }] });
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
      await store.set({
        key: 'a',
        meta: undefined,
        entry: entry([{ v: 'A' }]),
        version: undefined,
      });
      await store.set({
        key: 'b',
        meta: undefined,
        entry: entry([{ v: 'B' }]),
        version: undefined,
      });
      await store.set({
        key: 'c',
        meta: undefined,
        entry: entry([{ v: 'C' }]),
        version: undefined,
      });

      await store.unset({ keys: ['a', 'c'], meta: undefined });

      expect((await store.get('a')).entry).toBeUndefined();
      expect((await store.get('b')).entry).toEqual({ rows: [{ v: 'B' }] });
      expect((await store.get('c')).entry).toBeUndefined();
    });

    it('does nothing for missing keys', async () => {
      const store = createInMemoryCacheStore();
      await store.set({
        key: 'a',
        meta: undefined,
        entry: entry([{ v: 'A' }]),
        version: undefined,
      });

      await store.unset({ keys: ['absent'], meta: undefined });

      expect((await store.get('a')).entry).toEqual({ rows: [{ v: 'A' }] });
    });

    it('does nothing when neither keys nor meta is given', async () => {
      const store = createInMemoryCacheStore();
      await store.set({
        key: 'a',
        meta: undefined,
        entry: entry([{ v: 'A' }]),
        version: undefined,
      });

      await store.unset({ keys: undefined, meta: undefined });

      expect((await store.get('a')).entry).toEqual({ rows: [{ v: 'A' }] });
    });

    it.each([
      ['an object', { tags: ['users'] }],
      ['null', null],
    ])('rejects when meta is %s, and removes nothing', async (_label, meta) => {
      const store = createInMemoryCacheStore();
      await store.set({
        key: 'a',
        meta: undefined,
        entry: entry([{ v: 'A' }]),
        version: undefined,
      });

      await expect(store.unset({ keys: ['a'], meta })).rejects.toMatchObject({
        code: 'RUNTIME.CACHE_STORE_META_UNSUPPORTED',
      });
      expect((await store.get('a')).entry).toEqual({ rows: [{ v: 'A' }] });
    });
  });

  describe('versions', () => {
    it('returns version 0 and no entry for a key never seen', async () => {
      const store = createInMemoryCacheStore();

      expect(await store.get('absent')).toEqual({ entry: undefined, version: 0 });
    });

    it('returns the version with a live entry', async () => {
      const store = createInMemoryCacheStore();
      await store.set({ key: 'k', meta: undefined, entry: entry([{ v: 1 }]), version: undefined });

      expect(await store.get('k')).toEqual({ entry: { rows: [{ v: 1 }] }, version: 0 });
    });

    it('increments the version of a key unset removes', async () => {
      const store = createInMemoryCacheStore();
      await store.set({ key: 'k', meta: undefined, entry: entry([{ v: 1 }]), version: undefined });

      await store.unset({ keys: ['k'], meta: undefined });

      expect(await store.get('k')).toEqual({ entry: undefined, version: 1 });
    });

    it('increments the version of a key unset names that holds no entry', async () => {
      const store = createInMemoryCacheStore();

      await store.unset({ keys: ['absent'], meta: undefined });
      await store.unset({ keys: ['absent'], meta: undefined });

      expect(await store.get('absent')).toEqual({ entry: undefined, version: 2 });
    });

    it('does not change the version on set', async () => {
      const store = createInMemoryCacheStore();
      await store.unset({ keys: ['k'], meta: undefined });

      await store.set({ key: 'k', meta: undefined, entry: entry([{ v: 1 }]), version: 1 });

      expect((await store.get('k')).version).toBe(1);
    });

    it('stores and returns true when the version is still current', async () => {
      const store = createInMemoryCacheStore();
      const { version } = await store.get('k');

      const stored = await store.set({
        key: 'k',
        meta: undefined,
        entry: entry([{ v: 1 }]),
        version,
      });

      expect(stored).toBe(true);
      expect((await store.get('k')).entry).toEqual({ rows: [{ v: 1 }] });
    });

    it('stores nothing and returns false when the version has moved', async () => {
      const store = createInMemoryCacheStore();
      const { version } = await store.get('k');
      await store.unset({ keys: ['k'], meta: undefined });

      const stored = await store.set({
        key: 'k',
        meta: undefined,
        entry: entry([{ v: 1 }]),
        version,
      });

      expect(stored).toBe(false);
      expect((await store.get('k')).entry).toBeUndefined();
    });

    it('stores unconditionally when the version is undefined', async () => {
      const store = createInMemoryCacheStore();
      await store.unset({ keys: ['k'], meta: undefined });

      const stored = await store.set({
        key: 'k',
        meta: undefined,
        entry: entry([{ v: 1 }]),
        version: undefined,
      });

      expect(stored).toBe(true);
      expect((await store.get('k')).entry).toEqual({ rows: [{ v: 1 }] });
    });

    it('forgets the version of a key ttlMs after the unset that set it', async () => {
      const time = controlledClock();
      const store = createInMemoryCacheStore({ ttlMs: 100, clock: time.clock });
      await store.unset({ keys: ['k'], meta: undefined });

      time.advanceTo(99);
      expect((await store.get('k')).version).toBe(1);

      time.advanceTo(100);
      expect((await store.get('k')).version).toBe(0);
    });

    it('does not bump versions when it rejects meta', async () => {
      const store = createInMemoryCacheStore();

      await expect(store.unset({ keys: ['k'], meta: { tags: ['users'] } })).rejects.toMatchObject({
        code: 'RUNTIME.CACHE_STORE_META_UNSUPPORTED',
      });
      expect((await store.get('k')).version).toBe(0);
    });
  });

  describe('LRU eviction at maxEntries', () => {
    it('evicts the least recently used entry once maxEntries is exceeded', async () => {
      const store = createInMemoryCacheStore({ maxEntries: 2 });
      await store.set({
        key: 'a',
        meta: undefined,
        entry: entry([{ v: 'A' }]),
        version: undefined,
      });
      await store.set({
        key: 'b',
        meta: undefined,
        entry: entry([{ v: 'B' }]),
        version: undefined,
      });
      await store.set({
        key: 'c',
        meta: undefined,
        entry: entry([{ v: 'C' }]),
        version: undefined,
      });

      expect((await store.get('a')).entry).toBeUndefined();
      expect((await store.get('b')).entry).toEqual({ rows: [{ v: 'B' }] });
      expect((await store.get('c')).entry).toEqual({ rows: [{ v: 'C' }] });
    });

    it('counts a get as a use', async () => {
      const store = createInMemoryCacheStore({ maxEntries: 2 });
      await store.set({
        key: 'a',
        meta: undefined,
        entry: entry([{ v: 'A' }]),
        version: undefined,
      });
      await store.set({
        key: 'b',
        meta: undefined,
        entry: entry([{ v: 'B' }]),
        version: undefined,
      });
      await store.get('a');

      await store.set({
        key: 'c',
        meta: undefined,
        entry: entry([{ v: 'C' }]),
        version: undefined,
      });

      expect((await store.get('a')).entry).toEqual({ rows: [{ v: 'A' }] });
      expect((await store.get('b')).entry).toBeUndefined();
    });

    it('counts an overwrite as a use', async () => {
      const store = createInMemoryCacheStore({ maxEntries: 2 });
      await store.set({
        key: 'a',
        meta: undefined,
        entry: entry([{ v: 'A' }]),
        version: undefined,
      });
      await store.set({
        key: 'b',
        meta: undefined,
        entry: entry([{ v: 'B' }]),
        version: undefined,
      });
      await store.set({
        key: 'a',
        meta: undefined,
        entry: entry([{ v: 'A2' }]),
        version: undefined,
      });

      await store.set({
        key: 'c',
        meta: undefined,
        entry: entry([{ v: 'C' }]),
        version: undefined,
      });

      expect((await store.get('a')).entry).toEqual({ rows: [{ v: 'A2' }] });
      expect((await store.get('b')).entry).toBeUndefined();
    });

    it('keeps 1000 entries by default', async () => {
      const store = createInMemoryCacheStore();
      for (let i = 0; i <= 1000; i++) {
        await store.set({
          key: `k${i}`,
          meta: undefined,
          entry: entry([{ i }]),
          version: undefined,
        });
      }

      expect((await store.get('k0')).entry).toBeUndefined();
      expect((await store.get('k1')).entry).toEqual({ rows: [{ i: 1 }] });
      expect((await store.get('k1000')).entry).toEqual({ rows: [{ i: 1000 }] });
    });
  });

  describe('expiry', () => {
    it('expires an entry once ttlMs has passed since set, on the injected clock', async () => {
      const time = controlledClock(1_000);
      const store = createInMemoryCacheStore({ ttlMs: 500, clock: time.clock });
      await store.set({ key: 'k', meta: undefined, entry: entry([{ v: 1 }]), version: undefined });

      time.advanceTo(1_499);
      expect((await store.get('k')).entry).toEqual({ rows: [{ v: 1 }] });

      time.advanceTo(1_500);
      expect((await store.get('k')).entry).toBeUndefined();
    });

    it('expires entries after 60 seconds by default', async () => {
      const time = controlledClock();
      const store = createInMemoryCacheStore({ clock: time.clock });
      await store.set({ key: 'k', meta: undefined, entry: entry([{ v: 1 }]), version: undefined });

      time.advanceTo(59_999);
      expect((await store.get('k')).entry).toEqual({ rows: [{ v: 1 }] });

      time.advanceTo(60_000);
      expect((await store.get('k')).entry).toBeUndefined();
    });

    it('never expires an entry when ttlMs is Infinity', async () => {
      const time = controlledClock();
      const store = createInMemoryCacheStore({
        ttlMs: Number.POSITIVE_INFINITY,
        clock: time.clock,
      });
      await store.set({ key: 'k', meta: undefined, entry: entry([{ v: 1 }]), version: undefined });

      time.advanceTo(Number.MAX_SAFE_INTEGER);

      expect((await store.get('k')).entry).toEqual({ rows: [{ v: 1 }] });
    });

    it('frees the slot of an expired entry', async () => {
      const time = controlledClock();
      const store = createInMemoryCacheStore({ maxEntries: 2, ttlMs: 100, clock: time.clock });
      await store.set({
        key: 'old',
        meta: undefined,
        entry: entry([{ v: 'old' }]),
        version: undefined,
      });
      time.advanceTo(50);
      await store.set({
        key: 'live',
        meta: undefined,
        entry: entry([{ v: 'live' }]),
        version: undefined,
      });
      time.advanceTo(100);
      expect((await store.get('old')).entry).toBeUndefined();

      await store.set({
        key: 'new',
        meta: undefined,
        entry: entry([{ v: 'new' }]),
        version: undefined,
      });

      expect((await store.get('live')).entry).toEqual({ rows: [{ v: 'live' }] });
      expect((await store.get('new')).entry).toEqual({ rows: [{ v: 'new' }] });
    });
  });
});
