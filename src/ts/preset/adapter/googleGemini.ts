import type { ModelPreset } from '../types'
import {
    ModelPresetAdapterError,
    extractErrorMessage,
    normalizeFetchError,
    normalizeHttpStatus,
} from './error'
import { prepareAdapterRequest } from './resolveCredential'
import { parseSseStream } from './sse'
import type {
    AdapterChatMessage,
    AdapterChatOptions,
    AdapterChatResponse,
    AdapterChatStreamDelta,
    AdapterCredential,
    AdapterPreparedRequest,
    AdapterReasoningPart,
    AdapterToolCall,
    AdapterToolDef,
    AdapterUsage,
} from './types'
import { resolveWireModelId } from './wireInvariants'

interface GeminiPart {
    text?: string
    thought?: boolean
    thoughtSignature?: string
    functionCall?: { id?: string; name: string; args: unknown }
    functionResponse?: { id?: string; name: string; response: unknown }
}

interface GeminiContent {
    role: 'user' | 'model'
    parts: GeminiPart[]
}

export async function sendGoogleChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterChatResponse> {
    const prepared = await prepareGeminiBody(preset, options, credential, false)
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    let response: Response
    try {
        response = await fetchImpl(prepared.url, {
            method: prepared.method,
            headers: prepared.headers,
            body: JSON.stringify(prepared.body),
            signal: options.abortSignal,
        })
    } catch (err) {
        throw normalizeFetchError(err)
    }

    if (!response.ok) {
        throw await deriveHttpError(response)
    }

    let raw: unknown
    try {
        raw = await response.json()
    } catch (err) {
        throw new ModelPresetAdapterError('parse', 'Failed to parse Gemini JSON response', {
            cause: err,
        })
    }

    return parseGeminiResponse(raw)
}

export async function* streamGoogleChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    const prepared = await prepareGeminiBody(preset, options, credential, true)
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    let response: Response
    try {
        response = await fetchImpl(prepared.url, {
            method: prepared.method,
            headers: { ...prepared.headers, Accept: 'text/event-stream' },
            body: JSON.stringify(prepared.body),
            signal: options.abortSignal,
        })
    } catch (err) {
        throw normalizeFetchError(err)
    }

    if (!response.ok) {
        throw await deriveHttpError(response)
    }

    if (!response.body) {
        throw new ModelPresetAdapterError('parse', 'Gemini stream response has no body')
    }

    try {
        for await (const event of parseSseStream(response.body)) {
            if (event.data.length === 0) continue
            let raw: unknown
            try {
                raw = JSON.parse(event.data)
            } catch (err) {
                throw new ModelPresetAdapterError(
                    'parse',
                    'Failed to parse Gemini stream chunk JSON',
                    { cause: err },
                )
            }
            const delta = parseGeminiStreamDelta(raw)
            if (delta) yield delta
        }
    } catch (err) {
        if (err instanceof ModelPresetAdapterError) throw err
        throw normalizeFetchError(err)
    }
}

// Build the request without sending it (previewBody). The model id lives in the
// URL path for Gemini, so the preview carries it there.
export function previewGoogleChatRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterPreparedRequest> {
    return prepareGeminiBody(preset, options, credential, false)
}

async function prepareGeminiBody(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential: AdapterCredential | undefined,
    stream: boolean,
): Promise<AdapterPreparedRequest> {
    const prepared = await prepareAdapterRequest({
        preset,
        credential,
        abortSignal: options.abortSignal,
    })
    // Wire invariants overwrite any customBody collisions (plan §4-5):
    //   - contents / systemInstruction → adapter owns the prompt structure
    //   - model (URL path)             → adapter selects the endpoint, not
    //                                    body.model (which Gemini ignores)
    // Resolve modelId from the preset's user values / schema, not the
    // customBody-merged body, so `customBody.model` cannot redirect the URL.
    const modelId = resolveWireModelId(preset, { vendorName: 'Google Gemini' })
    delete prepared.body.model

    const { system, chat } = collectSystemAndChat(options.messages)
    prepared.body.contents = toGeminiContents(chat)
    if (system.length > 0) {
        prepared.body.systemInstruction = { parts: [{ text: system }] }
    } else {
        delete prepared.body.systemInstruction
    }
    if (options.tools && options.tools.length > 0) {
        prepared.body.tools = [{ functionDeclarations: options.tools.map(toGeminiFunctionDeclaration) }]
    } else {
        // Tools are gated by the request, not customBody / additionalParams:
        // strip the whole tool-control surface when off so the OFF toggle is a
        // hard text-only gate (a lingering toolConfig would force/restrict calls).
        delete prepared.body.tools
        delete prepared.body.toolConfig
    }

    const suffix = stream ? ':streamGenerateContent?alt=sse' : ':generateContent'
    prepared.url = `${prepared.url}/${encodeURIComponent(modelId)}${suffix}`
    return prepared
}

function toGeminiFunctionDeclaration(tool: AdapterToolDef): Record<string, unknown> {
    return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

function collectSystemAndChat(messages: AdapterChatMessage[]): {
    system: string
    chat: AdapterChatMessage[]
} {
    const systems: string[] = []
    const chat: AdapterChatMessage[] = []
    for (const message of messages) {
        if (message.role === 'system') {
            systems.push(message.content)
        } else {
            // tool / user / assistant flow into the wire builder, which maps tool
            // results to functionResponse parts on a user turn (Gemini shape).
            chat.push(message)
        }
    }
    return { system: systems.join('\n\n'), chat }
}

// Build Gemini `contents`. Consecutive tool messages collapse into one `user`
// turn of `functionResponse` parts (Gemini answers tool calls on the user role).
// Assistant ("model") turns emit thought parts first (carrying thoughtSignature),
// then text, then functionCall parts — each functionCall echoing the signature
// Gemini issued, which thinking models require on the follow-up request.
function toGeminiContents(chat: AdapterChatMessage[]): GeminiContent[] {
    const out: GeminiContent[] = []
    let pendingFnResponses: GeminiPart[] = []

    const flush = () => {
        if (pendingFnResponses.length > 0) {
            out.push({ role: 'user', parts: pendingFnResponses })
            pendingFnResponses = []
        }
    }

    for (const message of chat) {
        if (message.role === 'tool') {
            const functionResponse: NonNullable<GeminiPart['functionResponse']> = {
                name: message.name ?? '',
                response: { result: message.content },
            }
            // Echo Gemini's call id (when present) so parallel same-name results
            // match unambiguously. Empty toolCallId → name-based matching.
            if (message.toolCallId) functionResponse.id = message.toolCallId
            pendingFnResponses.push({ functionResponse })
            continue
        }
        flush()
        if (message.role === 'assistant') {
            // Verbatim re-send of the model's own parts (thoughtSignatures intact)
            // when captured this request; reconstruct for history-restored turns.
            const parts = Array.isArray(message.providerEcho)
                ? (message.providerEcho as GeminiPart[])
                : toModelParts(message)
            out.push({ role: 'model', parts })
        } else {
            out.push({ role: 'user', parts: [{ text: message.content }] })
        }
    }
    flush()
    return out
}

function toModelParts(message: AdapterChatMessage): GeminiPart[] {
    const parts: GeminiPart[] = []
    for (const part of message.reasoning ?? []) {
        if (part.text !== undefined) {
            parts.push({ text: part.text, thought: true, thoughtSignature: part.signature })
        }
    }
    if (message.content.length > 0) {
        parts.push({ text: message.content })
    }
    for (const call of message.toolCalls ?? []) {
        const functionCall: NonNullable<GeminiPart['functionCall']> = { name: call.name, args: parseToolArgs(call.arguments) }
        if (call.id) functionCall.id = call.id
        const fc: GeminiPart = { functionCall }
        if (call.signature) fc.thoughtSignature = call.signature
        parts.push(fc)
    }
    if (parts.length === 0) parts.push({ text: '' })
    return parts
}

function parseToolArgs(args: string): unknown {
    if (!args) return {}
    try {
        return JSON.parse(args)
    } catch {
        return {}
    }
}

async function deriveHttpError(response: Response): Promise<ModelPresetAdapterError> {
    let bodyText = ''
    try {
        bodyText = await response.text()
    } catch {
        // ignore body read failures
    }
    const message = extractErrorMessage(bodyText) ?? `HTTP ${response.status}`
    return normalizeHttpStatus(response.status, message)
        ?? new ModelPresetAdapterError('unknown', message, { status: response.status })
}

function parseGeminiResponse(raw: unknown): AdapterChatResponse {
    if (!isPlainObject(raw)) {
        throw new ModelPresetAdapterError('parse', 'Gemini response is not an object')
    }
    const candidates = raw['candidates']
    if (!Array.isArray(candidates) || candidates.length === 0) {
        // Per Google docs, no-candidates responses signal that the prompt
        // itself was rejected. Surface promptFeedback.blockReason as a
        // non-retryable invalid-request rather than misclassifying as parser
        // failure (which would otherwise be retry/fallback eligible).
        throwIfPromptBlocked(raw['promptFeedback'])
        throw new ModelPresetAdapterError('parse', 'Gemini response has no candidates')
    }
    const first = candidates[0]
    if (!isPlainObject(first)) {
        throw new ModelPresetAdapterError('parse', 'First Gemini candidate is not an object')
    }
    const parsed = parseGeminiParts(first['content'])
    const finishReason = typeof first['finishReason'] === 'string'
        ? (first['finishReason'] as string)
        : undefined
    const echoParts = isPlainObject(first['content']) && Array.isArray((first['content'] as Record<string, unknown>)['parts'])
        ? (first['content'] as Record<string, unknown>)['parts']
        : undefined
    return {
        text: parsed.text,
        toolCalls: parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
        reasoning: parsed.reasoning.length > 0 ? parsed.reasoning : undefined,
        // Keep the raw parts so a tool follow-up resends the model turn verbatim —
        // Gemini requires every thoughtSignature back on the exact part it issued,
        // including signatures on plain text parts.
        providerEcho: echoParts,
        finishReason,
        usage: parseGeminiUsage(raw['usageMetadata']),
        raw,
    }
}

// Split a Gemini candidate's content into visible text, tool calls, and reasoning
// (thought) parts. functionCall parts carry a thoughtSignature that thinking
// models require echoed back on the follow-up request.
function parseGeminiParts(content: unknown): {
    text: string
    toolCalls: AdapterToolCall[]
    reasoning: AdapterReasoningPart[]
} {
    const text: string[] = []
    const toolCalls: AdapterToolCall[] = []
    const reasoning: AdapterReasoningPart[] = []
    if (isPlainObject(content) && Array.isArray(content['parts'])) {
        for (const part of content['parts']) {
            if (!isPlainObject(part)) continue
            const signature = typeof part['thoughtSignature'] === 'string'
                ? (part['thoughtSignature'] as string)
                : undefined
            const fn = part['functionCall']
            if (isPlainObject(fn) && typeof fn['name'] === 'string') {
                toolCalls.push({
                    // Keep Gemini's real call id when present so it round-trips on
                    // the wire (functionCall/functionResponse id matching for
                    // same-name parallel calls). When omitted, leave it empty:
                    // encodeToolCall mints a unique KV key (`|| v4()`), and the
                    // wire falls back to name-based matching.
                    id: typeof fn['id'] === 'string' ? (fn['id'] as string) : '',
                    name: fn['name'] as string,
                    arguments: JSON.stringify(fn['args'] ?? {}),
                    signature,
                })
            } else if (part['thought'] === true && typeof part['text'] === 'string') {
                reasoning.push({ text: part['text'] as string, signature })
            } else if (typeof part['text'] === 'string') {
                text.push(part['text'] as string)
            }
        }
    }
    return { text: text.join(''), toolCalls, reasoning }
}

function parseGeminiStreamDelta(raw: unknown): AdapterChatStreamDelta | null {
    if (!isPlainObject(raw)) return null
    // Surface stream-level prompt blocks the same way as non-stream so the
    // user sees a real error instead of an empty stream that ends silently.
    throwIfPromptBlocked(raw['promptFeedback'])
    const candidates = raw['candidates']
    let textDelta = ''
    let finishReason: string | undefined
    if (Array.isArray(candidates) && candidates.length > 0 && isPlainObject(candidates[0])) {
        const first = candidates[0] as Record<string, unknown>
        textDelta = extractTextFromContent(first['content'])
        if (typeof first['finishReason'] === 'string') {
            finishReason = first['finishReason'] as string
        }
    }
    const usage = parseGeminiUsage(raw['usageMetadata'])
    if (textDelta.length === 0 && finishReason === undefined && usage === undefined) {
        return null
    }
    return { textDelta, finishReason, usage, raw }
}

function throwIfPromptBlocked(feedback: unknown): void {
    if (!isPlainObject(feedback)) return
    const reason = feedback['blockReason']
    if (typeof reason !== 'string' || reason.length === 0) return
    const message = typeof feedback['blockReasonMessage'] === 'string' && (feedback['blockReasonMessage'] as string).length > 0
        ? (feedback['blockReasonMessage'] as string)
        : reason
    throw new ModelPresetAdapterError(
        'invalid-request',
        `Gemini blocked the prompt: ${message}`,
        { retryable: false, fallbackEligible: false },
    )
}

function extractTextFromContent(content: unknown): string {
    if (!isPlainObject(content)) return ''
    const parts = content['parts']
    if (!Array.isArray(parts)) return ''
    let text = ''
    for (const part of parts) {
        if (isPlainObject(part) && typeof part['text'] === 'string') {
            text += part['text'] as string
        }
    }
    return text
}

function parseGeminiUsage(raw: unknown): AdapterUsage | undefined {
    if (!isPlainObject(raw)) return undefined
    const usage: AdapterUsage = {}
    if (typeof raw['promptTokenCount'] === 'number') {
        usage.promptTokens = raw['promptTokenCount'] as number
    }
    if (typeof raw['candidatesTokenCount'] === 'number') {
        usage.completionTokens = raw['candidatesTokenCount'] as number
    }
    if (typeof raw['totalTokenCount'] === 'number') {
        usage.totalTokens = raw['totalTokenCount'] as number
    }
    if (
        usage.promptTokens === undefined
        && usage.completionTokens === undefined
        && usage.totalTokens === undefined
    ) {
        return undefined
    }
    return usage
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
