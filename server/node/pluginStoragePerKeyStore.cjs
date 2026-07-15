// Server-side PER-KEY store for pluginCustomStorage (B inc 4 — b3 layout).
//
// The single-blob sidecar (pluginStorageStore.cjs) keeps all plugin keys in ONE
// KV entry. That reintroduces the very coupling B set out to remove: two clients
// saving concurrently both rewrite the whole blob, so the later write silently
// drops the earlier client's per-key changes whenever the key SET is unchanged
// (the common case — plugins rewrite existing shard values constantly). It also
// leaves the whole-store re-serialization in the patch-sync path.
//
// This store mirrors the proven PER-CHAT model (fullChatStore + one KV entry per
// chat) for plugin keys: each pluginCustomStorage key is its own KV entry, so a
// write touches only that key and concurrent writes to DIFFERENT keys never
// collide. Same-key concurrent writes are a genuine conflict and resolve
// last-write-wins, exactly as two tabs editing the same chat do.
//
// Pure factory over a small kv interface (like pluginStorageStore.cjs / chunkStore
// .cjs) so it unit-tests without booting the server. Nothing writes it in
// production yet; wiring (client per-key diff + endpoints + reassembly) lands in
// later increments. Until then it is dormant and additive — the single-blob store
// stays until the per-key path is wired and proven.

const { encodeRisuSaveLegacy, decodeRisuSave, validatePluginStorageDirectory } = require('./utils.cjs');

// Per-key entries live under this prefix, one KV row each, never inside
// database.bin. encodeURIComponent makes an arbitrary plugin key (which may hold
// ':', '/', or unicode) a reversible, KV-safe path segment.
const PLUGIN_STORAGE_PERKEY_PREFIX = 'pluginStorage/';

function kvKeyFor(pluginKey) {
    const s = String(pluginKey);
    let enc;
    // encodeURIComponent throws URIError on a lone surrogate. A plugin key with an
    // unpaired surrogate is pathological (almost always a bug); reject it with a
    // clear, fail-closed error rather than a cryptic URIError or silent corruption.
    try { enc = encodeURIComponent(s); }
    catch (e) { throw new Error(`pluginStorage key not encodable (lone surrogate or invalid string): ${e && e.message}`); }
    return `${PLUGIN_STORAGE_PERKEY_PREFIX}${enc}.bin`;
}

// Set an OWN enumerable property even for dangerous names like '__proto__'
// (a plain `obj[k]=v` would hit the prototype setter and silently drop the key).
function safeSet(obj, key, value) {
    Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * @param {{ get(key:string): (Buffer|Uint8Array|null), set(key:string, value:Buffer): void, del(key:string): void, listPrefix?(prefix:string): string[] }} kv
 */
function createPluginStoragePerKeyStore(kv) {
    if (!kv || typeof kv.get !== 'function' || typeof kv.set !== 'function' || typeof kv.del !== 'function') {
        throw new Error('createPluginStoragePerKeyStore: kv with get/set/del required');
    }

    // One key's value → one KV entry. Wrapped in { value } so the blob is
    // self-describing and decodes symmetrically with readKey().
    function writeKey(pluginKey, value) {
        kv.set(kvKeyFor(pluginKey), Buffer.from(encodeRisuSaveLegacy({ value: value ?? null })));
    }

    // Returns the stored value for one key, or undefined if that entry is absent.
    // undefined (not null) is the "this key has no entry" signal the loader uses to
    // fail closed when a directory lists a key whose entry is missing.
    async function readKey(pluginKey) {
        const raw = kv.get(kvKeyFor(pluginKey));
        if (!raw || raw.length === 0) return undefined;
        const decoded = await decodeRisuSave(raw);
        return decoded && typeof decoded === 'object' ? decoded.value : undefined;
    }

    function removeKey(pluginKey) {
        kv.del(kvKeyFor(pluginKey));
    }

    // Write only the given keys (the changed set). Does NOT touch other keys —
    // that is the whole point vs the single blob.
    function writeMany(entries) {
        if (!entries || typeof entries !== 'object') return;
        for (const k of Object.keys(entries)) writeKey(k, entries[k]);
    }

    // Reassemble the pluginCustomStorage map from a directory (the marker's key
    // list). FAIL CLOSED: if a listed key has no stored entry, the payload is lost
    // — throw rather than silently return a short map (that would delete memory on
    // the next save). An empty/absent directory is a legitimately empty map.
    async function loader(directory) {
        // Validate first: a malformed / wrong-version marker FAILS CLOSED instead of
        // silently resolving to an empty directory (which would drop plugin memory).
        const keys = validatePluginStorageDirectory(directory);
        const out = {};
        for (const k of keys) {
            const v = await readKey(k);
            if (v === undefined) {
                throw new Error(`pluginStorage per-key store: directory lists "${k}" but its entry is missing — failing closed to avoid silent memory loss`);
            }
            safeSet(out, k, v);
        }
        return out;
    }

    // Best-effort enumeration of stored plugin keys (decoded back from the path).
    // Needs kv.listPrefix; used by GC/reassembly/backup, not by the fail-closed
    // loader (which is directory-driven).
    function listKeys() {
        if (typeof kv.listPrefix !== 'function') return null;
        const raw = kv.listPrefix(PLUGIN_STORAGE_PERKEY_PREFIX) || [];
        return raw
            .filter((k) => k.startsWith(PLUGIN_STORAGE_PERKEY_PREFIX) && k.endsWith('.bin'))
            .map((k) => decodeURIComponent(k.slice(PLUGIN_STORAGE_PERKEY_PREFIX.length, -'.bin'.length)));
    }

    // Reassemble the WHOLE stored map by scanning the prefix (not directory-
    // driven; used for backup snapshots and the GET/export full-map view where no
    // marker directory is at hand). Requires listPrefix.
    async function readAll() {
        const keys = listKeys();
        if (keys === null) throw new Error('pluginStorage per-key store: readAll needs kv.listPrefix');
        const out = {};
        for (const k of keys) {
            const v = await readKey(k);
            if (v !== undefined) safeSet(out, k, v);
        }
        return out;
    }

    // Full-map replace: write every given key and DELETE any stored key absent
    // from the new map (stale cleanup). Back-compat shape for a client that still
    // sends the whole map; concurrent full-map replaces still clobber, so the
    // delta path below is what a per-key-aware client should use.
    function replaceAll(map) {
        const next = map && typeof map === 'object' ? map : {};
        const existing = listKeys() || [];
        const nextKeys = new Set(Object.keys(next));
        for (const k of existing) if (!nextKeys.has(k)) removeKey(k);
        writeMany(next);
    }

    // Delta apply: touch ONLY the changed keys and remove ONLY the removed keys.
    // This is the concurrency-safe path — two clients changing DIFFERENT keys
    // never collide, because each write lands in its own KV entry.
    function applyDelta({ changed, removed } = {}) {
        if (changed && typeof changed === 'object') writeMany(changed);
        if (Array.isArray(removed)) for (const k of removed) removeKey(k);
    }

    return {
        prefix: PLUGIN_STORAGE_PERKEY_PREFIX, kvKeyFor,
        writeKey, readKey, removeKey, writeMany, loader, listKeys,
        readAll, replaceAll, applyDelta,
    };
}

module.exports = { createPluginStoragePerKeyStore, PLUGIN_STORAGE_PERKEY_PREFIX, kvKeyFor };
