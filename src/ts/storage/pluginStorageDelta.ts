// Client-side per-key delta tracking for pluginCustomStorage (b3).
//
// The b3 layout keeps plugin VALUES out of database.bin (one KV entry per key on
// the server). To sync them without clobbering concurrent writers, the client
// sends only the keys it actually changed (a delta), not the whole map. Computing
// that delta must NOT recreate the OOM: no whole-store string, no resident clone of
// every value.
//
// So the baseline is a per-key content FINGERPRINT map (key -> digest), not a copy
// of the values. On save we digest each current value and compare. This detects
// EVERY change regardless of how it was made (sandbox setItem, the db proxy, the
// settings viewer, clear(), or a direct/nested mutation), which an intercept/op-log
// would miss.
//
// The digest MUST be collision-resistant AND match the SERIALIZATION THAT IS ACTUALLY
// SENT/PERSISTED, or a change is silently suppressed and the server left stale (the
// "never silent loss" cardinal sin). In the rows-as-authority layout pcs travels the
// wire as a JSON string (savePluginStorageDelta → JSON.stringify) and is stored per-key
// as JSON.stringify(value) — NOT msgpack. So the fingerprint is taken over the EXACT
// canonical JSON string that is sent: fingerprint equality then means the sent/stored
// bytes are identical. (The old msgpack fingerprint mismatched the JSON wire — e.g. a
// value with an `undefined` member fingerprinted one way but was JSON-sent another,
// diverging the baseline. Fingerprinting the JSON that is actually sent removes that.)
// Two seeded 53-bit hashes + a length prefix over the UTF-8 JSON bytes.

export type PluginStorageBaseline = Map<string, string>
export interface PluginStorageDelta { changed: Record<string, any>; removed: string[] }

// cyrb53 over raw bytes: well-distributed 53-bit hash (imul-based); two seeds give
// an effectively ~106-bit composite with the length prefix.
function cyrb53Bytes(bytes: Uint8Array, seed: number): number {
    let h1 = 0xdeadbeef ^ seed
    let h2 = 0x41c6ce57 ^ seed
    for (let i = 0; i < bytes.length; i++) {
        const ch = bytes[i]
        h1 = Math.imul(h1 ^ ch, 2654435761)
        h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

const _fpEnc = new TextEncoder()
// Fingerprint a CANONICAL JSON string (the exact bytes sent/stored). `json === undefined`
// means the value was not JSON-representable (undefined/function/symbol) — a stable sentinel
// keeps the baseline consistent (such a key is treated as ABSENT by computeDelta).
function fingerprintJson(json: string | undefined): string {
    if (json === undefined) return '!undef'
    const bytes = _fpEnc.encode(json)
    return `${bytes.length}:${cyrb53Bytes(bytes, 0x9e3779b9)}:${cyrb53Bytes(bytes, 0x85ebca6b)}`
}
function fingerprint(value: any): string {
    // Used to seed the baseline from a server/inline map (already plain JSON values).
    let json: string | undefined
    try { json = JSON.stringify(value) }
    catch (e) { return `!json:${typeof value}:${(e as any)?.message ?? ''}` } // cyclic/BigInt → loud-distinct
    return fingerprintJson(json)
}

// The live pcs container MUST be a plain object before we diff it. A Map/Date/typed-
// array/class-instance enumerates to ZERO own keys via Object.keys, so treating it as
// the map would mark EVERY baseline key as removed — a full wipe. A primitive is
// likewise not a map. Reject loudly (abort the save) rather than compute a destructive
// delta. null/undefined are allowed and mean "genuinely empty" (→ {} below).
function assertPlainPcsContainer(current: unknown): void {
    if (current === null || current === undefined) return
    if (typeof current !== 'object' || Array.isArray(current)) {
        throw new Error('pluginCustomStorage delta: live value is not a plain object (refusing to compute a wiping delta)')
    }
    const proto = Object.getPrototypeOf(current)
    if (proto !== null && proto !== Object.prototype) {
        throw new Error('pluginCustomStorage delta: live value is a non-plain object (Map/Date/typed/instance) — refusing to compute a wiping delta')
    }
}

export function seedPluginStorageBaseline(map: Record<string, any> | null | undefined): PluginStorageBaseline {
    const b: PluginStorageBaseline = new Map()
    if (map && typeof map === 'object') for (const k of Object.keys(map)) b.set(k, fingerprint(map[k]))
    return b
}

// changed = keys whose value is new or differs from the baseline fingerprint.
// removed = baseline keys absent from the current map. `changed` uses a null
// prototype so a key literally named "__proto__" is stored as an own entry, not
// swallowed by the prototype setter.
//
// Each changed value is serialized to JSON EXACTLY ONCE here; that one string is both the
// fingerprint source AND the snapshot stored in `changed[k]` (as JSON.parse of it — a fresh
// PLAIN object, never the live $state proxy). So: (a) a plugin mutating the live value while
// the POST is in flight cannot change what was captured (no live reference retained — the
// R16 live-proxy race); (b) the fingerprint equals the exact bytes the wire sends and the row
// stores, so the baseline advances to precisely what the server received.
export function computePluginStorageDelta(
    current: Record<string, any> | null | undefined,
    baseline: PluginStorageBaseline,
): PluginStorageDelta {
    assertPlainPcsContainer(current) // throw on Map/Date/typed/array/primitive (would wipe)
    const cur = current && typeof current === 'object' ? current : {}
    const changed: Record<string, any> = Object.create(null)
    const seen = new Set<string>()
    for (const k of Object.keys(cur)) {
        let json: string | undefined
        try { json = JSON.stringify(cur[k]) }
        catch (e) { throw new Error(`pluginCustomStorage: value for key "${k}" is not JSON-encodable (${(e as any)?.message ?? 'cyclic'}) — aborting save to avoid a divergent baseline`) }
        if (json === undefined) {
            // undefined/function/symbol value = no JSON-representable value. Treat the key as
            // ABSENT (JSON semantics + what the wire would omit): do NOT mark it seen, so if the
            // baseline had it the removed-loop deletes it; if it was never synced it is ignored.
            // Never record it as synced-present (the old '!undef' fingerprint did, diverging).
            continue
        }
        seen.add(k)
        const fp = fingerprintJson(json)
        if (baseline.get(k) !== fp) changed[k] = JSON.parse(json) // stable plain snapshot from the fingerprinted bytes
    }
    const removed: string[] = []
    for (const k of baseline.keys()) if (!seen.has(k)) removed.push(k)
    return { changed, removed }
}

export function pluginStorageDeltaIsEmpty(d: PluginStorageDelta): boolean {
    return Object.keys(d.changed).length === 0 && d.removed.length === 0
}

// Advance the baseline to reflect a CONFIRMED save. Call ONLY after the server acked
// the delta; a failed/retried save then recomputes from the un-advanced baseline and
// re-sends the same delta idempotently. Fingerprints the SNAPSHOT held in
// delta.changed (taken at compute time), so it matches what was sent.
export function advancePluginStorageBaseline(baseline: PluginStorageBaseline, delta: PluginStorageDelta): void {
    for (const k of Object.keys(delta.changed)) baseline.set(k, fingerprint(delta.changed[k]))
    for (const k of delta.removed) baseline.delete(k)
}
