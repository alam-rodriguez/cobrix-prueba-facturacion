/**
 * Starts the test environment in one process:
 *   - the invoice manager API over data/billing-api.sqlite  (BILLING_API_PORT, default 4310)
 *   - the panel skeleton                                     (PORT, default 4300)
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const billingApiDb = process.env.BILLING_API_DB ?? DEFAULT_BILLING_API_DB
const cobrixDb = process.env.COBRIX_DB ?? resolve(root, 'data/cobrix.sqlite')
const appPort = Number(process.env.PORT ?? 4300)
const billingApiPort = Number(process.env.BILLING_API_PORT ?? 4310)
const host = process.env.HOST ?? '127.0.0.1'

if (!existsSync(billingApiDb)) seedBillingApi(billingApiDb)

const billingApi = createBillingApiServer(billingApiDb)
const actualBillingApiPort = await billingApi.listen(billingApiPort, host)
const simulatorUrl = `http://${host}:${actualBillingApiPort}`

const store = createStore(cobrixDb)
const app = createApp({ simulatorUrl, assignmentPath: resolve(root, 'docs/ENUNCIADO.md'), store })
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
let lastAutomaticRun = store.getLastAutomaticRunDate()
let automaticRunInProgress = false
const scheduler = setInterval(() => {
	const settings = store.getSettings()
	if (!settings.autoRunEnabled || automaticRunInProgress) return
	const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())
	const part = (type: string): string => parts.find(value => value.type === type)?.value ?? ''
	const day = `${part('year')}-${part('month')}-${part('day')}`
	// Catch up once if the process started, or the setting was enabled, after today's target time.
	if (`${part('hour')}:${part('minute')}` < settings.autoRunTime || lastAutomaticRun === day) return
	lastAutomaticRun = day
	store.setLastAutomaticRunDate(day)
	automaticRunInProgress = true
	console.log(`[scheduler] iniciando corrida diaria (${settings.autoRunTime}, America/Caracas)`)
	void (async () => {
		try {
			const imported = await synchronizer.runImport(false)
			const importRun = store.db.prepare('SELECT status,error FROM run WHERE id=?').get(imported) as { status: string; error: string | null }
			if (importRun.status === 'failed') console.error(`[scheduler] importación fallida: ${importRun.error}`)
			const paid = await synchronizer.runPayments(false)
			const paymentRun = store.db.prepare('SELECT status,error FROM run WHERE id=?').get(paid) as { status: string; error: string | null }
			if (paymentRun.status === 'failed') console.error(`[scheduler] actualización de pagos fallida: ${paymentRun.error}`)
		} catch (error) { console.error('[scheduler] error inesperado', error) }
		finally { automaticRunInProgress = false }
	})()
}, 30_000)

console.log(`Panel:                    http://${host}:${actualAppPort}`)
console.log(`API del administrador:    ${simulatorUrl}/api/v1`)
console.log(`Swagger:                  ${simulatorUrl}/docs`)
console.log(`Fecha de la prueba:       ${process.env.SANDBOX_TODAY}`)

const shutdown = (): void => {
	clearInterval(scheduler)
	app.close(() => {
		store.close()
		void billingApi.close().then(() => process.exit(0))
	})
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
