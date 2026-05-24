import type { RegistryAuth } from '../types'
import { ModelPresetAdapterError } from './error'
import type { AdapterCredential, AdapterPreparedRequest } from './types'

export function applyAuth(
    prepared: AdapterPreparedRequest,
    auth: RegistryAuth,
    credential: AdapterCredential | undefined,
): AdapterPreparedRequest {
    switch (auth.kind) {
        case 'none':
            return prepared
        case 'bearer': {
            const key = requireApiKey(auth.kind, credential)
            return withHeader(prepared, 'Authorization', `Bearer ${key}`)
        }
        case 'x-api-key': {
            const key = requireApiKey(auth.kind, credential)
            return withHeader(prepared, 'x-api-key', key)
        }
        case 'x-goog-api-key': {
            const key = requireApiKey(auth.kind, credential)
            return withHeader(prepared, 'x-goog-api-key', key)
        }
        case 'query': {
            const key = requireApiKey(auth.kind, credential)
            return { ...prepared, url: appendQuery(prepared.url, 'key', key) }
        }
        case 'google-service-account':
            throw new ModelPresetAdapterError(
                'unsupported',
                "Auth kind 'google-service-account' is not supported by the shared adapter layer yet",
                { retryable: false },
            )
        default: {
            const exhaustiveCheck: never = auth.kind
            throw new ModelPresetAdapterError(
                'unsupported',
                `Unknown auth kind '${exhaustiveCheck as string}'`,
                { retryable: false },
            )
        }
    }
}

function requireApiKey(kind: string, credential: AdapterCredential | undefined): string {
    const key = credential?.apiKey
    if (typeof key !== 'string' || key.length === 0) {
        throw new ModelPresetAdapterError(
            'auth',
            `Auth kind '${kind}' requires an apiKey in credential`,
            { retryable: false },
        )
    }
    return key
}

function withHeader(
    prepared: AdapterPreparedRequest,
    name: string,
    value: string,
): AdapterPreparedRequest {
    return {
        ...prepared,
        headers: { ...prepared.headers, [name]: value },
    }
}

export function appendQuery(url: string, key: string, value: string): string {
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`
}
