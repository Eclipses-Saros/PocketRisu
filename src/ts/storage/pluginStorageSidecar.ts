// Plugin-storage sidecar — dual-read plumbing (B increment 2).
//
// Today `pluginCustomStorage` is embedded inline in the encoded database.bin.
// The eventual fix (B) moves it into a separate sidecar store so the whole
// plugin store is no longer re-serialized / held resident on every save. This
// module lands the READ side FIRST, inert: a decoded DB is only in the "new"
// (sidecar) layout when it carries the directory marker below. Nothing writes
// that marker yet, so `hydratePluginCustomStorage` is a pass-through today; the
// contract (inline authoritative in legacy, sidecar authoritative + fail-closed
// in the new layout) is proven by pluginStorageSidecar.test.ts before any writer
// exists. Read-before-write is deliberate: a reader that doesn't understand the
// new layout would see no pluginCustomStorage and could overwrite it — silent
// memory loss, the one outcome we must never ship.

// Directory-stub field present ONLY in the future new layout. Its presence is
// the sole signal that pluginCustomStorage lives in the sidecar rather than
// inline. A legacy DB with no plugin data has neither this marker nor inline
// pluginCustomStorage, and that is legitimately empty — not a lost sidecar.
export const PLUGIN_STORAGE_SIDECAR_MARKER = 'pluginStorageSidecar'

// Write-enable gate for the new (sidecar) layout. DEFAULT OFF: while off, the
// encoder still embeds pluginCustomStorage inline (byte-identical to today) and
// nothing produces the marker, so the whole sidecar path stays dormant. It only
// flips on once EVERY write-enable piece is in (encoder strip + sidecar send +
// client loader + persistence exits + downgrade guard) AND the end-to-end run
// passes. Kept as module state (not a build const) so tests can exercise both
// branches; production leaves it off until the coordinated flip.
//
// NOT YET FLIPPED: only the RisuSaveEncoder (full-write path) emits the marker.
// PocketRisu runs patch-sync (server enablePatchSync=true), whose RisuSavePatcher
// diff re-inlines pluginCustomStorage every save and is marker-unaware. So with
// the flag on, steady-state saves keep the whole-store cost in the patcher AND
// add a redundant whole-store sidecar write — measured encoder=0 / patcher=1.
// The flip only pays off once the patch-sync path treats pluginCustomStorage as
// a marker/stub (mirroring chatToStub for chats). Safe either way (marker ⟹
// sidecar sent first; patcher re-inline removes the marker → no fail-closed).
let sidecarWriteEnabled = false
export function isPluginStorageSidecarWriteEnabled(): boolean { return sidecarWriteEnabled }
export function setPluginStorageSidecarWriteEnabled(value: boolean): void { sidecarWriteEnabled = !!value }

// ── Boot reconciliation (pure decision; the applier lives in bootstrap) ───────
// The ACCOUNT mode is authoritative and account-wide, so boot ALWAYS probes it (even
// when this device isn't opted in): once any device migrates the account out-of-band,
// every device must use the sidecar or diverge from an empty inline block. The GET is
// discriminated and MUST NOT be collapsed to "empty":
//   fetchSidecar() === null   → legacy (404): no rows; inline in database.bin is authority.
//   fetchSidecar() === object → initialized (200, even {}): the per-key store is authority.
//   fetchSidecar() throws     → error (500/network): FAIL CLOSED — send nothing (never wipe
//                               the server rows), keep the decoded inline for this session.
// A legacy store REJECTS deltas, so the FIRST initialization on an opted-in device must be a
// full REPLACE (this was the missing production call). This function returns a plan; bootstrap
// applies the effects (flag, in-memory pcs, baseline, migration full-write). Kept pure so the
// blocker paths (404 / 200 {} / 500 / migrate) are unit-testable without a live server.
export interface PcsBootPlan {
    enableSidecar: boolean                    // → setPluginStorageSidecarWriteEnabled
    pcs: Record<string, any> | null           // non-null → set decodedDb.pluginCustomStorage
    baseline: Record<string, any>             // → resyncPluginStorageBaseline
    markMigration: boolean                    // true → markPluginStorageMigration (strip inline)
    warn?: string                             // set on fail-closed paths (bootstrap logs it)
}

export async function planPcsBoot(args: {
    localOptIn: boolean
    inlineObj: Record<string, any>
    fetchSidecar: () => Promise<Record<string, any> | null>
    replaceSidecar: (map: Record<string, any>) => Promise<void>
}): Promise<PcsBootPlan> {
    const { localOptIn, inlineObj, fetchSidecar, replaceSidecar } = args
    let fetched: Record<string, any> | null
    try {
        fetched = await fetchSidecar()
    } catch (e) {
        // FAIL CLOSED: mode unknown → disable sidecar (send nothing), keep decoded inline.
        return { enableSidecar: false, pcs: null, baseline: inlineObj, markMigration: false, warn: `account-mode probe failed — sidecar writes disabled this session (fail closed): ${e}` }
    }
    if (fetched !== null) {
        // INITIALIZED (authoritative, even {}). Adopt the sidecar regardless of local flag.
        // Strip any stale inline block still riding this DB via a full write.
        return { enableSidecar: true, pcs: fetched, baseline: fetched, markMigration: Object.keys(inlineObj).length > 0 }
    }
    // LEGACY (404).
    if (!localOptIn) {
        // Not opted in: stay legacy, inline authoritative (byte-identical to pre-b3).
        return { enableSidecar: false, pcs: null, baseline: inlineObj, markMigration: false }
    }
    // Opted-in device MIGRATES: replace-first (delta is rejected on a legacy store).
    try {
        await replaceSidecar(inlineObj)
    } catch (e) {
        return { enableSidecar: false, pcs: null, baseline: inlineObj, markMigration: false, warn: `legacy→initialized migration (replace) failed — staying legacy this session (fail closed): ${e}` }
    }
    // Replace acked: server now holds exactly inlineObj as rows. Adopt the sidecar, seed the
    // baseline, and full-write to strip the inline block from database.bin.
    return { enableSidecar: true, pcs: inlineObj, baseline: inlineObj, markMigration: true }
}

// Layout discriminator for the directory marker. v2 = PER-KEY store (one KV entry
// per plugin key). v1 was the never-shipped single-blob sidecar; no v1 data exists
// in production (the write flag was OFF since inception), so readers treat a v1 (or
// any non-v2) marker as unrecognized and FAIL CLOSED rather than mis-serve it.
export const PLUGIN_STORAGE_LAYOUT_VERSION = 2

// The directory stub embedded in database.bin (in place of the inline payload)
// when the new layout is written. Its presence is the marker the dual-read
// resolver keys on; the key list lets a reader/validator know exactly which
// per-key entries the sidecar MUST contain (fail-closed cross-check). The values
// never go in here — they travel to the per-key store.
export function buildPluginStorageDirectory(pluginCustomStorage: Record<string, any> | null | undefined): { version: number, keys: string[] } {
    // Keys are SORTED so the marker is deterministic: the client (patcher stub)
    // and the server (strip) build it from independently-ordered maps, and the
    // protocol hash of the key array is order-sensitive — sorting makes the two
    // sides agree regardless of insertion order.
    const keys = pluginCustomStorage && typeof pluginCustomStorage === 'object' ? Object.keys(pluginCustomStorage).sort() : []
    return { version: PLUGIN_STORAGE_LAYOUT_VERSION, keys }
}

// Validate a directory marker before a loader trusts it. A malformed marker
// (missing/non-array keys, unrecognized version) must FAIL CLOSED — treating it
// as "empty" would silently drop plugin memory. Returns the validated key list.
export function validatePluginStorageDirectory(directory: unknown): string[] {
    if (!directory || typeof directory !== 'object') {
        throw new Error('pluginCustomStorage directory marker malformed (not an object) — fail closed')
    }
    const d = directory as { version?: unknown, keys?: unknown }
    if (d.version !== PLUGIN_STORAGE_LAYOUT_VERSION) {
        throw new Error(`pluginCustomStorage directory marker version ${String(d.version)} unrecognized (expected ${PLUGIN_STORAGE_LAYOUT_VERSION}) — fail closed`)
    }
    if (!Array.isArray(d.keys) || !d.keys.every((k) => typeof k === 'string')) {
        throw new Error('pluginCustomStorage directory marker keys missing or not a string[] — fail closed')
    }
    return d.keys as string[]
}

// Pure dual-read resolver.
// - Legacy layout (no directory): inline is authoritative, even when undefined
//   (a DB that never had plugin data). Never throws.
// - New layout (directory present): the sidecar is authoritative and MUST be
//   present. A missing sidecar FAILS CLOSED — it must never resolve to empty,
//   or a plugin would treat "temporarily unavailable" as "memory gone" and
//   overwrite the survivors.
export function resolvePluginCustomStorage(args: {
    inline: unknown
    sidecar: unknown
    hasSidecarDirectory: boolean
}): unknown {
    const { inline, sidecar, hasSidecarDirectory } = args
    if (!hasSidecarDirectory) return inline
    if (sidecar !== undefined && sidecar !== null) return sidecar
    throw new Error('pluginCustomStorage sidecar expected by directory marker but missing — refusing to report empty (fail closed)')
}

// MARKER-AUTHORITATIVE resolver: the directory's key list is the allowlist. Build
// the map from EXACTLY those keys out of whatever the loader fetched (which may
// include orphans — values of deleted keys that linger per-key). Orphans are
// dropped (not in the marker) so a marker-only delete stays deleted on reload. A
// listed key missing from the fetched payload FAILS CLOSED — never silently short.
export function resolvePluginCustomStorageByDirectory(directory: unknown, fetched: unknown): Record<string, unknown> {
    const keys = validatePluginStorageDirectory(directory) // throws on malformed / wrong-version
    const out: Record<string, unknown> = {}
    if (keys.length === 0) return out // legitimately empty — no fetch needed, never 404-fails
    const map = (fetched && typeof fetched === 'object') ? fetched as Record<string, unknown> : null
    for (const k of keys) {
        if (!map || !Object.hasOwn(map, k)) {
            throw new Error(`pluginCustomStorage directory lists "${k}" but the sidecar payload is missing it — fail closed (no silent memory loss)`)
        }
        out[k] = (map as any)[k]
    }
    return out
}

// Sidecar payload loader. Default stub: no sidecar available → "absent" (null). The
// real client loader (GET /api/plugin-storage) is injected at boot. A directory
// marker with this returning null trips fail-closed, the safe outcome.
export async function loadPluginStorageSidecar(_directory: unknown): Promise<unknown | null> {
    return null
}

// Load-path hydration. Legacy layout (no marker) → returns db unchanged (inline
// pcs stays). Marker layout → resolves pcs from the sidecar, filtered to EXACTLY
// the marker's keys (orphans excluded, missing → fail closed), and strips the
// marker. An empty marker resolves to {} without any fetch (so a zero-key store
// never 404-fails boot).
export async function hydratePluginCustomStorage<T extends Record<string, any>>(
    db: T,
    loader: (directory: unknown) => Promise<unknown | null> = loadPluginStorageSidecar,
): Promise<T> {
    if (!db || typeof db !== 'object') return db
    const directory = (db as any)[PLUGIN_STORAGE_SIDECAR_MARKER]
    if (!directory) return db
    const keys = validatePluginStorageDirectory(directory)
    // Only fetch when the marker actually references keys.
    const fetched = keys.length === 0 ? {} : await loader(directory)
    ;(db as any).pluginCustomStorage = resolvePluginCustomStorageByDirectory(directory, fetched)
    delete (db as any)[PLUGIN_STORAGE_SIDECAR_MARKER]
    return db
}
