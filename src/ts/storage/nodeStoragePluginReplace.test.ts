import { describe, it, expect, vi } from 'vitest'

// codex round-6 HIGH: a Map/typed/symbol-keyed payload serializes (msgpack) to a
// plain {} on the wire — the server then can't tell it from a legitimate empty
// replace, so a full replace of {} would WIPE the store. The CLIENT is the only
// place that can catch it (before encoding). Prove savePluginStorageReplace refuses
// such payloads BEFORE any encode/network (i.e. throws the guard error, not a fetch
// error).
//
// Same mocks as the patch-sync integration test so importing nodeStorage stays pure.
vi.mock('./database.svelte', () => ({ getDatabase: () => ({}), setDatabase: () => {}, DBState: { db: {} }, getCurrentChat: () => ({}), getCurrentCharacter: () => ({}) }))
vi.mock('./chatStorage', () => ({ chatToStub: (c: any) => c }))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null }, alertError: () => {} }))

const { NodeStorage } = await import('./nodeStorage')

describe('NodeStorage.savePluginStorageReplace — plain-map guard (codex round-6)', () => {
    const ns: any = new NodeStorage()
    // any network attempt would throw a DIFFERENT (fetch) error; asserting the guard
    // message proves it refused BEFORE encoding/sending.
    const GUARD = /plain string-keyed|wipe the store/i

    it('refuses a Map (would serialize to {} and wipe)', async () => {
        await expect(ns.savePluginStorageReplace(new Map() as any)).rejects.toThrow(GUARD)
    })
    it('refuses Date / typed array / array / primitives / null', async () => {
        for (const bad of [new Date(), new Uint8Array([1]), [1, 2], 'x', 42, null, undefined] as any[]) {
            await expect(ns.savePluginStorageReplace(bad), String(bad)).rejects.toThrow(GUARD)
        }
    })
    it('refuses an object whose data is only in symbol / non-enumerable / accessor props', async () => {
        const symOnly: any = {}; symOnly[Symbol('k')] = 'v'
        const nonEnum: any = {}; Object.defineProperty(nonEnum, 'k', { value: 'v', enumerable: false })
        const getterOnly: any = {}; Object.defineProperty(getterOnly, 'k', { get: () => 'v', enumerable: true })
        for (const bad of [symOnly, nonEnum, getterOnly]) {
            await expect(ns.savePluginStorageReplace(bad)).rejects.toThrow(/plain string-keyed|non-string|enumerable data property/i)
        }
    })

    // codex round-7 HIGH #2: codec-unsafe keys rejected before encoding.
    it('refuses codec-unsafe keys (__proto__, lone surrogate)', async () => {
        const protoKey: any = {}; Object.defineProperty(protoKey, '__proto__', { value: 'v', enumerable: true, writable: true, configurable: true })
        await expect(ns.savePluginStorageReplace(protoKey)).rejects.toThrow(/codec-unsafe|__proto__/i)
        const surrogate: any = {}; surrogate['\uD800'] = 'v'
        await expect(ns.savePluginStorageReplace(surrogate)).rejects.toThrow(/codec-unsafe|surrogate/i)
    })

    // codex round-7 HIGH #1: a stateful Proxy is snapshotted in ONE enumeration before
    // encoding, so it cannot present different keys to the validator vs the encoder.
    it('reads a stateful Proxy exactly once (snapshot before encode)', async () => {
        let calls = 0
        const proxy = new Proxy({ keep: 'v' }, {
            ownKeys(t) { calls++; return calls === 1 ? Reflect.ownKeys(t) : [] },
        })
        // no server here → the call will reject at the network step AFTER a successful
        // snapshot; assert the proxy was enumerated exactly once (not re-read by encode).
        await ns.savePluginStorageReplace(proxy as any).catch(() => {})
        expect(calls).toBe(1)
    })
})
