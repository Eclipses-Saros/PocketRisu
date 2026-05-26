import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { ParsedServiceAccount } from './serviceAccount'

let cached: { pem: string; publicKey: KeyObject } | undefined

export function getTestKeyPair(): { pem: string; publicKey: KeyObject } {
    if (cached) return cached
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    cached = {
        pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        publicKey,
    }
    return cached
}

export function makeServiceAccountFixture(
    overrides: Partial<ParsedServiceAccount> = {},
): ParsedServiceAccount {
    const { pem } = getTestKeyPair()
    return {
        type: 'service_account',
        clientEmail: 'svc@demo.iam.gserviceaccount.com',
        privateKeyId: 'kid-1',
        privateKey: pem,
        tokenUri: 'https://oauth2.googleapis.com/token',
        ...overrides,
    }
}
