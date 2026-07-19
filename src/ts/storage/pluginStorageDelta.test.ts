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

    it('fingerprint matches the JSON that is actually sent — JSON-equal values do not re-send (F4)', () => {
        // The wire + per-key store are JSON (savePluginStorageDelta JSON.stringifies; the
        // row is JSON.stringify(value)). So the fingerprint is over that same JSON. Values
        // that JSON.stringify identically ({a:undefined}=={} , [undefined]==[null], NaN==null)
        // store IDENTICALLY, so there is nothing to re-send — the old msgpack fingerprint
        // reported a phantom change that the JSON wire could never satisfy, so the baseline
        // never converged (the F4 divergence). Now they are correctly equal → empty delta.
        expect(pluginStorageDeltaIsEmpty(computePluginStorageDelta({ k: {} }, seedPluginStorageBaseline({ k: { a: undefined } })))).toBe(true)
        expect(pluginStorageDeltaIsEmpty(computePluginStorageDelta({ k: [null] }, seedPluginStorageBaseline({ k: [undefined] })))).toBe(true)
        expect(pluginStorageDeltaIsEmpty(computePluginStorageDelta({ k: null }, seedPluginStorageBaseline({ k: NaN })))).toBe(true)
        // a genuine JSON-visible change IS still detected
        expect(computePluginStorageDelta({ k: { a: 1 } }, seedPluginStorageBaseline({ k: { a: 2 } })).changed).toHaveProperty('k')
        expect(computePluginStorageDelta({ k: 'x' }, seedPluginStorageBaseline({ k: 'y' })).changed).toHaveProperty('k')
        // idempotent: an unchanged value never re-sends
        expect(pluginStorageDeltaIsEmpty(computePluginStorageDelta({ k: { a: 1 } }, seedPluginStorageBaseline({ k: { a: 1 } })))).toBe(true)
    })

    it('refuses to compute a WIPING delta from a non-plain live container (F4)', () => {
        // A Map/Date/typed-array/primitive enumerates to zero own keys; treating it as the
        // map would mark every baseline key removed = full wipe. Reject loudly instead.
        const base = seedPluginStorageBaseline({ a: '1', b: '2' })
        for (const bad of [new Map([['a', 1]]), new Date(), new Uint8Array([1]), [1, 2], 'x', 42] as any[]) {
            expect(() => computePluginStorageDelta(bad, base), String(bad)).toThrow(/plain object|wiping delta/i)
        }
        // null/undefined are legitimately-empty (not a malformed container): allowed
        expect(computePluginStorageDelta(null, base).removed.sort()).toEqual(['a', 'b'])
        expect(computePluginStorageDelta({}, base).removed.sort()).toEqual(['a', 'b'])
    })

    it('snapshots object values at compute time (later mutation does not change the delta)', () => {
        const obj: any = { n: 1 }
        const base = seedPluginStorageBaseline({ k: { n: 0 } })
        const d = computePluginStorageDelta({ k: obj }, base)
        obj.n = 999 // plugin mutates the live value after we computed the delta
        expect(d.changed.k.n).toBe(1) // delta holds the compute-time snapshot
    })

    it('decouples the snapshot from a LIVE PROXY value + still detects the later mutation (R16 F2)', () => {
        // Mirrors the $state proxy case where structuredClone would fail and the old code
        // retained the live reference. The JSON snapshot must hold the compute-time value,
        // and the baseline must advance to the SENT value so a later mutation is NOT lost.
        const target: any = { n: 1 }
        const proxy = new Proxy(target, {})
        const base = seedPluginStorageBaseline({ k: { n: 0 } })
        const d = computePluginStorageDelta({ k: proxy }, base)
        expect(Object.getPrototypeOf(d.changed.k)).toBe(Object.prototype) // plain snapshot, not the proxy
        target.n = 999                                   // plugin mutates the live value after compute
        expect(d.changed.k.n).toBe(1)                    // snapshot unaffected (value 1 is what was sent)
        advancePluginStorageBaseline(base, d)            // baseline advances to the SENT value (1)
        const d2 = computePluginStorageDelta({ k: proxy }, base) // proxy now reads 999
        expect(d2.changed.k.n).toBe(999)                 // the later mutation IS detected — not silently lost
    })

    it('a top-level value that JSON.stringifies to undefined is treated as ABSENT (removed if it was synced)', () => {
        const base = seedPluginStorageBaseline({ keep: 'a', gone: 'b' })
        // gone := undefined (a plugin cleared it to a non-JSON value) → removed; a brand-new
        // undefined key is simply ignored (never sent, never recorded as synced-present)
        const d = computePluginStorageDelta({ keep: 'a', gone: undefined, fresh: undefined } as any, base)
        expect('gone' in d.changed).toBe(false)
        expect('fresh' in d.changed).toBe(false)
        expect(d.removed).toEqual(['gone'])
        expect('keep' in d.changed).toBe(false)          // unchanged
    })

    it('a cyclic value throws loudly (never a divergent baseline)', () => {
        const cyclic: any = {}; cyclic.self = cyclic
        expect(() => computePluginStorageDelta({ k: cyclic }, new Map())).toThrow(/not JSON-encodable|aborting/i)
    })
})
