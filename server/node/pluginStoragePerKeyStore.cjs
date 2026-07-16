// Server-side PER-KEY store for pluginCustomStorage (b3 layout; SSOT).
//
// The single-blob sidecar (pluginStorageStore.cjs) keeps all plugin keys in ONE
// KV entry. That reintroduces the coupling B set out to remove: two clients saving
// concurrently both rewrite the whole blob, so the later write silently drops the
// earlier client's per-key changes. It also keeps the whole-store re-serialization
// in the save path.
//
// This store mirrors the proven PER-CHAT model: each pluginCustomStorage key is its
// own SQLite KV row, so a write touches only that key and concurrent writes to
// DIFFERENT keys never collide. THE SQLITE ROWS ARE THE AUTHORITY — the set of keys
// IS `listPrefix('pluginStorage/data/')`. There is NO separate manifest listing
// "which keys should exist": a committed SQLite row cannot spontaneously vanish, and
// multi-row writes are atomic (one transaction), so the row set is always
// self-consistent. A second authority (a key-list manifest) would only ADD a way for
// the two to diverge — and defending that divergence would cost whole-store work per
// save, the exact cost this store exists to remove. The original monolithic blob had
// no "a row vanished" failure mode either; per-key + atomic writes matches that
// safety WITHOUT the whole-store save cost.
//
// The ONLY server-side state beyond the rows is a tiny MODE sentinel: "is this
// account out-of-band?" — a per-account flag, NOT authority over the data. It
// distinguishes an initialized-but-empty store from a never-migrated (legacy inline)
// one. It lives in the server store, never in database.bin and never in the client
// flag, so it cannot recreate the marker's hash/patch/ETag coupling.
//
// Pure factory over a small kv interface so it unit-tests without booting the server.

const { encodeRisuSaveLegacy, decodeRisuSave, validatePluginStorageDirectory, PLUGIN_STORAGE_SIDECAR_MARKER } = require('./utils.cjs');

// SSOT namespace. Per-key VALUE rows live under pluginStorage/data/, one KV row
// each, never inside database.bin. The mode sentinel lives under pluginStorage/
// control/ — a NESTED path with a .json suffix, IMPOSSIBLE under the old flat
// pluginStorage/<enc>.bin scheme, so no real plugin key can ever collide with it.
// encodeURIComponent makes an arbitrary plugin key a reversible, KV-safe segment.
const PLUGIN_STORAGE_ROOT_PREFIX = 'pluginStorage/';
const PLUGIN_STORAGE_PERKEY_PREFIX = 'pluginStorage/data/';
const PLUGIN_STORAGE_MODE_KEY = 'pluginStorage/control/mode.json';
// Layout/mode version. Distinct from the database.bin marker version (2).
const PLUGIN_STORAGE_MODE_VERSION = 3;

function kvKeyFor(pluginKey) {
    const s = String(pluginKey);
    let enc;
    // encodeURIComponent throws URIError on a lone surrogate. A plugin key with an
    // unpaired surrogate is pathological; reject it with a clear, fail-closed error.
    try { enc = encodeURIComponent(s); }
    catch (e) { throw new Error(`pluginStorage key not encodable (lone surrogate or invalid string): ${e && e.message}`); }
    return `${PLUGIN_STORAGE_PERKEY_PREFIX}${enc}.bin`;
}

// Set an OWN enumerable property even for dangerous names like '__proto__'.
function safeSet(obj, key, value) {
    Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

// The mode sentinel is a per-account flag, not authority over data. Only its EXACT
// shape is trusted — exactly the own keys {version, state} — so a stray object (e.g.
// a leftover key-list-shaped {version,state,keys:[...]}) is 'corrupt', never silently
// accepted or downgraded to legacy (which would ignore live per-key rows).
function isValidMode(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m) || m.__corrupt === true) return false;
    const keys = Object.keys(m);
    if (keys.length !== 2 || !keys.includes('version') || !keys.includes('state')) return false;
    return m.version === PLUGIN_STORAGE_MODE_VERSION && m.state === 'initialized';
}

// A replace payload MUST be a PLAIN object map. A string/array/null/typed object
// (Date, Uint8Array, RegExp, Map, …) must NEVER be accepted or coerced to {} — a
// typed object has zero enumerable own keys, so a full replace would silently DELETE
// the whole store. Require the prototype to be Object.prototype or null (a bare map).
function isPlainMap(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
    const proto = Object.getPrototypeOf(x);
    if (proto !== Object.prototype && proto !== null) return false;
    // Every own key must be an ENUMERABLE STRING DATA property. A symbol key, a
    // non-enumerable prop, or an accessor (getter) would vanish through Object.keys /
    // serialization, so the map would silently shrink — and an object whose data is
    // all in such props would serialize to {} and WIPE the store on a full replace.
    // (A live Map/Date/typed array is already rejected by the prototype check.)
    for (const k of Reflect.ownKeys(x)) {
        if (typeof k !== 'string') return false;
        const d = Object.getOwnPropertyDescriptor(x, k);
        if (!d || !d.enumerable || !('value' in d)) return false;
    }
    return true;
}

// A key is codec-safe iff it survives the msgpack save codec UNCHANGED. The codec
// rewrites "__proto__" (prototype-pollution guard) and replaces lone surrogates with
// U+FFFD — either would silently collapse a map key on the wire. Reject such keys
// FAIL-CLOSED (loud) rather than let a full replace delete the "vanished" row. Normal
// keys (unicode, ':', '/', spaces, etc.) are unaffected.
function isCodecSafeKey(k) {
    if (typeof k !== 'string') return false;
    if (k === '__proto__') return false;
    if (typeof k.isWellFormed === 'function') return k.isWellFormed();
    return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(k);
}

// Build a CANONICAL, immutable snapshot of an untrusted map in ONE enumeration:
// validate it is a plain object with only enumerable string DATA keys, reject any
// codec-unsafe key, and copy each descriptor VALUE once into a fresh null-proto
// object. Downstream code uses ONLY this snapshot and NEVER re-enumerates the
// original — a stateful Proxy can return different keys on a second read (validate
// vs encode/write), which would pass validation then wipe the store (TOCTOU).
function canonicalizeMap(x, label) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(`pluginStorage: ${label} must be a plain object map`);
    const proto = Object.getPrototypeOf(x);
    if (proto !== Object.prototype && proto !== null) throw new Error(`pluginStorage: ${label} must be a plain object map`);
    // SINGLE enumeration — do NOT call isPlainMap first (that would enumerate a second
    // time; a stateful Proxy could return different keys between the two passes → TOCTOU
    // wipe). Validate + snapshot in one Reflect.ownKeys walk, reading each descriptor
    // value once (never x[k], so no getter/Proxy trap re-runs).
    const out = Object.create(null);
    for (const k of Reflect.ownKeys(x)) {
        if (typeof k !== 'string') throw new Error(`pluginStorage: ${label} has a non-string key`);
        const d = Object.getOwnPropertyDescriptor(x, k);
        if (!d || !d.enumerable || !('value' in d)) throw new Error(`pluginStorage: ${label} key "${k}" is not an enumerable data property`);
        if (!isCodecSafeKey(k)) throw new Error(`pluginStorage: ${label} key "${k}" is codec-unsafe (__proto__ or lone surrogate) — rejected fail-closed`);
        out[k] = d.value;
    }
    return out;
}

/**
 * @param {{ get(key:string): (Buffer|Uint8Array|null), set(key:string, value:Buffer): void, del(key:string): void, listPrefix?(prefix:string): string[], transaction?(fn:()=>any): any }} kv
 */
function createPluginStoragePerKeyStore(kv) {
    if (!kv || typeof kv.get !== 'function' || typeof kv.set !== 'function' || typeof kv.del !== 'function') {
        throw new Error('createPluginStoragePerKeyStore: kv with get/set/del required');
    }

    // ---- Per-key primitives --------------------------------------------------
    // One key's value → one KV row, wrapped in { value } so it decodes symmetrically.
    // A single-key write is atomic in SQLite by itself; batch mutators below add a
    // transaction (all-or-nothing) plus the mode/flat guard.
    function writeKey(pluginKey, value) {
        kv.set(kvKeyFor(pluginKey), Buffer.from(encodeRisuSaveLegacy({ value: value ?? null })));
    }
    async function readKey(pluginKey) {
        const raw = kv.get(kvKeyFor(pluginKey));
        if (!raw || raw.length === 0) return undefined;
        const decoded = await decodeRisuSave(raw);
        return decoded && typeof decoded === 'object' ? decoded.value : undefined;
    }
    function removeKey(pluginKey) {
        kv.del(kvKeyFor(pluginKey));
    }

    // Run a synchronous multi-key mutation atomically when the kv provides a
    // transaction (real SQLite → BEGIN/COMMIT, nested → SAVEPOINT); otherwise run
    // directly. The callback MUST stay synchronous.
    function inTransaction(fn) {
        return typeof kv.transaction === 'function' ? kv.transaction(fn) : fn();
    }

    // ---- Mode sentinel -------------------------------------------------------
    //   readMode(): null (absent → legacy) | {__corrupt:true} (present but empty /
    //   unparseable / non-object) | the parsed object (validated by isValidMode).
    function readMode() {
        const raw = kv.get(PLUGIN_STORAGE_MODE_KEY);
        if (raw === null || raw === undefined) return null;
        if (raw.length === 0) return { __corrupt: true };
        let parsed;
        try { parsed = JSON.parse(Buffer.from(raw).toString('utf8')); }
        catch { return { __corrupt: true }; }
        // A present row that parses to a non-object (null/false/0/number/string) is
        // corrupt, NOT absent — it must never read back as "no mode" (legacy).
        if (parsed === null || typeof parsed !== 'object') return { __corrupt: true };
        return parsed;
    }
    function writeMode(mode) {
        kv.set(PLUGIN_STORAGE_MODE_KEY, Buffer.from(JSON.stringify(mode), 'utf8'));
    }
    // 'legacy' (no sentinel) | 'corrupt' (present-but-invalid) | 'initialized'.
    function modeState() {
        const m = readMode();
        if (m === null) return 'legacy';
        return isValidMode(m) ? 'initialized' : 'corrupt';
    }
    function isInitialized() { return modeState() === 'initialized'; }

    // Transition the store to out-of-band. ABSENT→initialized ONLY (refuse if a
    // sentinel already exists). Caller wraps in the same transaction as any value
    // writes so they commit atomically.
    function initializeMode() {
        if (readMode() !== null) {
            throw new Error('pluginStorage: initializeMode called but a mode sentinel already exists');
        }
        // Empty-init ONLY: refuse if any rows exist, so a manually-written partial row
        // set can never be blessed as authoritative (use initializeFromMap/replaceAll
        // to include rows atomically).
        if ((listKeys() || []).length > 0) {
            throw new Error('pluginStorage: initializeMode requires an empty store (rows already exist — use reconcileReplace with the complete map)');
        }
        if (hasLegacyFlatRows()) {
            throw new Error('pluginStorage: initializeMode with un-migrated flat rows present — failing closed');
        }
        writeMode({ version: PLUGIN_STORAGE_MODE_VERSION, state: 'initialized' });
    }

    // STRICT first-init from a full map: write every row AND set the mode in one
    // transaction. Refuses if a mode sentinel already exists, if data rows already
    // exist, or if un-migrated flat rows are present — a store with pre-existing rows
    // must be reconciled with replaceAll, not blessed into initialized (codex).
    function initializeFromMap(map) {
        const snap = canonicalizeMap(map, 'initializeFromMap'); // one enumeration → immutable snapshot
        inTransaction(() => {
            if (readMode() !== null) throw new Error('pluginStorage: initializeFromMap on a store that already has a mode sentinel');
            if ((listKeys() || []).length > 0) throw new Error('pluginStorage: initializeFromMap with pre-existing data rows — use reconcileReplace with the complete map');
            if (hasLegacyFlatRows()) throw new Error('pluginStorage: initializeFromMap with un-migrated flat rows present — failing closed');
            for (const k of Object.keys(snap)) writeKey(k, snap[k]);
            writeMode({ version: PLUGIN_STORAGE_MODE_VERSION, state: 'initialized' });
        });
    }

    // Guard at the START of every STEADY-STATE batch mutation (writeMany/applyDelta):
    // the store MUST be initialized. A corrupt sentinel, a legacy (uninitialized)
    // store, or un-migrated flat rows all refuse. First-init is initializeFromMap;
    // authoritative reconcile/import is replaceAll. This makes "legacy + data rows"
    // impossible to reach via the steady-state path.
    function assertInitialized() {
        const st = modeState();
        if (st === 'corrupt') throw new Error('pluginStorage: refusing to mutate — mode sentinel is corrupt');
        if (st === 'legacy') throw new Error('pluginStorage: refusing to mutate — store not initialized (send a full replace first)');
        if (hasLegacyFlatRows()) throw new Error('pluginStorage: refusing to mutate — un-migrated flat rows present (reconcile first)');
    }

    // ---- Batch mutators (atomic) --------------------------------------------
    function writeMany(entries) {
        if (!entries || typeof entries !== 'object') return;
        inTransaction(() => {
            assertInitialized();
            for (const k of Object.keys(entries)) writeKey(k, entries[k]);
        });
    }
    // Delta apply: touch ONLY changed/removed keys — the concurrency-safe steady-state
    // path. Requires an initialized store. Canonicalize `changed` (snapshot, one
    // enumeration, codec-safe keys) BEFORE the transaction, and validate every removed
    // key is codec-safe, so a Proxy/typed/codec-unsafe payload can never slip through.
    function applyDelta({ changed, removed } = {}) {
        const snap = (changed === undefined || changed === null) ? null : canonicalizeMap(changed, 'delta changed');
        const rm = Array.isArray(removed) ? removed : [];
        for (const k of rm) {
            if (!isCodecSafeKey(k)) throw new Error(`pluginStorage: delta removed key "${String(k)}" is codec-unsafe — rejected fail-closed`);
        }
        inTransaction(() => {
            assertInitialized();
            if (snap) for (const k of Object.keys(snap)) writeKey(k, snap[k]);
            for (const k of rm) removeKey(k);
        });
    }
    // Internal: overwrite the whole map + set initialized, in one transaction. The
    // map MUST already be validated as a plain object by the caller.
    function writeWholeMap(next) {
        inTransaction(() => {
            if (hasLegacyFlatRows()) throw new Error('pluginStorage: refusing full replace — un-migrated flat rows present (reconcile first)');
            const existing = listKeys() || [];
            const nextKeys = new Set(Object.keys(next));
            for (const k of existing) if (!nextKeys.has(k)) removeKey(k);
            for (const k of Object.keys(next)) writeKey(k, next[k]);
            writeMode({ version: PLUGIN_STORAGE_MODE_VERSION, state: 'initialized' });
        });
    }

    // PUBLIC first-sync / re-sync (the /api/plugin-storage `replace` envelope). STRICT
    // precondition so it can never MASK corruption or an ambiguous partial state and
    // never coerces a malformed payload to {} (which would wipe the store): the map
    // must be a plain object, and the store must be either pristine-legacy (no rows)
    // or already-initialized. Corrupt / legacy-with-rows / flat all fail LOUD — use
    // reconcileReplace for explicit recovery/import.
    function replaceAll(map) {
        const snap = canonicalizeMap(map, 'replace'); // snapshot BEFORE any precondition read
        const st = modeState();
        if (st === 'corrupt') throw new Error('pluginStorage: refusing replace — mode sentinel is corrupt (use reconcileReplace to recover)');
        if (st === 'legacy' && (listKeys() || []).length > 0) throw new Error('pluginStorage: refusing replace — data rows without an initialized mode (ambiguous; use reconcileReplace)');
        writeWholeMap(snap);
    }

    // EXPLICIT recovery / import reconcile: authoritatively overwrites WHATEVER state
    // is there (corrupt, ambiguous, initialized) with the given map, leaving a clean
    // initialized store. Still refuses a non-object payload and un-migrated flat rows.
    // Distinct from replaceAll so the steady-state path can never silently overwrite a
    // corrupt/ambiguous store — recovery must be an explicit choice.
    function reconcileReplace(map) {
        const snap = canonicalizeMap(map, 'reconcile'); // snapshot; never re-enumerate the original
        writeWholeMap(snap);
    }

    // ---- Reads / reassembly --------------------------------------------------
    // Reassemble from a directory (the marker's key list). FAIL CLOSED on a listed
    // key with no entry. Used by the server hydrate drop-in path.
    async function loader(directory) {
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

    // The authoritative key set: every data/ row. Never enumerates the mode sentinel.
    function listKeys() {
        if (typeof kv.listPrefix !== 'function') return null;
        const raw = kv.listPrefix(PLUGIN_STORAGE_PERKEY_PREFIX) || [];
        return raw
            .filter((k) => k.startsWith(PLUGIN_STORAGE_PERKEY_PREFIX) && k.endsWith('.bin'))
            .map((k) => decodeURIComponent(k.slice(PLUGIN_STORAGE_PERKEY_PREFIX.length, -'.bin'.length)));
    }

    // Any pre-namespace flat rows still present (pluginStorage/<enc>.bin, no nested
    // '/')? Their presence means migration has not completed; reads/mutations fail
    // closed rather than silently ignoring them (they are invisible to the data/ scan).
    function hasLegacyFlatRows() {
        if (typeof kv.listPrefix !== 'function') return false;
        const all = kv.listPrefix(PLUGIN_STORAGE_ROOT_PREFIX) || [];
        return all.some((k) =>
            k.startsWith(PLUGIN_STORAGE_ROOT_PREFIX) && k.endsWith('.bin') &&
            !k.slice(PLUGIN_STORAGE_ROOT_PREFIX.length, -'.bin'.length).includes('/'));
    }

    // Capture every data/ row's RAW bytes in ONE synchronous pass. In NodeOnly there
    // is a single process and a single better-sqlite3 connection, so this synchronous
    // list+get loop IS a point-in-time snapshot (no other connection can commit
    // between statements). If a second SQLite connection is ever introduced, wrap the
    // list+gets in one read transaction. FAILS CLOSED on a listed key whose row is
    // empty/missing (corruption), never silently shorting the map.
    function readAllRaw() {
        const keys = listKeys();
        if (keys === null) throw new Error('pluginStorage per-key store: readAllRaw needs kv.listPrefix');
        const rows = [];
        for (const pluginKey of keys) {
            const raw = kv.get(kvKeyFor(pluginKey));
            if (!raw || raw.length === 0) {
                throw new Error(`pluginStorage: listed key "${pluginKey}" has an empty/missing row — failing closed`);
            }
            rows.push({ pluginKey, raw: Buffer.from(raw) });
        }
        return rows;
    }

    // Reassemble the WHOLE stored map (GET/export/backup). FAIL CLOSED throughout: a
    // corrupt mode sentinel, un-migrated flat rows, an empty/missing row, or a row
    // that decodes without a `value` all throw — a partial/short map is never
    // returned. There is NO key-list cross-check: the rows ARE the key set.
    async function readAll() {
        const st = modeState();
        if (st === 'corrupt') {
            throw new Error('pluginStorage: mode sentinel corrupt — failing closed (never read as empty)');
        }
        if (hasLegacyFlatRows()) {
            throw new Error('pluginStorage: un-migrated flat rows present — failing closed (would be invisible to the data/ scan)');
        }
        // rows present without an initialized mode = the ambiguous partial-migration
        // state the classifier flags — never read those rows as authoritative.
        if (st === 'legacy' && (listKeys() || []).length > 0) {
            throw new Error('pluginStorage: data rows present without an initialized mode (ambiguous) — failing closed');
        }
        const rows = readAllRaw();
        const out = {};
        for (const { pluginKey, raw } of rows) {
            const decoded = await decodeRisuSave(raw);
            if (!decoded || typeof decoded !== 'object' || !Object.hasOwn(decoded, 'value')) {
                throw new Error(`pluginStorage: corrupt row for "${pluginKey}" (no value field) — failing closed`);
            }
            safeSet(out, pluginKey, decoded.value);
        }
        return out;
    }

    // ---- Reconciliation classifier ------------------------------------------
    //   legacy      — no mode, no rows: inline in the DB is authoritative
    //   initialized — mode ok, no DB-side pcs field: the per-key rows are authoritative
    //   ambiguous   — disagreement (un-migrated flat rows / rows without a mode /
    //                 dangling marker / DB-side pcs field after init): reconcile, never guess
    //   corrupt     — mode sentinel present-but-invalid
    function classify(dbObj) {
        const st = modeState();
        const flat = hasLegacyFlatRows();
        const hasRows = (listKeys() || []).length > 0;
        const isObj = !!(dbObj && typeof dbObj === 'object');
        const hasInlineField = isObj && Object.hasOwn(dbObj, 'pluginCustomStorage');
        const hasMarkerField = isObj && Object.hasOwn(dbObj, PLUGIN_STORAGE_SIDECAR_MARKER);
        const detail = { modeState: st, hasRows, hasInlineField, hasMarkerField, flatLegacy: flat };

        if (st === 'corrupt') return { state: 'corrupt', ...detail };
        if (flat) return { state: 'ambiguous', reason: 'un-migrated flat legacy rows present', ...detail };
        if (st === 'initialized') {
            if (hasInlineField || hasMarkerField) {
                return { state: 'ambiguous', reason: 'db-side pcs field present while SSOT is initialized', ...detail };
            }
            return { state: 'initialized', ...detail };
        }
        // legacy (no mode)
        if (hasRows) return { state: 'ambiguous', reason: 'per-key rows without a mode sentinel (partial migration)', ...detail };
        if (hasMarkerField) return { state: 'ambiguous', reason: 'db marker without a per-key store (dangling)', ...detail };
        return { state: 'legacy', ...detail };
    }

    // ---- One-time layout migration ------------------------------------------
    // Move every flat pre-namespace value row (pluginStorage/<enc>.bin, no nested
    // '/') down to pluginStorage/data/<enc>.bin. INCLUDES the empty key and a key
    // named "meta" (the mode sentinel is under control/…, not a flat *.bin). Preflight
    // per row inside one transaction:
    //   destination absent            → move
    //   byte-identical destination    → drop the stale flat duplicate
    //   present differing destination / zero-length destination / empty source → THROW
    // REFUSES outright if the store is already initialized and flat rows exist (that is
    // an ambiguous state — migrating would silently reshape an initialized store).
    // Idempotent: no flat rows → no-op.
    function migrateLegacyLayout() {
        if (typeof kv.listPrefix !== 'function') return { migrated: 0 };
        const all = kv.listPrefix(PLUGIN_STORAGE_ROOT_PREFIX) || [];
        const legacy = all.filter((k) =>
            k.startsWith(PLUGIN_STORAGE_ROOT_PREFIX) && k.endsWith('.bin') &&
            !k.slice(PLUGIN_STORAGE_ROOT_PREFIX.length, -'.bin'.length).includes('/'));
        if (legacy.length === 0) return { migrated: 0 };
        const st = modeState();
        if (st === 'initialized' || st === 'corrupt') {
            throw new Error(`pluginStorage: flat legacy rows present with mode '${st}' — failing closed (ambiguous, reconcile manually)`);
        }
        let migrated = 0;
        inTransaction(() => {
            for (const oldKey of legacy) {
                const mid = oldKey.slice(PLUGIN_STORAGE_ROOT_PREFIX.length, -'.bin'.length);
                const newKey = `${PLUGIN_STORAGE_PERKEY_PREFIX}${mid}.bin`;
                const src = kv.get(oldKey);
                if (!src || src.length === 0) {
                    throw new Error(`pluginStorage: legacy row "${oldKey}" is empty/missing — failing closed`);
                }
                const dst = kv.get(newKey);
                const dstPresent = dst !== null && dst !== undefined;
                if (dstPresent) {
                    if (dst.length === 0) {
                        throw new Error(`pluginStorage: destination "${newKey}" is a zero-length row (corruption) — failing closed`);
                    }
                    if (Buffer.compare(Buffer.from(dst), Buffer.from(src)) === 0) {
                        kv.del(oldKey); // byte-identical duplicate → drop the stale flat copy
                        migrated++;
                        continue;
                    }
                    throw new Error(`pluginStorage: migration conflict at "${newKey}" (differing destination exists) — failing closed`);
                }
                kv.set(newKey, Buffer.from(src));
                kv.del(oldKey);
                migrated++;
            }
        });
        // NOTE: migration does NOT set mode='initialized'. Flat rows prove the old
        // out-of-band path was USED, but NOT that the row set is COMPLETE — the
        // pre-sentinel writers were not completion-fenced, so a crash could have left
        // a partial set. Blessing a partial set as authoritative would let readAll
        // serve a short map. So migration only RELOCATES the bytes (atomically); the
        // store is left mode-absent = classify 'ambiguous' = reads/mutations fail
        // CLOSED (loud) until an explicit full reconcile (the client's complete
        // in-memory map) establishes 'initialized'. Completeness is asserted by the
        // reconcile, never inferred from flat rows.
        return { migrated };
    }

    return {
        prefix: PLUGIN_STORAGE_PERKEY_PREFIX, rootPrefix: PLUGIN_STORAGE_ROOT_PREFIX,
        modeKey: PLUGIN_STORAGE_MODE_KEY, modeVersion: PLUGIN_STORAGE_MODE_VERSION, kvKeyFor,
        writeKey, readKey, removeKey, writeMany, replaceAll, reconcileReplace, applyDelta,
        loader, listKeys, hasLegacyFlatRows, readAllRaw, readAll,
        readMode, modeState, isInitialized, initializeMode, initializeFromMap,
        classify, migrateLegacyLayout, inTransaction,
    };
}

module.exports = {
    createPluginStoragePerKeyStore,
    PLUGIN_STORAGE_PERKEY_PREFIX,
    PLUGIN_STORAGE_ROOT_PREFIX,
    PLUGIN_STORAGE_MODE_KEY,
    PLUGIN_STORAGE_MODE_VERSION,
    kvKeyFor,
    isPlainMap,
};
