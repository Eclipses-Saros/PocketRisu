import type { ModelPreset } from '../types'

export interface AdapterCredential {
    apiKey?: string
    inlineCredential?: unknown
}

export interface AdapterRequestContext {
    preset: ModelPreset
    credential?: AdapterCredential
    abortSignal?: AbortSignal
    stream?: boolean
}

export interface AdapterPreparedRequest {
    method: 'POST'
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>
}

export type AdapterErrorKind =
    | 'network'
    | 'timeout'
    | 'aborted'
    | 'auth'
    | 'rate-limit'
    | 'invalid-request'
    | 'not-found'
    | 'server'
    | 'parse'
    | 'unsupported'
    | 'unknown'

export interface AdapterError {
    kind: AdapterErrorKind
    message: string
    status?: number
    retryable: boolean
    fallbackEligible: boolean
    cause?: unknown
}

export interface AdapterStreamEvent {
    event?: string
    data: string
    id?: string
}

export type AdapterChatRole = 'system' | 'user' | 'assistant' | 'tool'

// A single function/tool invocation requested by the model. `arguments` is the
// raw JSON string the model emitted (matches OpenAI's wire shape and the classic
// `toolCallData.call.arg`), so it round-trips without lossy re-encoding.
export interface AdapterToolCall {
    id: string
    name: string
    arguments: string
    // Opaque continuity token Gemini attaches to a functionCall part
    // (thoughtSignature). Must be echoed back on the follow-up request or
    // thinking-enabled Gemini models reject the tool turn. Other providers leave
    // this undefined.
    signature?: string
}

// A reasoning ("thinking") block emitted by the model. Carried opaquely so the
// follow-up request in a tool loop can echo it back — thinking-enabled models
// require their prior reasoning (with its signature) to continue a tool turn.
// `text` is the human-visible thought; `signature` / `redactedData` are opaque
// provider tokens (Anthropic thinking.signature / redacted_thinking.data,
// Gemini thought part signature).
export interface AdapterReasoningPart {
    text?: string
    signature?: string
    redactedData?: string
}

// Image attachment on a user/assistant message. Image-only for now; `mime` is
// required wire-side on Anthropic/Gemini and cannot be inferred from raw base64,
// so callers must supply it (Stage 3 vision). Reserved until then.
export interface AdapterImagePart {
    kind: 'image'
    base64: string
    mime?: string
}

export interface AdapterChatMessage {
    role: AdapterChatRole
    content: string
    name?: string
    toolCallId?: string                 // role:'tool' — which call this answers
    toolCalls?: AdapterToolCall[]        // role:'assistant' — calls the model made
    reasoning?: AdapterReasoningPart[]   // role:'assistant' — thinking blocks to echo back
    // role:'assistant' — the provider's raw assistant payload (OpenAI message /
    // Anthropic content blocks / Gemini parts). When present, the adapter resends
    // it VERBATIM instead of reconstructing the turn from the parsed fields.
    // Both OpenRouter (reasoning_details) and Google (thoughtSignature on any
    // part) require the exact bytes back on the in-request follow-up. In-memory
    // only — never persisted (history-restored turns reconstruct from fields).
    providerEcho?: unknown
    images?: AdapterImagePart[]          // reserved for Stage 3 (vision)
    thoughts?: string[]                  // reserved for Stage 4 (reasoning display)
}

// A tool the model may call. `parameters` is a JSON schema already simplified by
// the caller for the target provider (simplifySchema lives in util.ts, which
// pulls getDatabase + Svelte components — importing it here would create the SSR
// cycle the adapter layer deliberately avoids). Adapters only reshape the
// envelope around it.
export interface AdapterToolDef {
    name: string
    description?: string
    parameters: unknown
}

export interface AdapterUsage {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
}

export interface AdapterChatResponse {
    text: string
    toolCalls?: AdapterToolCall[]        // calls the model requested this turn
    reasoning?: AdapterReasoningPart[]   // thinking blocks emitted this turn (for echo)
    providerEcho?: unknown               // raw assistant payload for verbatim re-send (see AdapterChatMessage)
    thoughts?: string                    // reserved for Stage 4 (reasoning display)
    finishReason?: string
    usage?: AdapterUsage
    raw: unknown
}

export interface AdapterChatStreamDelta {
    textDelta: string
    finishReason?: string
    usage?: AdapterUsage
    raw: unknown
}

export interface AdapterChatOptions {
    messages: AdapterChatMessage[]
    tools?: AdapterToolDef[]             // when present, enables tool use on the request
    abortSignal?: AbortSignal
    fetchImpl?: typeof fetch
}
