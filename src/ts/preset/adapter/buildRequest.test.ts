import { describe, expect, test } from 'vitest'
import type { ModelPreset, ResolvedModelProfileSnapshot } from '../types'
import { buildPreparedRequest } from './buildRequest'
import { ModelPresetAdapterError } from './error'

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
        uiSchema: { groups: [], fields: [] },
        defaults: {},
        headerTemplate: { 'Content-Type': 'application/json' },
        capabilities: ['streaming'],
        ...overrides,
    }
}

function makePreset(overrides: Partial<ModelPreset> = {}): ModelPreset {
    return {
        id: 'preset-1',
        name: 'Demo Preset',
        profileSnapshot: makeSnapshot(),
        userValues: { modelId: 'demo-fast' },
        createdAt: 100,
        updatedAt: 100,
        ...overrides,
    }
}

describe('buildPreparedRequest', () => {
    test('builds body from defaults + bodyTemplate + userValues mapsTo + auth header', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                defaults: { stream: false, temperature: 0.5 },
                bodyTemplate: { max_tokens: 1024 },
            }),
            userValues: { modelId: 'demo-faster', temperature: 0.9 },
        })
        const result = buildPreparedRequest({
            preset,
            credential: { apiKey: 'sk-test' },
        })
        expect(result.method).toBe('POST')
        expect(result.url).toBe('https://demo.test/v1/chat/completions')
        expect(result.body).toEqual({
            stream: false,
            temperature: 0.5,
            max_tokens: 1024,
            model: 'demo-faster',
        })
        expect(result.headers).toEqual({
            'Content-Type': 'application/json',
            Authorization: 'Bearer sk-test',
        })
    })

    test('falls back to schema default when userValues lacks the key', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'reasoning',
                        type: 'string',
                        label: 'Reasoning Effort',
                        default: 'low',
                        mapsTo: { target: 'body', path: 'reasoning_effort' },
                    },
                ],
            }),
            userValues: {},
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({ reasoning_effort: 'low' })
    })

    test('skips fields without mapsTo and ignores auth/custom targets at body merge', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    { key: 'helpOnly', type: 'string', label: 'help only' },
                    {
                        key: 'customExt',
                        type: 'string',
                        label: 'Custom',
                        mapsTo: { target: 'custom', path: 'whatever' },
                    },
                ],
            }),
            userValues: { helpOnly: 'visible', customExt: 'ignored' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({})
    })

    test('routes header and query mapsTo targets', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'projectId',
                        type: 'string',
                        label: 'Project',
                        mapsTo: { target: 'header', path: 'X-Project-Id' },
                    },
                    {
                        key: 'apiVersion',
                        type: 'string',
                        label: 'API Version',
                        mapsTo: { target: 'query', path: 'api-version' },
                    },
                ],
            }),
            userValues: { projectId: 'proj-123', apiVersion: '2025-05-01' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.headers['X-Project-Id']).toBe('proj-123')
        expect(result.url).toBe('https://demo.test/v1/chat/completions?api-version=2025-05-01')
    })

    test('writes nested body mapsTo paths', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'thinkingBudget',
                        type: 'integer',
                        label: 'Thinking Budget',
                        mapsTo: { target: 'body', path: 'thinking.budget_tokens' },
                    },
                ],
            }),
            userValues: { thinkingBudget: 1024 },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({ thinking: { budget_tokens: 1024 } })
    })

    test('customBody and customHeaders override prior merges', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                defaults: { stream: false },
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
            }),
            userValues: { modelId: 'demo-fast' },
            customBody: { stream: true, model: 'demo-overridden', extra: 1 },
            customHeaders: { 'X-Custom': '1', 'Content-Type': 'application/x-custom' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({ stream: true, model: 'demo-overridden', extra: 1 })
        expect(result.headers).toEqual({
            'Content-Type': 'application/x-custom',
            'X-Custom': '1',
            Authorization: 'Bearer sk',
        })
    })

    test('builds the Vertex OpenAI endpoint URL from custom-mapped project + location', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                auth: { kind: 'google-service-account', fields: ['serviceAccountJson'] },
                endpoint: { kind: 'vertex-openai' },
                schema: [
                    {
                        key: 'serviceAccountJson',
                        type: 'string',
                        label: 'Service Account JSON',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'project',
                        type: 'string',
                        label: 'GCP Project',
                        mapsTo: { target: 'custom', path: 'project' },
                    },
                    {
                        key: 'location',
                        type: 'string',
                        label: 'Vertex Location',
                        default: 'us-central1',
                        mapsTo: { target: 'custom', path: 'location' },
                    },
                ],
            }),
            userValues: { project: 'my-proj' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'ya29.token' } })
        expect(result.url).toBe(
            'https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/endpoints/openapi/chat/completions',
        )
        expect(result.headers.Authorization).toBe('Bearer ya29.token')
    })

    test('falls back to schema default for Vertex location when userValues omits it', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                auth: { kind: 'google-service-account', fields: ['serviceAccountJson'] },
                endpoint: { kind: 'vertex-openai' },
                schema: [
                    {
                        key: 'serviceAccountJson',
                        type: 'string',
                        label: 'SA',
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'project',
                        type: 'string',
                        label: 'Project',
                        mapsTo: { target: 'custom', path: 'project' },
                    },
                    {
                        key: 'location',
                        type: 'string',
                        label: 'Location',
                        default: 'global',
                        mapsTo: { target: 'custom', path: 'location' },
                    },
                ],
            }),
            userValues: { project: 'my-proj' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
        expect(result.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/endpoints/openapi/chat/completions',
        )
    })

    test('throws invalid-request when Vertex project is missing', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                auth: { kind: 'google-service-account', fields: ['serviceAccountJson'] },
                endpoint: { kind: 'vertex-openai' },
                schema: [
                    {
                        key: 'project',
                        type: 'string',
                        label: 'Project',
                        mapsTo: { target: 'custom', path: 'project' },
                    },
                    {
                        key: 'location',
                        type: 'string',
                        label: 'Location',
                        default: 'us-central1',
                        mapsTo: { target: 'custom', path: 'location' },
                    },
                ],
            }),
            userValues: {},
        })
        try {
            buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
            if (err instanceof ModelPresetAdapterError) {
                expect(err.kind).toBe('invalid-request')
                expect(err.retryable).toBe(false)
            }
        }
    })

    test('throws invalid-request when Vertex location is missing', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                auth: { kind: 'google-service-account', fields: ['serviceAccountJson'] },
                endpoint: { kind: 'vertex-openai' },
                schema: [
                    {
                        key: 'project',
                        type: 'string',
                        label: 'Project',
                        mapsTo: { target: 'custom', path: 'project' },
                    },
                    {
                        key: 'location',
                        type: 'string',
                        label: 'Location',
                        mapsTo: { target: 'custom', path: 'location' },
                    },
                ],
            }),
            userValues: { project: 'p' },
        })
        try {
            buildPreparedRequest({ preset, credential: { apiKey: 'tok' } })
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
            if (err instanceof ModelPresetAdapterError) {
                expect(err.kind).toBe('invalid-request')
            }
        }
    })

    test('throws invalid-request when static endpoint has no url', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                endpoint: { kind: 'static', url: '' },
            }),
        })
        try {
            buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
            if (err instanceof ModelPresetAdapterError) {
                expect(err.kind).toBe('invalid-request')
                expect(err.retryable).toBe(false)
            }
        }
    })

    test('does not mutate nested objects inside snapshot defaults/bodyTemplate or customBody', () => {
        const defaults = { thinking: { type: 'enabled' as const } }
        const bodyTemplate = { tools: [{ name: 'search' }] }
        const customBody = { extras: { nested: { value: 1 } } }
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                defaults,
                bodyTemplate,
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'thinkingBudget',
                        type: 'integer',
                        label: 'Thinking Budget',
                        mapsTo: { target: 'body', path: 'thinking.budget_tokens' },
                    },
                ],
            }),
            userValues: { thinkingBudget: 1024 },
            customBody,
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({
            thinking: { type: 'enabled', budget_tokens: 1024 },
            tools: [{ name: 'search' }],
            extras: { nested: { value: 1 } },
        })
        // input objects must remain untouched
        expect(defaults).toEqual({ thinking: { type: 'enabled' } })
        expect(bodyTemplate).toEqual({ tools: [{ name: 'search' }] })
        expect(customBody).toEqual({ extras: { nested: { value: 1 } } })
        // body subtree must be its own reference graph
        expect(result.body.thinking).not.toBe(defaults.thinking)
        expect(result.body.tools).not.toBe(bodyTemplate.tools)
        expect((result.body.extras as Record<string, unknown>).nested)
            .not.toBe(customBody.extras.nested)
    })

    test('falls back to snapshot.modelId when modelId schema field default is backfilled', () => {
        // simulates the post-backfill snapshot resolveSnapshot produces for model-specific profiles
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                modelId: 'gpt-5',
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
                        default: 'gpt-5',
                        mapsTo: { target: 'body', path: 'model' },
                    },
                ],
            }),
            userValues: {},
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({ model: 'gpt-5' })
    })

    test('resolves endpoint URL from userValues when schema has custom endpointUrl mapping', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                endpoint: { kind: 'static', url: '' },
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'endpointUrl',
                        type: 'string',
                        label: 'Endpoint URL',
                        mapsTo: { target: 'custom', path: 'endpointUrl' },
                    },
                    {
                        key: 'modelId',
                        type: 'string',
                        label: 'Model ID',
                        mapsTo: { target: 'body', path: 'model' },
                    },
                ],
            }),
            userValues: {
                endpointUrl: 'https://my-proxy.example/v1/chat/completions',
                modelId: 'demo-fast',
            },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.url).toBe('https://my-proxy.example/v1/chat/completions')
        expect(result.body).toEqual({ model: 'demo-fast' })
    })

    test('endpoint override takes precedence over snapshot.endpoint.url', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                endpoint: { kind: 'static', url: 'https://demo.test/v1/chat/completions' },
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'endpointUrl',
                        type: 'string',
                        label: 'Endpoint URL',
                        mapsTo: { target: 'custom', path: 'endpointUrl' },
                    },
                ],
            }),
            userValues: { endpointUrl: 'https://override.example/v1' },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.url).toBe('https://override.example/v1')
    })

    test('empty endpoint override throws invalid-request', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                endpoint: { kind: 'static', url: '' },
                schema: [
                    {
                        key: 'endpointUrl',
                        type: 'string',
                        label: 'Endpoint URL',
                        mapsTo: { target: 'custom', path: 'endpointUrl' },
                    },
                ],
            }),
            userValues: { endpointUrl: '' },
        })
        try {
            buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
            if (err instanceof ModelPresetAdapterError) {
                expect(err.kind).toBe('invalid-request')
            }
        }
    })

    test('userValues explicit null suppresses schema default fallback', () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                schema: [
                    {
                        key: 'apiKey',
                        type: 'string',
                        label: 'API Key',
                        secret: true,
                        mapsTo: { target: 'auth', path: 'apiKey' },
                    },
                    {
                        key: 'reasoning',
                        type: 'string',
                        label: 'Reasoning',
                        default: 'low',
                        mapsTo: { target: 'body', path: 'reasoning_effort' },
                    },
                ],
            }),
            userValues: { reasoning: null },
        })
        const result = buildPreparedRequest({ preset, credential: { apiKey: 'sk' } })
        expect(result.body).toEqual({ reasoning_effort: null })
    })
})
