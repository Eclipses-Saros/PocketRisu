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

    it('MIGRATION replace FAILS, re-probe confirms 404 → FAIL CLOSED: stay legacy, no throw (R17)', async () => {
        let calls = 0
        const plan = await planPcsBoot(base({
            localOptIn: true, inlineObj: INLINE, inlineFieldPresent: true,
            fetchSidecar: async () => { calls++; return null },  // probe → null; re-probe → null (still legacy)
            replaceSidecar: async () => { throw new Error('network') },
        }))
        expect(calls).toBe(2)                    // probed, then RE-probed after the replace error
        expect(plan.enableSidecar).toBe(false)   // did NOT half-migrate
        expect(plan.pcs).toBeNull()
        expect(plan.markMigration).toBe(false)
        expect(plan.warn).toMatch(/re-probe confirms legacy|migration.*failed/i)
    })

    it('MIGRATION replace fails but COMMITTED (response lost); re-probe shows 200 → ADOPT sidecar, no loss (R17)', async () => {
        // The server commits before responding; a lost response looks like a failed replace.
        // Re-probe reveals the store IS initialized → adopt it instead of booting legacy.
        let calls = 0
        const rows = { a: '1', b: '2' }
        const plan = await planPcsBoot(base({
            localOptIn: true, inlineObj: INLINE, inlineFieldPresent: true,
            fetchSidecar: async () => { calls++; return calls === 1 ? null : rows }, // 404 then (post-commit) 200
            replaceSidecar: async () => { throw new Error('response lost after commit') },
        }))
        expect(plan.enableSidecar).toBe(true)    // adopted the (committed) sidecar
        expect(plan.pcs).toBe(rows)
        expect(plan.baseline).toBe(rows)
    })

    it('MIGRATION replace fails and re-probe is UNKNOWN (throws) → propagate (block boot) (R17)', async () => {
        let calls = 0
        await expect(planPcsBoot(base({
            localOptIn: true, inlineObj: INLINE, inlineFieldPresent: true,
            fetchSidecar: async () => { calls++; if (calls === 1) return null; throw new Error('500 on re-probe') },
            replaceSidecar: async () => { throw new Error('network') },
        }))).rejects.toThrow(/500 on re-probe/)
    })

    it('fresh account (legacy 404, no inline field) + opted-in → replace({}) initializes an empty store', async () => {
        const replaceSidecar = vi.fn(async () => {})
        const plan = await planPcsBoot(base({ localOptIn: true, inlineObj: {}, inlineFieldPresent: false, fetchSidecar: async () => null, replaceSidecar }))
        expect(replaceSidecar).toHaveBeenCalledWith({})
        expect(plan).toMatchObject({ enableSidecar: true, pcs: {}, markMigration: false }) // no inline field → nothing to strip
    })
})
