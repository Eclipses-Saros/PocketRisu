import { describe, it, expect } from 'vitest'
import pkg from './utils.cjs'

// Server-side mirror of src/ts/storage/pluginStorageSidecar.test.ts. Proves the
// SERVER can read the new (sidecar) layout with the identical contract, BEFORE
// any client writes it — the server is a separate deploy, so an old server that
// didn't understand the layout would re-encode pluginCustomStorage away.
const {
    encodeRisuSaveLegacy,
    decodeRisuSave,
    normalizeJSON,
    resolvePluginCustomStorage,
    hydratePluginCustomStorageServer,
    assertPluginStorageResolved,
    PLUGIN_STORAGE_SIDECAR_MARKER,
} = pkg as any

function makePluginStorage(): Record<string, string> {
    return {
        'vector_rag_memory:scope:abc:records:shard:0000': JSON.stringify({ v: 2, blob: 'x'.repeat(3000) }),
        'hayaku.v1.durable.9f3a/weird': JSON.stringify({ 記憶: 'ユニコード' }),
        'empty-value-key': '',
    }
}
const clone = (o: any) => JSON.parse(JSON.stringify(o))

describe('server resolvePluginCustomStorage — directory-marker-aware contract', () => {
    it('legacy (no directory): inline authoritative even when undefined, never throws', () => {
        const pcs = makePluginStorage()
        expect(resolvePluginCustomStorage({ inline: pcs, sidecar: null, hasSidecarDirectory: false })).toBe(pcs)
        expect(resolvePluginCustomStorage({ inline: undefined, sidecar: null, hasSidecarDirectory: false })).toBeUndefined()
    })
    it('new layout: sidecar authoritative', () => {
        const pcs = makePluginStorage()
        expect(resolvePluginCustomStorage({ inline: undefined, sidecar: pcs, hasSidecarDirectory: true })).toBe(pcs)
    })
    it('new layout with missing sidecar fails closed', () => {
        expect(() => resolvePluginCustomStorage({ inline: undefined, sidecar: null, hasSidecarDirectory: true })).toThrow(/fail closed/i)
    })
})

describe('server hydratePluginCustomStorageServer — inert today, armed for the new layout', () => {
    it('legacy DB (no marker) decoded round-trip: pluginCustomStorage identical, pass-through', async () => {
        const db: any = { characters: [], pluginCustomStorage: makePluginStorage(), someRootField: 'x' }
        const decoded = normalizeJSON(await decodeRisuSave(encodeRisuSaveLegacy(clone(db))))
        const before = JSON.stringify(decoded.pluginCustomStorage)
        const out = await hydratePluginCustomStorageServer(decoded)
        expect(out).toBe(decoded)
        expect(JSON.stringify(out.pluginCustomStorage)).toBe(before)
        expect(PLUGIN_STORAGE_SIDECAR_MARKER in out).toBe(false)
    })

    it('legacy DB with no plugin data: stays undefined, does not fail closed', async () => {
        const db: any = { characters: [] }
        const out = await hydratePluginCustomStorageServer(normalizeJSON(await decodeRisuSave(encodeRisuSaveLegacy(db))))
        expect(out.pluginCustomStorage).toBeUndefined()
    })

    it('new-layout DB (marker) with the stub loader (no server sidecar store yet) fails closed', async () => {
        const db: any = { characters: [], [PLUGIN_STORAGE_SIDECAR_MARKER]: { keys: ['k1'] } }
        await expect(hydratePluginCustomStorageServer(db)).rejects.toThrow(/fail closed/i)
    })

    it('new-layout DB resolves from a provided sidecar loader (proves the armed path works)', async () => {
        const pcs = makePluginStorage()
        const db: any = { characters: [], [PLUGIN_STORAGE_SIDECAR_MARKER]: { keys: Object.keys(pcs) } }
        const out = await hydratePluginCustomStorageServer(db, async () => clone(pcs))
        expect(JSON.stringify(out.pluginCustomStorage)).toBe(JSON.stringify(pcs))
        expect(PLUGIN_STORAGE_SIDECAR_MARKER in out).toBe(false)
    })
})

describe('assertPluginStorageResolved — re-persist backstop', () => {
    it('passes through a resolved DB (no marker) — inert today', () => {
        const db: any = { characters: [], pluginCustomStorage: makePluginStorage() }
        expect(assertPluginStorageResolved(db)).toBe(db)
        expect(assertPluginStorageResolved({ characters: [] })).toBeTruthy()
        expect(assertPluginStorageResolved(null)).toBeNull()
    })
    it('throws if a DB about to be re-encoded still carries the unresolved marker', () => {
        const db: any = { characters: [], [PLUGIN_STORAGE_SIDECAR_MARKER]: { keys: ['k'] } }
        expect(() => assertPluginStorageResolved(db)).toThrow(/fail closed|unresolved/i)
    })
    it('a hydrated DB passes the backstop (hydrate strips the marker → re-persist safe)', async () => {
        const pcs = makePluginStorage()
        const db: any = { characters: [], [PLUGIN_STORAGE_SIDECAR_MARKER]: { keys: Object.keys(pcs) } }
        await hydratePluginCustomStorageServer(db, async () => clone(pcs))
        expect(() => assertPluginStorageResolved(db)).not.toThrow()
    })
})
