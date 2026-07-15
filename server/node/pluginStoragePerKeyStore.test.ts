import { describe, it, expect } from 'vitest'
import perKey from './pluginStoragePerKeyStore.cjs'
import utils from './utils.cjs'

const { createPluginStoragePerKeyStore, PLUGIN_STORAGE_PERKEY_PREFIX, kvKeyFor } = perKey as any
const { hydratePluginCustomStorageServer, assertPluginStorageResolved, PLUGIN_STORAGE_SIDECAR_MARKER, encodeRisuSaveLegacy, decodeRisuSave, normalizeJSON, buildPluginStorageDirectory, calculateHash, stripPluginStorageToMarker } = utils as any

// In-memory kv with listPrefix, matching the store's interface (Buffer values).
function fakeKv() {
    const m = new Map<string, Buffer>()
    return {
        m,
        get: (k: string) => (m.has(k) ? m.get(k)! : null),
        set: (k: string, v: Buffer) => { m.set(k, v) },
        del: (k: string) => { m.delete(k) },
        listPrefix: (p: string) => [...m.keys()].filter((k) => k.startsWith(p)),
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
        expect(PLUGIN_STORAGE_PERKEY_PREFIX).toBe('pluginStorage/')
        const kk = kvKeyFor('vector_rag_memory:scope:abc:records:shard:0000')
        expect(kk.startsWith('pluginStorage/')).toBe(true)
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
        s.writeKey('untouched', 'keep')
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

    it('__proto__ survives as an OWN key (no prototype pollution / silent loss)', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.writeKey('__proto__', { danger: 1 })
        s.writeKey('normal', 'ok')
        const map = await s.loader({ version: 2, keys: ['__proto__', 'normal'] })
        expect(Object.hasOwn(map, '__proto__')).toBe(true)
        expect(JSON.stringify((map as any)['__proto__'])).toBe(JSON.stringify({ danger: 1 }))
        expect(Object.getPrototypeOf(map)).toBe(Object.prototype)   // prototype NOT polluted
        const all = await s.readAll()
        expect(Object.hasOwn(all, '__proto__')).toBe(true)
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

    it('rejects a bad kv interface', () => {
        expect(() => createPluginStoragePerKeyStore(null)).toThrow(/kv/i)
        expect(() => createPluginStoragePerKeyStore({})).toThrow(/kv/i)
    })

    it('readAll reassembles the whole stored map by prefix scan', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        for (const [k, v] of Object.entries(KEYS)) s.writeKey(k, v)
        expect(JSON.stringify(await s.readAll())).toBe(JSON.stringify(KEYS))
    })

    it('replaceAll writes new keys and deletes stale ones', async () => {
        const s = createPluginStoragePerKeyStore(fakeKv())
        s.writeKey('old', 'x'); s.writeKey('keep', 'y')
        s.replaceAll({ keep: 'y2', fresh: 'z' })
        expect(await s.readKey('old')).toBeUndefined()   // stale removed
        expect(await s.readKey('keep')).toBe('y2')        // updated
        expect(await s.readKey('fresh')).toBe('z')        // added
    })

    it('applyDelta touches ONLY changed/removed keys (concurrency-safe path)', async () => {
        const kv = fakeKv()
        const s = createPluginStoragePerKeyStore(kv)
        s.writeKey('a', '1'); s.writeKey('b', '2'); s.writeKey('c', '3')
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
            expect(kk.startsWith('pluginStorage/')).toBe(true)
            expect(kk.slice('pluginStorage/'.length, -'.bin'.length)).not.toContain('/')
        }
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
        s.writeMany(values)
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
