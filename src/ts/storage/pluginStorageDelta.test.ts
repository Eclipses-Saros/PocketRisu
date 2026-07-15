import { describe, it, expect, vi } from 'vitest'

// pluginStorageDelta imports calculateHash from ./risuSave, which transitively
// pulls in database.svelte's Svelte runes. Mock the heavy deps (same as
// pluginStorageSaveCost.test.ts) so the import stays pure in the test runtime.
// In production globalApi already imports risuSave, so no new coupling.
vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({ chatToStub: (c: any) => c }))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))

const {
    seedPluginStorageBaseline,
    computePluginStorageDelta,
    advancePluginStorageBaseline,
    pluginStorageDeltaIsEmpty,
} = await import('./pluginStorageDelta')

describe('pluginStorageDelta — per-key delta without a resident copy (C3)', () => {
    it('no change → empty delta', () => {
        const map = { a: '1', b: JSON.stringify({ x: 1 }) }
        const base = seedPluginStorageBaseline(map)
        const d = computePluginStorageDelta(map, base)
        expect(pluginStorageDeltaIsEmpty(d)).toBe(true)
    })

    it('detects a changed value, an added key, and a removed key — only those', () => {
        const base = seedPluginStorageBaseline({ keep: '1', edit: 'old', gone: 'x' })
        const now = { keep: '1', edit: 'new', added: 'z' } // edit changed, added new, gone removed, keep same
        const d = computePluginStorageDelta(now, base)
        expect(Object.keys(d.changed).sort()).toEqual(['added', 'edit'])
        expect(d.changed.edit).toBe('new')
        expect(d.changed.added).toBe('z')
        expect(d.removed).toEqual(['gone'])
    })

    it('detects change regardless of HOW it was made (object/nested mutation, not just setItem)', () => {
        const obj = { nested: { n: 1 }, list: [1, 2] }
        const map: Record<string, any> = { k: obj }
        const base = seedPluginStorageBaseline(map)
        // in-place nested mutation (the case an intercept/op-log would miss)
        obj.nested.n = 2
        const d = computePluginStorageDelta(map, base)
        expect(Object.keys(d.changed)).toEqual(['k'])
    })

    it('advance only after confirmed save; a re-send before advance repeats the same delta (idempotent)', () => {
        const base = seedPluginStorageBaseline({ a: '1' })
        const now = { a: '2', b: '3' }
        const d1 = computePluginStorageDelta(now, base)
        expect(d1.changed).toEqual({ a: '2', b: '3' })
        // save "failed" → baseline NOT advanced → recompute yields the same delta
        const d2 = computePluginStorageDelta(now, base)
        expect(d2.changed).toEqual({ a: '2', b: '3' })
        // now confirm → advance → next compute is empty
        advancePluginStorageBaseline(base, d1)
        expect(pluginStorageDeltaIsEmpty(computePluginStorageDelta(now, base))).toBe(true)
    })

    it('advance handles removals: a removed key drops from the baseline', () => {
        const base = seedPluginStorageBaseline({ a: '1', b: '2' })
        const now = { a: '1' }
        const d = computePluginStorageDelta(now, base)
        expect(d.removed).toEqual(['b'])
        advancePluginStorageBaseline(base, d)
        // re-adding b later is seen as a change again
        const readd = computePluginStorageDelta({ a: '1', b: '2' }, base)
        expect(readd.changed).toEqual({ b: '2' })
    })

    it('clear() → all keys removed', () => {
        const base = seedPluginStorageBaseline({ a: '1', b: '2', c: '3' })
        const d = computePluginStorageDelta({}, base)
        expect(Object.keys(d.changed)).toEqual([])
        expect(d.removed.sort()).toEqual(['a', 'b', 'c'])
    })
})
