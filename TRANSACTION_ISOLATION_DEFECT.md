# PocketRisu — Core transaction-isolation defect (handoff for a separate session)

**Status:** identified, NOT fixed. Deferred to its own session (this is app-wide core
infrastructure, orthogonal to the pluginCustomStorage SSOT work that produced this note).
**Date:** 2026-07-16
**Chosen fix direction:** Option **B** (stage → single synchronous apply). See below.
**Flag state:** the pluginCustomStorage write-enable flag is independent of this; this
defect predates the per-key store and affects `database.bin`, chats, characters, assets,
and pluginStorage identically.

This document is self-contained: a fresh session with no prior context can act on it.

---

## 1. The root defect (one violated principle)

`importBackupFromSource` in [server/node/server.cjs](server/node/server.cjs) holds a **raw
SQLite `BEGIN` transaction open across `for await` on the network stream**, on the single
shared **synchronous** better-sqlite3 connection, while the Express server keeps serving
other requests. It also toggles a **connection-global** pragma for that whole window.

```
server.cjs (importBackupFromSource):
  ~2272  sqliteDb.pragma('synchronous = OFF');   // CONNECTION-GLOBAL, affects everyone
  ~2274  sqliteDb.exec('BEGIN');                  // raw tx opened
  ~2276  kvDelPrefix('assets/'), ...              // clears
  ~2291  for await (const chunk of dataSource) {  // <-- awaits network I/O with tx OPEN
             ... kvSet(entry) ...
  ~2405      COMMIT / BEGIN  (every BATCH_SIZE)   // batched, so not even atomic
         }
  ~2451  kvDelPrefix('pluginStorage/') + reconcile
  ~2459  COMMIT
  ~2466  pragma('synchronous = NORMAL')  (finally)
```

Because better-sqlite3 is synchronous and single-connection, **any other request handler
that runs during one of those `await`s and issues a synchronous DB write executes INSIDE
the import's open transaction** (a raw `kvSet`/`kvDel` joins the transaction; a
`sqliteDb.transaction()` call becomes a nested SAVEPOINT). The concurrent write is ACKed to
its client but is then part of the import's transaction — overwritten by the import's own
writes/clears, or rolled back if the import fails. **The ACK is a lie.**

Violated principle: *never hold a DB transaction open across async I/O on a shared
single connection, and never toggle a connection-global pragma around an async span.*

`/api/write` (the main `database.bin` persist path) has **no** `importInProgress` guard
from handler entry through its mutation, and the import itself does **not** enter
`queueStorageOperation`, so the existing storage queue does not exclude it.

Confirmed pre-existing and app-wide (not caused by the pluginCustomStorage migration) by
an independent review; the same `BEGIN`-across-`for await` + unguarded `database.bin` write
exists at baseline commit `9b1413db` (`server/node/server.cjs:2220-2244` and `:3513-3601`).

---

## 2. Concrete broken structures this one flow produces

All of these are **core data** (not plugin-specific):

1. **Global durability hole during import.** `synchronous = OFF` is connection-wide
   ([server.cjs ~2272](server/node/server.cjs)). For the entire import (a large backup =
   minutes), every committed write from every other handler runs without fsync → a
   concurrent write ACKed during an import can be lost on crash/power-loss even though it
   "succeeded."

2. **Debounced timer writes swallowed by the import transaction.** `/api/write` and
   `/api/patch` debounce persistence via
   `setTimeout(async () => { kvSet / persistDbCacheWithChats }, 5000)`
   ([server.cjs ~3842](server/node/server.cjs), [~4771](server/node/server.cjs);
   `SAVE_INTERVAL = 5000`). The client is ACKed at request time (fire-and-forget). If the
   5s timer fires during an import's open `BEGIN`, its `kvSet` joins the import transaction
   → overwritten/rolled back → **chat/character data silently lost while the client already
   got success**. This is a real pre-existing silent-loss path for core data.

3. **Inconsistent serialization.** `/api/remove` does a raw `kvDel` with **no**
   `queueStorageOperation` and no `importInProgress` ([server.cjs ~3467](server/node/server.cjs)).
   Other mutators use the queue, but the import does not join it, so the queue does not
   protect against the import. The queue + `importInProgress` machinery is a partial,
   inconsistent patch over a missing invariant.

4. **The import is not atomic.** It commits every `BATCH_SIZE` entries mid-stream
   ([server.cjs ~2405](server/node/server.cjs)), so a mid-import failure leaves a partially
   applied import — and with `synchronous = OFF`, non-durable.

5. **`savepoint`-during-import.** Every `sqliteDb.transaction()` call site (snapshot
   create/restore [~227](server/node/server.cjs)/[~570](server/node/server.cjs)/[~5843](server/node/server.cjs),
   `/api/assets/bulk-write` [~3981](server/node/server.cjs), save-folder import
   [~5010](server/node/server.cjs)/[~5041](server/node/server.cjs), chunkStore, and the
   pluginStorage per-key store) becomes a **nested SAVEPOINT** if it runs during the
   import's open `BEGIN` — its "commit" is a savepoint release, not durable until the import
   commits, and erased if the import clears those keys.

---

## 3. Chosen fix — Option B (root: remove the mechanism)

Restructure `importBackupFromSource` (and audit any other tx-across-async) to **never hold
a transaction open across async I/O**:

1. **Stream phase (NO open transaction).** Do not `BEGIN` before the stream. Accumulate the
   streamed KV entries into a **staging** structure — a temp table
   (`CREATE TEMP TABLE import_staging(key, value)`, written in short synchronous batches) or
   temp files. (Inlay files already use a staging dir + atomic rename at the end — extend
   that pattern to KV entries.) Remove the connection-global `synchronous = OFF` from this
   phase.
2. **Apply phase (single synchronous transaction, NO `await` inside).**
   `sqliteDb.transaction(() => { clear prefixes; copy staging → live; pluginStorage clear +
   reconcile; })()`. Being synchronous, it never yields the event loop, so no concurrent
   write can join it.
3. Inlay dir swap + cold-storage migration + WAL checkpoint stay after the transaction, as
   today.

Effect: the interleaving mechanism disappears for **all** namespaces at once; the global
pragma toggle is gone; broken structures 1, 2, 4, 5 dissolve. Endpoint-level
`importInProgress` guards, the pluginStorage-specific import guard (see §4), and a client
503 lifecycle-conflict path become unnecessary.

Cost/risk: backup import is complex and critical (streaming, batching, inlay staging, cold
storage). **Wrap it in regression/e2e tests that pin current import behavior FIRST**, then
restructure, then confirm green + an independent review.

### Alternative considered (rejected as the primary fix): Option A (coordinate around it)
Extend `importInProgress` to every mutator (two-point check, as done for
`/api/plugin-storage`) and to the debounced timers; scope `synchronous = OFF` down; return
503 during import and handle it on the client. Lower risk, but leaves the violated
principle in place and adds many touch points + client 503 handling. Kept only as a
fallback if B's rewrite proves too risky.

---

## 4. Interaction with the pluginCustomStorage SSOT (already committed this session)

The pcs SSOT is **separate and complete at app-parity** — do not redo it as part of this.
One thing to revisit once B lands:

- `POST /api/plugin-storage` currently has a **pluginStorage-specific** two-point
  `importInProgress` guard (commit `8721f577`, "2f") that refuses plugin writes during an
  import. After B removes the interleaving mechanism, that guard is redundant and can be
  removed (or kept as a cheap belt). It is currently the one place pcs is *stricter* than
  `database.bin`.

Relevant committed pcs work (this session, branch `feat/plugin-storage-sidecar-write` area):
per-key store `server/node/pluginStoragePerKeyStore.cjs`; wiring + export/import/backup/
snapshot in `server.cjs`; client `src/ts/storage/nodeStorage.ts`. All at parity; the
pcs-specific data-loss classes were closed and independently verified.

---

## 5. Quick checklist for the fix session

- [ ] Add regression/e2e tests pinning current backup import + server-restore behavior
      (round-trip a backup; assert all namespaces restored; assert a concurrent write is
      not silently swallowed).
- [ ] Restructure `importBackupFromSource`: stage (no tx) → single synchronous apply.
- [ ] Remove connection-global `synchronous = OFF`; if needed, scope it to the sync apply.
- [ ] Audit debounced timer writes (`saveTimers`) and `/api/remove` for consistency with
      the new model.
- [ ] Re-check every `sqliteDb.transaction()` site is only ever entered outside an import.
- [ ] Remove now-redundant guards (pcs "2f" import guard; any endpoint `importInProgress`
      checks that B makes unnecessary).
- [ ] Independent review + full test suite green.
