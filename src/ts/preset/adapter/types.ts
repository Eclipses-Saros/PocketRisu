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
