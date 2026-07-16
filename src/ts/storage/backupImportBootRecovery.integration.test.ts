// @vitest-environment node
// Boot-time reconciliation of a backup import that CRASHED mid inlay-swap (DEFECT.md §6 item 4,
// proportionate fix). The import stages new inlays in save/inlays_import_staging and parks the
// prior inlays in save/inlays_import_backup while swapping them into save/inlays. A hard crash
// mid-swap leaves those scratch dirs behind (and possibly no live save/inlays). recoverCrashedInlayImport()
// runs at startup: it restores the pre-import inlays if the live dir vanished, then clears the
// scratch dirs so nothing leaks. This pins that: pre-seed a crashed-mid-swap state, boot, assert.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import nodeCrypto from 'node:crypto'

vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({ chatToStub: (c: any) => c }))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))

const SERVER_CJS = nodePath.resolve(__dirname, '../../../server/node/server.cjs')
const PORT = 6790
const BASE = `http://127.0.0.1:${PORT}`
const JWT_SECRET = 'boot-recovery-test-secret'
const hex = (s: string) => Buffer.from(s, 'utf-8').toString('hex')

function forgeToken(): string {
    const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const header = b64({ alg: 'HS256', typ: 'JWT' })
    const payload = b64({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })
    const sig = nodeCrypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url')
    return `${header}.${payload}.${sig}`
}

let srv: ChildProcess | null = null
let dir = ''
let saveDir = ''
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
    dir = mkdtempSync(nodePath.join(tmpdir(), 'prisu-bootrec-'))
    saveDir = nodePath.join(dir, 'save')
    mkdirSync(saveDir, { recursive: true })
    writeFileSync(nodePath.join(saveDir, '__jwt_secret'), JWT_SECRET, 'utf-8')

    // Pre-seed a CRASHED-MID-SWAP state: prior inlays parked in the backup dir, new inlays in the
    // staging dir, and NO live save/inlays (the crash happened after "inlays → backup", before
    // "staging → inlays"). Recovery must restore the backup as save/inlays and clear the scratch.
    mkdirSync(nodePath.join(saveDir, 'inlays_import_backup'), { recursive: true })
    writeFileSync(nodePath.join(saveDir, 'inlays_import_backup', 'old.png'), 'OLD')
    mkdirSync(nodePath.join(saveDir, 'inlays_import_staging'), { recursive: true })
    writeFileSync(nodePath.join(saveDir, 'inlays_import_staging', 'new.png'), 'NEW')
    // deliberately NO save/inlays

    srv = spawn('node', [SERVER_CJS], {
        cwd: dir,
        env: { ...process.env, PORT: String(PORT), RISU_TUNNEL_DISABLED: 'true', RISU_UPDATE_CHECK: 'false', POCKETRISU_BACKUP_INTERVAL_MS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    const TOKEN = forgeToken()
    booted = await waitFor(async () => {
        const r = await fetch(`${BASE}/api/read`, { headers: { 'risu-auth': TOKEN, 'file-path': hex('nonexistent/x') } })
        return r.status !== undefined
    }, 15000)
    if (!booted) {
        throw new Error('boot-recovery server did not boot on ' + BASE + ' — likely a blocked 0.0.0.0 bind; run with network access (sandbox disabled).')
    }
    // recoverCrashedInlayImport runs in startServer BEFORE the listener, so by now it has run.
}, 30000)

afterAll(async () => {
    try { srv?.kill('SIGKILL') } catch {}
    try { if (dir) rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe('backup import — boot recovery of a crashed inlay swap (real server)', () => {
    it('restores the pre-import inlays and clears the scratch dirs', () => {
        expect(booted).toBe(true)
        // Scratch dirs cleared.
        expect(existsSync(nodePath.join(saveDir, 'inlays_import_staging'))).toBe(false)
        expect(existsSync(nodePath.join(saveDir, 'inlays_import_backup'))).toBe(false)
        // Live inlays restored from the backup (prior inlays never lost outright).
        expect(existsSync(nodePath.join(saveDir, 'inlays'))).toBe(true)
        expect(readdirSync(nodePath.join(saveDir, 'inlays'))).toContain('old.png')
    })
})
