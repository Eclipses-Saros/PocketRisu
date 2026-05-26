import { LLMFormat } from '../model/types'
import type {
    ApiKeyPoolEntry,
    ManualMigrationItem,
    MigrationBindingScope,
    MigrationReport,
    ModelBindingFields,
    ModelBinding,
    ModelPreset,
    ModelPresetMigrationSummary,
    ModelPresetSourceProfile,
    PlannedBinding,
    PlannedModelPreset,
    PlannedPluginBinding,
    ResolvedModelProfileSnapshot,
    ResolvedTask,
    TaskModelBindings,
} from './types'

type LegacyCustomModel = {
    id: string
    internalId?: string
    url?: string
    format?: number
    key?: string
    name?: string
    params?: string
    flags?: number[]
}

type LegacyTaskModels = {
    memory?: string
    emotion?: string
    translate?: string
    otherAx?: string
}

type LegacyFallbackModels = {
    memory?: string[]
    emotion?: string[]
    translate?: string[]
    otherAx?: string[]
    model?: string[]
}

type LegacyBotPreset = {
    id?: string
    name?: string
    aiModel?: string
    subModel?: string
    forceReplaceUrl?: string
    proxyKey?: string
    openAIKey?: string
    proxyRequestModel?: string
    openrouterRequestModel?: string
    nanogptRequestModel?: string
    customProxyRequestModel?: string
    customAPIFormat?: number
    currentPluginProvider?: string
    bias?: [string, number][]
    customFlags?: number[]
    enableCustomFlags?: boolean
    seperateModelsForAxModels?: boolean
    seperateModels?: LegacyTaskModels
    fallbackModels?: LegacyFallbackModels
}

export type ModelPresetMigrationInput = {
    aiModel?: string
    subModel?: string
    forceReplaceUrl?: string
    proxyKey?: string
    openAIKey?: string
    openrouterKey?: string
    nanogptKey?: string
    claudeAPIKey?: string
    proxyRequestModel?: string
    openrouterRequestModel?: string
    nanogptRequestModel?: string
    customProxyRequestModel?: string
    customAPIFormat?: number
    additionalParams?: [string, string][]
    currentPluginProvider?: string
    bias?: [string, number][]
    customFlags?: number[]
    enableCustomFlags?: boolean
    customModels?: LegacyCustomModel[]
    botPresets?: LegacyBotPreset[]
    seperateModelsForAxModels?: boolean
    seperateModels?: LegacyTaskModels
    fallbackModels?: LegacyFallbackModels
    modelTools?: string[]
    presetChain?: string
    google?: {
        accessToken?: string
        projectId?: string
    }
}

type ProfileResolution =
    | { kind: 'profile'; profileId: string; modelId?: string; credentialPath?: string }
    | { kind: 'plugin'; pluginModelId: string }
    | { kind: 'manual'; reason: string }
    | { kind: 'none' }

type BindingTarget = {
    scope: MigrationBindingScope
    ownerId?: string
    targetTask: ResolvedTask
    sourcePath: string
}

type MutableModelBindingFields = {
    modelBinding?: ModelBindingFields['modelBinding']
    subModelBinding?: ModelBindingFields['subModelBinding']
    taskModelBindings?: TaskModelBindings
}

type MutableChat = MutableModelBindingFields & {
    id?: string
    name?: string
}

export type ModelPresetMigrationApplyTarget = ModelPresetMigrationInput & MutableModelBindingFields & {
    modelPresets?: ModelPreset[]
    apiKeyPool?: Record<string, ApiKeyPoolEntry>
    modelPresetMigrationVersion?: number
    modelPresetMigrationAppliedAt?: number
    modelPresetMigrationReport?: ModelPresetMigrationSummary
    botPresets?: Array<LegacyBotPreset & MutableModelBindingFields>
    characters?: Array<{
        chats?: MutableChat[]
    }>
}

export interface MigrationSnapshotResult {
    snapshot: ResolvedModelProfileSnapshot
    sourceProfile?: ModelPresetSourceProfile
}

export type MigrationSnapshotResolver = (
    planned: PlannedModelPreset,
) => ResolvedModelProfileSnapshot | MigrationSnapshotResult | undefined

function normalizeSnapshotResult(
    raw: ResolvedModelProfileSnapshot | MigrationSnapshotResult | undefined,
): MigrationSnapshotResult | undefined {
    if (!raw) return undefined
    if ((raw as MigrationSnapshotResult).snapshot) return raw as MigrationSnapshotResult
    return { snapshot: raw as ResolvedModelProfileSnapshot }
}

export function analyzeModelPresetMigration(db: ModelPresetMigrationInput): MigrationReport {
    const report: MigrationReport = {
        version: 1,
        createdModelPresets: [],
        globalBindings: [],
        botPresetBindings: [],
        chatBindings: [],
        pluginBindings: [],
        manualRequired: [],
        skippedBias: [],
        preservedLegacyFields: [],
        warnings: [],
    }
    const plannedById = new Map<string, PlannedModelPreset>()

    const addPreset = (preset: PlannedModelPreset) => {
        plannedById.set(preset.id, preset)
    }

    for (const [index, customModel] of (db.customModels ?? []).entries()) {
        const sourcePath = `customModels.${customModel.id || index}`
        const baseProfileId = profileForFormat(customModel.format)
        if (!baseProfileId) {
            addManual(report, sourcePath, `Unsupported custom model format: ${customModel.format}`, customModel.id)
            continue
        }
        const profileId = pickOpenAiCompatibleProfile(baseProfileId, isNonEmptyString(customModel.key))
        // Legacy Google call path falls back to db.google.accessToken when the
        // per-model key is empty (see process/request/google.ts: `arg.key ||
        // db.google.accessToken`). Mirror that fallback during migration so a
        // Google custom model with empty key + valid top-level Google key still
        // ends up with a resolvable apiKeyRef. Per-model key always wins.
        const credentialPath = isNonEmptyString(customModel.key)
            ? `${sourcePath}.key`
            : (profileId === 'google:standard' && isNonEmptyString(db.google?.accessToken)
                ? 'db.google.accessToken'
                : undefined)
        addPreset(createPlannedPreset({
            sourceKind: 'custom',
            sourcePath,
            profileId,
            name: customModel.name || customModel.id || `Custom Model ${index + 1}`,
            endpointUrl: customModel.url || '',
            modelId: customModel.internalId || customModel.id,
            credentialPath,
            userValues: {
                endpointUrl: customModel.url || '',
                modelId: customModel.internalId || customModel.id,
                params: redactFreeform(customModel.params || ''),
                flags: cloneArray(customModel.flags ?? []),
            },
        }))
    }

    if (hasReverseProxyConfig(db)) {
        addReverseProxyPreset(report, plannedById, {
            sourceKind: 'reverse-proxy',
            sourcePath: 'db.reverse_proxy',
            name: 'Migrated Reverse Proxy',
            forceReplaceUrl: db.forceReplaceUrl,
            requestModel: db.customProxyRequestModel || db.proxyRequestModel,
            proxyKeyPath: isNonEmptyString(db.proxyKey) ? 'db.proxyKey' : undefined,
            customAPIFormat: db.customAPIFormat,
            additionalParams: db.additionalParams,
        })
    }

    addGlobalBindings(report, plannedById, db)
    addBotPresetBindings(report, plannedById, db)
    addDeprecatedItems(report, db)

    report.createdModelPresets = Array.from(plannedById.values())
    return report
}

export function applyModelPresetMigration(
    db: ModelPresetMigrationApplyTarget,
    report: MigrationReport,
    resolveSnapshot?: MigrationSnapshotResolver,
): void {
    if (report.version !== 1) {
        throw new Error(`Unsupported ModelPreset migration report version: ${report.version}`)
    }

    const appliedAt = Date.now()
    db.modelPresets = Array.isArray(db.modelPresets) ? db.modelPresets : []
    db.apiKeyPool = db.apiKeyPool && typeof db.apiKeyPool === 'object' && !Array.isArray(db.apiKeyPool)
        ? db.apiKeyPool
        : {}

    for (const planned of report.createdModelPresets) {
        upsertApiKeyPoolEntry(db, planned, appliedAt)
        upsertModelPreset(db, planned, appliedAt, resolveSnapshot)
    }

    for (const binding of report.globalBindings) {
        applyScopedBinding(db, binding)
    }
    for (const binding of report.botPresetBindings) {
        applyScopedBinding(db, binding)
    }
    for (const binding of report.chatBindings) {
        applyScopedBinding(db, binding)
    }
    for (const binding of report.pluginBindings) {
        applyScopedBinding(db, binding)
    }

    db.modelPresetMigrationVersion = report.version
    db.modelPresetMigrationAppliedAt = appliedAt
    db.modelPresetMigrationReport = summarizeMigrationReport(report, appliedAt)
}

function addGlobalBindings(
    report: MigrationReport,
    plannedById: Map<string, PlannedModelPreset>,
    db: ModelPresetMigrationInput,
): void {
    if (db.aiModel) {
        pushBinding(report, {
            scope: 'global',
            targetTask: 'model',
            sourcePath: 'db.aiModel',
        }, bindingForLegacyModel({
            model: db.aiModel,
            sourcePath: 'db.aiModel',
            plannedById,
            db,
        }))
    }
    if (db.subModel) {
        pushBinding(report, {
            scope: 'global',
            targetTask: 'submodel',
            sourcePath: 'db.subModel',
        }, bindingForLegacyModel({
            model: db.subModel,
            sourcePath: 'db.subModel',
            plannedById,
            db,
        }))
    }
    if (db.seperateModelsForAxModels && db.seperateModels) {
        addTaskBindings(report, plannedById, db, db.seperateModels, 'global', undefined, 'db.seperateModels')
    }
}

function addBotPresetBindings(
    report: MigrationReport,
    plannedById: Map<string, PlannedModelPreset>,
    db: ModelPresetMigrationInput,
): void {
    for (const [index, preset] of (db.botPresets ?? []).entries()) {
        const ownerId = botPresetOwnerId(preset, index)
        const sourcePrefix = `botPresets.${ownerId}`

        if (hasPresetReverseProxyConfig(preset)) {
            // Create the preset before resolving bindings so reverse_proxy
            // bindings can link to the planned ModelPreset by source path.
            addReverseProxyPreset(report, plannedById, {
                sourceKind: 'bot-preset-reverse-proxy',
                sourcePath: `${sourcePrefix}.reverse_proxy`,
                name: `Migrated ${preset.name || ownerId} Reverse Proxy`,
                forceReplaceUrl: preset.forceReplaceUrl,
                requestModel: preset.customProxyRequestModel || preset.proxyRequestModel,
                proxyKeyPath: isNonEmptyString(preset.proxyKey) ? `${sourcePrefix}.proxyKey` : undefined,
                customAPIFormat: preset.customAPIFormat,
                additionalParams: undefined,
            })
        }

        if (preset.aiModel) {
            pushBinding(report, {
                scope: 'botPreset',
                ownerId,
                targetTask: 'model',
                sourcePath: `${sourcePrefix}.aiModel`,
            }, bindingForLegacyModel({
                model: preset.aiModel,
                sourcePath: `${sourcePrefix}.aiModel`,
                plannedById,
                db,
                botPreset: preset,
            }))
        }
        if (preset.subModel) {
            pushBinding(report, {
                scope: 'botPreset',
                ownerId,
                targetTask: 'submodel',
                sourcePath: `${sourcePrefix}.subModel`,
            }, bindingForLegacyModel({
                model: preset.subModel,
                sourcePath: `${sourcePrefix}.subModel`,
                plannedById,
                db,
                botPreset: preset,
            }))
        }
        if (preset.seperateModelsForAxModels && preset.seperateModels) {
            addTaskBindings(report, plannedById, db, preset.seperateModels, 'botPreset', ownerId, `${sourcePrefix}.seperateModels`, preset)
        }
    }
}

function addTaskBindings(
    report: MigrationReport,
    plannedById: Map<string, PlannedModelPreset>,
    db: ModelPresetMigrationInput,
    taskModels: LegacyTaskModels,
    scope: MigrationBindingScope,
    ownerId: string | undefined,
    sourcePrefix: string,
    botPreset?: LegacyBotPreset,
): void {
    const taskEntries: Array<[ResolvedTask, string | undefined]> = [
        ['memory', taskModels.memory],
        ['emotion', taskModels.emotion],
        ['translate', taskModels.translate],
        ['otherAx', taskModels.otherAx],
    ]
    for (const [targetTask, model] of taskEntries) {
        if (!model) continue
        pushBinding(report, {
            scope,
            ownerId,
            targetTask,
            sourcePath: `${sourcePrefix}.${targetTask}`,
        }, bindingForLegacyModel({
            model,
            sourcePath: `${sourcePrefix}.${targetTask}`,
            plannedById,
            db,
            botPreset,
        }))
    }
}

function addReverseProxyPreset(
    report: MigrationReport,
    plannedById: Map<string, PlannedModelPreset>,
    args: {
        sourceKind: string
        sourcePath: string
        name: string
        forceReplaceUrl?: string
        requestModel?: string
        proxyKeyPath?: string
        customAPIFormat?: number
        additionalParams?: [string, string][]
    },
): void {
    const baseProfileId = profileForFormat(args.customAPIFormat ?? LLMFormat.OpenAICompatible)
    if (!baseProfileId) {
        addManual(report, args.sourcePath, `Unsupported reverse proxy format: ${args.customAPIFormat}`, 'reverse_proxy')
        return
    }
    const profileId = pickOpenAiCompatibleProfile(baseProfileId, Boolean(args.proxyKeyPath))
    const planned = createPlannedPreset({
        sourceKind: args.sourceKind,
        sourcePath: args.sourcePath,
        profileId,
        name: args.name,
        endpointUrl: args.forceReplaceUrl || '',
        modelId: args.requestModel || 'reverse_proxy',
        credentialPath: args.proxyKeyPath,
        userValues: {
            endpointUrl: args.forceReplaceUrl || '',
            modelId: args.requestModel || '',
            additionalParams: redactAdditionalParams(args.additionalParams ?? []),
        },
    })
    plannedById.set(planned.id, planned)
}

function pushBinding(report: MigrationReport, target: BindingTarget, result: ProfileResolution | ModelBinding): void {
    if ('kind' in result && result.kind === 'plugin') {
        const binding: ModelBinding = { kind: 'pluginModel', id: result.pluginModelId }
        report.pluginBindings.push({ ...target, pluginModelId: result.pluginModelId, binding })
        return
    }
    if ('kind' in result && result.kind === 'manual') {
        const binding: ModelBinding = { kind: 'manualRequired', reason: result.reason, legacySource: target.sourcePath }
        addBinding(report, { ...target, binding })
        report.manualRequired.push({ sourcePath: target.sourcePath, reason: result.reason, legacySource: target.sourcePath })
        return
    }
    if ('kind' in result && result.kind === 'none') {
        return
    }
    addBinding(report, { ...target, binding: result as ModelBinding })
}

function addBinding(report: MigrationReport, binding: {
    scope: MigrationBindingScope
    ownerId?: string
    targetTask: ResolvedTask
    sourcePath: string
    binding: ModelBinding
}): void {
    if (binding.scope === 'global') {
        report.globalBindings.push(binding)
    } else if (binding.scope === 'chat') {
        report.chatBindings.push(binding)
    } else {
        report.botPresetBindings.push(binding)
    }
}

function bindingForLegacyModel(args: {
    model: string
    sourcePath: string
    plannedById: Map<string, PlannedModelPreset>
    db: ModelPresetMigrationInput
    botPreset?: LegacyBotPreset
}): ProfileResolution | ModelBinding {
    const { model, plannedById, db, botPreset, sourcePath } = args
    if (model.startsWith('pluginmodel:::')) {
        return { kind: 'plugin', pluginModelId: model }
    }
    if (model.startsWith('xcustom:::')) {
        const found = (db.customModels ?? []).find((customModel) => customModel.id === model)
        if (!found) {
            return { kind: 'manual', reason: `Custom model not found: ${model}` }
        }
        const planned = findPresetBySource(plannedById, `customModels.${found.id}`)
        if (!planned) {
            return { kind: 'manual', reason: `Custom model is not auto-migratable: ${model}` }
        }
        return { kind: 'modelPreset', id: planned.id }
    }
    if (model === 'reverse_proxy') {
        const source = botPreset ? botPresetReverseProxySource(sourcePath) : 'db.reverse_proxy'
        const planned = findPresetBySource(plannedById, source)
        if (planned) return { kind: 'modelPreset', id: planned.id }
        return { kind: 'manual', reason: 'Reverse proxy is not auto-migratable' }
    }

    const resolved = profileForLegacyModel(model, db, botPreset, sourcePath)
    if (resolved.kind !== 'profile') return resolved

    const planned = createPlannedPreset({
        sourceKind: 'legacy-model',
        sourcePath,
        profileId: resolved.profileId,
        name: `Migrated ${model}`,
        modelId: resolved.modelId || model,
        credentialPath: resolved.credentialPath,
        userValues: {
            modelId: resolved.modelId || model,
            format: botPreset?.customAPIFormat ?? db.customAPIFormat,
        },
    })
    plannedById.set(planned.id, planned)
    return { kind: 'modelPreset', id: planned.id }
}

function profileForLegacyModel(
    model: string,
    db: ModelPresetMigrationInput,
    botPreset: LegacyBotPreset | undefined,
    sourcePath: string,
): ProfileResolution {
    if (!model) return { kind: 'none' }
    if (model === 'openrouter' || model.startsWith('openrouter')) {
        return {
            kind: 'profile',
            profileId: 'openrouter:openai-compatible',
            modelId: botPreset?.openrouterRequestModel || db.openrouterRequestModel || model,
            credentialPath: credentialPathFor('openrouterKey', db, botPreset, sourcePath),
        }
    }
    if (model === 'nanogpt' || model.startsWith('nanogpt')) {
        return {
            kind: 'profile',
            profileId: 'nanogpt:openai-compatible',
            modelId: botPreset?.nanogptRequestModel || db.nanogptRequestModel || model,
            credentialPath: credentialPathFor('nanogptKey', db, botPreset, sourcePath),
        }
    }
    if (model === 'ollama' || model.startsWith('ollama')) {
        return { kind: 'profile', profileId: 'ollama:openai-compatible-local', modelId: model }
    }
    if (model.startsWith('deepseek')) {
        return { kind: 'profile', profileId: 'deepseek:openai-compatible', modelId: model }
    }
    if (model.startsWith('deepinfra_')) {
        return { kind: 'profile', profileId: 'deepinfra:openai-compatible', modelId: model }
    }
    if (model.startsWith('vercel:') || model.startsWith('vercel_')) {
        return { kind: 'profile', profileId: 'vercel:openai-compatible', modelId: model }
    }
    if (isOpenAIModelId(model)) {
        return { kind: 'profile', profileId: 'openai:standard', modelId: model, credentialPath: credentialPathFor('openAIKey', db, botPreset, sourcePath) }
    }
    if (model.startsWith('claude')) {
        return { kind: 'profile', profileId: 'anthropic:standard', modelId: model, credentialPath: credentialPathFor('claudeAPIKey', db, botPreset, sourcePath) }
    }
    if (model.startsWith('anthropic.claude')) {
        return { kind: 'manual', reason: `Native Bedrock Claude model requires manual migration: ${model}` }
    }
    if (model.startsWith('gemini')) {
        return {
            kind: 'profile',
            profileId: 'google:standard',
            modelId: model,
            credentialPath: isNonEmptyString(db.google?.accessToken) ? 'db.google.accessToken' : undefined,
        }
    }
    return { kind: 'manual', reason: `Unsupported legacy model: ${model}` }
}

function profileForFormat(format: number | undefined): string | undefined {
    switch (format) {
        case undefined:
        case LLMFormat.OpenAICompatible:
        case LLMFormat.OpenAIResponseAPI:
        case LLMFormat.NanoGPT:
        case LLMFormat.NanoGPTResponses:
        case LLMFormat.NanoGPTMessages:
        case LLMFormat.NanoGPTLegacy:
            return 'openai-compatible:custom'
        case LLMFormat.Ollama:
            return 'ollama:openai-compatible-local'
        case LLMFormat.Anthropic:
            return 'anthropic:standard'
        case LLMFormat.GoogleCloud:
        case LLMFormat.VertexAIGemini:
            return 'google:standard'
        default:
            return undefined
    }
}

// Custom OpenAI-compatible endpoints (self-hosted vLLM, LiteLLM, local Ollama
// OpenAI mode, etc.) often run without authentication. The bundled registry
// expresses this as a separate `openai-compatible:custom-noauth` profile
// (auth.kind = 'none'); migration picks it whenever the legacy source has no
// credential. Other base providers always carry a credential by contract.
function pickOpenAiCompatibleProfile(baseProfileId: string, hasCredential: boolean): string {
    if (baseProfileId === 'openai-compatible:custom' && !hasCredential) {
        return 'openai-compatible:custom-noauth'
    }
    return baseProfileId
}

function hasReverseProxyConfig(db: ModelPresetMigrationInput): boolean {
    return Boolean(
        db.aiModel === 'reverse_proxy' ||
        db.forceReplaceUrl ||
        db.customProxyRequestModel ||
        db.proxyKey ||
        (db.additionalParams?.length ?? 0) > 0,
    )
}

function hasPresetReverseProxyConfig(preset: LegacyBotPreset): boolean {
    return Boolean(
        preset.aiModel === 'reverse_proxy' ||
        preset.subModel === 'reverse_proxy' ||
        preset.forceReplaceUrl ||
        preset.proxyRequestModel ||
        preset.customProxyRequestModel ||
        preset.proxyKey,
    )
}

function botPresetReverseProxySource(sourcePath: string): string {
    const match = /^botPresets\.([^.]+)\./.exec(sourcePath)
    return match ? `botPresets.${match[1]}.reverse_proxy` : sourcePath.replace(/\.[^.]+$/, '.reverse_proxy')
}

function credentialPathFor(
    key: 'openAIKey' | 'openrouterKey' | 'nanogptKey' | 'claudeAPIKey',
    db: ModelPresetMigrationInput,
    botPreset: LegacyBotPreset | undefined,
    sourcePath: string,
): string | undefined {
    if (key === 'openAIKey' && isNonEmptyString(botPreset?.openAIKey)) {
        const match = /^botPresets\.([^.]+)\./.exec(sourcePath)
        return match ? `botPresets.${match[1]}.${key}` : `${sourcePath}.${key}`
    }
    return isNonEmptyString(db[key]) ? `db.${key}` : undefined
}

function addDeprecatedItems(report: MigrationReport, db: ModelPresetMigrationInput): void {
    if ((db.bias?.length ?? 0) > 0) {
        report.skippedBias.push({ sourcePath: 'db.bias', reason: 'Bias is not migrated to v4 ModelPreset or PromptPreset' })
    }
    for (const [index, preset] of (db.botPresets ?? []).entries()) {
        if ((preset.bias?.length ?? 0) > 0) {
            report.skippedBias.push({
                sourcePath: `botPresets.${preset.id || index}.bias`,
                reason: 'Bias is not migrated to v4 ModelPreset or PromptPreset',
            })
        }
        if ((preset.customFlags?.length ?? 0) > 0 || preset.enableCustomFlags) {
            report.preservedLegacyFields.push({
                sourcePath: `botPresets.${preset.id || index}.customFlags`,
                reason: 'Custom flags are preserved and only auto-mapped when profile schema supports them',
            })
        }
        if (preset.fallbackModels) {
            report.preservedLegacyFields.push({
                sourcePath: `botPresets.${preset.id || index}.fallbackModels`,
                reason: 'Fallback models are preserved for a later migration pass',
            })
        }
    }
    if ((db.customFlags?.length ?? 0) > 0 || db.enableCustomFlags) {
        report.preservedLegacyFields.push({
            sourcePath: 'db.customFlags',
            reason: 'Custom flags are preserved and only auto-mapped when profile schema supports them',
        })
    }
    if (db.fallbackModels) {
        report.preservedLegacyFields.push({
            sourcePath: 'db.fallbackModels',
            reason: 'Fallback models are preserved for a later migration pass',
        })
    }
    for (const path of ['modelTools', 'presetChain'] as const) {
        if (db[path] && ((Array.isArray(db[path]) && db[path].length > 0) || (!Array.isArray(db[path]) && db[path]))) {
            report.preservedLegacyFields.push({
                sourcePath: `db.${path}`,
                reason: 'Legacy field is preserved and not migrated by this dry-run analyzer',
            })
        }
    }
}

function upsertApiKeyPoolEntry(
    db: ModelPresetMigrationApplyTarget,
    planned: PlannedModelPreset,
    now: number,
): void {
    const credentialPath = planned.credentialSource?.sourcePath
    if (!credentialPath || !db.apiKeyPool) return

    const key = readLegacyStringAtPath(db, credentialPath)
    if (!key) return

    const id = apiKeyPoolIdForSourcePath(credentialPath)
    const existing = db.apiKeyPool[id]
    db.apiKeyPool[id] = {
        id,
        name: existing?.name || `Migrated ${credentialPath}`,
        provider: existing?.provider || planned.profileId,
        key,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    }
}

function upsertModelPreset(
    db: ModelPresetMigrationApplyTarget,
    planned: PlannedModelPreset,
    now: number,
    resolveSnapshot?: MigrationSnapshotResolver,
): void {
    if (!db.modelPresets) return

    const existingIndex = db.modelPresets.findIndex((preset) =>
        preset.migrationSource?.sourcePath === planned.sourcePath ||
        preset.id === planned.id
    )
    const existing = existingIndex >= 0 ? db.modelPresets[existingIndex] : undefined
    const apiKeyRef = apiKeyPoolRefForPlanned(db, planned)
    const resolved = normalizeSnapshotResult(resolveSnapshot?.(planned))
    const preset: ModelPreset = {
        id: planned.id,
        name: existing?.name || planned.name,
        notes: existing?.notes,
        // sourceProfile must match the snapshot we are about to write. Falling
        // back to existing metadata when the new snapshot came from a different
        // path (or from the fallback) would leave stale registry pointers and
        // break profile-update detection later.
        sourceProfile: resolved?.sourceProfile,
        migrationSource: {
            sourceKind: planned.sourceKind,
            sourcePath: planned.sourcePath,
            configHash: configHashFromPlannedId(planned.id),
        },
        profileSnapshot: resolved?.snapshot || createFallbackMigrationSnapshot(planned),
        userValues: cloneJsonLike(planned.userValues) as Record<string, unknown>,
        orphanValues: existing?.orphanValues,
        apiKeyRef,
        inlineCredential: existing?.inlineCredential,
        fallbackModelPresetIds: existing?.fallbackModelPresetIds,
        pinned: existing?.pinned,
        order: existing?.order,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    }

    if (existingIndex >= 0) {
        db.modelPresets[existingIndex] = preset
    } else {
        db.modelPresets.push(preset)
    }
}

function applyScopedBinding(
    db: ModelPresetMigrationApplyTarget,
    binding: PlannedBinding | PlannedPluginBinding,
): void {
    const target = binding.scope === 'global'
        ? db
        : binding.scope === 'botPreset'
            ? findBotPresetForBinding(db, binding.ownerId)
            : findChatForBinding(db, binding.ownerId)
    if (!target) return
    setBinding(target, binding.targetTask, binding.binding)
}

function setBinding(target: MutableModelBindingFields, task: ResolvedTask, binding: ModelBinding): void {
    if (task === 'model') {
        target.modelBinding = binding
        return
    }
    if (task === 'submodel') {
        target.subModelBinding = binding
        return
    }
    target.taskModelBindings = target.taskModelBindings || {}
    target.taskModelBindings[task] = binding
}

function findBotPresetForBinding(
    db: ModelPresetMigrationApplyTarget,
    ownerId: string | undefined,
): (LegacyBotPreset & MutableModelBindingFields) | undefined {
    if (!ownerId || !Array.isArray(db.botPresets)) return undefined
    if (ownerId.startsWith('index:')) {
        const index = Number(ownerId.slice('index:'.length))
        return Number.isInteger(index) ? db.botPresets[index] : undefined
    }
    const byId = db.botPresets.find((preset) => preset.id === ownerId)
    if (byId) return byId
    const index = Number(ownerId)
    return Number.isInteger(index) ? db.botPresets[index] : undefined
}

function findChatForBinding(
    db: ModelPresetMigrationApplyTarget,
    ownerId: string | undefined,
): MutableChat | undefined {
    if (!ownerId || !Array.isArray(db.characters)) return undefined
    for (const character of db.characters) {
        const found = character.chats?.find((chat) => chat.id === ownerId)
        if (found) return found
    }
    const indexMatch = /^(\d+)\.(\d+)$/.exec(ownerId)
    if (!indexMatch) return undefined
    return db.characters[Number(indexMatch[1])]?.chats?.[Number(indexMatch[2])]
}

function summarizeMigrationReport(report: MigrationReport, appliedAt: number): ModelPresetMigrationSummary {
    return {
        version: report.version,
        appliedAt,
        createdModelPresetCount: report.createdModelPresets.length,
        botPresetBindingCount: report.botPresetBindings.length,
        chatBindingCount: report.chatBindings.length,
        pluginBindingCount: report.pluginBindings.length,
        manualRequiredCount: report.manualRequired.length,
        skippedBiasCount: report.skippedBias.length,
        warnings: report.warnings.slice(),
    }
}

function createFallbackMigrationSnapshot(planned: PlannedModelPreset): ResolvedModelProfileSnapshot {
    return {
        profileId: planned.profileId,
        profileVersion: 1,
        providerBaseId: providerBaseIdForProfile(planned.profileId),
        // Required for snapshot completeness. Migrations applied without a
        // registry resolver also skip writing `sourceProfile`, so this value
        // never reaches `getProfileUpdateAvailability` — it returns 'no-source'
        // first. Re-running migration with the bundled resolver fills the real
        // snapshot (and sourceProfile) from the registry.
        providerBaseVersion: 1,
        adapterKind: adapterKindForProfile(planned.profileId),
        auth: { kind: authKindForProfile(planned.profileId), fields: planned.credentialSource ? ['apiKey'] : undefined },
        endpoint: { kind: 'static', url: planned.endpointUrl },
        modelId: planned.modelId || planned.profileId,
        schema: [],
        uiSchema: { groups: [], fields: [] },
        defaults: {},
        capabilities: ['streaming'],
    }
}

function providerBaseIdForProfile(profileId: string): string {
    if (profileId.startsWith('openai-compatible:')) return 'openai-compatible'
    return profileId.split(':')[0] || profileId
}

function adapterKindForProfile(profileId: string): ResolvedModelProfileSnapshot['adapterKind'] {
    if (profileId.startsWith('anthropic:')) return 'anthropic-messages'
    if (profileId.startsWith('google:')) return 'google-gemini'
    return 'openai-compatible'
}

function authKindForProfile(profileId: string): ResolvedModelProfileSnapshot['auth']['kind'] {
    if (profileId.startsWith('ollama:')) return 'none'
    if (profileId.startsWith('anthropic:')) return 'x-api-key'
    if (profileId.startsWith('google:')) return 'x-goog-api-key'
    return 'bearer'
}

function readLegacyStringAtPath(db: ModelPresetMigrationApplyTarget, sourcePath: string): string | undefined {
    const value = readLegacyValueAtPath(db, sourcePath)
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readLegacyValueAtPath(db: ModelPresetMigrationApplyTarget, sourcePath: string): unknown {
    if (sourcePath.startsWith('db.')) {
        return readPathSegments(db as Record<string, unknown>, sourcePath.slice(3).split('.'))
    }
    if (sourcePath.startsWith('customModels.')) {
        const [, id, ...rest] = sourcePath.split('.')
        const customModel = (db.customModels ?? []).find((model) => model.id === id)
        return readPathSegments(customModel as Record<string, unknown> | undefined, rest)
    }
    if (sourcePath.startsWith('botPresets.')) {
        const [, id, ...rest] = sourcePath.split('.')
        const preset = findBotPresetForBinding(db, id)
        return readPathSegments(preset as Record<string, unknown> | undefined, rest)
    }
    return undefined
}

function readPathSegments(source: Record<string, unknown> | undefined, segments: string[]): unknown {
    let value: unknown = source
    for (const segment of segments) {
        if (value === null || typeof value !== 'object') return undefined
        value = (value as Record<string, unknown>)[segment]
    }
    return value
}

function apiKeyPoolIdForSourcePath(sourcePath: string): string {
    return `migrated-key:${hashStable(sourcePath)}`
}

function apiKeyPoolRefForPlanned(
    db: ModelPresetMigrationApplyTarget,
    planned: PlannedModelPreset,
): string | undefined {
    const sourcePath = planned.credentialSource?.sourcePath
    if (!sourcePath || !db.apiKeyPool) return undefined
    const id = apiKeyPoolIdForSourcePath(sourcePath)
    return db.apiKeyPool[id] ? id : undefined
}

function botPresetOwnerId(preset: LegacyBotPreset, index: number): string {
    return preset.id || `index:${index}`
}

function configHashFromPlannedId(id: string): string {
    const index = id.lastIndexOf(':')
    return index >= 0 ? id.slice(index + 1) : ''
}

function createPlannedPreset(args: {
    sourceKind: string
    sourcePath: string
    profileId: string
    name: string
    modelId?: string
    endpointUrl?: string
    credentialPath?: string
    userValues: Record<string, unknown>
}): PlannedModelPreset {
    const canonicalNonSecretConfig = {
        profileId: args.profileId,
        modelId: args.modelId,
        endpointUrl: args.endpointUrl,
        userValues: args.userValues,
    }
    return {
        id: `migrated:${args.sourceKind}:${args.sourcePath}:${hashStable(canonicalNonSecretConfig)}`,
        name: args.name,
        sourceKind: args.sourceKind,
        sourcePath: args.sourcePath,
        profileId: args.profileId,
        modelId: args.modelId,
        endpointUrl: args.endpointUrl,
        credentialSource: args.credentialPath ? { kind: 'legacyKey', sourcePath: args.credentialPath } : undefined,
        userValues: cloneJsonLike(args.userValues) as Record<string, unknown>,
    }
}

function findPresetBySource(plannedById: Map<string, PlannedModelPreset>, sourcePath: string): PlannedModelPreset | undefined {
    return Array.from(plannedById.values()).find((preset) => preset.sourcePath === sourcePath)
}

function addManual(report: MigrationReport, sourcePath: string, reason: string, legacySource?: string): void {
    const item: ManualMigrationItem = { sourcePath, reason, legacySource }
    report.manualRequired.push(item)
}

function isOpenAIModelId(model: string): boolean {
    return model === 'o1' ||
        model === 'o3' ||
        model === 'o4' ||
        model.startsWith('gpt-') ||
        model.startsWith('o1-') ||
        model.startsWith('o3-') ||
        model.startsWith('o4-')
}

function redactAdditionalParams(params: [string, string][]): [string, string][] {
    return params.map(([key, value]) => [key, shouldRedactKey(key) || shouldRedactValue(value) ? '[redacted]' : value])
}

function redactFreeform(value: string): string {
    if (!value) return ''
    return shouldRedactValue(value) ? '[redacted]' : value
}

function shouldRedactKey(key: string): boolean {
    return /authorization|api[-_ ]?key|token|secret|bearer|credential/i.test(key)
}

function shouldRedactValue(value: string): boolean {
    return /bearer\s+\S+|sk-[A-Za-z0-9_-]+|api[-_ ]?key|token|secret/i.test(value)
}

// Truthy checks on legacy DB fields (`db.proxyKey ? ... : ''`) would silently
// accept non-string truthy values (e.g. a number left by a corrupted import)
// and produce phantom credentialPath entries in the dry-run report, even
// though the apply phase later filters them out via `readLegacyStringAtPath`.
// Strict checking at analyze time keeps report/summary honest.
function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0
}

function cloneArray<T>(value: T[]): T[] {
    return value.slice()
}

function cloneJsonLike(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(cloneJsonLike)
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out[key] = cloneJsonLike(child)
    }
    return out
}

function hashStable(value: unknown): string {
    const input = stableStringify(value)
    let hash = 0x811c9dc5
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`
}
