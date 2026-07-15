import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

// Measurement test (B step 0). Proves the certain core rationale behind plan B:
// pluginCustomStorage rides the monolithic save, so every save that touches it
// re-serializes the WHOLE store and retains it in several resident copies — and
// the cost is independent of how small the actual change was. This is the
// baseline; after B this test should show the whole-store cost gone.
//
// Same mocks as risuSavePatcher.test.ts so importing risuSave.ts stays pure.
vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({ chatToStub: (c: any) => c }))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))

const { RisuSaveEncoder, RisuSavePatcher } = await import('./risuSave')

// Distinctive marker embedded in every stored value, so a JSON.stringify spy can
// tell "stringified the whole plugin store" from unrelated stringify calls.
const MARK = '__PCS_MARKER__'
const bigValue = (n: number) => JSON.stringify({ mark: MARK, shard: n, blob: 'x'.repeat(4000) })

function makeDb() {
    const pluginCustomStorage: Record<string, string> = {}
    for (let i = 0; i < 8; i++) pluginCustomStorage[`vector_rag_memory:shard:${i}`] = bigValue(i)
    return {
        characters: [],
        botPresets: [],
        modules: [],
        plugins: [],
        pluginCustomStorage,
        someRootField: 'unrelated',
    } as any
}

const emptyToSave = () => ({ character: [], chat: [], root: false, botPreset: false, modules: false, plugins: false, pluginCustomStorage: false })

// Count JSON.stringify calls whose OUTPUT contains the whole-store marker set
// (i.e. serialized the entire pluginCustomStorage), during a measured region.
function countWholeStoreStringifies(fn: () => void | Promise<void>) {
    const orig = JSON.stringify
    let whole = 0
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((...args: any[]) => {
        const out = (orig as any)(...args)
        if (typeof out === 'string') {
            // whole-store stringify = output contains ALL shard markers
            const hits = out.split(MARK).length - 1
            if (hits >= 8) whole += 1
        }
        return out
    })
    const done = () => { spy.mockRestore() }
    const r = fn()
    if (r && typeof (r as any).then === 'function') return (r as Promise<void>).then(() => { done(); return whole })
    done()
    return whole
}

describe('B step 0 — pluginCustomStorage save cost (baseline before B)', () => {
    test('a save that touches pluginCustomStorage re-serializes the WHOLE store multiple times', async () => {
        const db = makeDb()
        const encoder = new RisuSaveEncoder()
        const patcher = new RisuSavePatcher()
        await encoder.init(db)
        await patcher.init(db)

        // One save cycle touching pluginCustomStorage (mirrors persistTrackedChanges).
        const toSave = { ...emptyToSave(), pluginCustomStorage: true }
        const encoderWhole = await countWholeStoreStringifies(async () => { await encoder.set(db, { ...toSave }) })
        const patcherWhole = await countWholeStoreStringifies(async () => { await patcher.set(db, { ...toSave }) })

        // Baseline expectation: each side serializes the entire store at least once
        // per save. (Documented, not asserted as an upper bound.)
        console.log(`[B-cost] whole-store JSON.stringify per save — encoder: ${encoderWhole}, patcher: ${patcherWhole}`)
        expect(encoderWhole).toBeGreaterThanOrEqual(1)
        expect(patcherWhole).toBeGreaterThanOrEqual(1)
    })

    test('resident copies: encoder + patcher each retain a full copy of the store after a save', async () => {
        const db = makeDb()
        const encoder = new RisuSaveEncoder()
        const patcher = new RisuSavePatcher()
        await encoder.init(db)
        await patcher.init(db)
        await encoder.set(db, { ...emptyToSave(), pluginCustomStorage: true })
        await patcher.set(db, { ...emptyToSave(), pluginCustomStorage: true })

        // 1) encoder retains the serialized block (bytes of the whole-store JSON).
        const block = (encoder as any).blocks?.['pluginStorage']
        expect(block).toBeTruthy()
        expect(block.length).toBeGreaterThan(8 * 4000)

        // 2) patcher retains the normalized whole-store object baseline.
        const syncedPcs = (patcher as any).lastSyncedDb?.pluginCustomStorage
        expect(syncedPcs).toBeTruthy()
        expect(Object.keys(syncedPcs).length).toBe(8)

        // 3) patcher retains the whole-store JSON string baseline for the fast-skip.
        const rootJson = (patcher as any).lastRootKeyJsons?.get?.('pluginCustomStorage')
        expect(typeof rootJson).toBe('string')
        expect((rootJson.split(MARK).length - 1)).toBe(8)

        // → ≥3 resident representations beyond the live DBState.db copy.
        console.log(`[B-cost] resident copies after save: encoder-block(bytes=${block.length}) + patcher.lastSyncedDb.pluginCustomStorage + patcher.lastRootKeyJsons[pluginCustomStorage]`)
    })

    test('cost is INDEPENDENT of change size: touching one tiny key still re-serializes the whole store', async () => {
        const db = makeDb()
        const encoder = new RisuSaveEncoder()
        const patcher = new RisuSavePatcher()
        await encoder.init(db)
        await patcher.init(db)
        // First save to establish baseline.
        await encoder.set(db, { ...emptyToSave(), pluginCustomStorage: true })
        await patcher.set(db, { ...emptyToSave(), pluginCustomStorage: true })

        // Mutate ONE key by a single character — the smallest possible change.
        db.pluginCustomStorage['vector_rag_memory:shard:0'] =
            db.pluginCustomStorage['vector_rag_memory:shard:0'] + ' '

        const encoderWhole = await countWholeStoreStringifies(async () => { await encoder.set(db, { ...emptyToSave(), pluginCustomStorage: true }) })
        const patcherWhole = await countWholeStoreStringifies(async () => { await patcher.set(db, { ...emptyToSave(), pluginCustomStorage: true }) })

        console.log(`[B-cost] one-char change still whole-store-stringifies — encoder: ${encoderWhole}, patcher: ${patcherWhole}`)
        // The whole store is re-serialized even though only one key changed by 1 char.
        expect(encoderWhole).toBeGreaterThanOrEqual(1)
        expect(patcherWhole).toBeGreaterThanOrEqual(1)
    })
})
