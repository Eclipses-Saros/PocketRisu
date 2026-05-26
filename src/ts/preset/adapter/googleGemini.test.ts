import { describe, expect, test } from 'vitest'
import { loadBundledRegistry } from '../registry/loader'
import { resolveSnapshot } from '../registry/snapshot'
import type { ModelPreset, ResolvedModelProfileSnapshot } from '../types'
import { ModelPresetAdapterError } from './error'
import { sendGoogleChatRequest, streamGoogleChatRequest } from './googleGemini'
import type { AdapterChatMessage } from './types'

function makeSnapshot(overrides: Partial<ResolvedModelProfileSnapshot> = {}): ResolvedModelProfileSnapshot {
    return {
        profileId: 'demo:google',
        profileVersion: 1,
        providerBaseId: 'google',
        providerBaseVersion: 1,
        adapterKind: 'google-gemini',
        auth: { kind: 'x-goog-api-key', fields: ['apiKey'] },
        endpoint: { kind: 'static', url: 'https://demo.test/v1beta/models' },
        modelId: 'gemini-demo',
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
                default: 'gemini-demo',
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
        id: 'preset-google',
        name: 'Gemini',
        profileSnapshot: makeSnapshot(),
        userValues: {},
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    }
}

const messagesWithSystem: AdapterChatMessage[] = [
    { role: 'system', content: 'You are factual.' },
    { role: 'user', content: 'Hi' },
]

interface CapturedCall {
    url: string
    method: string
    headers: Record<string, string>
    body: Record<string, unknown>
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
    })
}

function sseResponse(chunks: string[]): Response {
    const encoder = new TextEncoder()
    let i = 0
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) {
                controller.enqueue(encoder.encode(chunks[i]))
                i++
            } else {
                controller.close()
            }
        },
    })
    return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
    })
}

function captureFetch(response: Response | (() => Response)): {
    fetchImpl: typeof fetch
    calls: CapturedCall[]
} {
    const calls: CapturedCall[] = []
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const headers = init?.headers as Record<string, string> | undefined
        const body = init?.body != null ? JSON.parse(init.body as string) : {}
        calls.push({
            url,
            method: (init?.method ?? 'GET') as string,
            headers: headers ?? {},
            body,
        })
        return typeof response === 'function' ? response() : response
    }
    return { fetchImpl, calls }
}

describe('sendGoogleChatRequest (non-stream)', () => {
    test('embeds modelId in URL path, uses x-goog-api-key, and sends contents + systemInstruction', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({
                candidates: [
                    {
                        content: { parts: [{ text: 'hello' }], role: 'model' },
                        finishReason: 'STOP',
                    },
                ],
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
            }),
        )
        const result = await sendGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'goog-test' },
        )
        expect(result.text).toBe('hello')
        expect(result.finishReason).toBe('STOP')
        expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 })

        expect(calls[0].url).toBe('https://demo.test/v1beta/models/gemini-demo:generateContent')
        expect(calls[0].headers['x-goog-api-key']).toBe('goog-test')
        expect(calls[0].body.model).toBeUndefined() // moved into URL path
        expect(calls[0].body.contents).toEqual([
            { role: 'user', parts: [{ text: 'Hi' }] },
        ])
        expect(calls[0].body.systemInstruction).toEqual({
            parts: [{ text: 'You are factual.' }],
        })
    })

    test('maps assistant role to model and merges multi-part text in candidate content', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({
                candidates: [
                    {
                        content: {
                            parts: [{ text: 'a ' }, { text: 'b' }],
                            role: 'model',
                        },
                    },
                ],
            }),
        )
        const result = await sendGoogleChatRequest(
            makePreset(),
            {
                messages: [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: 'r' },
                    { role: 'user', content: 'q2' },
                ],
                fetchImpl,
            },
            { apiKey: 'k' },
        )
        expect(result.text).toBe('a b')
        expect(calls[0].body.contents).toEqual([
            { role: 'user', parts: [{ text: 'q' }] },
            { role: 'model', parts: [{ text: 'r' }] },
            { role: 'user', parts: [{ text: 'q2' }] },
        ])
    })

    test('omits systemInstruction when no system messages', async () => {
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            makePreset(),
            { messages: [{ role: 'user', content: 'x' }], fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].body.systemInstruction).toBeUndefined()
    })

    test('rejects tool-role messages as unsupported rather than silently mapping them to user', async () => {
        // Gemini expresses tool results via `functionResponse` parts on
        // role `user`, not a `tool` role. Silently dropping the role would
        // corrupt the conversation; the adapter throws so the caller can
        // route to a tool-capable preset or drop the message.
        const { fetchImpl } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await expect(
            sendGoogleChatRequest(
                makePreset(),
                {
                    messages: [
                        { role: 'user', content: 'q' },
                        { role: 'tool', content: '{"r":1}', toolCallId: 'call-1' },
                    ],
                    fetchImpl,
                },
                { apiKey: 'k' },
            ),
        ).rejects.toMatchObject({ kind: 'unsupported', retryable: false, fallbackEligible: false })
    })

    test('URL-encodes modelId', async () => {
        const preset = makePreset({ userValues: { modelId: 'gemini/2.5-pro' } })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            preset,
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].url).toBe('https://demo.test/v1beta/models/gemini%2F2.5-pro:generateContent')
    })

    test('throws invalid-request when modelId is missing', async () => {
        const preset = makePreset({
            profileSnapshot: makeSnapshot({
                modelId: '',
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
        })
        const { fetchImpl } = captureFetch(jsonResponse({}))
        await expect(
            sendGoogleChatRequest(preset, { messages: messagesWithSystem, fetchImpl }, { apiKey: 'k' }),
        ).rejects.toMatchObject({ kind: 'invalid-request', retryable: false })
    })

    test('customBody cannot inject systemInstruction when user provided no system message', async () => {
        const preset = makePreset({
            customBody: { systemInstruction: { parts: [{ text: 'HIJACK' }] }, extra: 'kept' },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            preset,
            { messages: [{ role: 'user', content: 'hi' }], fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].body.systemInstruction).toBeUndefined()
        expect(calls[0].body.extra).toBe('kept')
    })

    test('customBody.systemInstruction cannot override user-provided system message', async () => {
        const preset = makePreset({
            customBody: { systemInstruction: { parts: [{ text: 'HIJACK' }] } },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            preset,
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].body.systemInstruction).toEqual({
            parts: [{ text: 'You are factual.' }],
        })
    })

    test('customBody.model cannot redirect the URL path modelId', async () => {
        const preset = makePreset({
            userValues: { modelId: 'gemini-real' },
            customBody: { model: 'HIJACK', generationConfig: { temperature: 0.5 } },
        })
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        )
        await sendGoogleChatRequest(
            preset,
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        expect(calls[0].url).toBe('https://demo.test/v1beta/models/gemini-real:generateContent')
        expect(calls[0].body.model).toBeUndefined()
        expect(calls[0].body.generationConfig).toEqual({ temperature: 0.5 })
    })

    test('non-stream promptFeedback.blockReason throws invalid-request (non-retryable, non-eligible)', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({
                promptFeedback: {
                    blockReason: 'SAFETY',
                    blockReasonMessage: 'Blocked due to safety policy.',
                },
            }),
        )
        await expect(
            sendGoogleChatRequest(makePreset(), { messages: messagesWithSystem, fetchImpl }, { apiKey: 'k' }),
        ).rejects.toMatchObject({
            kind: 'invalid-request',
            retryable: false,
            fallbackEligible: false,
            message: 'Gemini blocked the prompt: Blocked due to safety policy.',
        })
    })

    test('non-stream promptFeedback.blockReason without message falls back to the reason code', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }),
        )
        await expect(
            sendGoogleChatRequest(makePreset(), { messages: messagesWithSystem, fetchImpl }, { apiKey: 'k' }),
        ).rejects.toMatchObject({
            kind: 'invalid-request',
            message: 'Gemini blocked the prompt: SAFETY',
        })
    })

    test('classifies HTTP 400 with parsed message', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse(
                { error: { code: 400, message: 'invalid argument', status: 'INVALID_ARGUMENT' } },
                { status: 400 },
            ),
        )
        await expect(
            sendGoogleChatRequest(makePreset(), { messages: messagesWithSystem, fetchImpl }, { apiKey: 'k' }),
        ).rejects.toMatchObject({
            kind: 'invalid-request',
            status: 400,
            message: 'invalid argument',
        })
    })
})

describe('streamGoogleChatRequest', () => {
    test('yields accumulating textDelta from candidates parts and captures finishReason+usage', async () => {
        const { fetchImpl, calls } = captureFetch(
            sseResponse([
                'data: {"candidates":[{"content":{"parts":[{"text":"He"}],"role":"model"}}]}\n\n',
                'data: {"candidates":[{"content":{"parts":[{"text":"llo"}],"role":"model"}}]}\n\n',
                'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1,"totalTokenCount":4}}\n\n',
            ]),
        )
        const deltas: string[] = []
        let finishReason: string | undefined
        let usage: { promptTokens?: number } | undefined
        for await (const delta of streamGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )) {
            if (delta.textDelta) deltas.push(delta.textDelta)
            if (delta.finishReason) finishReason = delta.finishReason
            if (delta.usage) usage = delta.usage
        }
        expect(deltas.join('')).toBe('Hello')
        expect(finishReason).toBe('STOP')
        expect(usage).toEqual({ promptTokens: 3, completionTokens: 1, totalTokens: 4 })
        expect(calls[0].url).toBe('https://demo.test/v1beta/models/gemini-demo:streamGenerateContent?alt=sse')
        expect(calls[0].headers.Accept).toBe('text/event-stream')
    })

    test('throws parse error on non-JSON SSE data', async () => {
        const { fetchImpl } = captureFetch(sseResponse(['data: not json\n\n']))
        const gen = streamGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        await expect(gen.next()).rejects.toMatchObject({ kind: 'parse' })
    })

    test('stream promptFeedback.blockReason throws invalid-request mid-stream', async () => {
        const { fetchImpl } = captureFetch(
            sseResponse([
                'data: {"promptFeedback":{"blockReason":"SAFETY","blockReasonMessage":"Blocked due to safety policy."}}\n\n',
            ]),
        )
        const gen = streamGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        await expect(gen.next()).rejects.toMatchObject({
            kind: 'invalid-request',
            retryable: false,
            fallbackEligible: false,
            message: 'Gemini blocked the prompt: Blocked due to safety policy.',
        })
    })

    test('classifies HTTP 429 before streaming starts', async () => {
        const { fetchImpl } = captureFetch(
            jsonResponse({ error: { message: 'limited' } }, { status: 429 }),
        )
        const gen = streamGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        await expect(gen.next()).rejects.toMatchObject({
            kind: 'rate-limit',
            retryable: true,
            fallbackEligible: false,
        })
    })

    test('normalizes AbortError during stream body read', async () => {
        const abort = new Error('cancel')
        abort.name = 'AbortError'
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new TextEncoder().encode(
                    'data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\n\n',
                ))
                controller.error(abort)
            },
        })
        const fetchImpl: typeof fetch = async () => new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
        })
        const gen = streamGoogleChatRequest(
            makePreset(),
            { messages: messagesWithSystem, fetchImpl },
            { apiKey: 'k' },
        )
        const collect = async () => {
            const out: string[] = []
            for await (const delta of gen) {
                if (delta.textDelta) out.push(delta.textDelta)
            }
            return out
        }
        await expect(collect()).rejects.toMatchObject({ kind: 'aborted', retryable: false })
    })
})

describe('bundled google:standard profile integration', () => {
    test('google:standard routes to generateContent under the bundled base URL', async () => {
        const registry = loadBundledRegistry()
        const snapshot = resolveSnapshot(registry, 'google:standard')
        const preset: ModelPreset = {
            id: 'preset-gemini',
            name: 'Gemini',
            profileSnapshot: snapshot,
            userValues: { modelId: 'gemini-2.5-pro' },
            createdAt: 0,
            updatedAt: 0,
        }
        const { fetchImpl, calls } = captureFetch(
            jsonResponse({
                candidates: [
                    { content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' },
                ],
            }),
        )
        await sendGoogleChatRequest(preset, { messages: messagesWithSystem, fetchImpl }, { apiKey: 'gk' })
        expect(calls[0].url).toBe(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
        )
        expect(calls[0].headers['x-goog-api-key']).toBe('gk')
    })
})

describe('error class identity', () => {
    test('thrown error is ModelPresetAdapterError', async () => {
        const { fetchImpl } = captureFetch(jsonResponse({}, { status: 500 }))
        try {
            await sendGoogleChatRequest(
                makePreset(),
                { messages: messagesWithSystem, fetchImpl },
                { apiKey: 'k' },
            )
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
        }
    })
})
