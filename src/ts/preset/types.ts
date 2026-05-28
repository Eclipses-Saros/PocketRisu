export type AdapterKind =
    | 'openai-compatible'
    | 'anthropic-messages'
    | 'google-gemini'

export type AuthKind =
    | 'none'
    | 'bearer'
    | 'x-api-key'
    | 'x-goog-api-key'
    | 'query'
    | 'google-service-account'

export type EndpointKind =
    | 'static'
    | 'vertex-openai'

export type RegistryFieldType =
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'json'
    | 'stringArray'
    | 'keyValue'

export type RegistryWidget =
    | 'text'
    | 'secret'
    | 'textarea'
    | 'number-input'
    | 'slider'
    | 'select'
    | 'segmented'
    | 'toggle'
    | 'combobox'
    | 'string-array'
    | 'json'
    | 'key-value'

export type UiVisibility = 'basic' | 'advanced' | 'hidden'

export type RegistryMappingTarget =
    | 'body'
    | 'header'
    | 'query'
    | 'auth'
    | 'custom'

export interface RegistryMapping {
    target: RegistryMappingTarget
    path: string
}

export interface RegistryFieldSchema {
    key: string
    type: RegistryFieldType
    label: string
    description?: string
    default?: unknown
    enum?: Array<{ value: string | number | boolean; label: string }>
    min?: number
    max?: number
    step?: number
    required?: boolean
    secret?: boolean
    mapsTo?: RegistryMapping
}

export interface RegistrySimpleCondition {
    key: string
    equals?: unknown
    notEquals?: unknown
}

export interface RegistryUiField {
    key: string
    widget: RegistryWidget
    visibility: UiVisibility
    group?: string
    order?: number
    placeholder?: string
    help?: string
    showIf?: RegistrySimpleCondition
}

export interface RegistryUiSchema {
    groups: Array<{ id: string; label: string; order?: number }>
    fields: RegistryUiField[]
}

export interface RegistryEndpoint {
    kind: EndpointKind
    url?: string
}

export interface RegistryAuth {
    kind: AuthKind
    fields?: string[]
}

export type RegistryCapability =
    | 'streaming'
    | 'vision'
    | 'tools'
    | 'json'
    | 'reasoning'

export interface BaseProviderDefinition {
    id: string
    version: number
    displayName: string
    adapterKind: AdapterKind
    authKinds: AuthKind[]
    endpointKinds: EndpointKind[]
    defaultHeaders?: Record<string, string>
    defaultBody?: Record<string, unknown>
    requestSchema: RegistryFieldSchema[]
    uiSchema: RegistryUiSchema
    capabilities?: RegistryCapability[]
    sourceUrls: string[]
}

export interface ModelProfile {
    id: string
    version: number
    displayName: string
    providerBaseId: string
    profileTier: 'standard'
    description?: string
    modelId: string
    endpoint: RegistryEndpoint
    auth: RegistryAuth
    defaults: Record<string, unknown>
    schema: RegistryFieldSchema[]
    uiSchema: RegistryUiSchema
    bodyTemplate?: Record<string, unknown>
    headerTemplate?: Record<string, string>
    capabilities?: RegistryCapability[]
    sourceUrls: string[]
}

export interface ModelPresetSourceProfile {
    registryId: string
    profileId: string
    profileVersion: number
    // Optional for backwards compatibility: presets persisted before this
    // field existed will have it undefined. Profile-update detection treats
    // undefined as "unknown, backfill on next resolve" to avoid showing a
    // spurious update card on every legacy preset.
    providerBaseVersion?: number
    fetchedAt: number
}

export interface ResolvedModelProfileSnapshot {
    profileId: string
    profileVersion: number
    providerBaseId: string
    providerBaseVersion: number
    adapterKind: AdapterKind
    auth: RegistryAuth
    endpoint: RegistryEndpoint
    modelId: string
    schema: RegistryFieldSchema[]
    uiSchema: RegistryUiSchema
    defaults: Record<string, unknown>
    bodyTemplate?: Record<string, unknown>
    headerTemplate?: Record<string, string>
    capabilities?: RegistryCapability[]
}

export interface ModelPreset {
    id: string
    name: string
    notes?: string
    sourceProfile?: ModelPresetSourceProfile
    migrationSource?: {
        sourceKind: string
        sourcePath: string
        configHash: string
    }
    profileSnapshot: ResolvedModelProfileSnapshot
    userValues: Record<string, unknown>
    orphanValues?: Record<string, unknown>
    customBody?: Record<string, unknown>
    customHeaders?: Record<string, string>
    apiKeyRef?: string
    inlineCredential?: unknown
    fallbackModelPresetIds?: string[]
    pinned?: boolean
    order?: number
    createdAt: number
    updatedAt: number
}

export type ModelBinding =
    | { kind: 'modelPreset'; id: string }
    | { kind: 'pluginModel'; id: string }
    | { kind: 'manualRequired'; reason: string; legacySource?: string }
    | { kind: 'none' }

export type ResolvedTask =
    | 'model'
    | 'submodel'
    | 'memory'
    | 'emotion'
    | 'translate'
    | 'otherAx'

export type TaskModelBindings = Partial<Record<ResolvedTask, ModelBinding>>

export interface ModelBindingFields {
    modelBinding?: ModelBinding
    subModelBinding?: ModelBinding
    taskModelBindings?: TaskModelBindings
}

export interface ApiKeyPoolEntry {
    id: string
    name: string
    provider?: string
    key: string
    createdAt: number
    updatedAt: number
}

export interface RegistryCache {
    schemaVersion: 4
    registries: Record<string, {
        fetchedAt: number
        indexVersion?: number
        profiles?: Record<string, ModelProfile>
        baseProviders?: Record<string, BaseProviderDefinition>
    }>
}

// v5 migration scope (plan v5): customModels-only. Everything else (provider
// keys, reverse-proxy fields, native aiModel strings, botPreset overrides,
// task bindings, bias, fallbacks) stays in the legacy DB untouched and is
// surfaced via the "Legacy Info" UI. Summary/report types are sized to that.
export interface ModelPresetMigrationSummary {
    version: number
    appliedAt: number
    createdModelPresetCount: number
    manualRequiredCount: number
    warnings: string[]
}

export interface PlannedModelPreset {
    id: string
    name: string
    sourceKind: string
    sourcePath: string
    profileId: string
    modelId?: string
    endpointUrl?: string
    credentialSource?: {
        kind: 'legacyKey'
        sourcePath: string
    }
    userValues: Record<string, unknown>
}

export interface ManualMigrationItem {
    sourcePath: string
    reason: string
    legacySource?: string
}

export interface MigrationReport {
    version: 1
    createdModelPresets: PlannedModelPreset[]
    manualRequired: ManualMigrationItem[]
    warnings: string[]
}

export type SnapshotChangeKind = 'added' | 'removed' | 'modified'

export interface SnapshotSchemaFieldChange {
    key: string
    changeKind: SnapshotChangeKind
    fromType?: RegistryFieldType
    toType?: RegistryFieldType
    modifiedAttributes?: string[]
}

export interface SnapshotUiFieldChange {
    key: string
    changeKind: SnapshotChangeKind
    modifiedAttributes?: string[]
}

export interface SnapshotUiGroupChange {
    id: string
    changeKind: SnapshotChangeKind
}

export interface SnapshotDiff {
    profileId: string
    fromVersion: number
    toVersion: number
    providerBaseChanged: boolean
    adapterKindChanged: boolean
    modelIdChanged: boolean
    endpointChanged: boolean
    authChanged: boolean
    capabilitiesChanged: boolean
    defaultsChanged: boolean
    bodyTemplateChanged: boolean
    headerTemplateChanged: boolean
    schemaChanges: SnapshotSchemaFieldChange[]
    uiSchemaFieldChanges: SnapshotUiFieldChange[]
    uiSchemaGroupChanges: SnapshotUiGroupChange[]
}

export type ProfileUpdateAvailability =
    | { status: 'no-source' }
    | { status: 'profile-missing'; profileId: string }
    | { status: 'current'; profileId: string; version: number }
    | {
        status: 'available'
        profileId: string
        fromVersion: number
        toVersion: number
        latestSnapshot: ResolvedModelProfileSnapshot
        latestSourceProfile: ModelPresetSourceProfile
    }
    | {
        status: 'downgrade'
        profileId: string
        currentVersion: number
        registryVersion: number
    }

export interface OrphanedUserValue {
    key: string
    value: unknown
    reason: 'removed' | 'type-changed'
}

export interface ProfileSnapshotUpdateResult {
    preset: ModelPreset
    diff: SnapshotDiff
    movedToOrphan: OrphanedUserValue[]
    newFieldKeys: string[]
}
