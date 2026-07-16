import { describe, it, expect, vi } from 'vitest'
import { planPcsBoot } from './pluginStorageSidecar'

// F1/F2/F3 (codex R15): the client boot must reconcile the account-wide server mode with
// this device's opt-in WITHOUT collapsing the discriminated GET to "empty" and WITHOUT
// relying on a delta to initialize a legacy store (delta is rejected there; replace is
// required). These cover the exact cases R15 demanded: 404 legacy (opted-in and not),
// initialized 200 {} and non-empty, 500/network failure, and the migration replace call.

const INLINE = { a: '1', b: '2' }

describe('planPcsBoot — boot reconciliation (F1/F2/F3)', () => {
    it('LEGACY 404 + opted-in → MIGRATES via replace(inline), enables sidecar, marks strip', async () => {
        const replaceSidecar = vi.fn(async () => {})
        const plan = await planPcsBoot({
            localOptIn: true, inlineObj: INLINE,
            fetchSidecar: async () => null,            // 404
            replaceSidecar,
        })
        expect(replaceSidecar).toHaveBeenCalledTimes(1)
        expect(replaceSidecar).toHaveBeenCalledWith(INLINE) // replace, NOT delta
        expect(plan).toMatchObject({ enableSidecar: true, pcs: INLINE, baseline: INLINE, markMigration: true })
    })

    it('LEGACY 404 + NOT opted-in → stays legacy (inline authoritative), no replace, sidecar off', async () => {
        const replaceSidecar = vi.fn(async () => {})
        const plan = await planPcsBoot({
            localOptIn: false, inlineObj: INLINE,
            fetchSidecar: async () => null,
            replaceSidecar,
        })
        expect(replaceSidecar).not.toHaveBeenCalled()
        expect(plan).toMatchObject({ enableSidecar: false, pcs: null, baseline: INLINE, markMigration: false })
    })

    it('INITIALIZED 200 (non-empty) → authoritative rows, forces sidecar even if NOT opted in (F3)', async () => {
        const rows = { x: 'server' }
        const replaceSidecar = vi.fn(async () => {})
        const plan = await planPcsBoot({
            localOptIn: false, inlineObj: INLINE,       // stale inline present
            fetchSidecar: async () => rows,
            replaceSidecar,
        })
        expect(replaceSidecar).not.toHaveBeenCalled()
        expect(plan.enableSidecar).toBe(true)           // forced on despite localOptIn=false
        expect(plan.pcs).toBe(rows)                     // server rows win over inline
        expect(plan.baseline).toBe(rows)
        expect(plan.markMigration).toBe(true)           // stale inline present → schedule strip
    })

    it('INITIALIZED-EMPTY 200 {} → authoritative empty (NOT conflated with legacy), forces sidecar', async () => {
        const plan = await planPcsBoot({
            localOptIn: false, inlineObj: {},           // no inline
            fetchSidecar: async () => ({}),             // 200 {}
            replaceSidecar: async () => {},
        })
        expect(plan.enableSidecar).toBe(true)           // {} is initialized, not legacy
        expect(plan.pcs).toEqual({})
        expect(plan.markMigration).toBe(false)          // no inline to strip
    })

    it('INITIALIZED-EMPTY 200 {} does NOT resurrect stale inline (the conflation bug)', async () => {
        const plan = await planPcsBoot({
            localOptIn: true, inlineObj: { stale: 'x' }, // stale inline present
            fetchSidecar: async () => ({}),              // server authoritative-empty
            replaceSidecar: async () => {},
        })
        expect(plan.pcs).toEqual({})                     // empty server wins, inline NOT used
        expect(plan.markMigration).toBe(true)            // strip the stale inline
    })

    it('ERROR (500/network) → FAIL CLOSED: sidecar off, keep decoded inline, nothing sent', async () => {
        const replaceSidecar = vi.fn(async () => {})
        const plan = await planPcsBoot({
            localOptIn: true, inlineObj: INLINE,
            fetchSidecar: async () => { throw new Error('500') },
            replaceSidecar,
        })
        expect(replaceSidecar).not.toHaveBeenCalled()   // never send on unknown mode
        expect(plan.enableSidecar).toBe(false)          // disabled → no delta/replace → rows untouched
        expect(plan.pcs).toBeNull()                     // keep decoded inline
        expect(plan.baseline).toBe(INLINE)
        expect(plan.warn).toMatch(/fail closed/i)
    })

    it('MIGRATION replace FAILS → FAIL CLOSED: stay legacy this session, retry next boot', async () => {
        const plan = await planPcsBoot({
            localOptIn: true, inlineObj: INLINE,
            fetchSidecar: async () => null,             // legacy
            replaceSidecar: async () => { throw new Error('network') },
        })
        expect(plan.enableSidecar).toBe(false)          // did NOT half-migrate
        expect(plan.pcs).toBeNull()
        expect(plan.markMigration).toBe(false)
        expect(plan.warn).toMatch(/migration.*failed|fail closed/i)
    })

    it('fresh account (legacy 404, no inline) + opted-in → replace({}) initializes an empty store', async () => {
        const replaceSidecar = vi.fn(async () => {})
        const plan = await planPcsBoot({
            localOptIn: true, inlineObj: {},
            fetchSidecar: async () => null,
            replaceSidecar,
        })
        expect(replaceSidecar).toHaveBeenCalledWith({})
        expect(plan).toMatchObject({ enableSidecar: true, pcs: {}, markMigration: true })
    })
})
