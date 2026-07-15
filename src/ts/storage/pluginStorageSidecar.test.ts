import { describe, test, it, expect, vi, afterEach } from 'vitest'

// B step 1+2 — pluginCustomStorage sidecar SAFETY + inert dual-read wiring.
// Proves, before any writer produces the new layout: (1) moving pluginCustomStorage
// out of the encoded database.bin round-trips byte-identically; (2) the PRODUCTION
// resolver is directory-marker-aware — legacy layout keeps inline (even empty),
// new layout takes the sidecar and FAILS CLOSED if it's missing; (3) the load-path
// hydration is a pass-through today (no DB carries the marker → behavior identical).
vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({ chatToStub: (c: any) => c }))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))

const { encodeRisuSaveLegacy, decodeRisuSave, RisuSaveEncoder } = await import('./risuSave')
const {
    resolvePluginCustomStorage,
    resolvePluginCustomStorageByDirectory,
    hydratePluginCustomStorage,
    PLUGIN_STORAGE_SIDECAR_MARKER,
    isPluginStorageSidecarWriteEnabled,
    setPluginStorageSidecarWriteEnabled,
} = await import('./pluginStorageSidecar')

function makePluginStorage(): Record<string, string> {
    return {
        'vector_rag_memory:scope:abc:records:shard:0000': JSON.stringify({ v: 2, blob: 'x'.repeat(3000), mark: '샤드-0' }),
        'vector_rag_memory:scope:abc:manifest:v2': JSON.stringify({ count: 1200, shardCount: 19 }),
        'hayaku.v1.durable.9f3a/weird': JSON.stringify({ 記憶: 'ユニコード', nested: { a: [1, 2, 3] } }),
        'empty-value-key': '',
        '12345': JSON.stringify({ numericLikeKey: true }),
    }
}
function makeDb(): any {
    return {
        formatversion: 4, characters: [], botPresets: [{ id: 'p', name: 'preset' }],
        modules: [], plugins: [], pluginCustomStorage: makePluginStorage(), someRootField: 'unrelated',
    }
}
const clone = (o: any) => JSON.parse(JSON.stringify(o))

describe('pluginCustomStorage sidecar — safety (round-trip)', () => {
    test('inline round-trip is byte-identical (current layout loses nothing)', async () => {
        const db = makeDb()
        const back = await decodeRisuSave(encodeRisuSaveLegacy(clone(db)))
        expect(JSON.stringify(back.pluginCustomStorage)).toBe(JSON.stringify(db.pluginCustomStorage))
    })

    test('strip from database.bin + carry in sidecar reconstructs byte-identically', async () => {
        const db = makeDb()
        const stripped = clone(db); delete stripped.pluginCustomStorage
        const decodedStripped = await decodeRisuSave(encodeRisuSaveLegacy(stripped))
        const decodedSidecar = (await decodeRisuSave(encodeRisuSaveLegacy({ pluginCustomStorage: clone(db.pluginCustomStorage) }))).pluginCustomStorage
        expect(decodedStripped.pluginCustomStorage).toBeUndefined()
        expect(decodedStripped.someRootField).toBe('unrelated')
        const reconstructed = resolvePluginCustomStorage({ inline: decodedStripped.pluginCustomStorage, sidecar: decodedSidecar, hasSidecarDirectory: true })
        expect(JSON.stringify(reconstructed)).toBe(JSON.stringify(db.pluginCustomStorage))
    })

    test('edge values survive the sidecar round-trip (unicode, slash keys, empty value, numeric key)', async () => {
        const pcs = makePluginStorage()
        const back = (await decodeRisuSave(encodeRisuSaveLegacy({ pluginCustomStorage: clone(pcs) }))).pluginCustomStorage
        expect(back['empty-value-key']).toBe('')
        expect(back['hayaku.v1.durable.9f3a/weird']).toBe(pcs['hayaku.v1.durable.9f3a/weird'])
        expect(back['12345']).toBe(pcs['12345'])
        expect(Object.keys(back)).toEqual(Object.keys(pcs))
    })
})

describe('resolvePluginCustomStorage — directory-marker-aware contract', () => {
    test('legacy layout (no directory): inline is authoritative, even when undefined — never throws', () => {
        const pcs = makePluginStorage()
        expect(resolvePluginCustomStorage({ inline: pcs, sidecar: null, hasSidecarDirectory: false })).toBe(pcs)
        // A legacy DB that never had plugin data: undefined inline, no sidecar → empty is LEGITIMATE, must not throw.
        expect(resolvePluginCustomStorage({ inline: undefined, sidecar: null, hasSidecarDirectory: false })).toBeUndefined()
    })

    test('new layout (directory present): sidecar is authoritative', () => {
        const pcs = makePluginStorage()
        expect(resolvePluginCustomStorage({ inline: undefined, sidecar: pcs, hasSidecarDirectory: true })).toBe(pcs)
    })

    test('new layout with MISSING sidecar fails closed — never reports empty', () => {
        expect(() => resolvePluginCustomStorage({ inline: undefined, sidecar: null, hasSidecarDirectory: true })).toThrow(/fail closed/i)
        expect(() => resolvePluginCustomStorage({ inline: {}, sidecar: undefined, hasSidecarDirectory: true })).toThrow(/fail closed/i)
    })
})

describe('RisuSaveEncoder write-enable flag (B inc 3d-i) — default OFF is byte-identical', () => {
    const makeDb = (): any => ({
        formatversion: 4, characters: [], botPresets: [{ id: 'p', name: 'preset' }],
        modules: [], plugins: [], pluginCustomStorage: makePluginStorage(),
    })

    afterEach(() => setPluginStorageSidecarWriteEnabled(false))

    it('flag defaults OFF', () => {
        expect(isPluginStorageSidecarWriteEnabled()).toBe(false)
    })

    it('flag OFF: encode→decode embeds pluginCustomStorage inline, NO marker (today’s layout)', async () => {
        const db = makeDb()
        const enc = new RisuSaveEncoder()
        await enc.init(clone(db))
        const back = await decodeRisuSave(new Uint8Array(enc.encode()!))
        expect(JSON.stringify(back.pluginCustomStorage)).toBe(JSON.stringify(db.pluginCustomStorage))
        expect(PLUGIN_STORAGE_SIDECAR_MARKER in back).toBe(false)
    })

    it('flag ON: encode writes NO pluginStorage block — pcs is fully out-of-band', async () => {
        const db = makeDb()
        setPluginStorageSidecarWriteEnabled(true)
        const enc = new RisuSaveEncoder()
        await enc.init(clone(db))
        const back = await decodeRisuSave(new Uint8Array(enc.encode()!))
        // neither inline pluginCustomStorage nor any directory marker rides database.bin;
        // the values live per-key on the server and load via the /api/plugin-storage GET.
        expect(back.pluginCustomStorage).toBeUndefined()
        expect(PLUGIN_STORAGE_SIDECAR_MARKER in back).toBe(false)
    })
})

describe('hydratePluginCustomStorage — inert today (pass-through), armed for the new layout', () => {
    test('legacy DB (no marker): pass-through, pluginCustomStorage identical, no marker introduced', async () => {
        const db = makeDb()
        const before = JSON.stringify(db.pluginCustomStorage)
        const out = await hydratePluginCustomStorage(db)
        expect(out).toBe(db) // same object, mutated in place / returned as-is
        expect(JSON.stringify(out.pluginCustomStorage)).toBe(before)
        expect(PLUGIN_STORAGE_SIDECAR_MARKER in out).toBe(false)
    })

    test('legacy DB with no plugin data: stays undefined, does NOT fail closed', async () => {
        const db: any = { characters: [], someRootField: 'x' }
        const out = await hydratePluginCustomStorage(db)
        expect(out.pluginCustomStorage).toBeUndefined()
    })

    test('new-layout DB (marker present) with the increment-2 stub loader (no sidecar store) fails closed', async () => {
        // Proves the dormant new-layout branch is SAFE: if a marker ever appears
        // before increment 3 wires the real loader, boot refuses rather than
        // silently dropping plugin memory.
        const db: any = { characters: [], [PLUGIN_STORAGE_SIDECAR_MARKER]: { version: 2, keys: ['k1'] } }
        await expect(hydratePluginCustomStorage(db)).rejects.toThrow(/fail closed/i)
    })
})

// B2: the marker's key list is the authoritative allowlist on read.
describe('resolvePluginCustomStorageByDirectory — marker is the allowlist (B2)', () => {
    it('returns EXACTLY the marker keys, dropping orphans in the fetched payload', () => {
        const dir = { version: 2, keys: ['a', 'b'] }
        const out = resolvePluginCustomStorageByDirectory(dir, { a: '1', b: '2', orphan_deleted: 'ghost' })
        expect(out).toEqual({ a: '1', b: '2' })
        expect('orphan_deleted' in out).toBe(false) // a marker-only-deleted key does NOT resurrect
    })

    it('FAILS CLOSED when a listed key is missing from the fetched payload', () => {
        const dir = { version: 2, keys: ['a', 'b'] }
        expect(() => resolvePluginCustomStorageByDirectory(dir, { a: '1' })).toThrow(/fail closed|missing/i)
        expect(() => resolvePluginCustomStorageByDirectory(dir, null)).toThrow(/fail closed|missing/i)
    })

    it('empty marker → {} without needing any payload (no 404-on-empty)', () => {
        expect(resolvePluginCustomStorageByDirectory({ version: 2, keys: [] }, null)).toEqual({})
    })

    it('malformed / wrong-version marker → fail closed', () => {
        expect(() => resolvePluginCustomStorageByDirectory({ keys: ['a'] }, { a: '1' })).toThrow(/fail closed|version/i)
        expect(() => resolvePluginCustomStorageByDirectory({ version: 1, keys: ['a'] }, { a: '1' })).toThrow(/fail closed|version/i)
        expect(() => resolvePluginCustomStorageByDirectory(null, {})).toThrow(/fail closed|malformed/i)
    })

    it('hydrate drops orphans: a marker-only delete stays deleted on reload', async () => {
        // marker lists only [keep]; the server payload still has the deleted orphan.
        const db: any = { characters: [], [PLUGIN_STORAGE_SIDECAR_MARKER]: { version: 2, keys: ['keep'] } }
        await hydratePluginCustomStorage(db, async () => ({ keep: 'v', deleted_orphan: 'ghost' }))
        expect(db.pluginCustomStorage).toEqual({ keep: 'v' })
        expect('deleted_orphan' in db.pluginCustomStorage).toBe(false)
    })
})
