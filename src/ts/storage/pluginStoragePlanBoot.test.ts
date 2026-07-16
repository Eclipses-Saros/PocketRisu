import { describe, it, expect, vi } from 'vitest'
import { planPcsBoot } from './pluginStorageSidecar'

// The client boot reconciles the account-wide server mode with this device's opt-in WITHOUT
// collapsing the discriminated GET to "empty", and migrates a legacy store via an IDEMPOTENT,
// race-safe CAS INITIALIZE (not an unconditional replace). Cases: 404 legacy (opted-in/not),
// initialized 200 non-empty / {}, probe error (block boot), and the migration CAS outcomes —
// won (initialized), lost/racing (already → adopt authoritative), network retry, persistent
// failure (block boot). (F1/F2/F3 R15–R18.)

const INLINE = { a: '1', b: '2' }
const base = (over: any = {}) => ({
    localOptIn: true, inlineObj: {}, inlineFieldPresent: false,
    fetchSidecar: async () => null, initializeSidecar: async () => 'initialized' as const, ...over,
})

describe('planPcsBoot — boot reconciliation + migration CAS (R15–R18)', () => {
    it('LEGACY 404 + opted-in → migrates via CAS initialize(inline), adopts inline, marks strip', async () => {
        const initializeSidecar = vi.fn(async () => 'initialized' as const)
        const plan = await planPcsBoot(base({ inlineObj: INLINE, inlineFieldPresent: true, fetchSidecar: async () => null, initializeSidecar }))
        expect(initializeSidecar).toHaveBeenCalledTimes(1)
        expect(initializeSidecar).toHaveBeenCalledWith(INLINE)   // CAS initialize, NOT replace/delta
        expect(plan).toMatchObject({ enableSidecar: true, pcs: INLINE, baseline: INLINE, markMigration: true })
    })

    it('LEGACY 404 + NOT opted-in → stays legacy, no initialize, sidecar off', async () => {
        const initializeSidecar = vi.fn(async () => 'initialized' as const)
        const plan = await planPcsBoot(base({ localOptIn: false, inlineObj: INLINE, inlineFieldPresent: true, fetchSidecar: async () => null, initializeSidecar }))
        expect(initializeSidecar).not.toHaveBeenCalled()
        expect(plan).toMatchObject({ enableSidecar: false, pcs: null, baseline: INLINE, markMigration: false })
    })

    it('INITIALIZED 200 (non-empty) → authoritative rows, forces sidecar even if NOT opted in (F3)', async () => {
        const rows = { x: 'server' }
        const initializeSidecar = vi.fn(async () => 'initialized' as const)
        const plan = await planPcsBoot(base({ localOptIn: false, inlineObj: INLINE, inlineFieldPresent: true, fetchSidecar: async () => rows, initializeSidecar }))
        expect(initializeSidecar).not.toHaveBeenCalled()
        expect(plan.enableSidecar).toBe(true)
        expect(plan.pcs).toBe(rows)
        expect(plan.markMigration).toBe(true)
    })

    it('INITIALIZED-EMPTY 200 {} → authoritative empty (not legacy), forces sidecar, no strip if no inline field', async () => {
        const plan = await planPcsBoot(base({ localOptIn: false, inlineObj: {}, inlineFieldPresent: false, fetchSidecar: async () => ({}) }))
        expect(plan.enableSidecar).toBe(true)
        expect(plan.pcs).toEqual({})
        expect(plan.markMigration).toBe(false)
    })

    it('markMigration keyed on FIELD PRESENCE — an empty inline {} field still schedules a strip', async () => {
        const plan = await planPcsBoot(base({ localOptIn: true, inlineObj: {}, inlineFieldPresent: true, fetchSidecar: async () => ({ x: 'srv' }) }))
        expect(plan.markMigration).toBe(true)
    })

    it('INITIALIZED-EMPTY 200 {} does NOT resurrect stale inline', async () => {
        const plan = await planPcsBoot(base({ localOptIn: true, inlineObj: { stale: 'x' }, inlineFieldPresent: true, fetchSidecar: async () => ({}) }))
        expect(plan.pcs).toEqual({})
        expect(plan.markMigration).toBe(true)
    })

    it('PROBE ERROR (500/network/malformed) → THROWS to block boot; no initialize attempted', async () => {
        const initializeSidecar = vi.fn(async () => 'initialized' as const)
        await expect(planPcsBoot(base({
            localOptIn: true, inlineObj: INLINE, inlineFieldPresent: true,
            fetchSidecar: async () => { throw new Error('500') }, initializeSidecar,
        }))).rejects.toThrow(/500/)
        expect(initializeSidecar).not.toHaveBeenCalled()
    })

    // ── migration CAS outcomes (R18: idempotent, race-safe) ──────────────────
    it('initialize → ALREADY (racing device / lost-response commit) → adopts the AUTHORITATIVE map', async () => {
        const rows = { winner: 'other-device' }
        let getCalls = 0
        const plan = await planPcsBoot(base({
            localOptIn: true, inlineObj: INLINE, inlineFieldPresent: true,
            fetchSidecar: async () => { getCalls++; return getCalls === 1 ? null : rows }, // probe 404, then adopt-fetch 200
            initializeSidecar: async () => 'already' as const,
        }))
        expect(plan.enableSidecar).toBe(true)
        expect(plan.pcs).toBe(rows)          // adopted authoritative, NOT the local inline (no clobber)
        expect(plan.baseline).toBe(rows)
    })

    it('initialize network error then SUCCEEDS on retry (idempotent) → initialized', async () => {
        let n = 0
        const initializeSidecar = vi.fn(async () => { n++; if (n === 1) throw new Error('network'); return 'initialized' as const })
        const plan = await planPcsBoot(base({ localOptIn: true, inlineObj: INLINE, inlineFieldPresent: true, fetchSidecar: async () => null, initializeSidecar }))
        expect(n).toBe(2)                    // retried after the transient error
        expect(plan).toMatchObject({ enableSidecar: true, pcs: INLINE, markMigration: true })
    })

    it('initialize PERSISTENTLY fails → blocks boot (fail closed, no legacy fallback)', async () => {
        const initializeSidecar = vi.fn(async () => { throw new Error('down') })
        await expect(planPcsBoot(base({
            localOptIn: true, inlineObj: INLINE, inlineFieldPresent: true,
            fetchSidecar: async () => null, initializeSidecar,
        }))).rejects.toThrow(/did not reach a definitive state|blocking boot/i)
        expect(initializeSidecar.mock.calls.length).toBeGreaterThanOrEqual(3) // bounded retries
    })

    it('initialize ALREADY but adopt-fetch throws (unknown) → blocks boot', async () => {
        let getCalls = 0
        await expect(planPcsBoot(base({
            localOptIn: true, inlineObj: INLINE, inlineFieldPresent: true,
            fetchSidecar: async () => { getCalls++; if (getCalls === 1) return null; throw new Error('500 on adopt-fetch') },
            initializeSidecar: async () => 'already' as const,
        }))).rejects.toThrow(/500 on adopt-fetch/)
    })

    it('fresh account (404, no inline field) + opted-in → initialize({}) sets an empty store, no strip', async () => {
        const initializeSidecar = vi.fn(async () => 'initialized' as const)
        const plan = await planPcsBoot(base({ localOptIn: true, inlineObj: {}, inlineFieldPresent: false, fetchSidecar: async () => null, initializeSidecar }))
        expect(initializeSidecar).toHaveBeenCalledWith({})
        expect(plan).toMatchObject({ enableSidecar: true, pcs: {}, markMigration: false })
    })
})
