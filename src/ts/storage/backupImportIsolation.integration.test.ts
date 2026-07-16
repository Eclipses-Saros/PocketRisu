// @vitest-environment node
// REAL-ENVIRONMENT integration test pinning the transaction-isolation contract of
// the streaming backup importer (importBackupFromSource in server/node/server.cjs).
//
// See TRANSACTION_ISOLATION_DEFECT.md / TRANSACTION_ISOLATION_FIX_PLAN.md.
//
// The defect: importBackupFromSource holds a raw `BEGIN` open across `for await`
// on the stream, on the single synchronous better-sqlite3 connection. A concurrent
// request handler that issues a synchronous write DURING one of those awaits joins
// the import's open transaction — it is ACKed to its client but then rolled back
// with the import if the import fails. The ACK is a lie.
//
// These tests boot the ACTUAL server against a throwaway SQLite dir and drive the
// REAL protocol. They live in their OWN server (own port + temp dir) because a
// backup import WIPES the DB — keeping them out of the pcs patch-sync suite.
//
// Test 3 (concurrent write) is the REGRESSION this whole fix targets: it must FAIL
// before the stage->sync-apply refactor and PASS after. The others (round-trip,
// atomic rollback) pin behavior that must stay green across the refactor.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import nodeCrypto from 'node:crypto'
import nodeHttp from 'node:http'

// Same mocks as pluginStoragePatchSync.integration.test.ts so importing risuSave stays pure.
vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({ chatToStub: (c: any) => c }))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))

const { encodeRisuSaveLegacy, decodeRisuSave } = await import('./risuSave')

const SERVER_CJS = nodePath.resolve(__dirname, '../../../server/node/server.cjs')
const PORT = 6789
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const JWT_SECRET = 'backup-isolation-test-secret'
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
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
    dir = mkdtempSync(nodePath.join(tmpdir(), 'prisu-backupiso-'))
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
    // HARD FAIL (do NOT skip) if the server never booted. This file is the regression
    // gate for the transaction-isolation fix; a `if (!booted) return` skip would let a
    // no-boot environment (e.g. a sandbox that blocks the 0.0.0.0 bind) turn every test
    // into a silent no-op pass and mask a real regression. If you see this, run the test
    // with network access / the command sandbox disabled.
    if (!booted) {
        throw new Error(
            'backup-import isolation server did not boot on ' + BASE +
            ' — likely a blocked 0.0.0.0 bind. Run with network access (sandbox disabled). ' +
            'Refusing to skip so a no-boot run cannot mask the regression.'
        )
    }
}, 30000)

afterAll(async () => {
    try { srv?.kill('SIGKILL') } catch {}
    try { if (dir) rmSync(dir, { recursive: true, force: true }) } catch {}
})

const enc = (o: any) => Buffer.from(encodeRisuSaveLegacy(o))

const writeDb = (dbObj: any) => fetch(`${BASE}/api/write`, {
    method: 'POST', headers: authHeaders({ 'file-path': hex('database/database.bin'), 'content-type': 'application/octet-stream' }), body: enc(dbObj),
}).then((r) => r.status)

async function readDb(): Promise<any> {
    const r = await fetch(`${BASE}/api/read`, { headers: authHeaders({ 'file-path': hex('database/database.bin') }) })
    return decodeRisuSave(new Uint8Array(await r.arrayBuffer()))
}

// pluginCustomStorage travels as a JSON string in the envelope; GET returns the map.
const psPost = (env: any) => fetch(`${BASE}/api/plugin-storage`, {
    method: 'POST', headers: authHeaders({ 'content-type': 'application/octet-stream' }), body: enc(env),
}).then((r) => r.status)
const replacePerKey = (values: Record<string, any>) => psPost({ type: 'replace', json: JSON.stringify(values) })
const psDelta = (changed: Record<string, any>, removed: string[] = []) => psPost({ type: 'delta', json: JSON.stringify({ changed, removed }) })
async function getPerKey(): Promise<Record<string, any>> {
    const r = await fetch(`${BASE}/api/plugin-storage`, { headers: authHeaders() })
    if (r.status === 404) return {}
    return JSON.parse(await r.text()).pluginCustomStorage ?? {}
}

// Arbitrary KV key OUTSIDE every prefix the import clears (assets/, inlay*, coldstorage/,
// drafts/, remotes/, pluginStorage/, database/) and outside the entity tables. Its value
// therefore changes ONLY because a write actually committed — never because the import
// touched it — so a rollback that erases it is unambiguously a swallowed concurrent write.
const CANARY_KEY = 'testonly/canary'
const writeCanary = (val: string) => fetch(`${BASE}/api/write`, {
    method: 'POST', headers: authHeaders({ 'file-path': hex(CANARY_KEY), 'content-type': 'application/octet-stream' }), body: Buffer.from(val, 'utf-8'),
}).then((r) => r.status)
async function readCanary(): Promise<string | null> {
    const r = await fetch(`${BASE}/api/read`, { headers: authHeaders({ 'file-path': hex(CANARY_KEY) }) })
    if (r.status === 404) return null
    return Buffer.from(await r.arrayBuffer()).toString('utf-8')
}

function encodeBackupEntry(name: string, data: Buffer): Buffer {
    const encodedName = Buffer.from(name, 'utf-8')
    const nameLen = Buffer.alloc(4); nameLen.writeUInt32LE(encodedName.length, 0)
    const dataLen = Buffer.alloc(4); dataLen.writeUInt32LE(data.length, 0)
    return Buffer.concat([nameLen, encodedName, dataLen, data])
}

// Fetch a full backup blob (nodeonly target carries pcs as pluginStorage.risudat).
async function exportBackup(): Promise<Buffer> {
    const r = await fetch(`${BASE}/api/backup/export`, { headers: authHeaders() })
    return Buffer.from(await r.arrayBuffer())
}

// Import a fully-buffered backup blob (normal, non-throttled path).
async function importBackup(blob: Buffer): Promise<number> {
    const r = await fetch(`${BASE}/api/backup/import`, {
        method: 'POST', headers: authHeaders({ 'content-type': 'application/octet-stream' }), body: blob,
    })
    return r.status
}

// Open a streaming import request whose body WE feed incrementally over node:http, so we
// can hold the server parked mid-`for await` (transaction open) and fire other requests.
function openStreamingImport(): { req: nodeHttp.ClientRequest; done: Promise<{ status: number; body: string }> } {
    let resolveDone!: (v: { status: number; body: string }) => void
    let rejectDone!: (e: any) => void
    const done = new Promise<{ status: number; body: string }>((res, rej) => { resolveDone = res; rejectDone = rej })
    const req = nodeHttp.request({
        host: HOST, port: PORT, method: 'POST', path: '/api/backup/import',
        headers: { 'risu-auth': TOKEN, 'content-type': 'application/octet-stream' },
    }, (res) => {
        let body = ''
        res.on('data', (c) => { body += c.toString() })
        res.on('end', () => resolveDone({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', rejectDone)
    return { req, done }
}

describe('backup import — transaction isolation (real server)', () => {
    it('boots the real server', () => {
        expect(booted).toBe(true)
    })

    it('ROUND-TRIP: export → mutate → import restores database.bin + pcs (baseline)', async () => {
        // seed a known state
        expect(await writeDb({ formatversion: 4, characters: [], botPresets: [], modules: [], plugins: [], customCSS: 'ROUND-TRIP-A' })).toBe(200)
        expect(await replacePerKey({ k: 'RTA', other: 'keep' })).toBe(200)

        const blob = await exportBackup()
        expect(blob.length).toBeGreaterThan(0)

        // mutate live away from the exported state
        expect(await writeDb({ formatversion: 4, characters: [], botPresets: [], modules: [], plugins: [], customCSS: 'MUTATED' })).toBe(200)
        expect(await replacePerKey({ k: 'MUTATED' })).toBe(200)

        // importing the blob must restore the exported state exactly
        expect(await importBackup(blob)).toBe(200)
        expect((await readDb()).customCSS).toBe('ROUND-TRIP-A')
        expect(await getPerKey()).toEqual({ k: 'RTA', other: 'keep' })
    }, 30000)

    // TRUTHFUL CONCURRENCY via serialization. The import's destructive install is a single
    // queueStorageOperation, and every mutator runs through that same storage queue, so a
    // concurrent write can never be erased mid-flight: it either completes before the install
    // (a SUCCEEDING import then legitimately supersedes it) or after it (on the imported state).
    // Here the import FAILS (no database.risudat), so its install never runs and the write it
    // ACKed (200) SURVIVES — a truthful ACK, not the old tx-join rollback-erase, and no 503.
    it('CONCURRENCY: an /api/write ACKed during a FAILING import survives (not erased)', async () => {
        expect(await writeCanary('before')).toBe(200)
        const { req, done } = openStreamingImport()
        let importStatus = 0
        try {
            req.write(encodeBackupEntry('some-asset', Buffer.from('asset-bytes')))
            await delay(300) // import parked mid-stream; the queue is free, so the write runs
            expect(await writeCanary('after')).toBe(200) // accepted (no exclusion) and committed
        } finally {
            try { req.end() } catch {}
            importStatus = (await done.catch(() => ({ status: 0 }))).status
        }
        expect(importStatus).not.toBe(200) // the import itself failed (no database.risudat)
        expect(await readCanary()).toBe('after') // survived — the failed import's install never ran
    }, 30000)

    it('CONCURRENCY(pcs): a plugin-storage write ACKed during a FAILING import survives', async () => {
        await replacePerKey({ p: 'before' }) // initialize the store (a legacy store rejects deltas)
        const { req, done } = openStreamingImport()
        try {
            req.write(encodeBackupEntry('some-asset', Buffer.from('asset-bytes')))
            await delay(300)
            expect(await psDelta({ p: 'DURING' }, [])).toBe(200) // accepted, not 503
        } finally {
            try { req.end() } catch {}
            await done.catch(() => {})
        }
        expect((await getPerKey()).p).toBe('DURING') // survived the failed import
    }, 30000)

    // A SUCCEEDING import atomically supersedes a concurrent write. The write is fired mid-stream,
    // so it queues BEFORE the install (which is enqueued at end-of-stream): it commits, then the
    // install clears + restores the backup's state on top. The final state is the imported one —
    // the concurrent edit is superseded as one clean atomic transition, never a half-applied mix.
    it('SUPERSEDE: a concurrent write during a SUCCEEDING import is superseded by the import', async () => {
        await replacePerKey({ k: 'IMPORTED' })
        expect(await writeDb({ formatversion: 4, characters: [], botPresets: [], modules: [], plugins: [], customCSS: 'IMPORTED' })).toBe(200)
        const blob = await exportBackup() // captures pcs {k:'IMPORTED'} + db customCSS 'IMPORTED'
        expect(blob.length).toBeGreaterThan(0)

        const { req, done } = openStreamingImport()
        try {
            const half = Math.floor(blob.length / 2)
            req.write(blob.subarray(0, half))
            await delay(300) // mid-stream: a concurrent pcs write queues BEFORE the install
            expect(await psDelta({ k: 'CONCURRENT-EDIT' }, [])).toBe(200)
            req.write(blob.subarray(half))
        } finally {
            try { req.end() } catch {}
        }
        const result = await done
        expect(result.status).toBe(200) // the import succeeded
        expect((await getPerKey()).k).toBe('IMPORTED') // install (queued after the write) superseded it
    }, 30000)

    // ATOMICITY of the DB/PCS pair. The original importer reconciled pcs in the SAME
    // transaction as database.bin, so a malformed pcs blob threw before COMMIT and left the
    // prior DB + prior pcs intact (never new-DB paired with the prior account's plugin rows).
    // The per-batch refactor committed database.bin first and validated pcs later, so a
    // malformed pcs after a valid DB left new-DB + old-pcs — cross-account contamination.
    // This FAILS today (customCSS becomes the new value) and passes once the apply validates
    // pcs BEFORE any destructive write and commits db.bin + pcs together.
    it('ATOMICITY(pair): malformed pcs after a valid DB leaves prior database.bin + pcs intact', async () => {
        expect(await writeDb({ formatversion: 4, characters: [], botPresets: [], modules: [], plugins: [], customCSS: 'PRIOR-DB' })).toBe(200)
        expect(await replacePerKey({ survivor: 'prior-pcs' })).toBe(200)

        // Valid database.risudat FOLLOWED by a malformed pluginStorage.risudat.
        const validDb = enc({ formatversion: 4, characters: [], botPresets: [], modules: [], plugins: [], customCSS: 'NEW-DB' })
        const badPcs = Buffer.from('{ this is not valid json', 'utf8')
        const backup = Buffer.concat([
            encodeBackupEntry('database.risudat', validDb),
            encodeBackupEntry('pluginStorage.risudat', badPcs),
        ])
        expect(await importBackup(backup)).not.toBe(200) // import fails on the malformed pcs

        // Atomic: neither the DB nor the pcs moved — no new-DB/old-pcs split.
        expect((await readDb()).customCSS).toBe('PRIOR-DB')
        expect(await getPerKey()).toEqual({ survivor: 'prior-pcs' })
    }, 30000)

    it('ATOMICITY: a failed import leaves the prior database.bin + pcs fully intact', async () => {
        expect(await writeDb({ formatversion: 4, characters: [], botPresets: [], modules: [], plugins: [], customCSS: 'PRIOR-DB' })).toBe(200)
        expect(await replacePerKey({ survivor: 'prior-pcs' })).toBe(200)

        // A backup with an asset but no database.risudat fails the hasDatabase check → ROLLBACK.
        const bad = encodeBackupEntry('some-asset', Buffer.from('x'))
        expect(await importBackup(bad)).not.toBe(200)

        expect((await readDb()).customCSS).toBe('PRIOR-DB')
        expect(await getPerKey()).toEqual({ survivor: 'prior-pcs' })
    }, 30000)
})
