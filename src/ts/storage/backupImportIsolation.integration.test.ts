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

    // TRUTHFUL CONCURRENCY (exclusion). A CAS-less write has no way to detect that the
    // whole store is being replaced under it, so a 200 during an import would be a lie:
    // a successful import silently supersedes it, and a failed partial import can erase it.
    // The truthful contract is MUTUAL EXCLUSION — a write during an in-flight import is
    // REJECTED (503) so the client retries and rebases against the imported state. This
    // FAILS today (the importer does not serialize against mutators, so the write returns
    // 200) and passes once every mutator refuses while importInProgress.
    it('EXCLUSION: an /api/write during an in-flight import is rejected 503 (not a silent 200)', async () => {
        expect(await writeCanary('before')).toBe(200)
        expect(await readCanary()).toBe('before')

        const { req, done } = openStreamingImport()
        try {
            // Feed one complete asset entry so the importer enters its stream loop;
            // importInProgress is set at handler entry, so it is already true here.
            req.write(encodeBackupEntry('some-asset', Buffer.from('asset-bytes')))
            await delay(300) // let the server park mid-stream with importInProgress = true
            // The write must be REFUSED, not accepted-then-superseded/erased.
            expect(await writeCanary('after')).toBe(503)
        } finally {
            // ALWAYS end the stream, even if an assertion above threw — otherwise the import
            // stays parked with importInProgress=true and poisons later tests (409s / false pass).
            try { req.end() } catch {}
            await done.catch(() => {})
        }
        // The prior value is intact: the refused write never applied, and the failed import
        // (no database.risudat) rolled back without touching testonly/.
        expect(await readCanary()).toBe('before')
    }, 30000)

    // Same contract for pcs (which has NO CAS at all). A pcs write during an import must be
    // 503-refused, not silently accepted. This is the case my earlier item-5 removal of the
    // "2f" guard broke: without exclusion a pcs delta returns 200 and is then wiped by a
    // successful import's pluginStorage/ reconcile — a silent supersede the client can't see.
    it('EXCLUSION(pcs): a plugin-storage write during an in-flight import is rejected 503', async () => {
        await replacePerKey({ p: 'before' }) // initialize the store (a legacy store rejects deltas)
        expect((await getPerKey()).p).toBe('before')

        const { req, done } = openStreamingImport()
        try {
            req.write(encodeBackupEntry('some-asset', Buffer.from('asset-bytes')))
            await delay(300) // import parks mid-stream, importInProgress = true
            // Refused, not accepted. Under the removed guard this returned 200 (silent supersede).
            expect(await psDelta({ p: 'DURING' }, [])).toBe(503)
        } finally {
            try { req.end() } catch {}
            await done.catch(() => {})
        }
        expect((await getPerKey()).p).toBe('before') // unchanged — the write was refused
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
