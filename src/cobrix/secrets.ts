import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Settings } from './store.ts'

function encryptionKey(): Buffer | null {
	const secret = process.env.COBRIX_SECRET_KEY
	if (!secret) return null
	if (/^[\da-f]{64}$/i.test(secret)) return Buffer.from(secret, 'hex')
	return scryptSync(secret, 'cobrix-settings-v1', 32)
}

/** Create or load a stable local key when no deployment secret was configured. */
export function ensureSettingsEncryptionKeyFile(path: string): void {
	if (process.env.COBRIX_SECRET_KEY) return

	mkdirSync(dirname(path), { recursive: true })
	const loadKey = (): string => {
		const key = readFileSync(path, 'utf8').trim()
		if (!/^[\da-f]{64}$/i.test(key)) throw new Error(`La clave local de cifrado ${path} no es válida.`)
		chmodSync(path, 0o600)
		return key
	}

	try {
		process.env.COBRIX_SECRET_KEY = loadKey()
		return
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}

	const key = randomBytes(32).toString('hex')
	try {
		writeFileSync(path, `${key}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
		chmodSync(path, 0o600)
		process.env.COBRIX_SECRET_KEY = key
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		process.env.COBRIX_SECRET_KEY = loadKey()
	}
}

export function encodeSettings(settings: Settings): string {
	const key = encryptionKey()
	if (!key) return JSON.stringify(settings)
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	const encrypted = Buffer.concat([cipher.update(settings.apiPassword, 'utf8'), cipher.final()])
	const protectedPassword = `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`
	return JSON.stringify({ ...settings, apiPassword: protectedPassword })
}

export function decodeSettings(serialized: string): Settings {
	const parsed = JSON.parse(serialized) as Settings
	if (typeof parsed.apiPassword !== 'string' || !parsed.apiPassword.startsWith('enc:v1:')) return parsed
	const key = encryptionKey()
	if (!key) throw new Error('La configuración contiene una contraseña cifrada; define COBRIX_SECRET_KEY para abrir la base.')
	const [, version, ivText, tagText, ciphertextText] = parsed.apiPassword.split(':')
	if (version !== 'v1' || !ivText || !tagText || ciphertextText === undefined) throw new Error('La contraseña cifrada de la configuración no tiene un formato válido.')
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'))
		decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
		const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8')
		return { ...parsed, apiPassword: decrypted }
	} catch { throw new Error('No se pudo descifrar la contraseña del proveedor; revisa COBRIX_SECRET_KEY.') }
}

export function settingsPasswordIsEncrypted(serialized: string): boolean {
	const parsed = JSON.parse(serialized) as { apiPassword?: unknown }
	return typeof parsed.apiPassword === 'string' && parsed.apiPassword.startsWith('enc:v1:')
}

export function hasSettingsEncryptionKey(): boolean { return encryptionKey() !== null }
