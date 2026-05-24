import type {
    BaseProviderDefinition,
    ModelProfile,
    RegistryCache,
    RegistryFieldSchema,
    RegistryUiField,
    RegistryUiSchema,
    ResolvedModelProfileSnapshot,
} from '../types'

export class RegistryProfileNotFoundError extends Error {
    readonly profileId: string

    constructor(profileId: string) {
        super(`Registry profile "${profileId}" not found in bundled registry. ` +
            `Ensure the analyzer emits a profileId present in the registry, ` +
            `or sync the registry bundle.`)
        this.name = 'RegistryProfileNotFoundError'
        this.profileId = profileId
    }
}

export class RegistryBaseProviderNotFoundError extends Error {
    readonly baseProviderId: string
    readonly profileId: string

    constructor(profileId: string, baseProviderId: string) {
        super(`Registry profile "${profileId}" references unknown base provider "${baseProviderId}".`)
        this.name = 'RegistryBaseProviderNotFoundError'
        this.profileId = profileId
        this.baseProviderId = baseProviderId
    }
}

export function resolveSnapshot(registry: RegistryCache, profileId: string): ResolvedModelProfileSnapshot {
    const { baseProvider, profile } = findProfile(registry, profileId)

    return {
        profileId: profile.id,
        profileVersion: profile.version,
        providerBaseId: profile.providerBaseId,
        adapterKind: baseProvider.adapterKind,
        auth: profile.auth,
        endpoint: profile.endpoint,
        modelId: profile.modelId,
        schema: backfillSchemaDefaults(
            mergeSchemas(baseProvider.requestSchema, profile.schema),
            profile,
        ),
        uiSchema: mergeUiSchemas(baseProvider.uiSchema, profile.uiSchema),
        defaults: { ...(baseProvider.defaultBody ?? {}), ...profile.defaults },
        bodyTemplate: profile.bodyTemplate,
        headerTemplate: { ...(baseProvider.defaultHeaders ?? {}), ...(profile.headerTemplate ?? {}) },
        capabilities: profile.capabilities ?? baseProvider.capabilities,
    }
}

function backfillSchemaDefaults(
    schema: RegistryFieldSchema[],
    profile: ModelProfile,
): RegistryFieldSchema[] {
    if (!profile.modelId) return schema
    return schema.map((field) => {
        if (field.key === 'modelId' && field.default === undefined) {
            return { ...field, default: profile.modelId }
        }
        return field
    })
}

function findProfile(
    registry: RegistryCache,
    profileId: string,
): { baseProvider: BaseProviderDefinition; profile: ModelProfile } {
    for (const entry of Object.values(registry.registries)) {
        const profile = entry.profiles?.[profileId]
        if (!profile) continue
        const baseProvider = entry.baseProviders?.[profile.providerBaseId]
        if (!baseProvider) {
            throw new RegistryBaseProviderNotFoundError(profileId, profile.providerBaseId)
        }
        return { baseProvider, profile }
    }
    throw new RegistryProfileNotFoundError(profileId)
}

function mergeSchemas(
    base: RegistryFieldSchema[],
    extension: RegistryFieldSchema[],
): RegistryFieldSchema[] {
    if (!extension || extension.length === 0) return base.slice()
    const merged: RegistryFieldSchema[] = []
    const overrideKeys = new Set(extension.map((f) => f.key))
    for (const field of base) {
        if (!overrideKeys.has(field.key)) merged.push(field)
    }
    for (const field of extension) merged.push(field)
    return merged
}

function mergeUiSchemas(base: RegistryUiSchema, extension: RegistryUiSchema): RegistryUiSchema {
    if (!extension || (extension.groups.length === 0 && extension.fields.length === 0)) {
        return cloneUiSchema(base)
    }

    const groupIds = new Set(extension.groups.map((g) => g.id))
    const groups = base.groups.filter((g) => !groupIds.has(g.id)).concat(extension.groups)

    const fieldKeys = new Set(extension.fields.map((f) => f.key))
    const fields: RegistryUiField[] = base.fields
        .filter((f) => !fieldKeys.has(f.key))
        .concat(extension.fields)

    return { groups, fields }
}

function cloneUiSchema(ui: RegistryUiSchema): RegistryUiSchema {
    return {
        groups: ui.groups.slice(),
        fields: ui.fields.slice(),
    }
}
