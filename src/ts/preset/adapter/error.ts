import type { AdapterError, AdapterErrorKind } from './types'

export interface AdapterErrorOptions {
    status?: number
    retryable?: boolean
    fallbackEligible?: boolean
    cause?: unknown
}

export class ModelPresetAdapterError extends Error {
    readonly kind: AdapterErrorKind
    readonly status?: number
    readonly retryable: boolean
    readonly fallbackEligible: boolean

    constructor(kind: AdapterErrorKind, message: string, options: AdapterErrorOptions = {}) {
        super(message)
        this.name = 'ModelPresetAdapterError'
        this.kind = kind
        this.status = options.status
        this.retryable = options.retryable ?? defaultRetryable(kind)
        this.fallbackEligible = options.fallbackEligible ?? defaultFallbackEligible(kind)
        if (options.cause !== undefined) {
            ;(this as Error & { cause?: unknown }).cause = options.cause
        }
    }

    toAdapterError(): AdapterError {
        return {
            kind: this.kind,
            message: this.message,
            status: this.status,
            retryable: this.retryable,
            fallbackEligible: this.fallbackEligible,
            cause: (this as Error & { cause?: unknown }).cause,
        }
    }
}

export function defaultRetryable(kind: AdapterErrorKind): boolean {
    switch (kind) {
        case 'network':
        case 'timeout':
        case 'rate-limit':
        case 'server':
        case 'parse':
            return true
        default:
            return false
    }
}

// Distinct from `retryable`: this is the policy for switching to a fallback
// ModelPreset (plan §9-8). 429/rate-limit can be retried in place but is
// not a fallback trigger by policy.
export function defaultFallbackEligible(kind: AdapterErrorKind): boolean {
    switch (kind) {
        case 'network':
        case 'timeout':
        case 'server':
        case 'parse':
            return true
        default:
            return false
    }
}

export function normalizeFetchError(err: unknown): ModelPresetAdapterError {
    if (err instanceof ModelPresetAdapterError) return err
    if (err instanceof Error) {
        if (err.name === 'AbortError') {
            return new ModelPresetAdapterError('aborted', err.message || 'Request aborted', {
                retryable: false,
                cause: err,
            })
        }
        return new ModelPresetAdapterError('network', err.message || 'Network error', {
            cause: err,
        })
    }
    return new ModelPresetAdapterError('unknown', String(err))
}

export function normalizeHttpStatus(status: number, message?: string): ModelPresetAdapterError | null {
    if (status >= 200 && status < 300) return null
    if (status === 401 || status === 403) {
        return new ModelPresetAdapterError('auth', message ?? `HTTP ${status}`, {
            status,
            retryable: false,
        })
    }
    if (status === 404) {
        return new ModelPresetAdapterError('not-found', message ?? `HTTP ${status}`, {
            status,
            retryable: false,
        })
    }
    if (status === 408) {
        return new ModelPresetAdapterError('timeout', message ?? `HTTP ${status}`, { status })
    }
    if (status === 429) {
        return new ModelPresetAdapterError('rate-limit', message ?? `HTTP ${status}`, { status })
    }
    if (status >= 400 && status < 500) {
        return new ModelPresetAdapterError('invalid-request', message ?? `HTTP ${status}`, {
            status,
            retryable: false,
        })
    }
    if (status >= 500 && status < 600) {
        return new ModelPresetAdapterError('server', message ?? `HTTP ${status}`, { status })
    }
    return new ModelPresetAdapterError('unknown', message ?? `HTTP ${status}`, { status })
}
