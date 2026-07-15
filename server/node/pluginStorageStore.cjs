// Server-side sidecar store for pluginCustomStorage (B inc 3c).
//
// The whole point of the sidecar is to keep pluginCustomStorage OUT of the
// monolithic database.bin so it is no longer re-encoded / held resident with the
// main DB on every save. This module is the server's persistent home for that
// payload: a dedicated KV key, encoded with the same save codec as everything
// else. It is a pure factory (like chunkStore.cjs) over a small kv interface so
// it can be unit-tested without booting the server; server.cjs wires it to the
// real KV.
//
// Nothing writes this store in production yet — the client write-enable (a later
// increment) will POST the payload to the receiving endpoint, which calls
// write(). Until then this is dormant; read() returns null (no sidecar), which
// keeps the dual-read/fail-closed contract intact (a directory marker with no
// stored sidecar fails closed rather than reporting empty).

const { encodeRisuSaveLegacy, decodeRisuSave } = require('./utils.cjs');

// Sidecar lives beside database.bin under its own key, never inside it.
const PLUGIN_STORAGE_SIDECAR_KEY = 'database/pluginStorage.bin';

/**
 * @param {{ get(key:string): (Buffer|Uint8Array|null), set(key:string, value:Buffer): void, del(key:string): void }} kv
 * @param {string} [key]
 */
function createPluginStorageSidecarStore(kv, key = PLUGIN_STORAGE_SIDECAR_KEY) {
    if (!kv || typeof kv.get !== 'function' || typeof kv.set !== 'function') {
        throw new Error('createPluginStorageSidecarStore: kv with get/set/del required');
    }

    // Persist the whole pluginCustomStorage map. Wrapped in { pluginCustomStorage }
    // so the encoded blob is self-describing and decodes symmetrically with read().
    function write(pluginCustomStorage) {
        const payload = { pluginCustomStorage: pluginCustomStorage ?? {} };
        kv.set(key, Buffer.from(encodeRisuSaveLegacy(payload)));
    }

    // Returns the stored pluginCustomStorage map, or null if the sidecar is
    // absent. null is the "no sidecar" signal the dual-read resolver needs to
    // distinguish legacy-empty from new-layout-missing (fail closed).
    async function read() {
        const raw = kv.get(key);
        if (!raw || raw.length === 0) return null;
        const decoded = await decodeRisuSave(raw);
        const pcs = decoded && typeof decoded === 'object' ? decoded.pluginCustomStorage : undefined;
        return pcs === undefined ? null : pcs;
    }

    // Loader shaped for hydratePluginCustomStorageServer(dbObj, loader): ignores
    // the directory argument for now (the whole store is one blob), returns the
    // stored map or null.
    async function loader(_directory) {
        return read();
    }

    function remove() {
        if (typeof kv.del === 'function') kv.del(key);
    }

    return { key, write, read, loader, remove };
}

module.exports = { createPluginStorageSidecarStore, PLUGIN_STORAGE_SIDECAR_KEY };
