import { describe, expect, test, vi } from 'vitest'
import { LLMFormat } from '../model/types'
import { analyzeModelPresetMigration, applyModelPresetMigration } from './migration'
import type { ModelPresetMigrationApplyTarget } from './migration'
import type { MigrationReport } from './types'

describe('analyzeModelPresetMigration', () => {
    test('plans custom OpenAI-compatible models without leaking key material into ids', () => {
        const report = analyzeModelPresetMigration({
            customModels: [{
                id: 'xcustom:::main',
                internalId: 'gpt-custom',
                url: 'https://example.test/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: 'sk-secret',
                name: 'Main Custom',
                params: 'temperature=0.7',
                flags: [8],
            }],
            aiModel: 'xcustom:::main',
        })

        expect(report.createdModelPresets).toHaveLength(1)
        expect(report.createdModelPresets[0]).toMatchObject({
            sourceKind: 'custom',
            sourcePath: 'customModels.xcustom:::main',
            profileId: 'openai-compatible:custom',
            modelId: 'gpt-custom',
            credentialSource: {
                kind: 'legacyKey',
                sourcePath: 'customModels.xcustom:::main.key',
            },
        })
        expect(JSON.stringify(report.createdModelPresets)).not.toContain('sk-secret')
        expect(report.createdModelPresets[0].id).not.toContain('sk-secret')
        expect(report.globalBindings).toContainEqual({
            scope: 'global',
            targetTask: 'model',
            sourcePath: 'db.aiModel',
            binding: { kind: 'modelPreset', id: report.createdModelPresets[0].id },
        })
    })

    test('plans reverse proxy as custom OpenAI-compatible profile', () => {
        const report = analyzeModelPresetMigration({
            aiModel: 'reverse_proxy',
            forceReplaceUrl: 'https://proxy.test/v1/chat/completions',
            customProxyRequestModel: 'proxy-model',
            proxyKey: 'proxy-secret',
            customAPIFormat: LLMFormat.OpenAICompatible,
            additionalParams: [['x-provider', 'abc']],
        })

        expect(report.createdModelPresets).toHaveLength(1)
        expect(report.createdModelPresets[0]).toMatchObject({
            sourceKind: 'reverse-proxy',
            sourcePath: 'db.reverse_proxy',
            profileId: 'openai-compatible:custom',
            modelId: 'proxy-model',
            endpointUrl: 'https://proxy.test/v1/chat/completions',
            credentialSource: {
                kind: 'legacyKey',
                sourcePath: 'db.proxyKey',
            },
        })
        expect(JSON.stringify(report)).not.toContain('proxy-secret')
        expect(report.createdModelPresets[0].userValues.additionalParams).toEqual([['x-provider', 'abc']])
    })

    test('uses provider-specific request model fields for OpenRouter and reverse proxy', () => {
        const report = analyzeModelPresetMigration({
            aiModel: 'openrouter',
            openrouterRequestModel: 'anthropic/claude-3-opus',
            openrouterKey: 'sk-or-secret',
            botPresets: [{
                id: 'bot-router',
                aiModel: 'openrouter',
                openrouterRequestModel: 'openai/gpt-4o-mini',
            }, {
                id: 'bot-proxy',
                aiModel: 'reverse_proxy',
                forceReplaceUrl: 'https://proxy.test/v1/chat/completions',
                proxyRequestModel: 'proxy-model-from-legacy',
            }],
        })

        expect(report.createdModelPresets.find((preset) => preset.sourcePath === 'db.aiModel')).toMatchObject({
            profileId: 'openrouter:openai-compatible',
            modelId: 'anthropic/claude-3-opus',
            credentialSource: { kind: 'legacyKey', sourcePath: 'db.openrouterKey' },
            userValues: {
                modelId: 'anthropic/claude-3-opus',
                format: undefined,
            },
        })
        expect(report.createdModelPresets.find((preset) => preset.sourcePath === 'botPresets.bot-router.aiModel')).toMatchObject({
            profileId: 'openrouter:openai-compatible',
            modelId: 'openai/gpt-4o-mini',
        })
        expect(report.createdModelPresets.find((preset) => preset.sourcePath === 'botPresets.bot-proxy.reverse_proxy')).toMatchObject({
            profileId: 'openai-compatible:custom',
            modelId: 'proxy-model-from-legacy',
            userValues: {
                endpointUrl: 'https://proxy.test/v1/chat/completions',
                modelId: 'proxy-model-from-legacy',
                additionalParams: [],
            },
        })
        expect(report.botPresetBindings).toContainEqual({
            scope: 'botPreset',
            ownerId: 'bot-proxy',
            targetTask: 'model',
            sourcePath: 'botPresets.bot-proxy.aiModel',
            binding: {
                kind: 'modelPreset',
                id: report.createdModelPresets.find((preset) => preset.sourcePath === 'botPresets.bot-proxy.reverse_proxy')?.id,
            },
        })
        expect(JSON.stringify(report)).not.toContain('sk-or-secret')
    })

    test('creates plugin bindings without converting plugin models to ModelPreset', () => {
        const report = analyzeModelPresetMigration({
            aiModel: 'pluginmodel:::cpm',
            botPresets: [{
                id: 'bot-a',
                aiModel: 'pluginmodel:::other-plugin',
                bias: [],
            }],
        })

        expect(report.createdModelPresets).toEqual([])
        expect(report.pluginBindings).toEqual([
            {
                scope: 'global',
                targetTask: 'model',
                sourcePath: 'db.aiModel',
                pluginModelId: 'pluginmodel:::cpm',
                binding: { kind: 'pluginModel', id: 'pluginmodel:::cpm' },
            },
            {
                scope: 'botPreset',
                ownerId: 'bot-a',
                targetTask: 'model',
                sourcePath: 'botPresets.bot-a.aiModel',
                pluginModelId: 'pluginmodel:::other-plugin',
                binding: { kind: 'pluginModel', id: 'pluginmodel:::other-plugin' },
            },
        ])
    })

    test('reports unsupported native providers and skipped bias', () => {
        const report = analyzeModelPresetMigration({
            customModels: [{
                id: 'xcustom:::kobold',
                format: LLMFormat.Kobold,
                key: 'kobold-secret',
                name: 'Kobold',
            }],
            aiModel: 'novelai',
            bias: [['token', 42]],
            enableCustomFlags: true,
            customFlags: [6],
        })

        expect(report.createdModelPresets).toEqual([])
        expect(report.manualRequired).toEqual([
            {
                sourcePath: 'customModels.xcustom:::kobold',
                reason: `Unsupported custom model format: ${LLMFormat.Kobold}`,
                legacySource: 'xcustom:::kobold',
            },
            {
                sourcePath: 'db.aiModel',
                reason: 'Unsupported legacy model: novelai',
                legacySource: 'db.aiModel',
            },
        ])
        expect(report.skippedBias).toEqual([
            {
                sourcePath: 'db.bias',
                reason: 'Bias is not migrated to v4 ModelPreset or PromptPreset',
            },
        ])
        expect(report.preservedLegacyFields).toEqual([
            {
                sourcePath: 'db.customFlags',
                reason: 'Custom flags are preserved and only auto-mapped when profile schema supports them',
            },
        ])
        expect(JSON.stringify(report)).not.toContain('kobold-secret')
    })

    test('adds structured global and task binding metadata', () => {
        const report = analyzeModelPresetMigration({
            aiModel: 'gpt-4o',
            subModel: 'claude-3-5-sonnet',
            seperateModelsForAxModels: true,
            seperateModels: {
                memory: 'gemini-2.5-pro',
                translate: 'pluginmodel:::translator',
            },
            openAIKey: 'sk-openai',
            claudeAPIKey: 'sk-anthropic',
        })

        expect(report.globalBindings).toEqual([
            expect.objectContaining({
                scope: 'global',
                targetTask: 'model',
                sourcePath: 'db.aiModel',
                binding: { kind: 'modelPreset', id: expect.any(String) },
            }),
            expect.objectContaining({
                scope: 'global',
                targetTask: 'submodel',
                sourcePath: 'db.subModel',
                binding: { kind: 'modelPreset', id: expect.any(String) },
            }),
            expect.objectContaining({
                scope: 'global',
                targetTask: 'memory',
                sourcePath: 'db.seperateModels.memory',
                binding: { kind: 'modelPreset', id: expect.any(String) },
            }),
        ])
        expect(report.pluginBindings).toContainEqual({
            scope: 'global',
            targetTask: 'translate',
            sourcePath: 'db.seperateModels.translate',
            pluginModelId: 'pluginmodel:::translator',
            binding: { kind: 'pluginModel', id: 'pluginmodel:::translator' },
        })
        expect(report.createdModelPresets.find((preset) => preset.sourcePath === 'db.aiModel')?.credentialSource).toEqual({
            kind: 'legacyKey',
            sourcePath: 'db.openAIKey',
        })
        expect(JSON.stringify(report)).not.toContain('sk-openai')
        expect(JSON.stringify(report)).not.toContain('sk-anthropic')
    })

    test('redacts secret-like freeform params and additionalParams', () => {
        const report = analyzeModelPresetMigration({
            customModels: [{
                id: 'xcustom:::leaky',
                format: LLMFormat.OpenAICompatible,
                name: 'Leaky',
                params: 'Authorization=Bearer sk-leak',
            }],
            aiModel: 'reverse_proxy',
            forceReplaceUrl: 'https://proxy.test',
            additionalParams: [
                ['Authorization', 'Bearer sk-header-leak'],
                ['x-safe', 'visible'],
            ],
        })

        expect(JSON.stringify(report)).not.toContain('sk-leak')
        expect(JSON.stringify(report)).not.toContain('sk-header-leak')
        expect(report.createdModelPresets.find((preset) => preset.sourcePath === 'customModels.xcustom:::leaky')?.userValues.params).toBe('[redacted]')
        expect(report.createdModelPresets.find((preset) => preset.sourcePath === 'db.reverse_proxy')?.userValues.additionalParams).toEqual([
            ['Authorization', '[redacted]'],
            ['x-safe', 'visible'],
        ])
    })

    test('hardens legacy model prefix matching for native and lookalike ids', () => {
        const report = analyzeModelPresetMigration({
            aiModel: 'gpt2-large-conversational',
            subModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        })

        expect(report.createdModelPresets).toEqual([])
        expect(report.manualRequired).toEqual([
            {
                sourcePath: 'db.aiModel',
                reason: 'Unsupported legacy model: gpt2-large-conversational',
                legacySource: 'db.aiModel',
            },
            {
                sourcePath: 'db.subModel',
                reason: 'Native Bedrock Claude model requires manual migration: anthropic.claude-3-5-sonnet-20241022-v2:0',
                legacySource: 'db.subModel',
            },
        ])
    })

    test('does not mutate input during dry-run', () => {
        const db: ModelPresetMigrationApplyTarget = {
            customModels: [{
                id: 'xcustom:::main',
                internalId: 'model',
                url: 'https://example.test',
                format: LLMFormat.OpenAICompatible,
                key: 'secret',
                name: 'Main',
                params: '',
                flags: [],
            }],
            aiModel: 'xcustom:::main',
            bias: [['token', 1]] as [string, number][],
        }
        const before = JSON.stringify(db)

        analyzeModelPresetMigration(db)

        expect(JSON.stringify(db)).toBe(before)
    })

    test('applies migration report without storing secrets in migration summary', () => {
        const db: ModelPresetMigrationApplyTarget = {
            customModels: [{
                id: 'xcustom:::main',
                internalId: 'gpt-custom',
                url: 'https://example.test/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: 'sk-secret',
                name: 'Main Custom',
                params: '',
                flags: [],
            }],
            aiModel: 'xcustom:::main',
            botPresets: [{
                id: 'bot-a',
                aiModel: 'pluginmodel:::cpm',
            }],
        }
        const report = analyzeModelPresetMigration(db)

        applyModelPresetMigration(db, report)

        expect(db.modelPresets).toHaveLength(1)
        expect(db.modelPresets?.[0]).toMatchObject({
            id: report.createdModelPresets[0].id,
            migrationSource: {
                sourceKind: 'custom',
                sourcePath: 'customModels.xcustom:::main',
            },
            apiKeyRef: expect.any(String),
            profileSnapshot: {
                profileId: 'openai-compatible:custom',
                adapterKind: 'openai-compatible',
                modelId: 'gpt-custom',
            },
        })
        expect(db.modelBinding).toEqual({ kind: 'modelPreset', id: report.createdModelPresets[0].id })
        expect(db.botPresets?.[0].modelBinding).toEqual({ kind: 'pluginModel', id: 'pluginmodel:::cpm' })
        expect(Object.values(db.apiKeyPool ?? {})).toEqual([
            expect.objectContaining({
                provider: 'openai-compatible:custom',
                key: 'sk-secret',
            }),
        ])
        expect(db.modelPresetMigrationVersion).toBe(1)
        expect(JSON.stringify(db.modelPresetMigrationReport)).not.toContain('sk-secret')
        expect(JSON.stringify(report)).not.toContain('sk-secret')
    })

    test('applies task bindings and avoids numeric owner id collisions', () => {
        const db: ModelPresetMigrationApplyTarget = {
            aiModel: 'gpt-4o',
            seperateModelsForAxModels: true,
            seperateModels: {
                memory: 'gemini-2.5-pro',
                translate: 'pluginmodel:::translator',
            },
            botPresets: [{
                name: 'No Id',
                aiModel: 'gpt-4o-mini',
            }, {
                id: '0',
                name: 'Looks Like Numeric Index',
                aiModel: 'gpt-4o',
            }],
        }
        const report = analyzeModelPresetMigration(db)

        applyModelPresetMigration(db, report)

        expect(db.taskModelBindings?.memory).toEqual({
            kind: 'modelPreset',
            id: report.createdModelPresets.find((preset) => preset.sourcePath === 'db.seperateModels.memory')?.id,
        })
        expect(db.taskModelBindings?.translate).toEqual({ kind: 'pluginModel', id: 'pluginmodel:::translator' })
        expect(report.botPresetBindings.find((binding) => binding.sourcePath === 'botPresets.index:0.aiModel')).toMatchObject({
            ownerId: 'index:0',
            binding: { kind: 'modelPreset', id: expect.any(String) },
        })
        expect(db.botPresets?.[0].modelBinding).toEqual({
            kind: 'modelPreset',
            id: report.createdModelPresets.find((preset) => preset.sourcePath === 'botPresets.index:0.aiModel')?.id,
        })
        expect(db.botPresets?.[1].modelBinding).toEqual({
            kind: 'modelPreset',
            id: report.createdModelPresets.find((preset) => preset.sourcePath === 'botPresets.0.aiModel')?.id,
        })
    })

    test('reapplying migration upserts by source path instead of duplicating presets or keys', () => {
        const db: ModelPresetMigrationApplyTarget = {
            customModels: [{
                id: 'xcustom:::main',
                internalId: 'model-a',
                url: 'https://example.test/v1/chat/completions',
                format: LLMFormat.OpenAICompatible,
                key: 'sk-secret-a',
                name: 'Main Custom',
                params: '',
                flags: [],
            }],
            aiModel: 'xcustom:::main',
        }
        const firstReport = analyzeModelPresetMigration(db)
        vi.useFakeTimers()
        vi.setSystemTime(1000)
        applyModelPresetMigration(db, firstReport)
        const keyId = Object.keys(db.apiKeyPool ?? {})[0]
        if (keyId && db.apiKeyPool) {
            db.apiKeyPool[keyId].name = 'User Named Key'
            db.apiKeyPool[keyId].createdAt = 123
        }
        if (db.modelPresets?.[0]) {
            db.modelPresets[0].notes = 'user note'
            db.modelPresets[0].orphanValues = { oldField: true }
            db.modelPresets[0].inlineCredential = { kind: 'external' }
            db.modelPresets[0].fallbackModelPresetIds = ['fallback-a']
            db.modelPresets[0].pinned = true
            db.modelPresets[0].order = 7
        }

        db.customModels[0].internalId = 'model-b'
        db.customModels[0].key = 'sk-secret-b'
        const secondReport = analyzeModelPresetMigration(db)
        vi.setSystemTime(2000)
        applyModelPresetMigration(db, secondReport)

        expect(db.modelPresets).toHaveLength(1)
        expect(db.modelPresets?.[0]).toMatchObject({
            id: secondReport.createdModelPresets[0].id,
            userValues: {
                endpointUrl: 'https://example.test/v1/chat/completions',
                modelId: 'model-b',
                params: '',
                flags: [],
            },
            notes: 'user note',
            orphanValues: { oldField: true },
            inlineCredential: { kind: 'external' },
            fallbackModelPresetIds: ['fallback-a'],
            pinned: true,
            order: 7,
            createdAt: 1000,
            updatedAt: 2000,
        })
        expect(db.modelBinding).toEqual({ kind: 'modelPreset', id: secondReport.createdModelPresets[0].id })
        expect(Object.values(db.apiKeyPool ?? {})).toHaveLength(1)
        expect(Object.values(db.apiKeyPool ?? {})[0]).toMatchObject({
            name: 'User Named Key',
            key: 'sk-secret-b',
            createdAt: 123,
            updatedAt: 2000,
        })
        vi.useRealTimers()
    })

    test('applies chat bindings from a report', () => {
        const db: ModelPresetMigrationApplyTarget = {
            characters: [{
                chats: [{
                    id: 'chat-a',
                    name: 'Chat A',
                }],
            }],
        }
        const report: MigrationReport = {
            version: 1,
            createdModelPresets: [],
            globalBindings: [],
            botPresetBindings: [],
            chatBindings: [{
                scope: 'chat',
                ownerId: 'chat-a',
                targetTask: 'memory',
                sourcePath: 'characters.0.chats.0.memory',
                binding: { kind: 'modelPreset', id: 'preset-memory' },
            }, {
                scope: 'chat',
                ownerId: '0.0',
                targetTask: 'submodel',
                sourcePath: 'characters.0.chats.0.subModel',
                binding: { kind: 'pluginModel', id: 'pluginmodel:::sub' },
            }],
            pluginBindings: [],
            manualRequired: [],
            skippedBias: [],
            preservedLegacyFields: [],
            warnings: [],
        }

        applyModelPresetMigration(db, report)

        expect(db.characters?.[0].chats?.[0].taskModelBindings?.memory).toEqual({ kind: 'modelPreset', id: 'preset-memory' })
        expect(db.characters?.[0].chats?.[0].subModelBinding).toEqual({ kind: 'pluginModel', id: 'pluginmodel:::sub' })
    })

    test('applies manualRequired bindings for unsupported legacy models', () => {
        const db: ModelPresetMigrationApplyTarget = {
            aiModel: 'novelai',
        }
        const report = analyzeModelPresetMigration(db)

        applyModelPresetMigration(db, report)

        expect(db.modelBinding).toEqual({
            kind: 'manualRequired',
            reason: 'Unsupported legacy model: novelai',
            legacySource: 'db.aiModel',
        })
        expect(db.modelPresetMigrationReport).toMatchObject({
            manualRequiredCount: 1,
            createdModelPresetCount: 0,
        })
    })

    test('applies bias-only migration summary without creating presets', () => {
        const db: ModelPresetMigrationApplyTarget = {
            bias: [['token', 1]],
        }
        const report = analyzeModelPresetMigration(db)

        applyModelPresetMigration(db, report)

        expect(db.modelPresets).toEqual([])
        expect(db.modelPresetMigrationReport).toMatchObject({
            createdModelPresetCount: 0,
            skippedBiasCount: 1,
        })
    })
})
