import {
    RegistryProfileNotFoundError,
    resolveSnapshot,
} from './registry/snapshot'
import type {
    BaseProviderDefinition,
    ModelPreset,
    ModelPresetSourceProfile,
    ModelProfile,
    OrphanedUserValue,
    ProfileSnapshotUpdateResult,
    ProfileUpdateAvailability,
    RegistryAuth,
    RegistryCache,
    RegistryEndpoint,
    RegistryFieldSchema,
    RegistryUiField,
    RegistryUiSchema,
    ResolvedModelProfileSnapshot,
    SnapshotDiff,
    SnapshotSchemaFieldChange,
    SnapshotUiFieldChange,
    SnapshotUiGroupChange,
} from './types'

export interface ProfileUpdateOptions {
    now?: () => number
}

export interface ProfileSnapshotUpdateOptions extends ProfileUpdateOptions {
    sourceProfile?: ModelPresetSourceProfile
}

export function getProfileUpdateAvailability(
    preset: ModelPreset,
    registry: RegistryCache,
    options: ProfileUpdateOptions = {},
): ProfileUpdateAvailability {
    const source = preset.sourceProfile
    if (!source) return { status: 'no-source' }

    let latestSnapshot: ResolvedModelProfileSnapshot
    try {
        latestSnapshot = resolveSourceSnapshot(registry, source)
    } catch (err) {
        if (err instanceof RegistryProfileNotFoundError) {
            return { status: 'profile-missing', profileId: source.profileId }
        }
        throw err
    }

    const currentVersion = source.profileVersion
    const latestVersion = latestSnapshot.profileVersion
    const currentBaseVersion = source.providerBaseVersion
    const latestBaseVersion = latestSnapshot.providerBaseVersion
    // Optional field on the source profile (legacy presets persisted before
    // it existed leave it undefined). Treat undefined as "matches latest" so
    // legacy presets do not light up a spurious update card on every
    // base-provider bump. Once they go through an update apply they pick up
    // the providerBaseVersion and start participating in normal detection.
    const baseVersionsMatch = currentBaseVersion === undefined
        || currentBaseVersion === latestBaseVersion
    const baseVersionDowngrade = currentBaseVersion !== undefined
        && currentBaseVersion > latestBaseVersion

    if (currentVersion === latestVersion && baseVersionsMatch) {
        return { status: 'current', profileId: source.profileId, version: currentVersion }
    }
    if (currentVersion > latestVersion || baseVersionDowngrade) {
        return {
            status: 'downgrade',
            profileId: source.profileId,
            currentVersion,
            registryVersion: latestVersion,
        }
    }

    const now = options.now ?? Date.now
    return {
        status: 'available',
        profileId: source.profileId,
        fromVersion: currentVersion,
        toVersion: latestVersion,
        latestSnapshot,
        latestSourceProfile: {
            registryId: source.registryId,
            profileId: source.profileId,
            profileVersion: latestVersion,
            providerBaseVersion: latestBaseVersion,
            fetchedAt: now(),
        },
    }
}

export function diffProfileSnapshot(
    current: ResolvedModelProfileSnapshot,
    latest: ResolvedModelProfileSnapshot,
): SnapshotDiff {
    return {
        profileId: latest.profileId,
        fromVersion: current.profileVersion,
        toVersion: latest.profileVersion,
        providerBaseChanged: current.providerBaseId !== latest.providerBaseId,
        adapterKindChanged: current.adapterKind !== latest.adapterKind,
        modelIdChanged: current.modelId !== latest.modelId,
        endpointChanged: !endpointEqual(current.endpoint, latest.endpoint),
        authChanged: !authEqual(current.auth, latest.auth),
        capabilitiesChanged: !arrayEqual(current.capabilities, latest.capabilities),
        defaultsChanged: !deepEqual(current.defaults, latest.defaults),
        bodyTemplateChanged: !deepEqual(current.bodyTemplate, latest.bodyTemplate),
        headerTemplateChanged: !deepEqual(current.headerTemplate, latest.headerTemplate),
        schemaChanges: diffSchemaFields(current.schema, latest.schema),
        uiSchemaFieldChanges: diffUiFields(current.uiSchema, latest.uiSchema),
        uiSchemaGroupChanges: diffUiGroups(current.uiSchema, latest.uiSchema),
    }
}

export function applyProfileSnapshotUpdate(
    preset: ModelPreset,
    latestSnapshot: ResolvedModelProfileSnapshot,
    options: ProfileSnapshotUpdateOptions = {},
): ProfileSnapshotUpdateResult {
    const now = options.now ?? Date.now
    const updatedAt = now()
    const diff = diffProfileSnapshot(preset.profileSnapshot, latestSnapshot)

    const currentSchemaByKey = new Map(preset.profileSnapshot.schema.map((f) => [f.key, f]))
    const latestSchemaByKey = new Map(latestSnapshot.schema.map((f) => [f.key, f]))

    const nextUserValues: Record<string, unknown> = {}
    const movedToOrphan: OrphanedUserValue[] = []

    for (const [key, value] of Object.entries(preset.userValues)) {
        const latestField = latestSchemaByKey.get(key)
        if (!latestField) {
            movedToOrphan.push({ key, value, reason: 'removed' })
            continue
        }
        const currentField = currentSchemaByKey.get(key)
        if (currentField && currentField.type !== latestField.type) {
            movedToOrphan.push({ key, value, reason: 'type-changed' })
            continue
        }
        nextUserValues[key] = value
    }

    const newFieldKeys: string[] = []
    for (const key of latestSchemaByKey.keys()) {
        if (!currentSchemaByKey.has(key)) newFieldKeys.push(key)
    }

    const orphanValues = { ...(preset.orphanValues ?? {}) }
    for (const orphan of movedToOrphan) {
        orphanValues[orphan.key] = orphan.value
    }

    let sourceProfile: ModelPresetSourceProfile | undefined
    if (options.sourceProfile) {
        sourceProfile = options.sourceProfile
    } else if (preset.sourceProfile && preset.sourceProfile.profileId === latestSnapshot.profileId) {
        sourceProfile = {
            ...preset.sourceProfile,
            profileVersion: latestSnapshot.profileVersion,
            providerBaseVersion: latestSnapshot.providerBaseVersion,
            fetchedAt: updatedAt,
        }
    }

    const nextPreset: ModelPreset = {
        ...preset,
        profileSnapshot: latestSnapshot,
        sourceProfile,
        userValues: nextUserValues,
        orphanValues: Object.keys(orphanValues).length > 0 ? orphanValues : undefined,
        updatedAt,
    }

    return {
        preset: nextPreset,
        diff,
        movedToOrphan,
        newFieldKeys,
    }
}

function resolveSourceSnapshot(
    registry: RegistryCache,
    source: ModelPresetSourceProfile,
): ResolvedModelProfileSnapshot {
    const entry = registry.registries[source.registryId]
    if (!entry?.profiles?.[source.profileId]) {
        throw new RegistryProfileNotFoundError(source.profileId)
    }

    return resolveSnapshot({
        schemaVersion: registry.schemaVersion,
        registries: {
            [source.registryId]: {
                fetchedAt: entry.fetchedAt,
                indexVersion: entry.indexVersion,
                profiles: entry.profiles as Record<string, ModelProfile>,
                baseProviders: entry.baseProviders as Record<string, BaseProviderDefinition>,
            },
        },
    }, source.profileId)
}

function diffSchemaFields(
    current: RegistryFieldSchema[],
    latest: RegistryFieldSchema[],
): SnapshotSchemaFieldChange[] {
    const currentByKey = new Map(current.map((f) => [f.key, f]))
    const latestByKey = new Map(latest.map((f) => [f.key, f]))
    const changes: SnapshotSchemaFieldChange[] = []

    for (const field of latest) {
        if (!currentByKey.has(field.key)) {
            changes.push({ key: field.key, changeKind: 'added' })
        }
    }
    for (const field of current) {
        if (!latestByKey.has(field.key)) {
            changes.push({ key: field.key, changeKind: 'removed' })
        }
    }
    for (const [key, latestField] of latestByKey) {
        const currentField = currentByKey.get(key)
        if (!currentField) continue
        const change = compareSchemaField(currentField, latestField)
        if (change) changes.push(change)
    }
    return changes
}

function compareSchemaField(
    a: RegistryFieldSchema,
    b: RegistryFieldSchema,
): SnapshotSchemaFieldChange | null {
    const modified: string[] = []
    const typeChanged = a.type !== b.type
    if (typeChanged) modified.push('type')
    if (a.label !== b.label) modified.push('label')
    if (a.description !== b.description) modified.push('description')
    if (!deepEqual(a.default, b.default)) modified.push('default')
    if (!deepEqual(a.enum, b.enum)) modified.push('enum')
    if (a.min !== b.min) modified.push('min')
    if (a.max !== b.max) modified.push('max')
    if (a.step !== b.step) modified.push('step')
    if ((a.required ?? false) !== (b.required ?? false)) modified.push('required')
    if ((a.secret ?? false) !== (b.secret ?? false)) modified.push('secret')
    if (!deepEqual(a.mapsTo, b.mapsTo)) modified.push('mapsTo')
    if (modified.length === 0) return null
    return {
        key: a.key,
        changeKind: 'modified',
        fromType: typeChanged ? a.type : undefined,
        toType: typeChanged ? b.type : undefined,
        modifiedAttributes: modified,
    }
}

function diffUiFields(
    current: RegistryUiSchema,
    latest: RegistryUiSchema,
): SnapshotUiFieldChange[] {
    const currentByKey = new Map(current.fields.map((f) => [f.key, f]))
    const latestByKey = new Map(latest.fields.map((f) => [f.key, f]))
    const changes: SnapshotUiFieldChange[] = []

    for (const field of latest.fields) {
        if (!currentByKey.has(field.key)) {
            changes.push({ key: field.key, changeKind: 'added' })
        }
    }
    for (const field of current.fields) {
        if (!latestByKey.has(field.key)) {
            changes.push({ key: field.key, changeKind: 'removed' })
        }
    }
    for (const [key, latestField] of latestByKey) {
        const currentField = currentByKey.get(key)
        if (!currentField) continue
        const change = compareUiField(currentField, latestField)
        if (change) changes.push(change)
    }
    return changes
}

function compareUiField(
    a: RegistryUiField,
    b: RegistryUiField,
): SnapshotUiFieldChange | null {
    const modified: string[] = []
    if (a.widget !== b.widget) modified.push('widget')
    if (a.visibility !== b.visibility) modified.push('visibility')
    if (a.group !== b.group) modified.push('group')
    if (a.order !== b.order) modified.push('order')
    if (a.placeholder !== b.placeholder) modified.push('placeholder')
    if (a.help !== b.help) modified.push('help')
    if (!deepEqual(a.showIf, b.showIf)) modified.push('showIf')
    if (modified.length === 0) return null
    return { key: a.key, changeKind: 'modified', modifiedAttributes: modified }
}

function diffUiGroups(
    current: RegistryUiSchema,
    latest: RegistryUiSchema,
): SnapshotUiGroupChange[] {
    const currentById = new Map(current.groups.map((g) => [g.id, g]))
    const latestById = new Map(latest.groups.map((g) => [g.id, g]))
    const changes: SnapshotUiGroupChange[] = []

    for (const group of latest.groups) {
        if (!currentById.has(group.id)) {
            changes.push({ id: group.id, changeKind: 'added' })
        }
    }
    for (const group of current.groups) {
        if (!latestById.has(group.id)) {
            changes.push({ id: group.id, changeKind: 'removed' })
        }
    }
    for (const [id, latestGroup] of latestById) {
        const currentGroup = currentById.get(id)
        if (!currentGroup) continue
        if (currentGroup.label !== latestGroup.label || currentGroup.order !== latestGroup.order) {
            changes.push({ id, changeKind: 'modified' })
        }
    }
    return changes
}

function endpointEqual(a: RegistryEndpoint, b: RegistryEndpoint): boolean {
    return a.kind === b.kind && a.url === b.url
}

function authEqual(a: RegistryAuth, b: RegistryAuth): boolean {
    if (a.kind !== b.kind) return false
    return arrayEqual(a.fields, b.fields)
}

function arrayEqual(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
    if (a === b) return true
    if (!a || !b) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (!deepEqual(a[i], b[i])) return false
    }
    return true
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a === undefined || b === undefined) return a === b
    if (a === null || b === null) return a === b
    if (typeof a !== typeof b) return false
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b)) return false
        return arrayEqual(a, b)
    }
    if (typeof a === 'object' && typeof b === 'object') {
        const aKeys = Object.keys(a as Record<string, unknown>)
        const bKeys = Object.keys(b as Record<string, unknown>)
        if (aKeys.length !== bKeys.length) return false
        for (const key of aKeys) {
            if (!Object.prototype.hasOwnProperty.call(b, key)) return false
            if (!deepEqual(
                (a as Record<string, unknown>)[key],
                (b as Record<string, unknown>)[key],
            )) return false
        }
        return true
    }
    return false
}
