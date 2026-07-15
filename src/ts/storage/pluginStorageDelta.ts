// Client-side per-key delta tracking for pluginCustomStorage (b3 / C3).
//
// The sidecar layout keeps plugin VALUES out of database.bin (per-key on the
// server). To sync them without clobbering concurrent writers, the client sends
// only the keys it actually changed — a delta — not the whole map. Computing that
// delta must NOT recreate the OOM: no whole-store JSON string, no resident clone.
//
// So the baseline is a per-key FINGERPRINT map (key -> hash), not a copy of the
// values. On save we fingerprint each current value and compare — O(bytes) CPU but
// only tiny number allocations. This detects EVERY change regardless of how it was
// made (sandbox setItem, the db proxy, the settings viewer, clear(), or a direct /
// nested mutation), which an intercept/op-log would miss. calculateHash is the same
// hash the patch protocol already trusts for correctness.
import { calculateHash } from './risuSave'

export type PluginStorageBaseline = Map<string, number>
export interface PluginStorageDelta { changed: Record<string, any>; removed: string[] }

const fingerprint = (value: any): number => calculateHash(value)

// Seed the baseline from the last-synced map (call after load/hydrate, and after
// a confirmed full replace).
export function seedPluginStorageBaseline(map: Record<string, any> | null | undefined): PluginStorageBaseline {
    const b: PluginStorageBaseline = new Map()
    if (map && typeof map === 'object') for (const k of Object.keys(map)) b.set(k, fingerprint(map[k]))
    return b
}

// changed = keys whose value is new or differs from the baseline fingerprint.
// removed = baseline keys absent from the current map.
export function computePluginStorageDelta(
    current: Record<string, any> | null | undefined,
    baseline: PluginStorageBaseline,
): PluginStorageDelta {
    const cur = current && typeof current === 'object' ? current : {}
    const changed: Record<string, any> = {}
    const seen = new Set<string>()
    for (const k of Object.keys(cur)) {
        seen.add(k)
        if (baseline.get(k) !== fingerprint(cur[k])) changed[k] = cur[k]
    }
    const removed: string[] = []
    for (const k of baseline.keys()) if (!seen.has(k)) removed.push(k)
    return { changed, removed }
}

export function pluginStorageDeltaIsEmpty(d: PluginStorageDelta): boolean {
    return Object.keys(d.changed).length === 0 && d.removed.length === 0
}

// Advance the baseline to reflect a CONFIRMED save. Call ONLY after the server
// acked the delta — a failed/retried save then recomputes from the un-advanced
// baseline and re-sends the same delta idempotently (per-key writes are).
export function advancePluginStorageBaseline(baseline: PluginStorageBaseline, delta: PluginStorageDelta): void {
    for (const k of Object.keys(delta.changed)) baseline.set(k, fingerprint(delta.changed[k]))
    for (const k of delta.removed) baseline.delete(k)
}
