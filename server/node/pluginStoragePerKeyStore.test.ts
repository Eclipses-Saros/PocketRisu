import { describe, it, expect } from 'vitest'
import perKey from './pluginStoragePerKeyStore.cjs'
import utils from './utils.cjs'

const { createPluginStoragePerKeyStore, PLUGIN_STORAGE_PERKEY_PREFIX, kvKeyFor } = perKey as any
const { hydratePluginCustomStorageServer, assertPluginStorageResolved, PLUGIN_STORAGE_SIDECAR_MARKER, encodeRisuSaveLegacy, decodeRisuSave, normalizeJSON, buildPluginStorageDirectory, calculateHash, stripPluginStorageToMarker } = utils as any

// In-memory kv with listPrefix, matching the store's interface (Buffer values).
// transaction models SQLite's atomic rollback: snapshot the map, run fn, and on
// throw restore the snapshot so a failed batch leaves NO partial state.
function fakeKv() {
    const m = new Map<string, Buffer>()
    return {
        m,
        get: (k: string) => (m.has(k) ? m.get(k)! : null),
        set: (k: string, v: Buffer) => { m.set(k, v) },
        del: (k: string) => { m.delete(k) },
        listPrefix: (p: string) => [...m.keys()].filter((k) => k.startsWith(p)),
        transaction: (fn: () => any) => {
            const backup = new Map(m)
            try { return fn() }
            catch (e) { m.clear(); for (const [k, v] of backup) m.set(k, v); throw e }
        },
    }
}

// Realistic both-plugin keys: Flashback shard (':'), HAYAKU durable ('.', '/'),
// unicode, and an empty value.
const KEYS = {
    'vector_rag_memory:scope:abc:records:shard:0000': JSON.stringify({ v: 2, blob: 'x'.repeat(2000) }),
    'hayaku.v1.durable.9f3a/weird': JSON.stringify({ 記憶: 'ユニコード/스코프' }),
    'hayaku.v1.store': '',
}

describe('pluginStoragePerKeyStore — per-key server store (B inc 4, b3)', () => {
    it('one KV entry per key, under the prefix, reversible key scheme', () => {
        expect(PLUGIN_STORAGE_PERKEY_PREFIX).toBe('pluginStorage/data/')
        const kk = kvKeyFor('vector_rag_memory:scope:abc:records:shard:0000')
        expect(kk.startsWith('pluginStorage/data/')).toBe(true)
        expect(kk.endsWith('.bin')).toBe(true)
        // never collides with database.bin or its single-blob sidecar
        expect(kk).not.toBe('database/database.bin')
        expect(kk).not.toBe('database/pluginStorage.bin')
    })

    it('writeKey → readKey round-trips each value (incl. unicode, slash, empty)', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        for (const [k, v] of Object.entries(KEYS)) s.writeKey(k, v)
        for (const [k, v] of Object.entries(KEYS)) expect(await s.readKey(k)).toBe(v)
    })

    it('CONCURRENCY WIN: overwriting one key never touches another key’s entry', async () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        s.writeKey('K1', 'v1')
        s.writeKey('K2', 'v2')
        const k2entryBefore = Buffer.from(kv.m.get(kvKeyFor('K2'))!)
        // "concurrent" writer changes K1 only
        s.writeKey('K1', 'v1-updated')
        expect(await s.readKey('K1')).toBe('v1-updated')
        expect(await s.readKey('K2')).toBe('v2')                       // survived
        expect(Buffer.compare(kv.m.get(kvKeyFor('K2'))!, k2entryBefore)).toBe(0) // byte-untouched
    })

    it('writeMany writes only the given keys, leaves others intact', async () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        s.initializeFromMap({ untouched: 'keep' })   // steady-state writes require an initialized store
        s.writeMany({ a: '1', b: '2' })
        expect(await s.readKey('a')).toBe('1')
        expect(await s.readKey('b')).toBe('2')
        expect(await s.readKey('untouched')).toBe('keep')
    })

    it('loader(directory) reassembles the full map from the key list', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        for (const [k, v] of Object.entries(KEYS)) s.writeKey(k, v)
        const map = await s.loader({ version: 2, keys: Object.keys(KEYS) })
        expect(JSON.stringify(map)).toBe(JSON.stringify(KEYS))
    })

    it('loader FAILS CLOSED when the directory lists a key whose entry is missing', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.writeKey('present', 'ok')
        await expect(s.loader({ version: 2, keys: ['present', 'missing'] }))
            .rejects.toThrow(/fail(ing)? closed|missing/i)
    })

    it('valid empty directory → empty map (legitimately empty, not a loss)', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        expect(await s.loader({ version: 2, keys: [] })).toEqual({})
    })

    it('loader FAILS CLOSED on a malformed / wrong-version marker (never silently empty)', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        await expect(s.loader(null)).rejects.toThrow(/fail(ing)? closed|malformed/i)
        await expect(s.loader({ keys: ['a'] })).rejects.toThrow(/version|fail/i)              // no version
        await expect(s.loader({ version: 1, keys: ['a'] })).rejects.toThrow(/version|fail/i)  // old single-blob version
        await expect(s.loader({ version: 2 })).rejects.toThrow(/keys|fail/i)                  // no keys
        await expect(s.loader({ version: 2, keys: 'bad' })).rejects.toThrow(/keys|fail/i)     // keys not array
    })

    it('__proto__ survives as an OWN key at the ROW level (no prototype pollution)', async () => {
        // The RAW row primitives (writeKey/readKey/loader) handle a "__proto__" key
        // safely via safeSet + kvKeyFor. (Over the sync WIRE, __proto__ is codec-unsafe
        // and the map ops reject it fail-closed — see the codec-safe-key tests below.)
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.writeKey('__proto__', { danger: 1 })
        s.writeKey('normal', 'ok')
        const map = await s.loader({ version: 2, keys: ['__proto__', 'normal'] })
        expect(Object.hasOwn(map, '__proto__')).toBe(true)
        expect(JSON.stringify((map as any)['__proto__'])).toBe(JSON.stringify({ danger: 1 }))
        expect(Object.getPrototypeOf(map)).toBe(Object.prototype)   // prototype NOT polluted
    })

    it('lone-surrogate key fails with a clear error, not a cryptic URIError', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        expect(() => s.writeKey(String.fromCharCode(0xd800), 'x')).toThrow(/not encodable|surrogate/i)
    })

    it('removeKey removes exactly one entry; siblings survive', async () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        s.writeKey('a', '1'); s.writeKey('b', '2')
        s.removeKey('a')
        expect(await s.readKey('a')).toBeUndefined()
        expect(await s.readKey('b')).toBe('2')
    })

    it('listKeys enumerates stored plugin keys, decoded back from the path', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        for (const k of Object.keys(KEYS)) s.writeKey(k, KEYS[k as keyof typeof KEYS])
        expect(new Set(s.listKeys())).toEqual(new Set(Object.keys(KEYS)))
    })

    // SSOT step 1a (+ codex fixes): the flat pluginStorage/<key>.bin layout let a
    // plugin value collide with a would-be sentinel. Values now live under data/;
    // the mode sentinel lives under control/ (a nested .json path IMPOSSIBLE under
    // the flat scheme). migrateLegacyLayout moves EVERY flat value — including the
    // empty key ("") and a key literally named "meta" — leaves the sentinel,
    // preflights conflicts, and fails closed on corruption.
    const flatPath = (k: string) => `pluginStorage/${encodeURIComponent(k)}.bin`
    const seedFlat = (kv: any, k: string, v: any) => kv.m.set(flatPath(k), Buffer.from(JSON.stringify(v)))

    it('migrates every flat value incl. "" and "meta"; sentinel at control/ is left; idempotent', async () => {
        const kv = fakeKv()
        const legacyKeys: Record<string, string> = { '': 'empty-key-value', meta: 'a-plugin-key-named-meta', 'a:b/c': 'x' }
        for (const [k, v] of Object.entries(legacyKeys)) seedFlat(kv, k, v)
        // a sentinel at the control path must NOT be treated as a value; but a VALID
        // initialized sentinel + flat rows is ambiguous → migration refuses. Use a
        // control-path file that is NOT the mode sentinel to prove it is left alone.
        kv.m.set('pluginStorage/control/other.json', Buffer.from('{}', 'utf8'))

        const s = createPluginStoragePerKeyStore(kv)
        expect(s.migrateLegacyLayout().migrated).toBe(3)
        for (const [k, v] of Object.entries(legacyKeys)) expect(await s.readKey(k)).toBe(v)   // incl. "" and "meta"
        for (const k of Object.keys(legacyKeys)) expect(kv.m.has(flatPath(k))).toBe(false)     // flat rows gone
        expect(kv.m.has('pluginStorage/control/other.json')).toBe(true)                        // control/ untouched
        expect(new Set(s.listKeys())).toEqual(new Set(Object.keys(legacyKeys)))                // sentinel/control not enumerated
        expect(s.migrateLegacyLayout().migrated).toBe(0)                                       // idempotent
    })

    it('migration REFUSES flat rows in an already-initialized store (ambiguous, no silent reshape)', () => {
        const kv = fakeKv()
        seedFlat(kv, 'stale', 'v')
        kv.m.set('pluginStorage/control/mode.json', Buffer.from(JSON.stringify({ version: 3, state: 'initialized' }), 'utf8'))
        const s = createPluginStoragePerKeyStore(kv)
        expect(() => s.migrateLegacyLayout()).toThrow(/initialized|ambiguous|failing closed/i)
        expect(kv.m.has(flatPath('stale'))).toBe(true) // preserved
    })

    it('migration DROPS a byte-identical duplicate but THROWS on a differing destination (no overwrite)', async () => {
        // identical dst → drop stale flat copy
        const kv1 = fakeKv()
        seedFlat(kv1, 'k', 'v')
        kv1.m.set('pluginStorage/data/k.bin', Buffer.from(JSON.stringify('v'))) // identical dst
        const s1 = createPluginStoragePerKeyStore(kv1)
        expect(s1.migrateLegacyLayout().migrated).toBe(1)
        expect(kv1.m.has(flatPath('k'))).toBe(false)
        expect(await s1.readKey('k')).toBe('v')

        // differing dst → throw, preserve BOTH (never overwrite possibly-newer memory)
        const kv2 = fakeKv()
        seedFlat(kv2, 'k', 'OLD')
        kv2.m.set('pluginStorage/data/k.bin', Buffer.from(JSON.stringify('NEW'))) // differing dst
        const s2 = createPluginStoragePerKeyStore(kv2)
        expect(() => s2.migrateLegacyLayout()).toThrow(/conflict|failing closed/i)
        expect(kv2.m.has(flatPath('k'))).toBe(true)          // flat preserved (rolled back)
        expect(await s2.readKey('k')).toBe('NEW')            // dst preserved
    })

    it('migration FAILS CLOSED on a zero-length legacy row (never silently deletes evidence)', () => {
        const kv = fakeKv()
        kv.m.set('pluginStorage/zero.bin', Buffer.alloc(0))
        const s = createPluginStoragePerKeyStore(kv)
        expect(() => s.migrateLegacyLayout()).toThrow(/empty|failing closed/i)
        expect(kv.m.has('pluginStorage/zero.bin')).toBe(true) // preserved
    })

    it('rejects a bad kv interface', () => {
        expect(() => createPluginStoragePerKeyStore(null)).toThrow(/kv/i)
        expect(() => createPluginStoragePerKeyStore({})).toThrow(/kv/i)
    })

    // Backup export/import: the real backup entry is a JSON blob
    // (JSON.stringify({pluginCustomStorage: readAll})); import parses it and reconciles
    // it back out. Prove the whole round-trip is lossless with the JSON contract (msgpack
    // is NOT used for this blob — it would rename nested "__proto__"/surrogate keys).
    it('export blob → import reconcileReplace round-trips the whole per-key map (backup path, JSON)', async () => {
        const src = createPluginStoragePerKeyStore(fakeKv())
        src.initializeFromMap({ ...KEYS })          // out-of-band source
        // export: reassemble → JSON-encode (the real pluginStorageBackupEntry format)
        const blob = Buffer.from(JSON.stringify({ pluginCustomStorage: await src.readAll() }), 'utf8')
        // import into a store with a stale legacy row that must be cleared. Import is
        // an explicit RECOVERY → reconcileReplace (overwrites whatever state is live).
        const dst = createPluginStoragePerKeyStore(fakeKv())
        dst.writeKey('stale-should-be-removed', 'old')
        const decoded = JSON.parse(blob.toString('utf8'))
        dst.reconcileReplace(decoded.pluginCustomStorage)
        expect(await dst.readAll()).toEqual(KEYS)
        expect(await dst.readKey('stale-should-be-removed')).toBeUndefined() // wholesale replace
    })

    it('readAll reassembles the whole stored map by prefix scan', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeFromMap({ ...KEYS })
        expect(JSON.stringify(await s.readAll())).toBe(JSON.stringify(KEYS))
    })

    // SSOT step 1b: readAllRaw captures a synchronous point-in-time snapshot, so a
    // write landing after capture cannot tear the result (the torn read that the
    // old await-per-key readAll allowed).
    it('readAllRaw captures a synchronous snapshot immune to post-capture writes', async () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        s.writeKey('A', 'a'); s.writeKey('B', 'b')
        const rows = s.readAllRaw()
        expect(Array.isArray(rows)).toBe(true)                    // synchronous, not a Promise
        expect(rows.map((r: any) => r.pluginKey).sort()).toEqual(['A', 'B'])
        // concurrent mutations AFTER capture must not alter the captured snapshot
        s.writeKey('C', 'c'); s.removeKey('A')
        expect(rows.map((r: any) => r.pluginKey).sort()).toEqual(['A', 'B'])
        // decoding the captured buffers yields the pre-mutation values
        const map: Record<string, any> = {}
        for (const { pluginKey, raw } of rows) {
            map[pluginKey] = JSON.parse(Buffer.from(raw).toString())
        }
        expect(map).toEqual({ A: 'a', B: 'b' })
    })

    it('replaceAll writes new keys and deletes stale ones (re-sync on an initialized store)', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeFromMap({ old: 'x', keep: 'y' })
        s.replaceAll({ keep: 'y2', fresh: 'z' })
        expect(await s.readKey('old')).toBeUndefined()   // stale removed
        expect(await s.readKey('keep')).toBe('y2')        // updated
        expect(await s.readKey('fresh')).toBe('z')        // added
    })

    // SSOT step 1c: multi-key mutations are atomic. A mid-batch failure rolls back
    // earlier writes so a partial map is never persisted.
    it('writeMany is atomic: a mid-batch failure rolls back earlier writes', async () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        s.initializeFromMap({ pre: 'exists' })
        const bad = String.fromCharCode(0xd800) // lone surrogate → writeKey throws mid-batch
        // 'good' is written first, then the bad key throws → the whole batch rolls back
        expect(() => s.writeMany({ good: 'g', [bad]: 'x' })).toThrow(/encodable|surrogate/i)
        expect(kv.m.has(kvKeyFor('good'))).toBe(false)   // earlier write rolled back
        expect(await s.readKey('pre')).toBe('exists')    // pre-existing entry untouched
    })

    it('applyDelta is atomic: a failing change rolls back its removals too', async () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        s.initializeFromMap({ keep: 'v', doomed: 'v' })
        const bad = String.fromCharCode(0xd800)
        // an un-pathable (lone-surrogate) changed key throws in writeKey → the whole
        // transaction rolls back → the removal of 'doomed' is undone too.
        expect(() => s.applyDelta({ changed: { [bad]: 'x' }, removed: ['doomed'] })).toThrow(/not encodable|surrogate/i)
        expect(await s.readKey('doomed')).toBe('v')      // removal rolled back
        expect(await s.readKey('keep')).toBe('v')
    })

    // an un-pathable removed key throws mid-transaction → any completed removal rolls back.
    it('applyDelta rolls back when a removed key is un-pathable (lone surrogate)', async () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        s.initializeFromMap({ keepA: '1', keepB: '2' })
        const bad = String.fromCharCode(0xd800)
        expect(() => s.applyDelta({ removed: ['keepA', bad] })).toThrow(/not encodable|surrogate/i)
        expect(await s.readKey('keepA')).toBe('1')       // removal rolled back
        expect(await s.readKey('keepB')).toBe('2')
    })

    it('applyDelta touches ONLY changed/removed keys (concurrency-safe path)', async () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        s.initializeFromMap({ a: '1', b: '2', c: '3' })
        const bBefore = Buffer.from(kv.m.get(kvKeyFor('b'))!)
        s.applyDelta({ changed: { a: '1x' }, removed: ['c'] })
        expect(await s.readKey('a')).toBe('1x')                                     // changed
        expect(await s.readKey('c')).toBeUndefined()                               // removed
        expect(Buffer.compare(kv.m.get(kvKeyFor('b'))!, bBefore)).toBe(0)          // b untouched
    })

    // GENERALITY: works for ANY plugin, not just the two sample ones. The plugin
    // API stores whatever a plugin puts in db.pluginCustomStorage[key] — any string
    // key, any JSON value — so the store must round-trip all of it unchanged.
    it('round-trips arbitrary VALUE types (object, number, bool, null, array, empty string)', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        const values: Record<string, any> = {
            obj: { nested: { a: 1 }, list: [1, 2, 3] },
            num: 42.5, zero: 0, bool: false, nul: null, arr: ['x', { y: 1 }], emptyStr: '', str: 'hi',
        }
        for (const [k, v] of Object.entries(values)) s.writeKey(k, v)
        for (const [k, v] of Object.entries(values)) expect(JSON.stringify(await s.readKey(k))).toBe(JSON.stringify(v))
    })

    it('round-trips arbitrary KEY strings (empty, spaces, emoji, newline, very long, reserved chars)', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        const keys = ['', 'with space', 'emoji🔑key', 'line\nbreak', 'a'.repeat(2000), 'a/b:c?d#e&f%g', '../evil', '한글키']
        for (const k of keys) s.writeKey(k, `v:${k.length}`)
        for (const k of keys) expect(await s.readKey(k)).toBe(`v:${k.length}`)
        // distinct keys never collide on their KV path
        expect(new Set(keys.map(kvKeyFor)).size).toBe(keys.length)
        // none escape the prefix; '/' is percent-encoded so a key can't inject a KV
        // sub-path or collide with another namespace (e.g. database/database.bin).
        for (const k of keys) {
            const kk = kvKeyFor(k)
            expect(kk.startsWith(PLUGIN_STORAGE_PERKEY_PREFIX)).toBe(true)
            expect(kk.slice(PLUGIN_STORAGE_PERKEY_PREFIX.length, -'.bin'.length)).not.toContain('/')
        }
    })
})

// SSOT step 1d (re-simplified): the SQLite ROWS are the authority — the key set IS
// listPrefix('pluginStorage/data/'). There is NO manifest key-list (a second
// authority that could only diverge). The only server-side state beyond the rows is
// a tiny MODE sentinel at pluginStorage/control/mode.json: a per-account flag
// {version, state:'initialized'} that distinguishes an initialized-but-empty store
// from a never-migrated (legacy) one. Present-but-off-shape → corrupt, never legacy.
describe('pluginStoragePerKeyStore — mode sentinel (SSOT step 1d)', () => {
    const MODE = 'pluginStorage/control/mode.json'
    const setMode = (kv: any, obj: any) => kv.m.set(MODE, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8'))

    it('fresh store has no sentinel → legacy', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        expect(s.readMode()).toBeNull()
        expect(s.modeState()).toBe('legacy')
        expect(s.isInitialized()).toBe(false)
    })

    it('the sentinel records {version, state:initialized}; no key-list', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeFromMap({ z: '1', a: '2' })   // rows + sentinel atomically
        const m = s.readMode()
        expect(m.version).toBe(3)
        expect(m.state).toBe('initialized')
        expect('keys' in m).toBe(false)          // the rows are the authority, not a manifest list
        expect(s.modeState()).toBe('initialized')
    })

    it('empty initialized store is LEGITIMATELY empty (initialized, zero rows) — not legacy', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeMode()
        expect(s.modeState()).toBe('initialized')
        expect(s.listKeys()).toEqual([])
    })

    it('initializeFromMap writes rows AND sets the sentinel atomically', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeFromMap({ a: '1', b: '2' })
        expect(s.modeState()).toBe('initialized')
        expect(new Set(s.listKeys())).toEqual(new Set(['a', 'b']))
        expect(await s.readKey('a')).toBe('1')
    })

    // present-but-off-shape sentinel must be corrupt, NEVER downgraded to legacy
    // (which would ignore live per-key rows).
    it('present-but-invalid sentinels are corrupt (unknown state / wrong version / null / array / empty bytes)', () => {
        const bad: any[] = [
            { version: 3, state: 'future' },      // unknown state
            { version: 2, state: 'initialized' },  // wrong version
            { version: 3, state: 'initialized', keys: [] }, // extra prop (stray key-list shape)
            { version: 3 },                        // missing state
            null, false, 0, [1, 2, 3], '',         // JSON primitives / array / empty bytes
        ]
        for (const b of bad) {
            const kv = fakeKv()
            const s = createPluginStoragePerKeyStore(kv)
            setMode(kv, b)
            expect(s.modeState(), JSON.stringify(b)).toBe('corrupt')
            expect(s.classify({ characters: [] }).state, JSON.stringify(b)).toBe('corrupt')
        }
    })

    it('B2 fix: a plugin key named "meta" coexists with the sentinel (no collision)', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeFromMap({ meta: 'a-real-plugin-key-named-meta' }) // encodes under data/
        expect(s.listKeys()).toEqual(['meta'])            // the sentinel is not enumerated
        expect(kvKeyFor('meta')).toBe('pluginStorage/data/meta.bin')
        expect(s.modeKey).toBe('pluginStorage/control/mode.json')
        expect(s.modeKey).not.toBe(kvKeyFor('meta'))      // impossible under the flat scheme
    })

    it('a real per-key delete just deletes the row (no manifest to strand) — readAll reflects it', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeFromMap({ a: '1', b: '2' })
        s.applyDelta({ removed: ['b'] })
        expect(await s.readAll()).toEqual({ a: '1' })     // b gone, no stuck fail-closed state
    })

    it('refuses to mutate a corrupt sentinel (never writes into an unknown state)', () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        setMode(kv, { version: 3, state: 'bogus' })
        expect(() => s.applyDelta({ changed: { b: '2' } })).toThrow(/corrupt|failing/i)
    })

    it('refuses to mutate while un-migrated flat rows are present (reconcile first)', () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        s.initializeMode() // establish an empty out-of-band store first
        kv.m.set(`pluginStorage/${encodeURIComponent('flat')}.bin`, Buffer.from(JSON.stringify('v'))) // a flat row appears (half-migrated)
        expect(() => s.writeMany({ x: '1' })).toThrow(/flat|reconcile|failing/i)
    })

    it('initializeMode refuses when a sentinel already exists (no reset)', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeMode()
        expect(() => s.initializeMode()).toThrow(/already exists/i)
    })

    it('initializeMode refuses when data rows already exist (no blessing a partial set)', () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        kv.m.set(kvKeyFor('pre'), Buffer.from(JSON.stringify('x')))
        expect(() => s.initializeMode()).toThrow(/empty store|reconcileReplace/i)
    })

    // codex round-6: an object whose data is all in SYMBOL or NON-ENUMERABLE props (or a
    // getter) serializes to {} → would wipe on replace. isPlainMap must reject it even
    // though its prototype is Object.prototype.
    it('replaceAll REFUSES a plain object whose keys are symbol/non-enumerable/accessor', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.replaceAll({ a: '1' })
        const symOnly: any = {}; symOnly[Symbol('k')] = 'v'
        const nonEnum: any = {}; Object.defineProperty(nonEnum, 'k', { value: 'v', enumerable: false })
        const getterOnly: any = {}; Object.defineProperty(getterOnly, 'k', { get: () => 'v', enumerable: true })
        for (const bad of [symOnly, nonEnum, getterOnly]) {
            expect(() => s.replaceAll(bad)).toThrow(/plain object|non-string|enumerable data property/i)
        }
    })
})

// SSOT step 1e: the reconciliation classifier reads ALL representations and
// refuses to guess when they disagree (fail-closed 'ambiguous'), the property that
// kills codex's transition-state / dangling-marker / db-side-after-init silent loss.
describe('pluginStoragePerKeyStore — reconciliation classifier (SSOT step 1e)', () => {
    const markerDb = (extra: any = {}) => ({ characters: [], [PLUGIN_STORAGE_SIDECAR_MARKER]: { version: 2, keys: ['x'] }, ...extra })

    it('legacy: no sentinel, no rows, inline in DB → inline authoritative', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        expect(s.classify({ characters: [], pluginCustomStorage: { a: '1' } }).state).toBe('legacy')
    })

    it('legacy: no sentinel, no rows, genuinely empty DB → legacy (not a loss)', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        expect(s.classify({ characters: [] }).state).toBe('legacy')
    })

    it('initialized: sentinel ok, no DB-side pcs → per-key authoritative', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeFromMap({ a: '1' })
        expect(s.classify({ characters: [] }).state).toBe('initialized')
    })

    it('AMBIGUOUS: per-key rows exist but no sentinel (partial migration) → fail closed', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.writeKey('a', '1') // rows written, initializeMode never ran
        const c = s.classify({ characters: [] })
        expect(c.state).toBe('ambiguous')
        expect(c.reason).toMatch(/partial migration|without a mode/i)
    })

    it('AMBIGUOUS: SSOT initialized but the DB still carries inline pcs → fail closed', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeFromMap({ a: '1' })
        const c = s.classify({ characters: [], pluginCustomStorage: { a: 'stale-inline' } })
        expect(c.state).toBe('ambiguous')
    })

    it('AMBIGUOUS: DB marker but no per-key store (dangling) → fail closed', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        expect(s.classify(markerDb()).state).toBe('ambiguous')
    })

    it('corrupt: unreadable sentinel → corrupt', () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        kv.m.set('pluginStorage/control/mode.json', Buffer.from('garbage{', 'utf8'))
        expect(s.classify({ characters: [] }).state).toBe('corrupt')
    })

    it('AMBIGUOUS: un-migrated flat legacy rows present → fail closed (not legacy)', () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        kv.m.set(`pluginStorage/${encodeURIComponent('legacyKey')}.bin`, Buffer.from(JSON.stringify('v')))
        expect(s.classify({ characters: [] }).state).toBe('ambiguous')
    })

    it('initialized + empty DB pcs FIELD present (Object.hasOwn) → ambiguous, not initialized', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeFromMap({ a: '1' })
        // even an EMPTY {} field means a writer bypassed the SSOT
        expect(s.classify({ characters: [], pluginCustomStorage: {} }).state).toBe('ambiguous')
    })
})

// SSOT 2e (codex R11 finding 2): every lifecycle EXPORT (nodeonly backup entry,
// upstream re-inline) must abort — never silently ship a DB missing rows — for any
// store state other than clean-legacy or initialized. exportDisposition is the single
// gate both sites use.
describe('pluginStoragePerKeyStore — exportDisposition (SSOT 2e, no silent drop on export)', () => {
    it('clean legacy (no sentinel, no rows) → passthrough (inline rides the DB)', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        expect(s.exportDisposition()).toBe('passthrough')
    })

    it('initialized → reinline (rows are authoritative, export must pull them)', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeFromMap({ ...KEYS })
        expect(s.exportDisposition()).toBe('reinline')
    })

    it('initialized-EMPTY → reinline ({} still gets an entry so a restore clears stale rows)', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeFromMap({})
        expect(s.exportDisposition()).toBe('reinline')
    })

    it('AMBIGUOUS (rows without a mode) → THROWS (would silently drop the rows)', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.writeKey('a', '1') // rows, but initializeMode never ran
        expect(() => s.exportDisposition()).toThrow(/ambiguous|silently drop|refusing/i)
    })

    it('AMBIGUOUS (un-migrated flat legacy rows) → THROWS', () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        kv.m.set(`pluginStorage/${encodeURIComponent('legacyKey')}.bin`, Buffer.from(JSON.stringify('v')))
        expect(() => s.exportDisposition()).toThrow(/ambiguous|flat|silently drop|refusing/i)
    })

    it('CORRUPT sentinel → THROWS', () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        kv.m.set('pluginStorage/control/mode.json', Buffer.from('garbage{', 'utf8'))
        expect(() => s.exportDisposition()).toThrow(/corrupt|silently drop|refusing/i)
    })
})

// SSOT 2e (codex R11 finding 4): the upstream export re-encodes the re-inlined map to
// msgpack (the target format), which can rename exotic keys the local JSON store holds
// losslessly. deepEqualJSON is the round-trip guard that aborts such an export.
describe('pluginStoragePerKeyStore — deepEqualJSON (lossless re-inline guard)', () => {
    const { deepEqualJSON } = perKey as any
    it('equal for identical nested maps regardless of key ORDER', () => {
        expect(deepEqualJSON({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true)
    })
    it('detects a RENAMED key (the msgpack "__proto__" failure mode)', () => {
        // JSON.parse makes "__proto__" an OWN enumerable key (a literal would set the
        // prototype instead). This is exactly the key msgpack renames on re-encode.
        const withProto = JSON.parse('{"__proto__":"v"}')
        expect(Object.keys(withProto)).toEqual(['__proto__']) // sanity: own key, not proto
        expect(deepEqualJSON(withProto, { renamed: 'v' })).toBe(false)
        expect(deepEqualJSON(withProto, JSON.parse('{"__proto__":"v"}'))).toBe(true)
    })
    it('detects a DROPPED key', () => {
        expect(deepEqualJSON({ a: 1, b: 2 }, { a: 1 })).toBe(false)
    })
    it('detects a changed VALUE and a changed type', () => {
        expect(deepEqualJSON({ a: 1 }, { a: 2 })).toBe(false)
        expect(deepEqualJSON({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false)
        expect(deepEqualJSON({ a: '1' }, { a: 1 })).toBe(false)
        expect(deepEqualJSON({ a: {} }, { a: [] })).toBe(false)
    })
    it('handles null / primitives at the top level', () => {
        expect(deepEqualJSON(null, null)).toBe(true)
        expect(deepEqualJSON(null, {})).toBe(false)
        expect(deepEqualJSON('x', 'x')).toBe(true)
    })
})

// SSOT 2e (codex R11 findings 1 & 3): backup import ALWAYS clears pluginStorage/ then,
// if the backup carried a pcs entry, reconciles the exact saved map — all inside the
// restore transaction. Model that sequence at the store level (the server wraps the
// same two ops in the DB-restore BEGIN/COMMIT).
describe('pluginStoragePerKeyStore — backup import clear+reconcile (SSOT 2e)', () => {
    const clearPrefix = (kv: any) => { for (const k of [...kv.m.keys()].filter((x: string) => x.startsWith('pluginStorage/'))) kv.m.delete(k) }

    it('legacy/upstream backup (NO pcs entry): clearing resets a prior initialized store to legacy (imported inline wins)', () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        s.initializeFromMap({ ...KEYS })          // prior account: initialized rows + sentinel
        expect(s.classify({ characters: [] }).state).toBe('initialized')
        clearPrefix(kv)                            // import of an inline-only backup: no reconcile
        // now legacy — a GET/readAll no longer shadows the imported inline pcs with stale rows
        expect(s.classify({ characters: [], pluginCustomStorage: { imported: '1' } }).state).toBe('legacy')
        expect(s.listKeys()).toEqual([])
        expect(s.modeState()).toBe('legacy')
    })

    it('backup WITH a pcs entry: clear+reconcile replaces prior rows exactly (even over an ambiguous prior state)', async () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        s.initializeFromMap({ old: 'gone' })
        // simulate an ambiguous prior state: a stray flat legacy row alongside the sentinel
        kv.m.set(`pluginStorage/${encodeURIComponent('strayFlat')}.bin`, Buffer.from(JSON.stringify('x')))
        expect(s.hasLegacyFlatRows()).toBe(true)
        // import: clear removes the flat row + sentinel, so reconcileReplace lands clean
        clearPrefix(kv)
        s.reconcileReplace({ ...KEYS })
        expect(await s.readAll()).toEqual(KEYS)
        expect(await s.readKey('old')).toBeUndefined()
        expect(s.hasLegacyFlatRows()).toBe(false)
    })
})

// SSOT step 2: the mode sentinel is WIRED into the mutation path. Steady-state
// writes (writeMany/applyDelta) require an initialized store; replaceAll is the
// authoritative reconcile/first-sync that establishes the mode; boot migration marks
// a pre-sentinel out-of-band account initialized. This closes codex's "first live
// delta produces legacy+rows that readAll serves" gap.
describe('pluginStoragePerKeyStore — mode wiring (SSOT step 2)', () => {
    it('replaceAll on a fresh legacy store establishes the mode (first-sync) and writes the map', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        expect(s.modeState()).toBe('legacy')
        s.replaceAll({ a: '1', b: '2' })
        expect(s.modeState()).toBe('initialized')          // mode established
        expect(await s.readAll()).toEqual({ a: '1', b: '2' })
    })

    it('replaceAll over an initialized store replaces rows and stays initialized', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeFromMap({ old: 'x', keep: 'y' })
        s.replaceAll({ keep: 'y2', fresh: 'z' })
        expect(s.modeState()).toBe('initialized')
        expect(await s.readAll()).toEqual({ keep: 'y2', fresh: 'z' })   // old removed
    })

    it('applyDelta/writeMany REFUSE a legacy (uninitialized) store — no legacy+rows accumulation', () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        expect(() => s.applyDelta({ changed: { a: '1' } })).toThrow(/not initialized|full replace/i)
        expect(() => s.writeMany({ a: '1' })).toThrow(/not initialized|full replace/i)
        expect(s.modeState()).toBe('legacy')               // nothing written
        expect(s.listKeys()).toEqual([])
    })

    it('initializeFromMap REFUSES pre-existing data rows (must reconcile via replaceAll)', () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        kv.m.set(kvKeyFor('pre'), Buffer.from(JSON.stringify('x'))) // a stray data row
        expect(() => s.initializeFromMap({ a: '1' })).toThrow(/pre-existing data rows|reconcile/i)
    })

    // codex round-4 HIGH: a malformed replace payload must NEVER be coerced to {} (that
    // would silently wipe the store).
    it('replaceAll REFUSES a non-plain-object payload (never coerces to {} / wipes the store)', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.replaceAll({ a: '1' })                            // establish initialized
        // codex round-5: a TYPED object (Date/Uint8Array/RegExp/Map) has ZERO enumerable
        // keys, so accepting it would delete every row. All must be refused.
        const bad: any[] = ['bad', 42, null, undefined, [1, 2], new Date(), new Uint8Array([1, 2]), /re/, new Map()]
        for (const b of bad) {
            expect(() => s.replaceAll(b), String(b)).toThrow(/plain object|wipe/i)
            expect(() => s.reconcileReplace(b), `reconcile ${String(b)}`).toThrow(/plain object/i)
        }
        expect(s.modeState()).toBe('initialized')           // store untouched by the bad calls
        expect(await s.readAll()).toEqual({ a: '1' })       // row survives
    })

    it('an Object.create(null) bare map IS accepted (legitimate plain map)', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        const bare: any = Object.create(null); bare.k = 'v'
        s.replaceAll(bare)
        expect(await s.readAll()).toEqual({ k: 'v' })
    })

    // codex round-7 HIGH #1: a stateful Proxy returning different keys on a second
    // enumeration must NOT wipe the store. canonicalizeMap reads ownKeys ONCE and
    // writeWholeMap uses only that snapshot — the Proxy is never re-enumerated.
    it('canonical snapshot: a stateful Proxy is read ONCE — cannot wipe via re-enumeration (TOCTOU)', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeFromMap({ old: 'x' })
        let calls = 0
        const proxy = new Proxy({}, {
            ownKeys() { calls++; return calls === 1 ? ['keep'] : [] },   // keys first, empty on any later read
            getOwnPropertyDescriptor() { return { value: 'v', enumerable: true, configurable: true, writable: true } },
        })
        s.replaceAll(proxy as any)
        expect(await s.readAll()).toEqual({ keep: 'v' })   // first-read key written; NOT wiped to {}
        expect(calls).toBe(1)                              // proxy enumerated exactly once
    })

    // JSON representation: a "__proto__" key now round-trips LOSSLESSLY (own key, no
    // pollution) — no codec rewrites it. A lone-surrogate OUTER key is un-representable
    // as a KV path and is rejected fail-closed by kvKeyFor. Normal keys are fine.
    it('__proto__ key round-trips (own key, no pollution); a lone-surrogate key is rejected', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        const protoKey: any = {}; Object.defineProperty(protoKey, '__proto__', { value: 'first', enumerable: true, writable: true, configurable: true })
        s.replaceAll(protoKey)
        const back = await s.readAll()
        expect(Object.hasOwn(back, '__proto__')).toBe(true)
        expect((back as any).__proto__).toBe('first')
        expect(Object.getPrototypeOf(back)).toBe(Object.prototype)   // NOT polluted

        const surrogate: any = {}; surrogate['\uD800'] = 'v'
        expect(() => createPluginStoragePerKeyStore(fakeKv()).replaceAll(surrogate)).toThrow(/not encodable|surrogate/i)

        const s2 = createPluginStoragePerKeyStore(fakeKv())
        s2.replaceAll({ 'a:b/c': '1', '記憶': '2', 'with space': '3' })
        expect(await s2.readAll()).toEqual({ 'a:b/c': '1', '記憶': '2', 'with space': '3' })
    })

    // JSON: a VALUE containing nested "__proto__"/surrogate keys survives losslessly
    // (the msgpack codec would have collapsed them) — this was codex round-9 HIGH #2.
    it('a value with nested __proto__ / surrogate keys round-trips losslessly', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        const nested: any = { plain: 1 }
        Object.defineProperty(nested, '__proto__', { value: 'first', enumerable: true, writable: true, configurable: true })
        nested['\uD800lone'] = 'surr'
        s.replaceAll({ k: nested })
        const back: any = (await s.readAll()).k
        expect(back.__proto__).toBe('first')
        expect(back['\uD800lone']).toBe('surr')
        expect(back.plain).toBe(1)
    })

    it('applyDelta: a __proto__ changed key round-trips; a lone-surrogate removed key is rejected', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeFromMap({ a: '1' })
        const protoChanged: any = {}; Object.defineProperty(protoChanged, '__proto__', { value: 'pv', enumerable: true, writable: true, configurable: true })
        s.applyDelta({ changed: protoChanged })
        expect(((await s.readAll()) as any).__proto__).toBe('pv')      // stored losslessly
        expect(() => s.applyDelta({ removed: ['\uD800'] })).toThrow(/not encodable|surrogate/i) // un-pathable key
        expect(await s.readKey('a')).toBe('1')                         // untouched by the rejected removal
    })

    // codex round-8 HIGH#2: a key in both changed and removed = write-then-delete = net
    // loss → rejected, nothing applied.
    it('applyDelta rejects a key in BOTH changed and removed', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeFromMap({ x: '0' })
        expect(() => s.applyDelta({ changed: { a: '1' }, removed: ['a'] })).toThrow(/both changed and removed/i)
        expect(await s.readAll()).toEqual({ x: '0' })   // nothing applied
    })

    // codex round-8 HIGH#2: `removed` is materialized in ONE pass; a stateful array that
    // would present a different second reading cannot cause a different key to be deleted.
    it('applyDelta materializes `removed` once — a stateful array cannot delete a different key', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.initializeFromMap({ keep: 'v', victim: 'v' })
        let iter = 0
        const removed: any = new Proxy([], {
            get(t, p, r) {
                if (p === Symbol.iterator) {
                    iter++
                    const seq = iter === 1 ? ['nonexistent'] : ['victim'] // 2nd read would target victim
                    return function* () { yield* seq }
                }
                if (p === 'length') return 1
                return Reflect.get(t, p, r)
            },
        })
        s.applyDelta({ removed })                 // reads removed exactly once (→ ['nonexistent'], a no-op)
        expect(iter).toBe(1)                       // materialized once, never re-read
        expect(await s.readKey('victim')).toBe('v') // 'victim' survives (2nd-read sequence never used)
        expect(await s.readKey('keep')).toBe('v')
    })

    // codex round-4 HIGH: ordinary replace must not MASK corruption/ambiguity —
    // recovery is the explicit reconcileReplace.
    it('replaceAll REFUSES a corrupt or ambiguous store; reconcileReplace overwrites it', async () => {
        const kvC = fakeKv()
        const sC = createPluginStoragePerKeyStore(kvC)
        kvC.m.set('pluginStorage/control/mode.json', Buffer.from('{"version":3,"state":"future"}', 'utf8')) // corrupt
        expect(() => sC.replaceAll({ a: '1' })).toThrow(/corrupt|reconcile/i)     // ordinary replace refuses
        sC.reconcileReplace({ a: '1' })                                            // explicit recovery overwrites
        expect(sC.modeState()).toBe('initialized')
        expect(await sC.readAll()).toEqual({ a: '1' })
    })

    // codex round-4 HIGH: migration RELOCATES bytes but must NOT bless a possibly-partial
    // flat-row set as authoritative — it leaves the store ambiguous (loud) until an
    // explicit reconcile asserts completeness.
    it('boot migration relocates flat rows but leaves the store AMBIGUOUS (not initialized)', async () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        kv.m.set(`pluginStorage/${encodeURIComponent('shard:0')}.bin`, Buffer.from(JSON.stringify('v')))
        expect(s.migrateLegacyLayout().migrated).toBe(1)
        expect(s.modeState()).toBe('legacy')               // NOT blessed initialized
        expect(s.classify({ characters: [] }).state).toBe('ambiguous') // rows without a mode → loud
        await expect(s.readAll()).rejects.toThrow(/non-initialized|legacy|ambiguous|failing closed/i)
        expect(await s.readKey('shard:0')).toBe('v')       // bytes are present (relocated), just not authoritative yet
        // an explicit reconcile (client's complete map) establishes initialized
        s.reconcileReplace({ 'shard:0': 'v' })
        expect(s.modeState()).toBe('initialized')
        expect(await s.readAll()).toEqual({ 'shard:0': 'v' })
    })
})

// codex HIGH: authoritative full reads must FAIL CLOSED, never serialize a short map.
describe('pluginStoragePerKeyStore — readAll fail-closed (SSOT step 1b/HIGH)', () => {
    it('throws on a corrupt row (invalid JSON bytes — out-of-band corruption)', async () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        s.initializeFromMap({ a: '1' })                     // initialized store
        // a row whose bytes are not valid JSON (out-of-band corruption)
        kv.m.set(kvKeyFor('b'), Buffer.from('not json{', 'utf8'))
        await expect(s.readAll()).rejects.toThrow(/corrupt row|failing closed/i)
    })

    it('throws on a listed key whose row is zero-length (corruption, not a short map)', async () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        s.initializeFromMap({ a: '1' })
        kv.m.set(kvKeyFor('b'), Buffer.alloc(0)) // present under data/ but empty
        await expect(s.readAll()).rejects.toThrow(/empty\/missing|failing closed/i)
    })

    it('corrupt sentinel → readAll throws (never reads as empty)', async () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        s.writeKey('a', '1')
        kv.m.set('pluginStorage/control/mode.json', Buffer.from('{"version":3,"state":"future"}', 'utf8'))
        await expect(s.readAll()).rejects.toThrow(/corrupt|failing closed/i)
    })

    it('un-migrated flat rows → readAll throws (would be invisible to the data/ scan)', async () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        kv.m.set(`pluginStorage/${encodeURIComponent('flat')}.bin`, Buffer.from(JSON.stringify('v')))
        await expect(s.readAll()).rejects.toThrow(/flat|failing closed/i)
    })
})

// Server hydrate/reassemble contract: the per-key loader is a drop-in for the
// single-blob loader (same (directory) → map | fail-closed shape), so the
// server's existing hydrate path resolves a marker DB straight from per-key KV.
describe('pluginStoragePerKeyStore — drives server hydrate (inc2, drop-in loader)', () => {
    it('marker DB hydrates from per-key entries; marker stripped, map restored', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        for (const [k, v] of Object.entries(KEYS)) s.writeKey(k, v)
        const db: any = { characters: [], [PLUGIN_STORAGE_SIDECAR_MARKER]: { version: 2, keys: Object.keys(KEYS) } }
        await hydratePluginCustomStorageServer(db, s.loader)
        expect(JSON.stringify(db.pluginCustomStorage)).toBe(JSON.stringify(KEYS))
        expect(PLUGIN_STORAGE_SIDECAR_MARKER in db).toBe(false)
        // resolved DB passes the re-encode guard
        expect(() => assertPluginStorageResolved(db)).not.toThrow()
    })

    it('hydrate FAILS CLOSED when a listed key has no per-key entry', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.writeKey('present', 'ok')
        const db: any = { characters: [], [PLUGIN_STORAGE_SIDECAR_MARKER]: { version: 2, keys: ['present', 'gone'] } }
        await expect(hydratePluginCustomStorageServer(db, s.loader)).rejects.toThrow(/fail(ing)? closed|missing/i)
    })

    it('marker is DETERMINISTIC: same key set in any order → identical marker + hash', () => {
        const a = buildPluginStorageDirectory({ z: 1, a: 2, m: 3 })
        const b = buildPluginStorageDirectory({ a: 9, m: 9, z: 9 })   // same keys, different order + values
        expect(a.version).toBe(2)
        expect(a.keys).toEqual(['a', 'm', 'z'])                        // sorted
        expect(JSON.stringify(a)).toBe(JSON.stringify(b))              // value-independent, order-independent
        // the protocol hash the client (marker) and server (marker) both feed is equal
        const hashA = calculateHash(normalizeJSON({ [PLUGIN_STORAGE_SIDECAR_MARKER]: a }))
        const hashB = calculateHash(normalizeJSON({ [PLUGIN_STORAGE_SIDECAR_MARKER]: b }))
        expect(hashA).toBe(hashB)
    })

    it('stripPluginStorageToMarker: inline → marker + extracted values; round-trips via loader', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        const dbObj: any = { characters: [], pluginCustomStorage: { ...KEYS } }
        const { db, values } = stripPluginStorageToMarker(dbObj)
        expect('pluginCustomStorage' in db).toBe(false)                // inline removed
        expect(db[PLUGIN_STORAGE_SIDECAR_MARKER].version).toBe(2)
        expect(JSON.stringify(values)).toBe(JSON.stringify(KEYS))      // values extracted
        // feed values into the per-key store, then the marker hydrates back to the map
        // (toEqual: key ORDER differs — the marker is sorted — but the map is equal)
        s.initializeFromMap(values)
        expect(await s.loader(db[PLUGIN_STORAGE_SIDECAR_MARKER])).toEqual(KEYS)
        // idempotent: a marker-form db returns values=null, unchanged
        const again = stripPluginStorageToMarker(db)
        expect(again.values).toBeNull()
        expect(again.db).toBe(db)
    })

    it('marker-DB blob → decode → hydrate → re-encode inline (upstream re-inline shape)', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        for (const [k, v] of Object.entries(KEYS)) s.writeKey(k, v)
        const markerDb: any = { characters: [], [PLUGIN_STORAGE_SIDECAR_MARKER]: { version: 2, keys: Object.keys(KEYS) } }
        const decoded = normalizeJSON(await decodeRisuSave(encodeRisuSaveLegacy(markerDb)))
        await hydratePluginCustomStorageServer(decoded, s.loader)
        const inlineBlob = Buffer.from(encodeRisuSaveLegacy(decoded))
        const back = normalizeJSON(await decodeRisuSave(inlineBlob))
        expect(JSON.stringify(back.pluginCustomStorage)).toBe(JSON.stringify(KEYS))
        expect(PLUGIN_STORAGE_SIDECAR_MARKER in back).toBe(false)
    })
})
