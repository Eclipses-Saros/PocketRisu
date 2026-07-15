import { describe, it, expect } from 'vitest'
import store from './pluginStorageStore.cjs'
import utils from './utils.cjs'

const { createPluginStorageSidecarStore, PLUGIN_STORAGE_SIDECAR_KEY } = store as any
const { hydratePluginCustomStorageServer, PLUGIN_STORAGE_SIDECAR_MARKER, encodeRisuSaveLegacy, decodeRisuSave } = utils as any

// Minimal in-memory kv matching the store's interface (Buffer values).
function fakeKv() {
    const m = new Map<string, Buffer>()
    return {
        m,
        get: (k: string) => (m.has(k) ? m.get(k)! : null),
        set: (k: string, v: Buffer) => { m.set(k, v) },
        del: (k: string) => { m.delete(k) },
    }
}

function makePcs(): Record<string, string> {
    return {
        'vector_rag_memory:scope:abc:records:shard:0000': JSON.stringify({ v: 2, blob: 'x'.repeat(3000) }),
        'hayaku.v1.durable.9f3a/weird': JSON.stringify({ 記憶: 'ユニコード' }),
        'empty-value-key': '',
    }
}
const clone = (o: any) => JSON.parse(JSON.stringify(o))

describe('pluginStorageStore — server sidecar store (inc 3c-i)', () => {
    it('stores under a dedicated key beside database.bin, not inside it', () => {
        expect(PLUGIN_STORAGE_SIDECAR_KEY).toBe('database/pluginStorage.bin')
        expect(PLUGIN_STORAGE_SIDECAR_KEY).not.toBe('database/database.bin')
    })

    it('write → read round-trips byte-identically', async () => {
        const kv = fakeKv()
        const s = createPluginStorageSidecarStore(kv)
        const pcs = makePcs()
        s.write(clone(pcs))
        expect(JSON.stringify(await s.read())).toBe(JSON.stringify(pcs))
    })

    it('read returns null when the sidecar is absent (the "no sidecar" signal)', async () => {
        const s = createPluginStorageSidecarStore(fakeKv())
        expect(await s.read()).toBeNull()
    })

    it('remove clears the sidecar → subsequent read is null', async () => {
        const kv = fakeKv()
        const s = createPluginStorageSidecarStore(kv)
        s.write(makePcs())
        expect(await s.read()).not.toBeNull()
        s.remove()
        expect(await s.read()).toBeNull()
    })

    it('edge values survive (unicode, slash key, empty value)', async () => {
        const kv = fakeKv()
        const s = createPluginStorageSidecarStore(kv)
        const pcs = makePcs()
        s.write(clone(pcs))
        const back = await s.read()
        expect(back['empty-value-key']).toBe('')
        expect(back['hayaku.v1.durable.9f3a/weird']).toBe(pcs['hayaku.v1.durable.9f3a/weird'])
        expect(Object.keys(back)).toEqual(Object.keys(pcs))
    })

    it('its loader drives hydrate: a marker DB resolves from the store', async () => {
        const kv = fakeKv()
        const s = createPluginStorageSidecarStore(kv)
        const pcs = makePcs()
        s.write(clone(pcs))
        const db: any = { characters: [], [PLUGIN_STORAGE_SIDECAR_MARKER]: { keys: Object.keys(pcs) } }
        await hydratePluginCustomStorageServer(db, s.loader)
        expect(JSON.stringify(db.pluginCustomStorage)).toBe(JSON.stringify(pcs))
        expect(PLUGIN_STORAGE_SIDECAR_MARKER in db).toBe(false)
    })

    it('its loader drives hydrate fail-closed when the store is empty (marker but no stored sidecar)', async () => {
        const s = createPluginStorageSidecarStore(fakeKv())
        const db: any = { characters: [], [PLUGIN_STORAGE_SIDECAR_MARKER]: { keys: ['k'] } }
        await expect(hydratePluginCustomStorageServer(db, s.loader)).rejects.toThrow(/fail closed/i)
    })

    it('rejects a bad kv interface', () => {
        expect(() => createPluginStorageSidecarStore(null as any)).toThrow(/kv/i)
        expect(() => createPluginStorageSidecarStore({} as any)).toThrow(/kv/i)
    })

    // Endpoint wire-format contract (proven without booting express): the bytes a
    // client would POST decode the way /api/plugin-storage decodes them, store.write
    // persists, and a later marker-DB decode resolves from the store via its loader.
    it('POST wire payload → store → GET wire payload round-trips, and hydrate resolves it', async () => {
        const kv = fakeKv()
        const s = createPluginStorageSidecarStore(kv)
        const pcs = makePcs()

        // Client POST body (binary), exactly what GET would also return.
        const postBody = Buffer.from(encodeRisuSaveLegacy({ pluginCustomStorage: clone(pcs) }))
        // Endpoint POST handler core: decode → extract → write.
        const decodedPost = await decodeRisuSave(postBody)
        s.write(decodedPost.pluginCustomStorage ?? decodedPost)

        // Endpoint GET handler core: read → encode.
        const getBody = Buffer.from(encodeRisuSaveLegacy({ pluginCustomStorage: await s.read() }))
        expect(JSON.stringify((await decodeRisuSave(getBody)).pluginCustomStorage)).toBe(JSON.stringify(pcs))

        // Server decode of a marker-DB resolves pluginCustomStorage from the store.
        const db: any = { characters: [], [PLUGIN_STORAGE_SIDECAR_MARKER]: { keys: Object.keys(pcs) } }
        await hydratePluginCustomStorageServer(db, s.loader)
        expect(JSON.stringify(db.pluginCustomStorage)).toBe(JSON.stringify(pcs))
    })
})
