import { createVerify } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { ModelPresetAdapterError } from '../error'
import {
    buildServiceAccountAssertion,
    DEFAULT_SCOPE,
    decodeJwtHeaderForTest,
    decodeJwtPayloadForTest,
} from './jwt'
import { getTestKeyPair, makeServiceAccountFixture as fixture } from './__testFixtures'

const fixedNow = () => 1_700_000_000_000

describe('buildServiceAccountAssertion', () => {
    test('produces three-segment JWT with header, payload, signature', () => {
        const result = buildServiceAccountAssertion({ serviceAccount: fixture(), now: fixedNow })
        const segments = result.assertion.split('.')
        expect(segments).toHaveLength(3)
        expect(`${segments[0]}.${segments[1]}`).toBe(result.signingInput)
        expect(segments[2]).toBe(result.signature)
        expect(result.signature).not.toContain('=')
        expect(result.signature).not.toContain('+')
        expect(result.signature).not.toContain('/')
    })

    test('payload contains iss, scope, aud, iat, exp with 1h TTL', () => {
        const result = buildServiceAccountAssertion({ serviceAccount: fixture(), now: fixedNow })
        const payload = decodeJwtPayloadForTest(result.assertion) as Record<string, unknown>
        expect(payload.iss).toBe('svc@demo.iam.gserviceaccount.com')
        expect(payload.scope).toBe(DEFAULT_SCOPE)
        expect(payload.aud).toBe('https://oauth2.googleapis.com/token')
        expect(payload.iat).toBe(Math.floor(fixedNow() / 1000))
        expect(payload.exp).toBe(Math.floor(fixedNow() / 1000) + 3600)
    })

    test('header contains alg=RS256, typ=JWT, kid when privateKeyId present', () => {
        const result = buildServiceAccountAssertion({ serviceAccount: fixture(), now: fixedNow })
        const header = decodeJwtHeaderForTest(result.assertion) as Record<string, unknown>
        expect(header.alg).toBe('RS256')
        expect(header.typ).toBe('JWT')
        expect(header.kid).toBe('kid-1')
    })

    test('header omits kid when privateKeyId is absent', () => {
        const result = buildServiceAccountAssertion({
            serviceAccount: fixture({ privateKeyId: undefined }),
            now: fixedNow,
        })
        const header = decodeJwtHeaderForTest(result.assertion) as Record<string, unknown>
        expect('kid' in header).toBe(false)
    })

    test('honors custom scope', () => {
        const result = buildServiceAccountAssertion({
            serviceAccount: fixture(),
            scope: 'https://www.googleapis.com/auth/aiplatform',
            now: fixedNow,
        })
        const payload = decodeJwtPayloadForTest(result.assertion) as Record<string, unknown>
        expect(payload.scope).toBe('https://www.googleapis.com/auth/aiplatform')
    })

    test('empty scope falls back to default', () => {
        const result = buildServiceAccountAssertion({
            serviceAccount: fixture(),
            scope: '',
            now: fixedNow,
        })
        const payload = decodeJwtPayloadForTest(result.assertion) as Record<string, unknown>
        expect(payload.scope).toBe(DEFAULT_SCOPE)
    })

    test('signature verifies against matching public key (real RS256)', () => {
        const result = buildServiceAccountAssertion({ serviceAccount: fixture(), now: fixedNow })
        const verifier = createVerify('RSA-SHA256')
        verifier.update(result.signingInput)
        verifier.end()
        const sigBase64 = result.signature
            .replace(/-/gu, '+')
            .replace(/_/gu, '/')
            .padEnd(result.signature.length + ((4 - (result.signature.length % 4)) % 4), '=')
        const ok = verifier.verify(getTestKeyPair().publicKey, Buffer.from(sigBase64, 'base64'))
        expect(ok).toBe(true)
    })

    test('different now produces different iat/exp and different signature', () => {
        const a = buildServiceAccountAssertion({ serviceAccount: fixture(), now: () => 1_700_000_000_000 })
        const b = buildServiceAccountAssertion({ serviceAccount: fixture(), now: () => 1_700_000_010_000 })
        expect(a.payload.iat).not.toBe(b.payload.iat)
        expect(a.assertion).not.toBe(b.assertion)
    })

    test('throws invalid-request when private key is malformed PEM body', () => {
        const badPem =
            '-----BEGIN PRIVATE KEY-----\nnot-actually-base64-of-a-key\n-----END PRIVATE KEY-----\n'
        try {
            buildServiceAccountAssertion({
                serviceAccount: fixture({ privateKey: badPem }),
                now: fixedNow,
            })
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ModelPresetAdapterError)
            if (err instanceof ModelPresetAdapterError) {
                expect(err.kind).toBe('invalid-request')
                expect(err.retryable).toBe(false)
                expect(err.fallbackEligible).toBe(false)
            }
        }
    })
})
