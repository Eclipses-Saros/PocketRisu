import { describe, expect, test } from 'vitest'
import {
    applyProfileSnapshotUpdate,
    diffProfileSnapshot,
    getProfileUpdateAvailability,
} from './profileUpdate'
import type {
    BaseProviderDefinition,
    ModelPreset,
    ModelProfile,
    RegistryCache,
    RegistryFieldSchema,
    RegistryUiSchema,
    ResolvedModelProfileSnapshot,
} from './types'

function makeRegistry(profiles: ModelProfile[], baseProviders: BaseProviderDefinition[]): RegistryCache {
    const baseMap: Record<string, BaseProviderDefinition> = {}
    for (const b of baseProviders) baseMap[b.id] = b
    const profileMap: Record<string, ModelProfile> = {}
    for (const p of profiles) profileMap[p.id] = p
    return {
        schemaVersion: 4,
        registries: {
            synthetic: {
                fetchedAt: 0,
                baseProviders: baseMap,
                profiles: profileMap,
            },
        },
    }
}

function makeBaseProvider(overrides: Partial<BaseProviderDefinition> = {}): BaseProviderDefinition {
    return {
        id: 'demo',
        version: 1,
        displayName: 'Demo',
        adapterKind: 'openai-compatible',
        authKinds: ['bearer'],
        endpointKinds: ['static'],
        defaultHeaders: { 'Content-Type': 'application/json' },
        requestSchema: [
            {
                key: 'apiKey',
                type: 'string',
                label: 'API Key',
                secret: true,
                mapsTo: { target: 'auth', path: 'apiKey' },
            },
            {
                key: 'modelId',
                type: 'string',
                label: 'Model ID',
                mapsTo: { target: 'body', path: 'model' },
            },
        ],
        uiSchema: {
            groups: [{ id: 'credentials', label: 'Credentials', order: 1 }],
            fields: [
                { key: 'apiKey', widget: 'secret', visibility: 'basic', group: 'credentials' },
                { key: 'modelId', widget: 'text', visibility: 'basic', group: 'credentials' },
            ],
        },
        capabilities: ['streaming'],
        sourceUrls: ['https://example.test'],
        ...overrides,
    }
}

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
    return {
        id: 'demo:standard',
        version: 1,
        displayName: 'Demo Standard',
        providerBaseId: 'demo',
        profileTier: 'standard',
        modelId: 'demo-fast',
        endpoint: { kind: 'static', url: 'https://demo.test/v1/chat/completions' },
        auth: { kind: 'bearer', fields: ['apiKey'] },
        defaults: {},
        schema: [],
        uiSchema: { groups: [], fields: [] },
        sourceUrls: ['https://example.test/profile'],
        ...overrides,
    }
}

function makeSnapshot(overrides: Partial<ResolvedModelProfileSnapshot> = {}): ResolvedModelProfileSnapshot {
    return {
        profileId: 'demo:standard',
        profileVersion: 1,
        providerBaseId: 'demo',
        providerBaseVersion: 1,
        adapterKind: 'openai-compatible',
        auth: { kind: 'bearer', fields: ['apiKey'] },
        endpoint: { kind: 'static', url: 'https://demo.test/v1/chat/completions' },
        modelId: 'demo-fast',
        schema: [
            {
                key: 'apiKey',
                type: 'string',
                label: 'API Key',
                secret: true,
                mapsTo: { target: 'auth', path: 'apiKey' },
            },
            {
                key: 'modelId',
                type: 'string',
                label: 'Model ID',
                mapsTo: { target: 'body', path: 'model' },
            },
        ],
        uiSchema: {
            groups: [{ id: 'credentials', label: 'Credentials', order: 1 }],
            fields: [
                { key: 'apiKey', widget: 'secret', visibility: 'basic', group: 'credentials' },
                { key: 'modelId', widget: 'text', visibility: 'basic', group: 'credentials' },
            ],
        },
        defaults: {},
        headerTemplate: { 'Content-Type': 'application/json' },
        capabilities: ['streaming'],
        ...overrides,
    }
}

function makePreset(overrides: Partial<ModelPreset> = {}): ModelPreset {
    return {
        id: 'preset-1',
        name: 'My Preset',
        profileSnapshot: makeSnapshot(),
        userValues: { apiKey: 'sk-test', modelId: 'demo-fast' },
        sourceProfile: {
            registryId: 'synthetic',
            profileId: 'demo:standard',
            profileVersion: 1,
            fetchedAt: 100,
        },
        createdAt: 100,
        updatedAt: 100,
        ...overrides,
    }
}

describe('getProfileUpdateAvailability', () => {
    test('returns no-source when preset has no sourceProfile', () => {
        const preset = makePreset({ sourceProfile: undefined })
        const registry = makeRegistry([makeProfile()], [makeBaseProvider()])
        expect(getProfileUpdateAvailability(preset, registry)).toEqual({ status: 'no-source' })
    })

    test('returns profile-missing when registry lacks the source profile id', () => {
        const preset = makePreset()
        const registry = makeRegistry(
            [makeProfile({ id: 'demo:other' })],
            [makeBaseProvider()],
        )
        expect(getProfileUpdateAvailability(preset, registry)).toEqual({
            status: 'profile-missing',
            profileId: 'demo:standard',
        })
    })

    test('returns current when versions match', () => {
        const preset = makePreset()
        const registry = makeRegistry([makeProfile({ version: 1 })], [makeBaseProvider()])
        expect(getProfileUpdateAvailability(preset, registry)).toEqual({
            status: 'current',
            profileId: 'demo:standard',
            version: 1,
        })
    })

    test('returns available with latest snapshot when registry version is higher', () => {
        const preset = makePreset()
        const registry = makeRegistry(
            [makeProfile({ version: 2, modelId: 'demo-faster' })],
            [makeBaseProvider()],
        )
        const result = getProfileUpdateAvailability(preset, registry, { now: () => 999 })
        if (result.status !== 'available') throw new Error(`expected available, got ${result.status}`)
        expect(result.fromVersion).toBe(1)
        expect(result.toVersion).toBe(2)
        expect(result.latestSnapshot.profileVersion).toBe(2)
        expect(result.latestSnapshot.modelId).toBe('demo-faster')
        expect(result.latestSourceProfile).toEqual({
            registryId: 'synthetic',
            profileId: 'demo:standard',
            profileVersion: 2,
            providerBaseVersion: 1,
            fetchedAt: 999,
        })
    })

    test('uses the source registry id when multiple registries contain the same profile id', () => {
        const preset = makePreset({
            sourceProfile: {
                registryId: 'remote',
                profileId: 'demo:standard',
                profileVersion: 1,
                fetchedAt: 100,
            },
        })
        const baseProvider = makeBaseProvider()
        const registry: RegistryCache = {
            schemaVersion: 4,
            registries: {
                bundled: {
                    fetchedAt: 0,
                    baseProviders: { demo: baseProvider },
                    profiles: { 'demo:standard': makeProfile({ version: 1 }) },
                },
                remote: {
                    fetchedAt: 0,
                    baseProviders: { demo: baseProvider },
                    profiles: {
                        'demo:standard': makeProfile({ version: 2, modelId: 'demo-remote' }),
                    },
                },
            },
        }

        const result = getProfileUpdateAvailability(preset, registry, { now: () => 1234 })
        if (result.status !== 'available') throw new Error(`expected available, got ${result.status}`)
        expect(result.toVersion).toBe(2)
        expect(result.latestSnapshot.modelId).toBe('demo-remote')
        expect(result.latestSourceProfile).toEqual({
            registryId: 'remote',
            profileId: 'demo:standard',
            profileVersion: 2,
            providerBaseVersion: 1,
            fetchedAt: 1234,
        })
    })

    test('returns downgrade when registry version is lower than current', () => {
        const preset = makePreset({
            sourceProfile: {
                registryId: 'synthetic',
                profileId: 'demo:standard',
                profileVersion: 5,
                fetchedAt: 100,
            },
        })
        const registry = makeRegistry([makeProfile({ version: 2 })], [makeBaseProvider()])
        expect(getProfileUpdateAvailability(preset, registry)).toEqual({
            status: 'downgrade',
            profileId: 'demo:standard',
            currentVersion: 5,
            registryVersion: 2,
        })
    })

    test('returns available when only the base provider version bumped', () => {
        // Mirrors the Anthropic max_tokens scenario (option B+C round 1 P1):
        // base provider v1 → v2 introduces a new `defaultBody` but the profile
        // version stays the same. Detection should now flag the update so the
        // user can refresh the snapshot.
        const preset = makePreset({
            sourceProfile: {
                registryId: 'synthetic',
                profileId: 'demo:standard',
                profileVersion: 1,
                providerBaseVersion: 1,
                fetchedAt: 100,
            },
        })
        const registry = makeRegistry(
            [makeProfile({ version: 1 })],
            [makeBaseProvider({ version: 2, defaultBody: { max_tokens: 4096 } })],
        )
        const result = getProfileUpdateAvailability(preset, registry, { now: () => 500 })
        if (result.status !== 'available') throw new Error(`expected available, got ${result.status}`)
        expect(result.latestSnapshot.providerBaseVersion).toBe(2)
        expect(result.latestSourceProfile.providerBaseVersion).toBe(2)
        expect(result.latestSourceProfile.profileVersion).toBe(1)
    })

    test('treats legacy sourceProfile (no providerBaseVersion) as current to avoid mass update noise', () => {
        // Presets persisted before providerBaseVersion existed leave the field
        // undefined. Detection treats undefined as "matches latest" so legacy
        // presets do not flood the UI with update cards on every base bump.
        // Adapter-side safety nets (e.g., ANTHROPIC_FALLBACK_MAX_TOKENS)
        // cover the functional gap for those legacy snapshots.
        const preset = makePreset({
            sourceProfile: {
                registryId: 'synthetic',
                profileId: 'demo:standard',
                profileVersion: 1,
                // providerBaseVersion intentionally omitted
                fetchedAt: 100,
            },
        })
        const registry = makeRegistry(
            [makeProfile({ version: 1 })],
            [makeBaseProvider({ version: 2 })],
        )
        expect(getProfileUpdateAvailability(preset, registry)).toEqual({
            status: 'current',
            profileId: 'demo:standard',
            version: 1,
        })
    })

    test('available when both profile version and base provider version bumped', () => {
        const preset = makePreset({
            sourceProfile: {
                registryId: 'synthetic',
                profileId: 'demo:standard',
                profileVersion: 1,
                providerBaseVersion: 1,
                fetchedAt: 100,
            },
        })
        const registry = makeRegistry(
            [makeProfile({ version: 2 })],
            [makeBaseProvider({ version: 2 })],
        )
        const result = getProfileUpdateAvailability(preset, registry, { now: () => 700 })
        if (result.status !== 'available') throw new Error(`expected available, got ${result.status}`)
        expect(result.fromVersion).toBe(1)
        expect(result.toVersion).toBe(2)
        expect(result.latestSourceProfile.providerBaseVersion).toBe(2)
    })

    test('returns downgrade when source providerBaseVersion is higher than registry', () => {
        const preset = makePreset({
            sourceProfile: {
                registryId: 'synthetic',
                profileId: 'demo:standard',
                profileVersion: 1,
                providerBaseVersion: 5,
                fetchedAt: 100,
            },
        })
        const registry = makeRegistry(
            [makeProfile({ version: 1 })],
            [makeBaseProvider({ version: 2 })],
        )
        expect(getProfileUpdateAvailability(preset, registry)).toEqual({
            status: 'downgrade',
            profileId: 'demo:standard',
            currentVersion: 1,
            registryVersion: 1,
        })
    })
})

describe('diffProfileSnapshot', () => {
    test('returns no changes for identical snapshots', () => {
        const snapshot = makeSnapshot()
        const diff = diffProfileSnapshot(snapshot, makeSnapshot())
        expect(diff.schemaChanges).toEqual([])
        expect(diff.uiSchemaFieldChanges).toEqual([])
        expect(diff.uiSchemaGroupChanges).toEqual([])
        expect(diff.endpointChanged).toBe(false)
        expect(diff.authChanged).toBe(false)
        expect(diff.modelIdChanged).toBe(false)
        expect(diff.capabilitiesChanged).toBe(false)
        expect(diff.defaultsChanged).toBe(false)
        expect(diff.bodyTemplateChanged).toBe(false)
        expect(diff.headerTemplateChanged).toBe(false)
        expect(diff.providerBaseChanged).toBe(false)
        expect(diff.adapterKindChanged).toBe(false)
    })

    test('detects added, removed, and modified schema fields', () => {
        const current = makeSnapshot()
        const latest = makeSnapshot({
            profileVersion: 2,
            schema: [
                {
                    key: 'apiKey',
                    type: 'string',
                    label: 'API Key (renamed)',
                    secret: true,
                    mapsTo: { target: 'auth', path: 'apiKey' },
                },
                {
                    key: 'reasoning',
                    type: 'string',
                    label: 'Reasoning Effort',
                    mapsTo: { target: 'body', path: 'reasoning_effort' },
                },
            ],
        })
        const diff = diffProfileSnapshot(current, latest)
        const byKey = Object.fromEntries(diff.schemaChanges.map((c) => [c.key, c]))
        expect(byKey.apiKey?.changeKind).toBe('modified')
        expect(byKey.apiKey?.modifiedAttributes).toEqual(['label'])
        expect(byKey.modelId?.changeKind).toBe('removed')
        expect(byKey.reasoning?.changeKind).toBe('added')
    })

    test('marks schema field type change with fromType/toType', () => {
        const current = makeSnapshot()
        const latest = makeSnapshot({
            schema: [
                { key: 'apiKey', type: 'string', label: 'API Key', secret: true },
                { key: 'modelId', type: 'integer', label: 'Model ID' },
            ],
        })
        const diff = diffProfileSnapshot(current, latest)
        const modelChange = diff.schemaChanges.find((c) => c.key === 'modelId')
        expect(modelChange?.changeKind).toBe('modified')
        expect(modelChange?.fromType).toBe('string')
        expect(modelChange?.toType).toBe('integer')
        expect(modelChange?.modifiedAttributes).toContain('type')
    })

    test('detects endpoint url change', () => {
        const current = makeSnapshot()
        const latest = makeSnapshot({
            endpoint: { kind: 'static', url: 'https://demo.test/v2/chat/completions' },
        })
        const diff = diffProfileSnapshot(current, latest)
        expect(diff.endpointChanged).toBe(true)
    })

    test('detects auth kind change', () => {
        const current = makeSnapshot()
        const latest = makeSnapshot({ auth: { kind: 'x-api-key', fields: ['apiKey'] } })
        const diff = diffProfileSnapshot(current, latest)
        expect(diff.authChanged).toBe(true)
    })

    test('detects modelId, capabilities, defaults, and template changes', () => {
        const current = makeSnapshot()
        const latest = makeSnapshot({
            modelId: 'demo-faster',
            capabilities: ['streaming', 'vision'],
            defaults: { temperature: 0.7 },
            bodyTemplate: { stream: true },
            headerTemplate: { 'Content-Type': 'application/json', 'X-Extra': '1' },
        })
        const diff = diffProfileSnapshot(current, latest)
        expect(diff.modelIdChanged).toBe(true)
        expect(diff.capabilitiesChanged).toBe(true)
        expect(diff.defaultsChanged).toBe(true)
        expect(diff.bodyTemplateChanged).toBe(true)
        expect(diff.headerTemplateChanged).toBe(true)
    })

    test('detects ui group and field changes', () => {
        const current = makeSnapshot()
        const latest = makeSnapshot({
            uiSchema: {
                groups: [
                    { id: 'credentials', label: 'Credentials', order: 1 },
                    { id: 'advanced', label: 'Advanced', order: 2 },
                ],
                fields: [
                    { key: 'apiKey', widget: 'secret', visibility: 'basic', group: 'credentials' },
                    { key: 'modelId', widget: 'select', visibility: 'basic', group: 'credentials' },
                ],
            },
        })
        const diff = diffProfileSnapshot(current, latest)
        expect(diff.uiSchemaGroupChanges).toEqual([{ id: 'advanced', changeKind: 'added' }])
        const modelChange = diff.uiSchemaFieldChanges.find((c) => c.key === 'modelId')
        expect(modelChange?.changeKind).toBe('modified')
        expect(modelChange?.modifiedAttributes).toEqual(['widget'])
    })
})

describe('applyProfileSnapshotUpdate', () => {
    test('keeps user values whose schema field survives unchanged', () => {
        const preset = makePreset({
            userValues: { apiKey: 'sk-test', modelId: 'demo-fast' },
        })
        const latestSnapshot = makeSnapshot({ profileVersion: 2 })
        const result = applyProfileSnapshotUpdate(preset, latestSnapshot, { now: () => 200 })
        expect(result.preset.userValues).toEqual({ apiKey: 'sk-test', modelId: 'demo-fast' })
        expect(result.preset.orphanValues).toBeUndefined()
        expect(result.movedToOrphan).toEqual([])
        expect(result.newFieldKeys).toEqual([])
        expect(result.preset.profileSnapshot.profileVersion).toBe(2)
        expect(result.preset.updatedAt).toBe(200)
    })

    test('moves user values to orphanValues when schema field is removed', () => {
        const preset = makePreset({
            userValues: { apiKey: 'sk-test', modelId: 'demo-fast', removedKey: 'gone' },
            profileSnapshot: makeSnapshot({
                schema: [
                    ...makeSnapshot().schema,
                    {
                        key: 'removedKey',
                        type: 'string',
                        label: 'Removed',
                        mapsTo: { target: 'body', path: 'removed' },
                    },
                ],
            }),
        })
        const latestSnapshot = makeSnapshot({ profileVersion: 2 })
        const result = applyProfileSnapshotUpdate(preset, latestSnapshot, { now: () => 300 })
        expect(result.preset.userValues).toEqual({ apiKey: 'sk-test', modelId: 'demo-fast' })
        expect(result.preset.orphanValues).toEqual({ removedKey: 'gone' })
        expect(result.movedToOrphan).toEqual([
            { key: 'removedKey', value: 'gone', reason: 'removed' },
        ])
    })

    test('moves user values to orphanValues when field type changes', () => {
        const preset = makePreset({
            userValues: { apiKey: 'sk-test', modelId: 'demo-fast' },
        })
        const latestSnapshot = makeSnapshot({
            profileVersion: 2,
            schema: [
                makePreset().profileSnapshot.schema[0],
                {
                    key: 'modelId',
                    type: 'integer',
                    label: 'Model ID',
                    mapsTo: { target: 'body', path: 'model' },
                },
            ],
        })
        const result = applyProfileSnapshotUpdate(preset, latestSnapshot, { now: () => 400 })
        expect(result.preset.userValues).toEqual({ apiKey: 'sk-test' })
        expect(result.preset.orphanValues).toEqual({ modelId: 'demo-fast' })
        expect(result.movedToOrphan).toEqual([
            { key: 'modelId', value: 'demo-fast', reason: 'type-changed' },
        ])
    })

    test('reports new field keys added in the latest snapshot', () => {
        const preset = makePreset()
        const latestSnapshot = makeSnapshot({
            profileVersion: 2,
            schema: [
                ...makeSnapshot().schema,
                {
                    key: 'reasoning',
                    type: 'string',
                    label: 'Reasoning Effort',
                    mapsTo: { target: 'body', path: 'reasoning_effort' },
                },
            ],
        })
        const result = applyProfileSnapshotUpdate(preset, latestSnapshot)
        expect(result.newFieldKeys).toEqual(['reasoning'])
        expect(result.preset.userValues).toEqual({ apiKey: 'sk-test', modelId: 'demo-fast' })
    })

    test('uses provided sourceProfile and falls back to bumping the current one', () => {
        const preset = makePreset()
        const latestSnapshot = makeSnapshot({ profileVersion: 3 })

        const explicit = applyProfileSnapshotUpdate(preset, latestSnapshot, {
            now: () => 500,
            sourceProfile: {
                registryId: 'custom',
                profileId: 'demo:standard',
                profileVersion: 3,
                fetchedAt: 500,
            },
        })
        expect(explicit.preset.sourceProfile).toEqual({
            registryId: 'custom',
            profileId: 'demo:standard',
            profileVersion: 3,
            fetchedAt: 500,
        })

        const bumped = applyProfileSnapshotUpdate(preset, latestSnapshot, { now: () => 600 })
        expect(bumped.preset.sourceProfile).toEqual({
            registryId: 'synthetic',
            profileId: 'demo:standard',
            profileVersion: 3,
            providerBaseVersion: 1,
            fetchedAt: 600,
        })

        const noSource = applyProfileSnapshotUpdate(
            makePreset({ sourceProfile: undefined }),
            latestSnapshot,
            { now: () => 700 },
        )
        expect(noSource.preset.sourceProfile).toBeUndefined()
    })

    test('does not keep stale sourceProfile fallback when latest snapshot is for a different profile', () => {
        const result = applyProfileSnapshotUpdate(
            makePreset(),
            makeSnapshot({ profileId: 'demo:other', profileVersion: 2 }),
            { now: () => 800 },
        )
        expect(result.preset.sourceProfile).toBeUndefined()
    })

    test('uses one timestamp for sourceProfile fallback and updatedAt', () => {
        let currentTime = 900
        const result = applyProfileSnapshotUpdate(
            makePreset(),
            makeSnapshot({ profileVersion: 2 }),
            { now: () => currentTime++ },
        )
        expect(result.preset.sourceProfile?.fetchedAt).toBe(900)
        expect(result.preset.updatedAt).toBe(900)
    })

    test('accumulates orphan values across consecutive updates', () => {
        const initialSnapshot = makeSnapshot({
            schema: [
                ...makeSnapshot().schema,
                {
                    key: 'legacyA',
                    type: 'string',
                    label: 'A',
                    mapsTo: { target: 'body', path: 'a' },
                },
                {
                    key: 'legacyB',
                    type: 'string',
                    label: 'B',
                    mapsTo: { target: 'body', path: 'b' },
                },
            ],
        })
        const preset = makePreset({
            profileSnapshot: initialSnapshot,
            userValues: { apiKey: 'sk', modelId: 'm', legacyA: 'a-value', legacyB: 'b-value' },
        })

        const afterFirst = applyProfileSnapshotUpdate(
            preset,
            makeSnapshot({
                profileVersion: 2,
                schema: [
                    ...makeSnapshot().schema,
                    {
                        key: 'legacyB',
                        type: 'string',
                        label: 'B',
                        mapsTo: { target: 'body', path: 'b' },
                    },
                ],
            }),
            { now: () => 800 },
        ).preset
        expect(afterFirst.orphanValues).toEqual({ legacyA: 'a-value' })

        const afterSecond = applyProfileSnapshotUpdate(
            afterFirst,
            makeSnapshot({ profileVersion: 3 }),
            { now: () => 900 },
        ).preset
        expect(afterSecond.orphanValues).toEqual({ legacyA: 'a-value', legacyB: 'b-value' })
    })

    test('available result feeds applyProfileSnapshotUpdate end-to-end', () => {
        const preset = makePreset()
        const registry = makeRegistry(
            [
                makeProfile({
                    version: 4,
                    schema: [
                        {
                            key: 'reasoning',
                            type: 'string',
                            label: 'Reasoning Effort',
                            enum: [
                                { value: 'low', label: 'Low' },
                                { value: 'high', label: 'High' },
                            ],
                            mapsTo: { target: 'body', path: 'reasoning_effort' },
                        },
                    ],
                    uiSchema: {
                        groups: [],
                        fields: [
                            { key: 'reasoning', widget: 'select', visibility: 'advanced' },
                        ],
                    },
                }),
            ],
            [makeBaseProvider()],
        )
        const availability = getProfileUpdateAvailability(preset, registry, { now: () => 1000 })
        if (availability.status !== 'available') {
            throw new Error(`expected available, got ${availability.status}`)
        }
        const result = applyProfileSnapshotUpdate(preset, availability.latestSnapshot, {
            now: () => 1000,
            sourceProfile: availability.latestSourceProfile,
        })
        expect(result.preset.sourceProfile?.profileVersion).toBe(4)
        expect(result.newFieldKeys).toContain('reasoning')
        expect(result.preset.profileSnapshot.schema.map((f) => f.key)).toEqual([
            'apiKey',
            'modelId',
            'reasoning',
        ])
    })
})

// Tiny smoke that imports the shared types compile cleanly; keeps unused-import lint quiet
// when refactoring the test helpers.
function _typeGuards(_field: RegistryFieldSchema, _ui: RegistryUiSchema): void {}
void _typeGuards
