import { describe, test, expect, vi } from 'vitest'

// B step 1+2 — pluginCustomStorage sidecar SAFETY + inert dual-read wiring.
// Proves, before any writer produces the new layout: (1) moving pluginCustomStorage
// out of the encoded database.bin round-trips byte-identically; (2) the PRODUCTION
// resolver is directory-marker-aware — legacy layout keeps inline (even empty),
// new layout takes the sidecar and FAILS CLOSED if it's missing; (3) the load-path
// hydration is a pass-through today (no DB carries the marker → behavior identical).
vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({ chatToStub: (c: any) => c }))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))

const { encodeRisuSaveLegacy, decodeRisuSave } = await import('./risuSave')
const {
    resolvePluginCustomStorage,
    hydratePluginCustomStorage,
    PLUGIN_STORAGE_SIDECAR_MARKER,
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
        const db: any = { characters: [], [PLUGIN_STORAGE_SIDECAR_MARKER]: { keys: ['k1'] } }
        await expect(hydratePluginCustomStorage(db)).rejects.toThrow(/fail closed/i)
    })
})
