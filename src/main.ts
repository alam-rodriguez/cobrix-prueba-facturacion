/**
 * Starts the test environment in one process:
 *   - the local test invoice-manager API (loopback only, BILLING_API_PORT, default 4310)
 *   - the authenticated panel (PORT, default 4300)
 *
 * The provided database was generated for 2026-10-13. That date is pinned by default so
 * the acceptance numbers in docs/ENUNCIADO.md hold; set SANDBOX_TODAY to change it.
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.SANDBOX_TODAY ??= '2026-10-13'

const { DEFAULT_BILLING_API_DB, seedBillingApi } = await import('./billing-api/seed.ts')
const { createBillingApiServer } = await import('./billing-api/server.ts')
const { createApp } = await import('./web/app.ts')
const { createStore } = await import('./cobrix/store.ts')
const { Synchronizer } = await import('./cobrix/sync.ts')
const { AutomaticRunner } = await import('./cobrix/scheduler.ts')
const { ensureSettingsEncryptionKeyFile, hasSettingsEncryptionKey } = await import('./cobrix/secrets.ts')
const { isLoopbackBind } = await import('./cobrix/url-policy.ts')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const billingApiDb = process.env.BILLING_API_DB ?? DEFAULT_BILLING_API_DB
const cobrixDb = process.env.COBRIX_DB ?? resolve(root, 'data/cobrix.sqlite')
const appPort = Number(process.env.PORT ?? 4300)
const billingApiPort = Number(process.env.BILLING_API_PORT ?? 4310)
const host = process.env.HOST ?? '127.0.0.1'
const panelUsername = process.env.COBRIX_PANEL_USER ?? 'operador'
const panelPassword = process.env.COBRIX_PANEL_PASSWORD ?? 'cobrix-local-demo-2026'
const secureCookies = process.env.COBRIX_SECURE_COOKIES === '1'

if (isLoopbackBind(host) && !process.env.COBRIX_SECRET_KEY) ensureSettingsEncryptionKeyFile(resolve(root, 'data/cobrix.secret'))
if (!panelUsername || panelPassword.length < 16) throw new Error('COBRIX_PANEL_PASSWORD debe tener al menos 16 caracteres.')
if (!hasSettingsEncryptionKey()) throw new Error('Configura COBRIX_SECRET_KEY (64 caracteres hexadecimales) para cifrar las credenciales del ISP en SQLite.')
if (!isLoopbackBind(host) && (!process.env.COBRIX_PANEL_USER || !process.env.COBRIX_PANEL_PASSWORD || panelPassword === 'cobrix-local-demo-2026' || !process.env.COBRIX_SECRET_KEY || !secureCookies || !process.env.COBRIX_API_HOSTS?.trim())) {
	throw new Error('Para enlazar fuera de loopback configura credenciales y COBRIX_SECRET_KEY, un proxy HTTPS, COBRIX_SECURE_COOKIES=1 y COBRIX_API_HOSTS.')
}

let billingApi: ReturnType<typeof createBillingApiServer> | undefined
let simulatorUrl = ''
if (isLoopbackBind(host)) {
	if (!existsSync(billingApiDb)) seedBillingApi(billingApiDb)
	billingApi = createBillingApiServer(billingApiDb)
	const actualBillingApiPort = await billingApi.listen(billingApiPort, '127.0.0.1')
	simulatorUrl = `http://127.0.0.1:${actualBillingApiPort}`
}

const store = createStore(cobrixDb)
const app = createApp({
	simulatorUrl,
	assignmentPath: resolve(root, 'docs/ENUNCIADO.md'),
	auth: { username: panelUsername, password: panelPassword },
	secureCookies,
	store,
})
const actualAppPort = await new Promise<number>((resolvePort, reject) => {
	const onError = (error: Error): void => reject(error)
	app.once('error', onError)
	app.listen(appPort, host, () => {
		app.off('error', onError)
		const address = app.address()
		resolvePort(typeof address === 'object' && address ? address.port : appPort)
	})
})

const synchronizer = new Synchronizer(store)
const automaticRunner = new AutomaticRunner(store, synchronizer)
const scheduler = setInterval(() => {
	void automaticRunner.tick().catch(error => console.error('[scheduler] error inesperado', error))
}, 30_000)

console.log(`Panel:                    http://${host}:${actualAppPort}`)
if (isLoopbackBind(host) && !process.env.COBRIX_PANEL_USER && !process.env.COBRIX_PANEL_PASSWORD) {
	console.log(`Acceso local:             operador / cobrix-local-demo-2026`)
}
if (simulatorUrl) {
	console.log(`API simulada del ISP:     ${simulatorUrl}/api/v1`)
	console.log(`Swagger:                  ${simulatorUrl}/docs`)
}
console.log(`Fecha de la prueba:       ${process.env.SANDBOX_TODAY}`)

const shutdown = (): void => {
	clearInterval(scheduler)
	void automaticRunner.waitForIdle().then(() => {
		app.close(() => {
			store.close()
			if (billingApi) void billingApi.close().then(() => process.exit(0))
			else process.exit(0)
		})
	})
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
