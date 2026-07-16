// @vitest-environment node
// Boot-time reconciliation of a backup import that CRASHED mid inlay-swap (DEFECT.md §6 item 4,
// proportionate fix). The import swap is: ensureInlayDir → rename(inlays→backup) →
// rename(staging→inlays) → writeFile(marker) → rm(backup). A hard crash between those steps
// leaves the scratch dirs (save/inlays_import_staging, save/inlays_import_backup) behind, and the
// live save/inlays may be missing. recoverCrashedInlayImport() runs at startup and must reconcile
// WITHOUT ever losing the sole copy of the inlays. Each test pre-seeds a distinct crash state,
// boots a real server, and asserts the on-disk result.
import { describe, it, expect, afterEach, vi } from 'vitest'
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

async function waitFor(pred: () => Promise<boolean>, ms: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < ms) {
        try { if (await pred()) return true } catch {}
        await new Promise((r) => setTimeout(r, 150))
    }
    return false
}

let srv: ChildProcess | null = null
let dir = ''

afterEach(async () => {
    try { srv?.kill('SIGKILL') } catch {}
    srv = null
    try { if (dir) rmSync(dir, { recursive: true, force: true }) } catch {}
    dir = ''
    await new Promise((r) => setTimeout(r, 200)) // let the port free before the next spawn
})

// Pre-seed a save dir, boot a real server (recovery runs before the listener), return the save dir.
async function bootWithSeed(seed: (saveDir: string) => void): Promise<string> {
    dir = mkdtempSync(nodePath.join(tmpdir(), 'prisu-bootrec-'))
    const saveDir = nodePath.join(dir, 'save')
    mkdirSync(saveDir, { recursive: true })
    writeFileSync(nodePath.join(saveDir, '__jwt_secret'), JWT_SECRET, 'utf-8')
    seed(saveDir)
    srv = spawn('node', [SERVER_CJS], {
        cwd: dir,
        env: { ...process.env, PORT: String(PORT), RISU_TUNNEL_DISABLED: 'true', RISU_UPDATE_CHECK: 'false', POCKETRISU_BACKUP_INTERVAL_MS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    const TOKEN = forgeToken()
    const booted = await waitFor(async () => {
        const r = await fetch(`${BASE}/api/read`, { headers: { 'risu-auth': TOKEN, 'file-path': hex('nonexistent/x') } })
        return r.status !== undefined
    }, 15000)
    if (!booted) throw new Error('boot-recovery server did not boot on ' + BASE + ' — likely a blocked 0.0.0.0 bind; run with network access (sandbox disabled).')
    return saveDir
}

describe('backup import — boot recovery of a crashed inlay swap (real server)', () => {
    // Crash AFTER inlays→backup, BEFORE staging→inlays: live dir missing, prior inlays only in backup.
    // Recovery must restore the prior inlays (never lose them) and clear the scratch.
    it('restores the prior inlays from backup when the live dir vanished mid-swap', async () => {
        const saveDir = await bootWithSeed((sd) => {
            mkdirSync(nodePath.join(sd, 'inlays_import_backup'), { recursive: true })
            writeFileSync(nodePath.join(sd, 'inlays_import_backup', 'old.png'), 'OLD')
            mkdirSync(nodePath.join(sd, 'inlays_import_staging'), { recursive: true })
            writeFileSync(nodePath.join(sd, 'inlays_import_staging', 'new.png'), 'NEW')
            // deliberately NO save/inlays
        })
        expect(existsSync(nodePath.join(saveDir, 'inlays_import_staging'))).toBe(false)
        expect(existsSync(nodePath.join(saveDir, 'inlays_import_backup'))).toBe(false)
        expect(existsSync(nodePath.join(saveDir, 'inlays'))).toBe(true)
        expect(readdirSync(nodePath.join(saveDir, 'inlays'))).toContain('old.png')
    }, 30000)

    // Crash on a FIRST-ever import (no prior inlays) BEFORE inlays→backup: no backup, staging holds
    // the new inlays, live dir missing. Recovery must adopt the staged new inlays (not lose them).
    it('adopts the staged inlays when the live dir is missing and there is no backup', async () => {
        const saveDir = await bootWithSeed((sd) => {
            mkdirSync(nodePath.join(sd, 'inlays_import_staging'), { recursive: true })
            writeFileSync(nodePath.join(sd, 'inlays_import_staging', 'new.png'), 'NEW')
            // no inlays_import_backup, no save/inlays
        })
        expect(existsSync(nodePath.join(saveDir, 'inlays_import_staging'))).toBe(false)
        expect(existsSync(nodePath.join(saveDir, 'inlays'))).toBe(true)
        expect(readdirSync(nodePath.join(saveDir, 'inlays'))).toContain('new.png')
    }, 30000)

    // Crash AFTER staging→inlays, BEFORE rm(backup): live dir already holds the new inlays; the
    // backup is redundant. Recovery must keep the live (new) inlays and just clear the scratch.
    it('keeps the already-swapped new inlays and clears the redundant backup', async () => {
        const saveDir = await bootWithSeed((sd) => {
            mkdirSync(nodePath.join(sd, 'inlays'), { recursive: true })
            writeFileSync(nodePath.join(sd, 'inlays', 'new.png'), 'NEW')
            mkdirSync(nodePath.join(sd, 'inlays_import_backup'), { recursive: true })
            writeFileSync(nodePath.join(sd, 'inlays_import_backup', 'old.png'), 'OLD')
        })
        expect(existsSync(nodePath.join(saveDir, 'inlays_import_backup'))).toBe(false)
        expect(existsSync(nodePath.join(saveDir, 'inlays'))).toBe(true)
        const files = readdirSync(nodePath.join(saveDir, 'inlays'))
        expect(files).toContain('new.png')
        expect(files).not.toContain('old.png') // did not clobber with the redundant backup
    }, 30000)
})
