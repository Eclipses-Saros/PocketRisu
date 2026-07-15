import { describe, it, expect } from 'vitest'
// Self-contained now (no risuSave/Svelte import) → no mocks needed.
import {
    seedPluginStorageBaseline,
    computePluginStorageDelta,
    advancePluginStorageBaseline,
    pluginStorageDeltaIsEmpty,
} from './pluginStorageDelta'

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

    // B4: the OLD 32-bit order-independent object hash collided ({a:1,b:2} vs
    // {a:2,b:1}) → a real value change was suppressed → server kept stale. The
    // content-string digest must DETECT this.
    it('detects order-swapped object values (no hash collision → no silent staleness)', () => {
        const base = seedPluginStorageBaseline({ k: { a: 1, b: 2 } })
        const d = computePluginStorageDelta({ k: { a: 2, b: 1 } }, base)
        expect(Object.keys(d.changed)).toEqual(['k'])
        expect(JSON.stringify(d.changed.k)).toBe(JSON.stringify({ a: 2, b: 1 }))
    })

    it('distinguishes values that differ only in type/shape (1 vs "1", [] vs {})', () => {
        const base = seedPluginStorageBaseline({ n: 1, e: [] })
        const d = computePluginStorageDelta({ n: '1', e: {} }, base)
        expect(Object.keys(d.changed).sort()).toEqual(['e', 'n'])
    })

    it('changed map is null-prototype: a "__proto__" key becomes an OWN entry, no pollution', () => {
        const base = seedPluginStorageBaseline({})
        const cur: Record<string, any> = {}
        Object.defineProperty(cur, '__proto__', { value: 'evil', enumerable: true, configurable: true, writable: true })
        const d = computePluginStorageDelta(cur, base)
        expect(Object.hasOwn(d.changed, '__proto__')).toBe(true)
        expect(Object.getPrototypeOf(d.changed)).toBeNull()
        expect(({} as any).evil).toBeUndefined() // global prototype not polluted
    })

    it('detects distinctions msgpack persists but JSON.stringify collapses (F4)', () => {
        // {a:undefined} vs {}, [undefined] vs [null], NaN vs null all JSON.stringify
        // to the same text but encode to DIFFERENT msgpack bytes -> must be detected.
        expect(Object.keys(computePluginStorageDelta({ k: {} }, seedPluginStorageBaseline({ k: { a: undefined } }))).length >= 0).toBe(true)
        expect(computePluginStorageDelta({ k: {} }, seedPluginStorageBaseline({ k: { a: undefined } })).changed).toHaveProperty('k')
        expect(computePluginStorageDelta({ k: [null] }, seedPluginStorageBaseline({ k: [undefined] })).changed).toHaveProperty('k')
        expect(computePluginStorageDelta({ k: null }, seedPluginStorageBaseline({ k: NaN })).changed).toHaveProperty('k')
        // and no false positive when genuinely unchanged
        expect(pluginStorageDeltaIsEmpty(computePluginStorageDelta({ k: { a: undefined } }, seedPluginStorageBaseline({ k: { a: undefined } })))).toBe(true)
    })

    it('snapshots object values at compute time (later mutation does not change the delta)', () => {
        const obj: any = { n: 1 }
        const base = seedPluginStorageBaseline({ k: { n: 0 } })
        const d = computePluginStorageDelta({ k: obj }, base)
        obj.n = 999 // plugin mutates the live value after we computed the delta
        expect(d.changed.k.n).toBe(1) // delta holds the compute-time snapshot
    })
})
