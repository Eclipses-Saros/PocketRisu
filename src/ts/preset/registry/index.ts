import type { MigrationSnapshotResolver } from '../migration'
import { getBundledRegistryId, loadBundledRegistry } from './loader'
import { resolveSnapshot } from './snapshot'

export { loadBundledRegistry, getBundledRegistryId } from './loader'
export {
    resolveSnapshot,
    RegistryProfileNotFoundError,
    RegistryBaseProviderNotFoundError,
} from './snapshot'

export function bundledMigrationResolver(): MigrationSnapshotResolver {
    const registry = loadBundledRegistry()
    const registryId = getBundledRegistryId()
    return (planned) => {
        const snapshot = resolveSnapshot(registry, planned.profileId)
        return {
            snapshot,
            sourceProfile: {
                registryId,
                profileId: snapshot.profileId,
                profileVersion: snapshot.profileVersion,
                providerBaseVersion: snapshot.providerBaseVersion,
                fetchedAt: Date.now(),
            },
        }
    }
}
