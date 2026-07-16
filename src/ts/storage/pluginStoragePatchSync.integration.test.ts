// @vitest-environment node
// REAL-ENVIRONMENT integration test for the pluginCustomStorage b3 sync path.
//
// "Hard to unit-test" is not "can't test": this boots the ACTUAL server
// (server/node/server.cjs) against a throwaway SQLite dir and drives the REAL
// protocol (/api/write, /api/plugin-storage, /api/read, /api/patch, /api/db/
// snapshots) with the REAL client patcher (RisuSavePatcher).
//
// b3 model under test: pluginCustomStorage is FULLY out-of-band — one KV entry per
// key, synced via /api/plugin-storage (delta/replace); database.bin carries NOTHING
// about it (no inline, no marker), so it never enters the patch/etag/hash/rebase
// machinery. That removes the marker/hash coupling that caused the concurrency
// defects. Skips (does not fail) if the server can't boot here.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import nodeCrypto from 'node:crypto'

// Same mocks as pluginStorageSaveCost.test.ts so importing risuSave stays pure.
vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({ chatToStub: (c: any) => c }))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))

const { RisuSavePatcher, encodeRisuSaveLegacy, decodeRisuSave } = await import('./risuSave')
const { setPluginStorageSidecarWriteEnabled, planPcsBoot } = await import('./pluginStorageSidecar')

const SERVER_CJS = nodePath.resolve(__dirname, '../../../server/node/server.cjs')
const PORT = 6788
const BASE = `http://127.0.0.1:${PORT}`
const JWT_SECRET = 'integration-test-secret'
const hex = (s: string) => Buffer.from(s, 'utf-8').toString('hex')

function forgeToken(): string {
    const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const header = b64({ alg: 'HS256', typ: 'JWT' })
    const payload = b64({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })
    const sig = nodeCrypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url')
    return `${header}.${payload}.${sig}`
}
let TOKEN = ''
const authHeaders = (extra: Record<string, string> = {}) => ({ 'risu-auth': TOKEN, ...extra })

let srv: ChildProcess | null = null
let dir = ''
let booted = false

async function waitFor(pred: () => Promise<boolean>, ms: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < ms) {
        try { if (await pred()) return true } catch {}
        await new Promise((r) => setTimeout(r, 150))
    }
    return false
}

beforeAll(async () => {
    dir = mkdtempSync(nodePath.join(tmpdir(), 'prisu-patchsync-'))
    mkdirSync(nodePath.join(dir, 'save'), { recursive: true })
    writeFileSync(nodePath.join(dir, 'save', '__jwt_secret'), JWT_SECRET, 'utf-8')
    TOKEN = forgeToken()
    srv = spawn('node', [SERVER_CJS], {
        cwd: dir,
        env: { ...process.env, PORT: String(PORT), RISU_TUNNEL_DISABLED: 'true', RISU_UPDATE_CHECK: 'false', POCKETRISU_BACKUP_INTERVAL_MS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    booted = await waitFor(async () => {
        const r = await fetch(`${BASE}/api/read`, { headers: authHeaders({ 'file-path': hex('nonexistent/x') }) })
        return r.status !== undefined
    }, 15000)
}, 30000)

afterAll(async () => {
    try { srv?.kill('SIGKILL') } catch {}
    try { if (dir) rmSync(dir, { recursive: true, force: true }) } catch {}
})

const enc = (o: any) => Buffer.from(encodeRisuSaveLegacy(o))
const psPost = (env: any) => fetch(`${BASE}/api/plugin-storage`, {
    method: 'POST', headers: authHeaders({ 'content-type': 'application/octet-stream' }), body: enc(env),
}).then((r) => r.status)
// The pluginCustomStorage data travels as a JSON STRING in the envelope's `json` field
// (never msgpack object keys), and GET returns the map as a JSON string.
async function getPerKey(): Promise<Record<string, any>> {
    const r = await fetch(`${BASE}/api/plugin-storage`, { headers: authHeaders() })
    if (r.status === 404) return {}
    return JSON.parse(await r.text()).pluginCustomStorage ?? {}
}
const replacePerKey = (values: Record<string, any>) => psPost({ type: 'replace', json: JSON.stringify(values) })
const psDelta = (changed: Record<string, any>, removed: string[] = []) => psPost({ type: 'delta', json: JSON.stringify({ changed, removed }) })
const writeDb = (dbObj: any) => fetch(`${BASE}/api/write`, {
    method: 'POST', headers: authHeaders({ 'file-path': hex('database/database.bin'), 'content-type': 'application/octet-stream' }), body: enc(dbObj),
}).then((r) => r.status)

describe('pluginCustomStorage b3 — out-of-band per-key, REAL server', () => {
    it('boots the real server', () => {
        if (!booted) { console.warn('server did not boot — skipping'); return }
        expect(booted).toBe(true)
    })

    // codex R15 F1/F2: the CLIENT migration path, end-to-end against the real server,
    // starting from a genuine fresh LEGACY store (no manual pre-initialization). Proves
    // planPcsBoot itself issues a REPLACE (a legacy store rejects deltas), so a pre-b3
    // account with inline pcs actually initializes — the path the old integration test
    // bypassed by pre-calling replace. Runs FIRST so it sees the fresh legacy state.
    it('CLIENT MIGRATION e2e: fresh legacy (404) → planPcsBoot replaces inline → initialized (200)', async () => {
        if (!booted) return
        const rawGet = () => fetch(`${BASE}/api/plugin-storage`, { headers: authHeaders() }).then((r) => r.status)
        expect(await rawGet()).toBe(404)                 // fresh store = legacy → 404 (NOT initialized-empty)

        // real client boot closures, mirroring nodeStorage.fetch/saveReplace, hitting the live server
        const fetchSidecar = async (): Promise<Record<string, any> | null> => {
            const r = await fetch(`${BASE}/api/plugin-storage`, { headers: authHeaders() })
            if (r.status === 404) return null            // legacy — never an empty map
            if (r.status < 200 || r.status >= 300) throw new Error(`GET ${r.status}`) // error — fail closed
            const d = JSON.parse(await r.text())
            return d && typeof d === 'object' ? (d.pluginCustomStorage ?? null) : null
        }
        const replaceSidecar = async (m: Record<string, any>) => {
            const s = await replacePerKey(m)
            if (s !== 200) throw new Error(`replace ${s}`)
        }

        // a pre-b3 legacy DB carries pcs INLINE; an opted-in device migrates it
        const plan = await planPcsBoot({ localOptIn: true, inlineObj: { seed: JSON.stringify({ v: 1 }) }, inlineFieldPresent: true, fetchSidecar, replaceSidecar })
        expect(plan.enableSidecar).toBe(true)
        expect(plan.markMigration).toBe(true)            // schedule the inline-strip full write
        expect(plan.pcs).toEqual({ seed: JSON.stringify({ v: 1 }) })

        // the account is now INITIALIZED on the real server, holding the migrated inline map
        expect(await rawGet()).toBe(200)                 // initialized → 200 (NOT 404)
        expect(await getPerKey()).toEqual({ seed: JSON.stringify({ v: 1 }) })

        // a steady-state DELTA is now accepted (it was rejected while legacy) — the migration point
        expect(await psDelta({ seed2: 'v2' }, [])).toBe(200)
        expect((await getPerKey()).seed2).toBe('v2')
    })

    it('per-key delta round-trips through the real server (POST changed → GET)', async () => {
        if (!booted) return
        expect(await replacePerKey({ 'vector_rag:shard:0': JSON.stringify({ v: 1 }), 'hayaku.v1.durable.a': 'x' })).toBe(200)
        expect(await psDelta({ 'vector_rag:shard:0': JSON.stringify({ v: 2 }) }, [])).toBe(200)
        const back = await getPerKey()
        expect(JSON.parse(back['vector_rag:shard:0']).v).toBe(2)   // updated
        expect(back['hayaku.v1.durable.a']).toBe('x')              // untouched key survives
    })

    it('DELETE is real: a removed key is gone from the store (no orphan resurrection)', async () => {
        if (!booted) return
        await replacePerKey({ keep: 'a', gone: 'b' })
        expect(await psDelta({}, ['gone'])).toBe(200)
        const back = await getPerKey()
        expect(back.keep).toBe('a')
        expect('gone' in back).toBe(false)   // really deleted (removeKey), not a lingering orphan
    })

    it('CONCURRENCY: two tabs editing DIFFERENT keys both survive (no clobber)', async () => {
        if (!booted) return
        await replacePerKey({ base: 'b' })
        const [s1, s2] = await Promise.all([
            psDelta({ A: 'a1' }, []),
            psDelta({ B: 'b1' }, []),
        ])
        expect(s1).toBe(200); expect(s2).toBe(200)
        const back = await getPerKey()
        expect(back).toEqual({ base: 'b', A: 'a1', B: 'b1' })   // both adds present, neither dropped
    })

    it('flag-ON patcher EXCLUDES pcs → database.bin patch is accepted (no marker/hash coupling)', async () => {
        if (!booted) return
        setPluginStorageSidecarWriteEnabled(true)
        // server DB carries NO pcs (b3). Seed one, then read it back.
        expect(await writeDb({ formatversion: 4, characters: [], botPresets: [{ id: 'p', name: 'preset' }], modules: [], plugins: [], customCSS: 'v1' })).toBe(200)
        const readDb = await decodeRisuSave(new Uint8Array(await (await fetch(`${BASE}/api/read`, { headers: authHeaders({ 'file-path': hex('database/database.bin') }) })).arrayBuffer()))
        // the LIVE db has pcs (plugins use it); the flag-ON patcher must exclude it so
        // its hash matches the pcs-free server DB (this is what used to 409-loop).
        const liveDb: any = { ...readDb, pluginCustomStorage: { 'k': 'v' } } // customCSS stays 'v1' (baseline)
        const patcher = new RisuSavePatcher()
        await patcher.init(liveDb)
        liveDb.customCSS = 'v2' // the actual change, made AFTER init so the diff is v1->v2
        const { patch, expectedHash } = await patcher.set(liveDb, {
            character: [], chat: [], root: true, botPreset: false, modules: false, plugins: false, pluginCustomStorage: true,
        } as any)
        // the patch must not carry pcs at all
        expect(JSON.stringify(patch)).not.toContain('pluginCustomStorage')
        const resp = await fetch(`${BASE}/api/patch`, {
            method: 'POST', headers: authHeaders({ 'file-path': hex('database/database.bin'), 'content-type': 'application/json' }),
            body: JSON.stringify({ patch, expectedHash }),
        })
        expect(resp.status).toBe(200)   // hash agrees — no pcs on either side
    })

    it('BACKUP/RESTORE: a DB snapshot captures + restores the per-key plugin memory', async () => {
        if (!booted) return
        await replacePerKey({ A: 'a0', B: 'b0' })
        await writeDb({ formatversion: 4, characters: [], botPresets: [], modules: [], plugins: [], customCSS: 'backup-marker' }) // forces a fresh backup pairing per-key {A:a0,B:b0}
        const list = await (await fetch(`${BASE}/api/db/snapshots`, { headers: authHeaders() })).json()
        const snaps: any[] = Array.isArray(list) ? list : (list.snapshots ?? list.items ?? [])
        // take the LATEST snapshot (keys are time-ordered) — the one we just made,
        // since a later delta POST does not create a snapshot.
        const snapKey = snaps.map((s: any) => (typeof s === 'string' ? s : s.key)).filter(Boolean).sort().reverse()[0]
        expect(snapKey, 'a snapshot should exist').toBeTruthy()
        await psDelta({ A: 'a1-CHANGED' }, [])
        expect((await getPerKey()).A).toBe('a1-CHANGED')
        const r = await fetch(`${BASE}/api/db/snapshots/restore`, {
            method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ key: snapKey }),
        })
        expect(r.status).toBe(200)
        const after = await getPerKey()
        expect(after.A).toBe('a0')   // reverted with the snapshot
        expect(after.B).toBe('b0')
    })

    // codex round-8 HIGH#1: restore RESETS the live plugin memory to exactly the
    // snapshot's — a key ADDED after the snapshot must be GONE after restore (never
    // left stale), and the DB blob + plugin prefix are restored as one atomic pair.
    it('BACKUP/RESTORE: a key added after the snapshot is removed on restore (no stale keys)', async () => {
        if (!booted) return
        await replacePerKey({ A: 'a', B: 'b' })
        await writeDb({ formatversion: 4, characters: [], botPresets: [], modules: [], plugins: [], customCSS: 'stale-key-marker' }) // snapshot pairs {A,B}
        const list = await (await fetch(`${BASE}/api/db/snapshots`, { headers: authHeaders() })).json()
        const snaps: any[] = Array.isArray(list) ? list : (list.snapshots ?? list.items ?? [])
        const snapKey = snaps.map((s: any) => (typeof s === 'string' ? s : s.key)).filter(Boolean).sort().reverse()[0]
        await psDelta({ C: 'c-added-after-snapshot' }, [])
        expect((await getPerKey()).C).toBe('c-added-after-snapshot')
        const r = await fetch(`${BASE}/api/db/snapshots/restore`, {
            method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ key: snapKey }),
        })
        expect(r.status).toBe(200)
        const after = await getPerKey()
        expect(after).toEqual({ A: 'a', B: 'b' })   // C is gone — live reset to the snapshot, not merged
    })

    it('malformed envelope is rejected 400 (no type, or no json string)', async () => {
        if (!booted) return
        expect(await psPost({ changed: { A: 'x' } })).toBe(400)             // no discriminator
        expect(await psPost({ type: 'replace' })).toBe(400)                 // no json field
        expect(await psPost({ type: 'replace', json: 'not json{' })).toBe(400) // invalid JSON
    })

    it('replace with a non-object json payload is rejected 400 (never coerced to {} → no silent wipe)', async () => {
        if (!booted) return
        await replacePerKey({ survivor: 'keep-me' })                        // seed real memory
        // JSON that parses to a non-object (string / array / number) must be refused —
        // accepting it would coerce to {} and wipe every row.
        expect(await psPost({ type: 'replace', json: JSON.stringify('bad') })).toBe(400)
        expect(await psPost({ type: 'replace', json: JSON.stringify([1, 2]) })).toBe(400)
        expect(await psPost({ type: 'replace', json: JSON.stringify(42) })).toBe(400)
        expect((await getPerKey()).survivor).toBe('keep-me')               // memory intact (not wiped)
    })
})
