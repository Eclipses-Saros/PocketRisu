import { describe, expect, test } from 'vitest'
import { getBundledRegistryId, loadBundledRegistry } from './loader'

const EXPECTED_BASE_PROVIDER_IDS = [
    'anthropic',
    'bedrock',
    'deepinfra',
    'deepseek',
    'google',
    'nanogpt',
    'ollama',
    'ollama-cloud',
    'openai',
    'openai-compatible',
    'openrouter',
    'vercel',
    'vertex-openai',
]

const EXPECTED_PROFILE_IDS = [
    'anthropic:haiku-45',
    'anthropic:opus-4',
    'anthropic:opus-41',
    'anthropic:opus-45',
    'anthropic:opus-46',
    'anthropic:opus-47',
    'anthropic:opus-48',
    'anthropic:sonnet-4',
    'anthropic:sonnet-45',
    'anthropic:sonnet-46',
    'bedrock:openai-compatible',
    'deepinfra:openai-compatible',
    'deepseek:v4-flash',
    'deepseek:v4-flash-thinking',
    'deepseek:v4-pro',
    'deepseek:v4-pro-thinking',
    'google:gemini-25-flash',
    'google:gemini-25-flash-lite',
    'google:gemini-25-pro',
    'google:gemini-3-flash',
    'google:gemini-31-flash-lite',
    'google:gemini-31-pro',
    'google:gemini-35-flash',
    'google:gemma-4-26b',
    'google:gemma-4-31b',
    'nanogpt:openai-compatible',
    'ollama-cloud:standard',
    'ollama:openai-compatible-local',
    'openai-compatible:custom',
    'openai-compatible:custom-noauth',
    'openai:gpt-4',
    'openai:gpt-41',
    'openai:gpt-41-mini',
    'openai:gpt-4o',
    'openai:gpt-4o-mini',
    'openai:gpt-5',
    'openai:gpt-5-mini',
    'openai:gpt-5-nano',
    'openai:gpt-51',
    'openai:gpt-52',
    'openai:gpt-54',
    'openai:gpt-54-mini',
    'openai:gpt-54-nano',
    'openai:gpt-55',
    'openai:o3',
    'openrouter:openai-compatible',
    'vercel:openai-compatible',
    'vertex-openai:standard',
]

describe('loadBundledRegistry', () => {
    test('produces a v4 registry cache with the bundled registry id', () => {
        const registry = loadBundledRegistry()
        expect(registry.schemaVersion).toBe(4)
        expect(Object.keys(registry.registries)).toEqual([getBundledRegistryId()])
    })

    test('exposes every bundled base provider keyed by id', () => {
        const registry = loadBundledRegistry()
        const baseProviders = registry.registries[getBundledRegistryId()]?.baseProviders ?? {}
        expect(Object.keys(baseProviders).sort()).toEqual(EXPECTED_BASE_PROVIDER_IDS)
        for (const id of EXPECTED_BASE_PROVIDER_IDS) {
            expect(baseProviders[id]?.id).toBe(id)
            expect(baseProviders[id]?.requestSchema.length).toBeGreaterThan(0)
        }
    })

    test('exposes every bundled profile keyed by id', () => {
        const registry = loadBundledRegistry()
        const profiles = registry.registries[getBundledRegistryId()]?.profiles ?? {}
        expect(Object.keys(profiles).sort()).toEqual(EXPECTED_PROFILE_IDS)
        for (const id of EXPECTED_PROFILE_IDS) {
            expect(profiles[id]?.id).toBe(id)
            expect(['current', 'outdated', 'deprecated']).toContain(profiles[id]?.profileStatus)
        }
    })

    test('returns a stable singleton on repeated load', () => {
        const first = loadBundledRegistry()
        const second = loadBundledRegistry()
        expect(second).toBe(first)
    })
})
