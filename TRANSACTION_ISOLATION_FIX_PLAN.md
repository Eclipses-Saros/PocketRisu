# PocketRisu — core transaction-isolation fix PLAN (Option B)

Companion to [TRANSACTION_ISOLATION_DEFECT.md](TRANSACTION_ISOLATION_DEFECT.md) (the diagnosis).
This is the executable plan for a **separate session**. Self-contained; a fresh session can
follow it. Chosen approach: **Option B — stage the streamed import, then apply it in a single
SYNCHRONOUS transaction** (never hold a DB transaction open across async I/O).

Line anchors are for `server/node/server.cjs` at the time of writing (branch
`feat/plugin-storage-sidecar-write`); re-grep before editing — they will drift.

---

## 0. Principle being restored

Never hold a `better-sqlite3` transaction open across `await` on the single shared
connection, and never toggle a connection-global pragma around an async span. `better-sqlite3`
is synchronous and single-connection: while a `BEGIN` is open across `for await`, any other
request handler that runs during an `await` and issues a synchronous write JOINS that
transaction (ACK-then-erase) and every commit in that window loses `synchronous=NORMAL`
durability.

---

## 1. Current shape of `importBackupFromSource` (server.cjs ~2210–2503)

```
2211  const BATCH_SIZE = 5000
2262  await flushPendingDb()
2263  createBackupAndRotate()
2272  sqliteDb.pragma('synchronous = OFF')          // ← CONNECTION-GLOBAL, remove/scope
2274  sqliteDb.exec('BEGIN')                         // ← raw tx opened...
2275  kvDelPrefix('assets/' | 'inlay/' | 'inlay_thumb/' | 'inlay_meta/' | 'inlay_info/'
2280               | 'coldstorage/' | 'drafts/' | 'remotes/'); kvDel(REMOTE_MIGRATION_MARKER); clearEntities()
2291  for await (const chunk of dataSource) {        // ← ...held across network I/O
          parseBackupChunk(buf, (name, data) => {
              inlay* → writeStagingInlayFileSync(stagingDir)   // ALREADY staged to disk + atomic rename
              name==='pluginStorage.risudat' → capturedPcsBlob = data  // in-memory (added in 2e)
              else → kvSet(resolveBackupStorageKey(name), value)       // ← goes into the open tx
          })
2404      if (batchCount >= BATCH_SIZE) { COMMIT; BEGIN }              // batched, so not even atomic
      }
2420  if (!hasDatabase) throw
2451  kvDelPrefix('pluginStorage/')                                    // (2e) pcs reconcile,
2452  if (sawPcsEntry) { JSON.parse+validate; pluginStoragePerKeyStore.reconcileReplace(...) }  //   inside the tx
2459  sqliteDb.exec('COMMIT')
2461  } catch { ROLLBACK; rm staging } finally { pragma('synchronous = NORMAL') }
2474  fs.rename(stagingDir → inlayDir)               // inlay atomic swap (post-tx)
2493  decodeDatabaseWithPersistentChatIds(...)       // cold-storage migration (post-tx)
2502  checkpointWal('TRUNCATE')
```

Note: inlay files ALREADY use the stage→atomic-rename pattern. Only the KV entries
(`database/database.bin`, `assets/*`, `coldstorage/*`) and the pcs blob are streamed into the
open transaction.

---

## 2. Option B refactor of `importBackupFromSource`

### 2.1 Stage phase (NO transaction open across the stream)
- Delete the `pragma('synchronous = OFF')` at 2272 and the `BEGIN` at 2274. Do NOT clear
  prefixes here.
- Create a connection-local staging table ONCE at the start:
  `sqliteDb.exec('CREATE TEMP TABLE IF NOT EXISTS import_staging (k TEXT PRIMARY KEY, v BLOB)')`
  then `sqliteDb.exec('DELETE FROM import_staging')` (in case of reuse). Temp tables are
  per-connection and dropped on close; they live in SQLite's temp store (disk-backed), so a
  huge backup does not balloon JS heap.
- In the stream callback, replace `kvSet(storageKey, value)` with a staging insert. Keep the
  inlay staging and the in-memory `capturedPcsBlob` capture exactly as they are.
- Batch the staging inserts in SHORT synchronous transactions with NO `await` inside:
  accumulate rows, and every BATCH_SIZE rows do `sqliteDb.transaction(rows => { for (r of rows)
  stagingInsert.run(r.k, r.v) })(batch)`. Between batches (during the stream's `await`) NO
  transaction is open, so concurrent handler writes commit independently.
- Keep the `hasDatabase` / incomplete-entry checks after the loop.
- Alternative staging mechanism (if a temp table is undesirable): temp files under the existing
  staging dir keyed by an encoded name, mirroring the inlay path. Temp table is simpler for KV.

### 2.2 Apply phase (ONE synchronous transaction, NO `await` inside)
Wrap the whole install in `sqliteDb.transaction(() => { ... })()`:
```
sqliteDb.transaction(() => {
    kvDelPrefix('assets/'); kvDelPrefix('inlay/'); ... ; kvDelPrefix('remotes/')
    kvDel(REMOTE_MIGRATION_MARKER_KEY); clearEntities()
    // copy staging → live
    for (const { k, v } of stagingSelectAll.iterate()) kvSet(k, v)
    // pcs (moved from 2451): ALWAYS clear, then reconcile if a blob was captured
    kvDelPrefix('pluginStorage/')
    if (sawPcsEntry) { const d = JSON.parse(capturedPcsBlob...); validate; pluginStoragePerKeyStore.reconcileReplace(d.pluginCustomStorage) }
})()
sqliteDb.exec('DELETE FROM import_staging')   // free the temp rows
```
Because this callback is synchronous, the event loop never runs during it, so NO concurrent
write (endpoint handler OR a debounced save timer) can join it. All-or-nothing: a throw rolls
the whole install back (the prior DB survives). `synchronous` stays at NORMAL (durable); if the
one-shot fsync cost matters, scope `pragma('synchronous = OFF')`/`NORMAL` around ONLY this
synchronous apply (still safe — nothing else runs during it).

### 2.3 Post phase (unchanged)
Inlay dir swap (2474), cold-storage migration (2493), WAL checkpoint (2502) stay after the
apply transaction, exactly as today.

### 2.4 Apply the same shape to the OTHER streaming importers
`clearExistingData` + `importHexFilesFromDir` / `importHexEntries` (save-folder execute/upload,
server.cjs ~4968, ~5060, ~5090) and `/api/backup/server/restore` (~4440) share the pattern.
Audit each for a transaction (or prefix clear) held across an `await`; give each the same
stage→sync-apply treatment or confirm it is already synchronous.

---

## 3. Items this defect spawned — fold into the SAME session

1. **Debounced timer writes** (`saveTimers`, `SAVE_INTERVAL`, server.cjs 3842 / 4771).
   Option B auto-fixes the swallow (no open import tx for a timer to join). VERIFY: after the
   refactor, a timer firing during import commits independently or is correctly ordered; add a
   test that a `/api/write`-scheduled persist during an in-flight import is not lost.
2. **`/api/remove` serialization** (server.cjs 3467): it does a raw `kvDel` outside
   `queueStorageOperation`. Route it through the queue for consistency (low priority once the
   import no longer holds a long tx).
3. **Snapshot restore vs concurrent writes** (server.cjs 5814 `/api/db/snapshots/restore`,
   `restorePluginStorageSnapshotForDb` 5256): it runs inside `queueStorageOperation` + a
   synchronous `sqliteDb.transaction`, so it cannot be interleaved mid-apply; but a plugin
   write QUEUED before it can apply a pre-restore delta afterward (codex R13 F2). Decide: does
   restore need `importInProgress` (reject concurrent pcs mutations) or is queue-ordering
   enough? Add a test.
4. **F3 server-side downgrade guard** (deferred from the pcs work): reject/strip inline pcs in a
   `/api/write` of `database.bin` while the pcs mode is `initialized`, so a flag-off / 500-
   fallback device cannot resurrect a stale inline copy. This needs a decode of the incoming
   blob (hot-path cost) — decide accept-and-strip vs reject-and-signal. The client always-probe
   already prevents a *successfully-booted* device from doing this, so this is defense-in-depth.
5. **Retire pcs write-during-import guard (2f)**: once the import no longer holds a tx across
   async, a pcs write during import commits independently (then the import legitimately
   overwrites it). The `importInProgress` two-point guard in `POST /api/plugin-storage`
   (added as "2f", commit 8721f577) becomes redundant — remove it, or keep as a cheap belt.
6. **F5 (lossless outer keys)**: `kvKeyFor` rejects an outer lone-surrogate key via
   `encodeURIComponent` (fails closed). If lossless-for-every-JSON-key is wanted, encode row
   names from an escaped JSON string / UTF-16 code units with a `PLUGIN_STORAGE_LAYOUT_VERSION`
   bump + migration. Low priority (no real plugin hits it).
7. **Dead marker helpers** in `src/ts/storage/pluginStorageSidecar.ts`
   (buildPluginStorageDirectory / hydratePluginCustomStorage / resolve*ByDirectory /
   validatePluginStorageDirectory / PLUGIN_STORAGE_LAYOUT_VERSION): unused by the rows-as-
   authority client, still referenced by tests. Remove module + tests together.

---

## 4. Test plan (add BEFORE refactoring — pin current behavior, then keep green)

Extend `src/ts/storage/pluginStoragePatchSync.integration.test.ts` (it already boots the real
server) and/or add a server-node test:
- **Round-trip**: export a backup, import it, assert database.bin + assets + coldstorage +
  pcs all restored (baseline for the refactor).
- **Concurrent write during import is not silently lost**: start an import of a large stream
  (throttle the source so it yields), fire a `/api/write` (or `/api/plugin-storage`) mid-stream,
  and assert the ACK is truthful — the write either survives or is deterministically overwritten
  by the import, never "ACKed then erased inside the import's tx". This is the regression the
  whole fix targets; it must FAIL before the refactor and PASS after.
- **Atomic apply**: force the apply to throw (e.g. a malformed pcs blob) and assert the prior DB
  is fully intact (no partial import).
- **Debounced timer during import** (item 3.1).
- Keep all existing pcs tests green (156 at time of writing).

---

## 5. Risks / rollback
- Backup import is critical and complex (streaming, batching, inlay staging, cold-storage). The
  refactor is behavior-preserving for the success path; the risk is edge cases (very large
  backups, temp-store disk pressure). Mitigate with the round-trip + atomicity tests first.
- `PRAGMA temp_store` / temp-dir disk space: a multi-GB backup stages ~its size in the temp
  store. Confirm the temp store has room (same disk-space preflight the restore path already
  does at ~4465).
- Rollback: the change is contained to the importer functions; revert the commit to restore the
  streaming-into-open-tx behavior if a regression appears.

---

## 6. Definition of done
- No DB transaction is held open across an `await` anywhere in server.cjs (grep BEGIN/COMMIT and
  every `sqliteDb.transaction(` — confirm each callback is synchronous).
- No connection-global pragma toggled around an async span.
- The concurrent-write-during-import test passes (truthful ACK).
- Items 3.1–3.5 addressed or explicitly re-deferred with reasons.
- Independent review (codex, neutral data-integrity framing) GO + full suite green.
