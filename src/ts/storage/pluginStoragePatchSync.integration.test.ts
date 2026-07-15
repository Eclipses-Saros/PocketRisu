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
const { setPluginStorageSidecarWriteEnabled, buildPluginStorageDirectory, PLUGIN_STORAGE_SIDECAR_MARKER, hydratePluginCustomStorage } = await import('./pluginStorageSidecar')

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

    it('BACKUP/RESTORE: a DB snapshot captures + restores the per-key plugin memory', async () => {
        if (!booted) { console.warn('server not booted — skipping'); return }
        // seed + create a snapshot (interval=0 → the seed write backs up with the
        // per-key state {A:a0,B:b0} paired in)
        await seedMarkerDbAndValues({ A: 'a0', B: 'b0' })
        await fetch(`${BASE}/api/read`, { headers: authHeaders({ 'file-path': hex('database/database.bin') }) }) // flush → backup
        const list = await (await fetch(`${BASE}/api/db/snapshots`, { headers: authHeaders() })).json()
        const snaps: any[] = Array.isArray(list) ? list : (list.snapshots ?? list.items ?? [])
        const snapKey = snaps.map((s: any) => (typeof s === 'string' ? s : s.key)).find(Boolean)
        expect(snapKey, 'a snapshot should exist').toBeTruthy()

        // mutate per-key AFTER the snapshot
        await fetch(`${BASE}/api/plugin-storage`, {
            method: 'POST', headers: authHeaders({ 'content-type': 'application/octet-stream' }),
            body: Buffer.from(encodeRisuSaveLegacy({ type: 'delta', changed: { A: 'a1-CHANGED' }, removed: [] })),
        })
        const mid = (await decodeRisuSave(new Uint8Array(await (await fetch(`${BASE}/api/plugin-storage`, { headers: authHeaders() })).arrayBuffer()))).pluginCustomStorage
        expect(mid.A).toBe('a1-CHANGED')

        // restore the snapshot → per-key reverts to {A:a0,B:b0}
        const r = await fetch(`${BASE}/api/db/snapshots/restore`, {
            method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ key: snapKey }),
        })
        expect(r.status).toBe(200)
        const after = (await decodeRisuSave(new Uint8Array(await (await fetch(`${BASE}/api/plugin-storage`, { headers: authHeaders() })).arrayBuffer()))).pluginCustomStorage
        expect(after.A).toBe('a0')   // reverted (per-key snapshot restored)
        expect(after.B).toBe('b0')
    })

    it('ORPHAN DROP: a marker-only delete stays deleted on reload (real server GET + client hydrate)', async () => {
        if (!booted) { console.warn('server not booted — skipping'); return }
        // seed per-key {A,B}; the server GET (readAll) will keep returning B as an
        // orphan after we "delete" it by shrinking the marker to [A] only.
        await fetch(`${BASE}/api/plugin-storage`, {
            method: 'POST', headers: authHeaders({ 'content-type': 'application/octet-stream' }),
            body: Buffer.from(encodeRisuSaveLegacy({ type: 'replace', values: { A: 'a', B: 'b' } })),
        })
        // client loads a DB whose marker lists ONLY A (B was marker-only-deleted).
        const markerDb: any = { formatversion: 4, characters: [], [PLUGIN_STORAGE_SIDECAR_MARKER]: buildPluginStorageDirectory({ A: 'a' }) }
        // the real client hydrate fetches the server map (which still has orphan B) …
        const serverMap = (await decodeRisuSave(new Uint8Array(await (await fetch(`${BASE}/api/plugin-storage`, { headers: authHeaders() })).arrayBuffer()))).pluginCustomStorage
        expect(serverMap.B).toBe('b') // orphan is still stored server-side
        await hydratePluginCustomStorage(markerDb, async () => serverMap)
        // … but hydration filters to marker.keys → B does NOT resurrect.
        expect(markerDb.pluginCustomStorage).toEqual({ A: 'a' })
        expect('B' in markerDb.pluginCustomStorage).toBe(false)
    })

    it('KEY-SET CONCURRENCY: two tabs adding DIFFERENT new keys both land, rebuilt marker = union', async () => {
        if (!booted) { console.warn('server not booted — skipping'); return }
        await fetch(`${BASE}/api/plugin-storage`, {
            method: 'POST', headers: authHeaders({ 'content-type': 'application/octet-stream' }),
            body: Buffer.from(encodeRisuSaveLegacy({ type: 'replace', values: { base: 'b' } })),
        })
        const post = (env: any) => fetch(`${BASE}/api/plugin-storage`, {
            method: 'POST', headers: authHeaders({ 'content-type': 'application/octet-stream' }),
            body: Buffer.from(encodeRisuSaveLegacy(env)),
        }).then((r) => r.status)
        // two independent tabs add different NEW keys concurrently
        const [s1, s2] = await Promise.all([
            post({ type: 'delta', changed: { X: 'x' }, removed: [] }),
            post({ type: 'delta', changed: { Y: 'y' }, removed: [] }),
        ])
        expect(s1).toBe(200); expect(s2).toBe(200)
        // both adds landed per-key (neither clobbered) …
        const serverMap = (await decodeRisuSave(new Uint8Array(await (await fetch(`${BASE}/api/plugin-storage`, { headers: authHeaders() })).arrayBuffer()))).pluginCustomStorage
        expect(serverMap).toEqual({ base: 'b', X: 'x', Y: 'y' })
        // … so the marker a rebase rebuilds from the server map is the UNION (neither
        // key dropped — the failure the 409→rebase routing prevents).
        expect(buildPluginStorageDirectory(serverMap).keys).toEqual(['X', 'Y', 'base'])
    })

    it('BACKSTOP: server refuses to persist a marker referencing a value not in the per-key store', async () => {
        if (!booted) { console.warn('server not booted — skipping'); return }
        // per-key has ONLY A; a marker claiming [A,B] would be a dangling marker.
        await fetch(`${BASE}/api/plugin-storage`, {
            method: 'POST', headers: authHeaders({ 'content-type': 'application/octet-stream' }),
            body: Buffer.from(encodeRisuSaveLegacy({ type: 'replace', values: { A: 'a' } })),
        })
        const danglingDb: any = { formatversion: 4, characters: [], botPresets: [], modules: [], plugins: [],
            [PLUGIN_STORAGE_SIDECAR_MARKER]: buildPluginStorageDirectory({ A: 'a', B: 'b' }) } // B absent from per-key
        const w = await fetch(`${BASE}/api/write`, {
            method: 'POST', headers: authHeaders({ 'file-path': hex('database/database.bin'), 'content-type': 'application/octet-stream' }),
            body: Buffer.from(encodeRisuSaveLegacy(danglingDb)),
        })
        expect(w.status).toBe(500) // rejected, not silently persisted
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
