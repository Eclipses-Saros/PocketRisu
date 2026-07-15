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
export async function hydratePluginCustomStorage<T extends Record<string, any>>(db: T): Promise<T> {
    if (!db || typeof db !== 'object') return db
    const hasSidecarDirectory = !!(db as any)[PLUGIN_STORAGE_SIDECAR_MARKER]
    if (!hasSidecarDirectory) return db
    const sidecar = await loadPluginStorageSidecar((db as any)[PLUGIN_STORAGE_SIDECAR_MARKER])
    ;(db as any).pluginCustomStorage = resolvePluginCustomStorage({
        inline: (db as any).pluginCustomStorage,
        sidecar,
        hasSidecarDirectory: true,
    })
    delete (db as any)[PLUGIN_STORAGE_SIDECAR_MARKER]
    return db
}
