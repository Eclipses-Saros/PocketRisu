# PocketRisu — core transaction-isolation fix PLAN

Companion to [TRANSACTION_ISOLATION_DEFECT.md](TRANSACTION_ISOLATION_DEFECT.md) (the diagnosis).
This is the executable plan for a **separate session**. Self-contained; a fresh session can
follow it. Chosen approach: **never hold a DB transaction open across async I/O** — flush the
streamed import in per-batch SYNCHRONOUS transactions using the EXISTING chunk-aware `kvSet`.
(An earlier draft proposed a raw-BLOB staging table for whole-import atomicity; that
reintroduces the BLOB bind limit chunkStore removes — see §1a. Atomicity is a non-goal, §2.3.)

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

### 1a. CRITICAL CONSTRAINT — chunkStore is DB-blob-only (do NOT stage a raw BLOB)

`kvSet` chunks ONLY `database/database.bin` (`db.cjs:118` → `chunkStore.putValue` iff
`key === DB_BLOB_KEY`); every other key is a raw `INSERT INTO kv`. chunkStore exists precisely
so "no single SQLite value exceeds the BLOB bind limit" (`chunkStore.cjs`, threshold 16MB): a
heavy user's `database.bin` is >16MB and MUST be chunked. Assets/coldstorage/pcs rows are
small and go in raw.

Therefore a generic **`CREATE TEMP TABLE import_staging(k, v BLOB)` + raw `INSERT` would put
`database.bin` in ONE raw BLOB row and REINTRODUCE the exact bind limit chunkStore removes.**
(An earlier draft of this plan proposed that — it is wrong.) Any staging of `database.bin`
must go through the chunk-aware path, or `database.bin` must not be staged as a raw value at
all. This constraint is why §2 uses per-batch synchronous transactions with the EXISTING
chunk-aware `kvSet` rather than a raw staging table.

---

## 2. Refactor of `importBackupFromSource` (per-batch synchronous transactions)

The DEFECT is the tx held open across the stream's `await`s plus the connection-global pragma —
NOT a lack of whole-import atomicity (the import was already non-atomic: it commits every
BATCH_SIZE entries). So the root fix keeps the existing chunk-aware `kvSet` and only changes
WHEN a transaction is open: never across an `await`.

### 2.1 Stream phase — no transaction open across an `await`
- Delete `pragma('synchronous = OFF')` at 2272 (it is connection-global — it weakens EVERY
  other handler's durability for the whole import). Delete the single `BEGIN` at 2274 and the
  mid-stream `COMMIT; BEGIN` at 2404–2406.
- Keep buffering each entry as today (`parseBackupChunk` hands the full entry bytes to the
  callback). Accumulate ready entries into an in-memory batch list of `{ apply: () => void }`
  thunks (or `{storageKey, value}` records), NOT into a raw BLOB table. Keep the inlay staging
  and the in-memory `capturedPcsBlob` capture unchanged.
- When the batch reaches BATCH_SIZE (or `database/database.bin` is in it — flush promptly so
  the big blob isn't held with others), flush it in ONE SYNCHRONOUS transaction that uses the
  EXISTING chunk-aware `kvSet` (so `database.bin` still chunks, everything else is a raw row):
  `sqliteDb.transaction(recs => { for (const r of recs) kvSet(r.storageKey, r.value) })(batch)`.
  There is NO `await` inside this callback, so the event loop cannot run mid-flush and no
  concurrent write can join it. Between flushes (while `await`-ing the next chunk) NO
  transaction is open, so a concurrent handler write commits independently — never swallowed
  into the import's transaction (that was the ACK-then-erase lie).
- Do the prefix clears (`assets/`, `inlay*`, `coldstorage/`, `drafts/`, `remotes/`,
  REMOTE_MIGRATION_MARKER, `clearEntities`) in the FIRST flush transaction (before its writes),
  so the clear+first-writes are one atomic unit and there is no separately-committed
  "everything cleared, nothing written yet" state visible to a reader.
- Keep the `hasDatabase` / incomplete-entry checks after the loop.

### 2.2 Final flush + pcs reconcile (one synchronous transaction)
After the loop, flush any remaining batch AND reconcile pcs in ONE synchronous transaction:
```
sqliteDb.transaction(() => {
    for (const r of remainingBatch) kvSet(r.storageKey, r.value)   // chunk-aware for db.bin
    kvDelPrefix('pluginStorage/')                                   // (2e logic, moved here)
    if (sawPcsEntry) { const d = JSON.parse(capturedPcsBlob.toString('utf8')); validate;
                       pluginStoragePerKeyStore.reconcileReplace(d.pluginCustomStorage) }
})()
```
Synchronous → the event loop never runs during it, so NO concurrent write (endpoint OR a
debounced save timer) can join it. `synchronous` stays NORMAL (durable). If the per-flush fsync
cost matters for very large imports, scope `pragma('synchronous = OFF')` to the DURATION of the
import and restore NORMAL + an explicit `wal_checkpoint` at the end — but note that is still
connection-global while set; prefer leaving NORMAL unless a measured regression forces it.

### 2.3 Atomicity is a NON-GOAL here (document it)
This does NOT make the whole import all-or-nothing — a crash between flushes leaves a partial
import, exactly as the pre-existing BATCH_SIZE commits did. That is acceptable: the import is a
user-initiated recovery op, and the DEFECT being fixed is interleaving + durability, not
atomicity. If whole-import atomicity is later wanted, it requires CHUNK-AWARE staging (stage
`database.bin` via `chunkStore` under a temp key, small entries as rows, then `kvCopyValue`
the staged db-blob manifest to `DB_BLOB_KEY` in a single apply tx). That needs `chunkStore`
exposed for a staging key and is out of scope for the defect fix.

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
   The per-batch refactor auto-fixes the swallow (no import tx stays open across an `await`
   for a timer to join). VERIFY: after the refactor, a timer firing between flushes commits
   independently; add a test that a `/api/write`-scheduled persist during an in-flight import
   is not lost.
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
- **Final-flush failure is loud, not silent**: force the final flush to throw (e.g. a malformed
  pcs blob) and assert the import REPORTS FAILURE and the pcs store is not left half-written
  (the DB may be partially imported — non-atomic by design, §2.3 — so assert failure is
  surfaced, not that the whole DB rolled back).
- **Debounced timer during import** (item 3.1).
- Keep all existing pcs tests green (156 at time of writing).

---

## 5. Risks / rollback
- Backup import is critical and complex (streaming, batching, inlay staging, cold-storage). The
  refactor is behavior-preserving for the success path; the risk is edge cases (very large
  backups). Mitigate with the round-trip + concurrent-write tests first.
- `database.bin` is still buffered fully in memory transiently when its entry is flushed (same
  as today — `parseBackupChunk` hands the whole entry to the callback, and `kvSet` chunks it).
  Flush the batch containing it promptly so it isn't held resident alongside a large backlog.
  Do NOT stage it as a raw BLOB (§1a — reintroduces the bind limit).
- Per-batch commits mean a crash mid-import leaves a partial import (unchanged from today's
  BATCH_SIZE commits; documented non-goal §2.3).
- Rollback: the change is contained to the importer functions; revert the commit to restore the
  streaming-into-open-tx behavior if a regression appears.

---

## 6. Definition of done
- No DB transaction is held open across an `await` anywhere in server.cjs (grep BEGIN/COMMIT and
  every `sqliteDb.transaction(` — confirm each callback is synchronous).
- No connection-global pragma toggled around an async span.
- The concurrent-write-during-import test passes (truthful ACK).
- `database.bin` still routes through chunk-aware `kvSet` (never a raw staging BLOB — §1a).
- §3 items 1–7 addressed or explicitly re-deferred with reasons.
- Independent review (codex, neutral data-integrity framing) GO + full suite green.
