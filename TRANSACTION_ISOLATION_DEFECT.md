# PocketRisu — Core transaction-isolation defect (handoff for a separate session)

**Status:** CONCURRENCY class FIXED (commits `473dfba6` + the debounced-timer follow-up).
A separate, orthogonal **filesystem-store + resource** class remains deferred to its own
session (see §6). Independently reviewed (codex) across the redesign.
**Date:** 2026-07-16
**Root cause:** the backup import bypassed `queueStorageOperation` — the app's single-writer
serializer that every other mutator runs through. Every concurrency symptom (ACK-then-erase,
DB/pcs split, timer-defeats-restore) traced to "the import is not a queue operation."
**Chosen fix direction (shipped):** make the import a well-behaved member of the queue.
Stream + stage OFF the live store; validate; then run the WHOLE destructive install as ONE
`queueStorageOperation` (clears + staged copy + `database.bin` + pcs reconcile in one
synchronous transaction, then inlay swap + cold-storage migration). Because every KV mutator
(now incl. `/api/assets/bulk-write` and the debounced `/api/patch` + `/api/chat-content`
persist timers) also goes through the queue, the install is serialized against all of them
structurally — no per-endpoint guard, no flag TOCTOU. This REPLACED an earlier per-batch +
per-mutator-`importInProgress`-guard attempt, which was symptom-level (guard sprinkle with
entry-only TOCTOU + missed mutators); see the git history / §3.
**Flag state:** the pluginCustomStorage write-enable flag is independent of this; this
defect predates the per-key store and affected `database.bin`, chats, characters, assets,
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

## 3. Chosen fix (shipped) — the import is a queue operation

The root cause is **not** "a tx held across async I/O" per se — that was one symptom. The
root is that the import **bypassed `queueStorageOperation`**, the app's single-writer
serializer. The fix makes the import a well-behaved member of that queue:

1. **Stream + stage OFF the live store.** No `BEGIN`, no live write during the stream. Small
   KV (assets/coldstorage) → a disk-backed `import_staging` table (NOT a `temp_store=MEMORY`
   temp table → no OOM); `database.bin` held in a JS var (kvSet chunks only that key, so a raw
   staging row would hit the BLOB bind limit `chunkStore` removes); pcs blob captured; inlays
   staged to files as before.
2. **Validate before destroy.** The pcs blob is parsed + shape-checked BEFORE anything
   destructive (fail closed). (Validating the `database.bin` blob is deferred — §6.)
3. **Install as ONE `queueStorageOperation`.** A single synchronous `sqliteDb.transaction`
   (prefix clears + `clearEntities` + staged→live copy + `database.bin` + `pluginStorage/`
   clear + `reconcileReplace` — the DB image and the per-key store commit together), then the
   inlay dir swap, then the cold-storage migration, all inside that one queue op.

Why this is the root fix: because EVERY KV mutator runs through `queueStorageOperation`
(`/api/write`, `/api/patch`, `/api/remove`, `/api/plugin-storage`, `/api/chat-content`, and —
made so by this work — `/api/assets/bulk-write` and the debounced `/api/patch` + `/api/chat-
content` persist timers), the install is serialized against all of them **structurally**. A
concurrent write can never be erased mid-flight: it either completed before the install (a
succeeding import then legitimately supersedes it — ordinary last-op-wins) or runs after it
(on the imported state). No per-endpoint `importInProgress` guard, no flag TOCTOU, no missed-
mutator class. `synchronous = OFF` is gone (durable NORMAL throughout).

**What this dissolves:** broken structures 1, 2, 5 (interleave/durability/savepoint) AND the
DB/pcs split AND the debounced-timer-defeats-restore race — all as the single "import joins
the queue" property.

### Rejected earlier attempts (kept for the record)
- **Per-mutator `importInProgress` 503 guard on every endpoint** (an earlier commit): symptom-
  level. Needed a guard on each mutator, had an entry-only TOCTOU, and missed mutators
  (`/api/inlays/compress`, the debounced timers). Replaced by queue serialization.
- **Per-batch synchronous flush with atomicity as a non-goal**: fixed the tx-across-await but
  left real P1s (a concurrent write to a cleared namespace lost on a failed import; a new-DB/
  old-pcs split on malformed pcs). Superseded by the atomic queued install above.

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

## 5. Checklist — CONCURRENCY class (done)

- [x] Regression/e2e tests (`src/ts/storage/backupImportIsolation.integration.test.ts`):
      round-trip; write + pcs-delta ACKed during a FAILING import SURVIVE (no erase, no 503);
      a SUCCEEDING import atomically SUPERSEDES a concurrent write; malformed pcs → prior
      DB+pcs intact. RED pre-fix, GREEN post-fix.
- [x] Restructure `importBackupFromSource`: stage off-live → validate → ONE queued atomic
      install (no tx across `await`; `synchronous = OFF` removed → durable NORMAL).
- [x] Route the remaining unqueued KV mutators through the queue: `/api/assets/bulk-write`
      and the debounced `/api/patch` + `/api/chat-content` persist timers.
- [x] Removed the pcs "2f" `importInProgress` guard and the per-mutator guard sprinkle
      (queue serialization replaces them); `importInProgress` now only 409s a second import.
- [x] Independent review (codex, 3 rounds): confirmed serialization holds, no deadlock in the
      queued install, SUPERSEDE is truthful. Full suites green (isolation 7 / storage 208 /
      compat 53 / server 129).

## 6. Filesystem-store + resource class — proportionate fixes (done) + one deferred

Orthogonal to the concurrency fix (these stem from "the filesystem inlay dir is a second store
with no serializer" + resource use), pre-date this work. Addressed **proportionately** to their
severity (all are low-probability; (4)'s worst case is recoverable missing-images, not chat loss)
rather than with a full off-side/generation-pointer rewrite (huge blast radius — no connection
reopen path, ~21 instance-bound prepared statements; ruled out):

- **[x] Validate-before-destroy for `database.bin`.** A read-only `decodeRisuSave` of the staged
  blob runs BEFORE the destructive install (commit `1b3e72c5`); a corrupt blob aborts with the
  prior store intact. The cold-storage migration still runs on the installed blob afterward.
- **[x] `/api/inlays/compress` vs the inlay swap.** Compress now participates in the same
  import-vs-import mutual exclusion (`importInProgress`): refused 409 while an import runs, and it
  sets the flag for its own duration so an import refuses to start under it. No swap can race it.
- **[x] SQLite ↔ filesystem (inlay dir) crash atomicity — proportionate.** The DB install is one
  SQLite transaction and the inlay swap has an in-process rollback; the remaining gap was a hard
  CRASH mid-swap. `recoverCrashedInlayImport()` runs at boot: if the scratch dirs are present it
  restores the pre-import inlays (if the live dir vanished) and clears the scratch, so inlays are
  never lost outright and nothing leaks. Residual: a new-DB/old-inlays generation mismatch after
  such a crash shows as missing images, recoverable by re-import — an accepted low-severity
  tradeoff. Full cross-store atomicity (a generation pointer stored in SQLite, flipped atomically
  with the DB) is the only way to eliminate the mismatch, and is DEFERRED as not worth its blast
  radius for this severity.
- **[x] `import_staging` disk amplification — accepted.** The staged rows are DELETEd after the
  install (success + catch); freed pages return to the SQLite freelist and are reused, so this is
  a transient high-water file size, not unbounded growth. No code change.
- **[ ] `database.bin` in-memory hold (deferred).** The install-time chunking (`chunkStore.putValue`
  → `cdcSplit`) needs the whole blob in memory, so temp-file staging wouldn't help — the real fix
  is a STREAMING chunker (chunk from a file/stream), a `chunkStore` API change out of scope here.
  The proportionate guard against adversarial huge imports is a `RISU_BACKUP_IMPORT_MAX_BYTES`
  default (a policy decision — a too-low default breaks large legitimate backups), not code.
