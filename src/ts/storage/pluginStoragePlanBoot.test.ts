import { describe, it, expect, vi } from 'vitest'
import { planPcsBoot } from './pluginStorageSidecar'

// F1/F2/F3 (codex R15/R16): the client boot reconciles the account-wide server mode with this
// device's opt-in WITHOUT collapsing the discriminated GET to "empty", initializes a legacy
// store via REPLACE (delta is rejected there), and FAILS CLOSED (blocks boot) when the mode is
// unknown. Cases: 404 legacy (opted-in and not), initialized 200 non-empty / {}, probe error
// (must throw = block boot), migration-replace failure (safe legacy fallback), and the
// markMigration=field-presence rule (R16 F4).

const INLINE = { a: '1', b: '2' }
const base = (over: any = {}) => ({
    localOptIn: true, inlineObj: {}, inlineFieldPresent: false,
    fetchSidecar: async () => null, replaceSidecar: async () => {}, ...over,
})

describe('planPcsBoot — boot reconciliation (F1/F2/F3, R16)', () => {
    it('LEGACY 404 + opted-in → MIGRATES via replace(inline), enables sidecar, marks strip', async () => {
        const replaceSidecar = vi.fn(async () => {})
        const plan = await planPcsBoot(base({ inlineObj: INLINE, inlineFieldPresent: true, fetchSidecar: async () => null, replaceSidecar }))
        expect(replaceSidecar).toHaveBeenCalledTimes(1)
        expect(replaceSidecar).toHaveBeenCalledWith(INLINE)   // replace, NOT delta
        expect(plan).toMatchObject({ enableSidecar: true, pcs: INLINE, baseline: INLINE, markMigration: true })
    })

    it('LEGACY 404 + NOT opted-in → stays legacy (inline authoritative), no replace, sidecar off', async () => {
        const replaceSidecar = vi.fn(async () => {})
        const plan = await planPcsBoot(base({ localOptIn: false, inlineObj: INLINE, inlineFieldPresent: true, fetchSidecar: async () => null, replaceSidecar }))
        expect(replaceSidecar).not.toHaveBeenCalled()
        expect(plan).toMatchObject({ enableSidecar: false, pcs: null, baseline: INLINE, markMigration: false })
    })

    it('INITIALIZED 200 (non-empty) → authoritative rows, forces sidecar even if NOT opted in (F3)', async () => {
        const rows = { x: 'server' }
        const replaceSidecar = vi.fn(async () => {})
        const plan = await planPcsBoot(base({ localOptIn: false, inlineObj: INLINE, inlineFieldPresent: true, fetchSidecar: async () => rows, replaceSidecar }))
        expect(replaceSidecar).not.toHaveBeenCalled()
        expect(plan.enableSidecar).toBe(true)   // forced on despite localOptIn=false
        expect(plan.pcs).toBe(rows)             // server rows win over inline
        expect(plan.baseline).toBe(rows)
        expect(plan.markMigration).toBe(true)   // a stale inline field is present → schedule strip
    })

    it('INITIALIZED-EMPTY 200 {} → authoritative empty (NOT conflated with legacy), forces sidecar', async () => {
        const plan = await planPcsBoot(base({ localOptIn: false, inlineObj: {}, inlineFieldPresent: false, fetchSidecar: async () => ({}) }))
        expect(plan.enableSidecar).toBe(true)   // {} is initialized, not legacy
        expect(plan.pcs).toEqual({})
        expect(plan.markMigration).toBe(false)  // no inline field to strip
    })

    it('markMigration is keyed on FIELD PRESENCE — an empty inline {} field still schedules a strip (R16 F4)', async () => {
        // initialized + the DB carries an EMPTY inline pcs field (inlineFieldPresent, inlineObj {})
        const plan = await planPcsBoot(base({ localOptIn: true, inlineObj: {}, inlineFieldPresent: true, fetchSidecar: async () => ({ x: 'srv' }) }))
        expect(plan.markMigration).toBe(true)   // field present (even empty) → strip it (avoid dangling/ambiguous)
    })

    it('INITIALIZED-EMPTY 200 {} does NOT resurrect stale inline (the conflation bug)', async () => {
        const plan = await planPcsBoot(base({ localOptIn: true, inlineObj: { stale: 'x' }, inlineFieldPresent: true, fetchSidecar: async () => ({}) }))
        expect(plan.pcs).toEqual({})            // empty server wins, inline NOT used
        expect(plan.markMigration).toBe(true)   // strip the stale inline field
    })

    it('PROBE ERROR (500/network/malformed) → THROWS to BLOCK boot (never boot an initialized account empty)', async () => {
        const replaceSidecar = vi.fn(async () => {})
        await expect(planPcsBoot(base({
            localOptIn: true, inlineObj: INLINE, inlineFieldPresent: true,
            fetchSidecar: async () => { throw new Error('500') }, replaceSidecar,
        }))).rejects.toThrow(/500/)
        expect(replaceSidecar).not.toHaveBeenCalled()   // never write on unknown mode
    })

    it('MIGRATION replace FAILS (mode KNOWN legacy) → FAIL CLOSED: stay legacy this session, no throw', async () => {
        const plan = await planPcsBoot(base({
            localOptIn: true, inlineObj: INLINE, inlineFieldPresent: true,
            fetchSidecar: async () => null,                 // legacy — mode known
            replaceSidecar: async () => { throw new Error('network') },
        }))
        expect(plan.enableSidecar).toBe(false)   // did NOT half-migrate
        expect(plan.pcs).toBeNull()
        expect(plan.markMigration).toBe(false)
        expect(plan.warn).toMatch(/migration.*failed|fail closed/i)
    })

    it('fresh account (legacy 404, no inline field) + opted-in → replace({}) initializes an empty store', async () => {
        const replaceSidecar = vi.fn(async () => {})
        const plan = await planPcsBoot(base({ localOptIn: true, inlineObj: {}, inlineFieldPresent: false, fetchSidecar: async () => null, replaceSidecar }))
        expect(replaceSidecar).toHaveBeenCalledWith({})
        expect(plan).toMatchObject({ enableSidecar: true, pcs: {}, markMigration: false }) // no inline field → nothing to strip
    })
})
