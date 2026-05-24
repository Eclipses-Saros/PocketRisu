import type { ResolvedModelProfileSnapshot } from '../types'
import { appendQuery, applyAuth } from './auth'
import { ModelPresetAdapterError } from './error'
import type { AdapterPreparedRequest, AdapterRequestContext } from './types'

export function buildPreparedRequest(ctx: AdapterRequestContext): AdapterPreparedRequest {
    const snapshot = ctx.preset.profileSnapshot
    const baseUrl = resolveEndpointUrl(snapshot)

    const body: Record<string, unknown> = structuredClone({
        ...(snapshot.defaults ?? {}),
        ...(snapshot.bodyTemplate ?? {}),
    })
    const headers: Record<string, string> = { ...(snapshot.headerTemplate ?? {}) }
    const queryAdditions: Array<[string, string]> = []

    const userValues = ctx.preset.userValues
    for (const field of snapshot.schema) {
        if (!field.mapsTo) continue
        const effective = pickEffective(userValues, field.key, field.default)
        if (effective === undefined) continue
        switch (field.mapsTo.target) {
            case 'body':
                setNested(body, field.mapsTo.path, effective)
                break
            case 'header':
                headers[field.mapsTo.path] = String(effective)
                break
            case 'query':
                queryAdditions.push([field.mapsTo.path, String(effective)])
                break
            case 'auth':
            case 'custom':
                // 'auth' values flow through applyAuth via credential; 'custom' is adapter-specific.
                break
        }
    }

    if (ctx.preset.customBody) {
        Object.assign(body, structuredClone(ctx.preset.customBody))
    }
    if (ctx.preset.customHeaders) {
        Object.assign(headers, ctx.preset.customHeaders)
    }

    let url = baseUrl
    for (const [k, v] of queryAdditions) {
        url = appendQuery(url, k, v)
    }

    const prepared: AdapterPreparedRequest = {
        method: 'POST',
        url,
        headers,
        body,
    }
    return applyAuth(prepared, snapshot.auth, ctx.credential)
}

function resolveEndpointUrl(snapshot: ResolvedModelProfileSnapshot): string {
    if (snapshot.endpoint.kind === 'static') {
        if (!snapshot.endpoint.url) {
            throw new ModelPresetAdapterError(
                'invalid-request',
                'Endpoint URL is missing in profile snapshot',
                { retryable: false },
            )
        }
        return snapshot.endpoint.url
    }
    throw new ModelPresetAdapterError(
        'unsupported',
        `Endpoint kind '${snapshot.endpoint.kind}' is not supported by the shared request builder yet`,
        { retryable: false },
    )
}

function pickEffective(
    userValues: Record<string, unknown>,
    key: string,
    fallback: unknown,
): unknown {
    if (Object.prototype.hasOwnProperty.call(userValues, key)) {
        const value = userValues[key]
        if (value !== undefined) return value
    }
    return fallback
}

function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
    if (path.length === 0) return
    const parts = path.split('.')
    let cur: Record<string, unknown> = obj
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]
        const next = cur[part]
        if (typeof next !== 'object' || next === null || Array.isArray(next)) {
            cur[part] = {}
        }
        cur = cur[part] as Record<string, unknown>
    }
    cur[parts[parts.length - 1]] = value
}
