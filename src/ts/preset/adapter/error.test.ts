import { describe, expect, test } from 'vitest'
import {
    ModelPresetAdapterError,
    defaultFallbackEligible,
    defaultRetryable,
    normalizeFetchError,
    normalizeHttpStatus,
} from './error'

describe('defaultRetryable', () => {
    test('marks network/timeout/rate-limit/server/parse as retryable', () => {
        for (const kind of ['network', 'timeout', 'rate-limit', 'server', 'parse'] as const) {
            expect(defaultRetryable(kind)).toBe(true)
        }
    })

    test('marks auth/invalid-request/not-found/aborted/unsupported as non-retryable', () => {
        for (const kind of [
            'auth',
            'invalid-request',
            'not-found',
            'aborted',
            'unsupported',
            'unknown',
        ] as const) {
            expect(defaultRetryable(kind)).toBe(false)
        }
    })
})

describe('defaultFallbackEligible', () => {
    test('marks network/timeout/server/parse as fallback-eligible (plan §9-8)', () => {
        for (const kind of ['network', 'timeout', 'server', 'parse'] as const) {
            expect(defaultFallbackEligible(kind)).toBe(true)
        }
    })

    test('marks rate-limit as fallback non-eligible even though it is retryable', () => {
        expect(defaultFallbackEligible('rate-limit')).toBe(false)
        expect(defaultRetryable('rate-limit')).toBe(true)
    })

    test('marks auth/invalid-request/not-found/aborted/unsupported/unknown as non-eligible', () => {
        for (const kind of [
            'auth',
            'invalid-request',
            'not-found',
            'aborted',
            'unsupported',
            'unknown',
        ] as const) {
            expect(defaultFallbackEligible(kind)).toBe(false)
        }
    })
})

describe('ModelPresetAdapterError', () => {
    test('inherits Error and exposes adapter fields', () => {
        const err = new ModelPresetAdapterError('rate-limit', 'slow down', { status: 429 })
        expect(err).toBeInstanceOf(Error)
        expect(err.kind).toBe('rate-limit')
        expect(err.status).toBe(429)
        expect(err.retryable).toBe(true)
        expect(err.fallbackEligible).toBe(false)
        expect(err.message).toBe('slow down')
    })

    test('options.retryable and options.fallbackEligible override defaults independently', () => {
        const err = new ModelPresetAdapterError('network', 'override', {
            retryable: false,
            fallbackEligible: false,
        })
        expect(err.retryable).toBe(false)
        expect(err.fallbackEligible).toBe(false)
    })

    test('toAdapterError exposes plain shape with fallbackEligible', () => {
        const cause = new Error('underlying')
        const err = new ModelPresetAdapterError('server', 'boom', { status: 502, cause })
        expect(err.toAdapterError()).toEqual({
            kind: 'server',
            message: 'boom',
            status: 502,
            retryable: true,
            fallbackEligible: true,
            cause,
        })
    })
})

describe('normalizeFetchError', () => {
    test('returns the same instance if already normalized', () => {
        const original = new ModelPresetAdapterError('network', 'x')
        expect(normalizeFetchError(original)).toBe(original)
    })

    test('AbortError maps to aborted/non-retryable', () => {
        const abort = new Error('aborted')
        abort.name = 'AbortError'
        const err = normalizeFetchError(abort)
        expect(err.kind).toBe('aborted')
        expect(err.retryable).toBe(false)
    })

    test('generic Error maps to network/retryable', () => {
        const err = normalizeFetchError(new Error('fetch failed'))
        expect(err.kind).toBe('network')
        expect(err.retryable).toBe(true)
    })

    test('non-Error value maps to unknown', () => {
        const err = normalizeFetchError('boom')
        expect(err.kind).toBe('unknown')
        expect(err.message).toBe('boom')
    })
})

describe('normalizeHttpStatus', () => {
    test('returns null for 2xx', () => {
        expect(normalizeHttpStatus(200)).toBeNull()
        expect(normalizeHttpStatus(204)).toBeNull()
    })

    test('401/403 -> auth non-retryable', () => {
        for (const status of [401, 403]) {
            const err = normalizeHttpStatus(status)!
            expect(err.kind).toBe('auth')
            expect(err.retryable).toBe(false)
            expect(err.status).toBe(status)
        }
    })

    test('404 -> not-found non-retryable', () => {
        const err = normalizeHttpStatus(404)!
        expect(err.kind).toBe('not-found')
        expect(err.retryable).toBe(false)
    })

    test('408 -> timeout retryable', () => {
        const err = normalizeHttpStatus(408)!
        expect(err.kind).toBe('timeout')
        expect(err.retryable).toBe(true)
    })

    test('429 -> rate-limit retryable but fallback non-eligible', () => {
        const err = normalizeHttpStatus(429)!
        expect(err.kind).toBe('rate-limit')
        expect(err.retryable).toBe(true)
        expect(err.fallbackEligible).toBe(false)
    })

    test('other 4xx -> invalid-request non-retryable', () => {
        const err = normalizeHttpStatus(422)!
        expect(err.kind).toBe('invalid-request')
        expect(err.retryable).toBe(false)
    })

    test('5xx -> server retryable and fallback-eligible', () => {
        for (const status of [500, 502, 503]) {
            const err = normalizeHttpStatus(status)!
            expect(err.kind).toBe('server')
            expect(err.retryable).toBe(true)
            expect(err.fallbackEligible).toBe(true)
        }
    })

    test('outside common ranges -> unknown', () => {
        const err = normalizeHttpStatus(600)!
        expect(err.kind).toBe('unknown')
    })
})
