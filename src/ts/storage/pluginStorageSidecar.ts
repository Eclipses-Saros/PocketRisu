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
        throw new Error('pluginCustomStorage directory marker malformed (not an object) — failing closed')
    }
    const d = directory as { version?: unknown, keys?: unknown }
    if (d.version !== PLUGIN_STORAGE_LAYOUT_VERSION) {
        throw new Error(`pluginCustomStorage directory marker version ${String(d.version)} unrecognized (expected ${PLUGIN_STORAGE_LAYOUT_VERSION}) — failing closed`)
    }
    if (!Array.isArray(d.keys) || !d.keys.every((k) => typeof k === 'string')) {
        throw new Error('pluginCustomStorage directory marker keys missing or not a string[] — failing closed')
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

// Sidecar payload loader. Stub for increment 2: no sidecar store exists yet, so
// it always reports "absent". Increment 3 implements the real read; until then a
// present directory marker with this returning null trips the fail-closed guard,
// which is exactly the safety we want if a new-layout DB ever appears early.
export async function loadPluginStorageSidecar(_directory: unknown): Promise<unknown | null> {
    return null
}

// Load-path hydration, wired into the DB decode path. Inert today: no decoded DB
// carries the marker, so this returns `db` unchanged (pluginCustomStorage stays
// exactly as decoded). When a real sidecar layout arrives (increment 3+), it
// resolves pluginCustomStorage from the sidecar and strips the marker.
export async function hydratePluginCustomStorage<T extends Record<string, any>>(
    db: T,
    loader: (directory: unknown) => Promise<unknown | null> = loadPluginStorageSidecar,
): Promise<T> {
    if (!db || typeof db !== 'object') return db
    const hasSidecarDirectory = !!(db as any)[PLUGIN_STORAGE_SIDECAR_MARKER]
    if (!hasSidecarDirectory) return db
    const sidecar = await loader((db as any)[PLUGIN_STORAGE_SIDECAR_MARKER])
    ;(db as any).pluginCustomStorage = resolvePluginCustomStorage({
        inline: (db as any).pluginCustomStorage,
        sidecar,
        hasSidecarDirectory: true,
    })
    delete (db as any)[PLUGIN_STORAGE_SIDECAR_MARKER]
    return db
}
