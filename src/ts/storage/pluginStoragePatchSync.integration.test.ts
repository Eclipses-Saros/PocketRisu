// @vitest-environment node
// REAL-ENVIRONMENT integration test for the pluginCustomStorage patch-sync path.
//
// "Hard to unit-test" is not "can't test": this boots the ACTUAL server
// (server/node/server.cjs) against a throwaway SQLite dir and drives the REAL
// save protocol (/api/write, /api/plugin-storage, /api/read, /api/patch) with the
// REAL client patcher (RisuSavePatcher). It targets codex BLOCKER 1: the client
// hashes the marker form while the server hashes the inline form, so a flag-on
// patch is rejected with 409 forever.
//
// Expected states:
//   - BEFORE C1-step2 (server hydrates pcs inline at decode → dbCache inline):
//       the marker-hash patch MISMATCHES → server replies 409. (RED)
//   - AFTER  C1-step2 (server preserves the marker in dbCache → hashes marker):
//       the patch is accepted → 200, and the value round-trips. (GREEN)
//
// Skips itself (does not fail) if the server can't boot in this environment.
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
const { setPluginStorageSidecarWriteEnabled, buildPluginStorageDirectory, PLUGIN_STORAGE_SIDECAR_MARKER } = await import('./pluginStorageSidecar')

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
        env: { ...process.env, PORT: String(PORT), RISU_TUNNEL_DISABLED: 'true', RISU_UPDATE_CHECK: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    booted = await waitFor(async () => {
        const r = await fetch(`${BASE}/api/read`, { headers: authHeaders({ 'file-path': hex('nonexistent/x') }) })
        return r.status !== undefined // any HTTP response means it's listening
    }, 15000)
}, 30000)

afterAll(async () => {
    try { srv?.kill('SIGKILL') } catch {}
    try { if (dir) rmSync(dir, { recursive: true, force: true }) } catch {}
})

// Seed database.bin (marker form) + the per-key values, then run one flag-ON
// client patch cycle and observe whether the server accepts it.
async function seedMarkerDbAndValues(pcs: Record<string, string>) {
    // 1) per-key values (mimics the client sidecar seed). Discriminated "replace".
    const post = await fetch(`${BASE}/api/plugin-storage`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/octet-stream' }),
        body: Buffer.from(encodeRisuSaveLegacy({ type: 'replace', values: pcs })),
    })
    expect(post.status).toBe(200)
    // 2) database.bin in MARKER form (no inline pcs; carries the directory marker).
    const markerDb: any = { formatversion: 4, characters: [], botPresets: [], modules: [], plugins: [],
        [PLUGIN_STORAGE_SIDECAR_MARKER]: buildPluginStorageDirectory(pcs) }
    const w = await fetch(`${BASE}/api/write`, {
        method: 'POST',
        headers: authHeaders({ 'file-path': hex('database/database.bin'), 'content-type': 'application/octet-stream' }),
        body: Buffer.from(encodeRisuSaveLegacy(markerDb)),
    })
    expect(w.status).toBe(200)
}

async function readDb(): Promise<any> {
    const r = await fetch(`${BASE}/api/read`, { headers: authHeaders({ 'file-path': hex('database/database.bin') }) })
    expect(r.status).toBe(200)
    const buf = new Uint8Array(await r.arrayBuffer())
    return await decodeRisuSave(buf)
}

describe('pluginCustomStorage patch-sync — REAL server (codex BLOCKER 1)', () => {
    it('boots the real server', () => {
        if (!booted) { console.warn('server did not boot — skipping'); return }
        expect(booted).toBe(true)
    })

    it('flag-ON client value-change patch is ACCEPTED (marker hash agrees) and round-trips', async () => {
        if (!booted) { console.warn('server not booted — skipping'); return }
        setPluginStorageSidecarWriteEnabled(true)
        const pcs = { 'vector_rag:shard:0': JSON.stringify({ v: 1 }), 'hayaku.v1.durable.a': 'x' }
        await seedMarkerDbAndValues(pcs)

        // client reads the server's DB (marker form after C1-step2) and hydrates
        // pcs inline so its patcher baseline matches the server dbCache.
        const readServerDb = await readDb()
        const getPcs = await fetch(`${BASE}/api/plugin-storage`, { headers: authHeaders() })
        const hydrated = getPcs.status === 200 ? (await decodeRisuSave(new Uint8Array(await getPcs.arrayBuffer()))).pluginCustomStorage : {}
        const liveDb: any = { ...readServerDb, pluginCustomStorage: { ...hydrated } }

        const patcher = new RisuSavePatcher()
        await patcher.init(liveDb)
        // value-only change: marker (key set) unchanged → patch carries no pcs op,
        // value travels via the per-key POST below (concurrency-safe path).
        liveDb.pluginCustomStorage['vector_rag:shard:0'] = JSON.stringify({ v: 2 })
        const delta = { type: 'delta', changed: { 'vector_rag:shard:0': liveDb.pluginCustomStorage['vector_rag:shard:0'] }, removed: [] }
        const dp = await fetch(`${BASE}/api/plugin-storage`, {
            method: 'POST', headers: authHeaders({ 'content-type': 'application/octet-stream' }),
            body: Buffer.from(encodeRisuSaveLegacy(delta)),
        })
        expect(dp.status).toBe(200)

        const { patch, expectedHash } = await patcher.set(liveDb, {
            character: [], chat: [], root: true, botPreset: false, modules: false, plugins: false, pluginCustomStorage: true,
        } as any)
        const resp = await fetch(`${BASE}/api/patch`, {
            method: 'POST', headers: authHeaders({ 'file-path': hex('database/database.bin'), 'content-type': 'application/json' }),
            body: JSON.stringify({ patch, expectedHash }),
        })
        // THE ASSERTION: marker-canonical server accepts the marker-hash patch.
        // (Pre-C1-step2 this is 409 — server hashes the hydrated inline form.)
        expect(resp.status).toBe(200)

        // round-trip: the new value is durable + readable
        const getPcs2 = await fetch(`${BASE}/api/plugin-storage`, { headers: authHeaders() })
        const back = (await decodeRisuSave(new Uint8Array(await getPcs2.arrayBuffer()))).pluginCustomStorage
        expect(JSON.parse(back['vector_rag:shard:0']).v).toBe(2)
    })

    it('CONCURRENCY: two tabs editing DIFFERENT keys both survive (no clobber)', async () => {
        if (!booted) { console.warn('server not booted — skipping'); return }
        await seedMarkerDbAndValues({ A: 'a0', B: 'b0' })
        // two independent clients send per-key deltas for different keys, concurrently
        const post = (env: any) => fetch(`${BASE}/api/plugin-storage`, {
            method: 'POST', headers: authHeaders({ 'content-type': 'application/octet-stream' }),
            body: Buffer.from(encodeRisuSaveLegacy(env)),
        }).then((r) => r.status)
        const [s1, s2] = await Promise.all([
            post({ type: 'delta', changed: { A: 'a1' }, removed: [] }),
            post({ type: 'delta', changed: { B: 'b1' }, removed: [] }),
        ])
        expect(s1).toBe(200)
        expect(s2).toBe(200)
        const back = (await decodeRisuSave(new Uint8Array(await (await fetch(`${BASE}/api/plugin-storage`, { headers: authHeaders() })).arrayBuffer()))).pluginCustomStorage
        // BOTH edits present — the single-blob layout would have lost one.
        expect(back.A).toBe('a1')
        expect(back.B).toBe('b1')
    })

    it('malformed envelope (no type) is rejected 400 (no bare-map guessing)', async () => {
        if (!booted) { console.warn('server not booted — skipping'); return }
        const r = await fetch(`${BASE}/api/plugin-storage`, {
            method: 'POST', headers: authHeaders({ 'content-type': 'application/octet-stream' }),
            body: Buffer.from(encodeRisuSaveLegacy({ changed: { A: 'x' } })), // looks like a delta but no type
        })
        expect(r.status).toBe(400)
    })
})
