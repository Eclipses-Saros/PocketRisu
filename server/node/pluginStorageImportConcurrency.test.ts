import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import perKey from './pluginStoragePerKeyStore.cjs'

const { createPluginStoragePerKeyStore } = perKey as any

// A faithful KV-over-SQLite adapter mirroring server.cjs (kvGet/kvSet/kvDel/kvList +
// transaction = db.transaction(fn)()). Using a REAL better-sqlite3 connection is the
// only way to reproduce the hazard the guard defends against: a store mutation issued
// while an import holds a transaction OPEN runs as a nested SAVEPOINT inside it, so the
// import's later prefix clear erases the "committed" write before the outer COMMIT.
function realSqliteKv() {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB)')
    const getStmt = db.prepare('SELECT value FROM kv WHERE key = ?')
    const setStmt = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    const delStmt = db.prepare('DELETE FROM kv WHERE key = ?')
    const listStmt = db.prepare('SELECT key FROM kv WHERE key >= ? AND key < ?')
    const upper = (p: string) => p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1)
    const kv = {
        db,
        get: (k: string) => { const r = getStmt.get(k) as any; return r ? Buffer.from(r.value) : null },
        set: (k: string, v: Buffer) => { setStmt.run(k, v) },
        del: (k: string) => { delStmt.run(k) },
        listPrefix: (p: string) => (listStmt.all(p, upper(p)) as any[]).map((r) => r.key),
        transaction: (fn: () => any) => db.transaction(fn)(),
    }
    const delPrefix = (p: string) => { for (const k of kv.listPrefix(p)) kv.del(k) }
    return { kv, delPrefix }
}

describe('pluginStorage import-vs-mutation concurrency guard (SSOT 2f, codex R12)', () => {
    // HAZARD (proves the test has teeth): a write applied while the import transaction is
    // OPEN is erased by the import's unconditional prefix clear before COMMIT — exactly
    // the "ACK a write we cannot keep" silent loss.
    it('HAZARD: a store write inside an open import transaction is erased by the final clear', async () => {
        const { kv, delPrefix } = realSqliteKv()
        const store = createPluginStoragePerKeyStore(kv)
        store.initializeFromMap({ existing: 'v0' })

        // Model an import that holds a raw BEGIN across "stream reads", during which an
        // UNGUARDED plugin write lands (as a savepoint), then the import clears + commits.
        kv.db.exec('BEGIN')
        store.applyDelta({ changed: { racer: 'ACKED-then-lost' } })   // savepoint inside the import tx
        expect(await store.readKey('racer')).toBe('ACKED-then-lost')  // visible pre-commit (would ACK)
        delPrefix('pluginStorage/')                                   // import's unconditional clear
        store.reconcileReplace({ imported: 'fromBackup' })            // import installs the backup's map
        kv.db.exec('COMMIT')

        // The "successful" write is gone — the client was lied to.
        expect(await store.readKey('racer')).toBeUndefined()
        expect(await store.readAll()).toEqual({ imported: 'fromBackup' })
    })

    // GUARD: the handler refuses a write while importInProgress is set, so the mutator is
    // never called inside the import's transaction — no write is ACKed that the import
    // would erase. Models the two-point check in POST /api/plugin-storage.
    it('GUARD: importInProgress refuses the write (mutator not called), store keeps the import result', async () => {
        const { kv, delPrefix } = realSqliteKv()
        const store = createPluginStoragePerKeyStore(kv)
        store.initializeFromMap({ existing: 'v0' })

        let importInProgress = false
        // The exact guard the endpoint applies before touching the store.
        function guardedWrite(changed: Record<string, string>): { ok: boolean; status?: number } {
            if (importInProgress) return { ok: false, status: 503 } // handler-entry + TOCTOU re-check
            store.applyDelta({ changed })
            return { ok: true }
        }

        // A write BEFORE the import commits durably and truthfully.
        expect(guardedWrite({ before: 'kept' }).ok).toBe(true)

        // Import starts: flag set BEFORE the transaction opens (as every lifecycle path does).
        importInProgress = true
        kv.db.exec('BEGIN')
        // A racing write arrives during the open import transaction → refused, never applied.
        const racing = guardedWrite({ racer: 'never-applied' })
        expect(racing.ok).toBe(false)
        expect(racing.status).toBe(503)
        delPrefix('pluginStorage/')
        store.reconcileReplace({ imported: 'fromBackup' })
        kv.db.exec('COMMIT')
        importInProgress = false

        // No phantom ACK: the refused write was never in the store; the import result stands.
        expect(await store.readKey('racer')).toBeUndefined()
        expect(await store.readAll()).toEqual({ imported: 'fromBackup' })

        // After the import, writes work again (against the new state).
        expect(guardedWrite({ after: 'ok' } as any).ok).toBe(true)
        expect(await store.readKey('after')).toBe('ok')
    })
})
