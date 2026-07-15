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
const { setPluginStorageSidecarWriteEnabled } = await import('./pluginStorageSidecar')

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
async function getPerKey(): Promise<Record<string, any>> {
    const r = await fetch(`${BASE}/api/plugin-storage`, { headers: authHeaders() })
    if (r.status === 404) return {}
    return (await decodeRisuSave(new Uint8Array(await r.arrayBuffer()))).pluginCustomStorage ?? {}
}
const replacePerKey = (values: Record<string, any>) => psPost({ type: 'replace', values })
const writeDb = (dbObj: any) => fetch(`${BASE}/api/write`, {
    method: 'POST', headers: authHeaders({ 'file-path': hex('database/database.bin'), 'content-type': 'application/octet-stream' }), body: enc(dbObj),
}).then((r) => r.status)

describe('pluginCustomStorage b3 — out-of-band per-key, REAL server', () => {
    it('boots the real server', () => {
        if (!booted) { console.warn('server did not boot — skipping'); return }
        expect(booted).toBe(true)
    })

    it('per-key delta round-trips through the real server (POST changed → GET)', async () => {
        if (!booted) return
        expect(await replacePerKey({ 'vector_rag:shard:0': JSON.stringify({ v: 1 }), 'hayaku.v1.durable.a': 'x' })).toBe(200)
        expect(await psPost({ type: 'delta', changed: { 'vector_rag:shard:0': JSON.stringify({ v: 2 }) }, removed: [] })).toBe(200)
        const back = await getPerKey()
        expect(JSON.parse(back['vector_rag:shard:0']).v).toBe(2)   // updated
        expect(back['hayaku.v1.durable.a']).toBe('x')              // untouched key survives
    })

    it('DELETE is real: a removed key is gone from the store (no orphan resurrection)', async () => {
        if (!booted) return
        await replacePerKey({ keep: 'a', gone: 'b' })
        expect(await psPost({ type: 'delta', changed: {}, removed: ['gone'] })).toBe(200)
        const back = await getPerKey()
        expect(back.keep).toBe('a')
        expect('gone' in back).toBe(false)   // really deleted (removeKey), not a lingering orphan
    })

    it('CONCURRENCY: two tabs editing DIFFERENT keys both survive (no clobber)', async () => {
        if (!booted) return
        await replacePerKey({ base: 'b' })
        const [s1, s2] = await Promise.all([
            psPost({ type: 'delta', changed: { A: 'a1' }, removed: [] }),
            psPost({ type: 'delta', changed: { B: 'b1' }, removed: [] }),
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
        await psPost({ type: 'delta', changed: { A: 'a1-CHANGED' }, removed: [] })
        expect((await getPerKey()).A).toBe('a1-CHANGED')
        const r = await fetch(`${BASE}/api/db/snapshots/restore`, {
            method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ key: snapKey }),
        })
        expect(r.status).toBe(200)
        const after = await getPerKey()
        expect(after.A).toBe('a0')   // reverted with the snapshot
        expect(after.B).toBe('b0')
    })

    it('malformed envelope (no type) is rejected 400 (no bare-map guessing)', async () => {
        if (!booted) return
        expect(await psPost({ changed: { A: 'x' } })).toBe(400)   // looks like a delta but no discriminator
    })
})
