import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { seedBillingApi } from '../src/billing-api/seed.ts'
import { createBillingApiServer, type BillingApiServer } from '../src/billing-api/server.ts'
import { createStore, DEFAULT_SETTINGS, type Store } from '../src/cobrix/store.ts'
import { normalizeDocument, parseInstallmentLabel, Synchronizer } from '../src/cobrix/sync.ts'
import { createApp } from '../src/web/app.ts'

process.env.SANDBOX_TODAY = '2026-10-13'

describe('integración con el administrador ISP', () => {
	let directory: string
	let api: BillingApiServer
	let apiUrl: string
	let store: Store
	let synchronizer: Synchronizer
	let panel: ReturnType<typeof createApp>
	let panelUrl: string

	before(async () => {
		directory = mkdtempSync(join(tmpdir(), 'cobrix-integration-'))
		const apiDb = join(directory, 'isp.sqlite')
		seedBillingApi(apiDb)
		api = createBillingApiServer(apiDb)
		apiUrl = `http://127.0.0.1:${await api.listen(0)}`
		store = createStore(join(directory, 'cobrix.sqlite'))
		store.saveSettings({ ...DEFAULT_SETTINGS, apiUrl })
		synchronizer = new Synchronizer(store)
		panel = createApp({ simulatorUrl: apiUrl, assignmentPath: new URL('../docs/ENUNCIADO.md', import.meta.url).pathname, store })
		await new Promise<void>(resolve => panel.listen(0, '127.0.0.1', resolve))
		const address = panel.address()
		panelUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
	})

	after(async () => {
		await new Promise<void>(resolve => panel.close(() => resolve()))
		store.close()
		await api.close()
		rmSync(directory, { recursive: true, force: true })
	})

	it('normaliza identificación y deriva periodo/vencimiento sin asumir datos', () => {
		assert.deepEqual(normalizeDocument('V-12345678'), { id: 'V12345678', type: 'V' })
		assert.deepEqual(normalizeDocument('09000123'), { id: '9000123', type: '' })
		assert.deepEqual(normalizeDocument('J-40123456-7'), { id: 'J401234567', type: 'J' })
		assert.equal(normalizeDocument('V-123'), null)
		assert.deepEqual(parseInstallmentLabel(['PLAN15MB25 - 2026 Agosto']), { period: '2026-08', dueDate: '2026-08-01' })
		assert.equal(parseInstallmentLabel(['detalle sin periodo']), null)
	})

	it('actualiza la configuración en Zustand y la conserva en SQLite entre reinicios', () => {
		const scheduleDb = join(directory, 'scheduler.sqlite')
		const first = createStore(scheduleDb)
		const configurationChanges: string[] = []
		const unsubscribe = first.configuration.subscribe(state => configurationChanges.push(state.settings.companyName))
		first.saveSettings({ ...first.getSettings(), companyName: 'Fibra de prueba' })
		unsubscribe()
		assert.deepEqual(configurationChanges, ['Fibra de prueba'])
		first.setLastAutomaticRunDate('2026-10-13')
		first.close()
		const reopened = createStore(scheduleDb)
		assert.equal(reopened.getLastAutomaticRunDate(), '2026-10-13')
		assert.equal(reopened.getSettings().companyName, 'Fibra de prueba')
		reopened.close()
	})

	it('simula sin escrituras, importa de forma idempotente y respeta las exclusiones', async () => {
		const simulatedRun = await synchronizer.runImport(true)
		assert.equal(Number((store.db.prepare('SELECT COUNT(*) n FROM customer').get() as { n: number }).n), 0)
		const simulatedItems = store.db.prepare('SELECT result FROM run_item WHERE run_id=?').all(simulatedRun) as Array<{ result: string }>
		assert.equal(simulatedItems.filter(row => row.result === 'se_importaria').length, 42)
		const excludedCustomer = store.db.prepare(`SELECT ri.customer_id FROM run_item ri LEFT JOIN customer c ON c.id=ri.customer_id
			WHERE ri.run_id=? AND ri.customer_id IS NOT NULL AND c.id IS NULL LIMIT 1`).get(simulatedRun) as { customer_id: string }
		const simulationDetail = await (await fetch(`${panelUrl}/sincronizacion?run=${simulatedRun}`)).text()
		assert.doesNotMatch(simulationDetail, new RegExp(`<a href="/clientes/${excludedCustomer.customer_id}">`))
		assert.match(simulationDetail, /Importadas/)
		assert.doesNotMatch(simulationDetail, /Imported|Already imported|Marked paid|No evidence/)
		assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM run_item WHERE run_id=? AND reason LIKE 'Estado %no configurado%' ").get(simulatedRun) as { n: number }).n), 9)
		assert.equal(Number((store.db.prepare("SELECT COUNT(DISTINCT contract_id) n FROM run_item WHERE run_id=? AND reason LIKE 'Moneda USD incoherente%' ").get(simulatedRun) as { n: number }).n), 1)
		assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM run_item WHERE run_id=? AND result='saldo_residual'").get(simulatedRun) as { n: number }).n), 1)

		await synchronizer.runImport(false)
		assert.equal(Number((store.db.prepare('SELECT COUNT(*) n FROM customer').get() as { n: number }).n), 20)
		assert.equal(Number((store.db.prepare('SELECT COUNT(*) n FROM invoice').get() as { n: number }).n), 42)
		assert.equal(Number((store.db.prepare('SELECT SUM(amount_minor) n FROM invoice').get() as { n: number }).n), 123500)
		assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM customer WHERE id='9000123'").get() as { n: number }).n), 1)
		assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM contract WHERE customer_id='V9876543'").get() as { n: number }).n), 2)
		for (const name of ['CARLOS ROJAS','ROSA DIAZ','PEDRO LEON','ANDRES VARGAS','LAURA MENDEZ','JORGE CASTILLO']) {
			assert.equal(Number((store.db.prepare('SELECT COUNT(*) n FROM customer WHERE name=?').get(name) as { n: number }).n), 0, name)
		}
		const secondRun = await synchronizer.runImport(false)
		const newCount = Number((store.db.prepare("SELECT COUNT(*) n FROM run_item WHERE run_id=? AND result='importada'").get(secondRun) as { n: number }).n)
		assert.equal(newCount, 0)
	})

	it('actualiza pagos completos, abonos y anulaciones con evidencia del libro', async () => {
		const pay = async (contractId: number, amount?: number): Promise<{ id_factura: number }> => {
			const response = await fetch(`${apiUrl}/__sim/pagar`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_contrato: contractId, ...(amount === undefined ? {} : { monto: amount }) }) })
			assert.equal(response.status, 200)
			return await response.json() as { id_factura: number }
		}
		await pay(900101)
		await pay(900103, 25)
		await pay(900104)
		await pay(900114, 70)
		const elenaPayment = await pay(900113)
		const annul = await fetch(`${apiUrl}/__sim/anular`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_factura: elenaPayment.id_factura }) })
		assert.equal(annul.status, 200)

		const run = await synchronizer.runPayments(false)
		const runRows = store.db.prepare('SELECT result,reason FROM run_item WHERE run_id=?').all(run) as Array<{ result: string; reason: string }>
		assert.equal(runRows.filter(row => row.result === 'marcada_pagada').length, 8)
		assert.ok(runRows.some(row => row.result === 'abono_parcial'))
		const paid = Number((store.db.prepare("SELECT COUNT(*) n FROM invoice WHERE status='paid'").get() as { n: number }).n)
		const open = Number((store.db.prepare("SELECT COUNT(*) n FROM invoice WHERE status='open'").get() as { n: number }).n)
		const balance = Number((store.db.prepare("SELECT SUM(balance_minor) n FROM invoice WHERE status='open'").get() as { n: number }).n)
		assert.deepEqual({ paid, open, balance }, { paid: 8, open: 34, balance: 95500 })
		assert.ok(runRows.some(row => row.result === 'sin_evidencia'))
		assert.match(String((store.db.prepare("SELECT description FROM event WHERE type='invoice_paid' LIMIT 1").get() as { description: string }).description), /facturas? ISP/)
		const repeated = await synchronizer.runPayments(false)
		assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM run_item WHERE run_id=? AND result='marcada_pagada'").get(repeated) as { n: number }).n), 0)
	})

	it('registra fallos de autenticación en el historial', async () => {
		const settings = store.getSettings()
		store.saveSettings({ ...settings, apiPassword: 'incorrecta' })
		const runId = await synchronizer.runImport(false)
		const run = store.db.prepare('SELECT status,error FROM run WHERE id=?').get(runId) as { status: string; error: string }
		assert.equal(run.status, 'failed')
		assert.match(run.error, /Contraseña Incorrecta/)
		store.saveSettings(settings)
	})

	it('sirve las pantallas operativas y permite navegar al expediente', async () => {
		for (const path of ['/', '/clientes', '/sincronizacion', '/configuracion']) {
			const response = await fetch(`${panelUrl}${path}`)
			assert.equal(response.status, 200)
			assert.match(await response.text(), /<h1>/)
		}
		const detail = await fetch(`${panelUrl}/clientes/9000123`)
		assert.match(await detail.text(), /ELENA RUIZ/)
		const history = await fetch(`${panelUrl}/sincronizacion`)
		assert.match(await history.text(), /Historial de corridas/)
		const latestRunId = Number((store.db.prepare('SELECT MAX(id) id FROM run').get() as { id: number }).id)
		const detailPage = await (await fetch(`${panelUrl}/sincronizacion?run=${latestRunId}`)).text()
		assert.match(detailPage, /Detalle de corrida/)
		assert.doesNotMatch(detailPage, /<h2>Historial de corridas<\/h2>/)
		assert.match(detailPage, /← Volver atrás/)
		const settingsBefore = store.getSettings()
		const settingsForm = new URLSearchParams({ companyName: 'Fibra Norte', companyTaxId: settingsBefore.companyTaxId, collectionsEmail: settingsBefore.collectionsEmail, apiUrl: settingsBefore.apiUrl, apiUser: settingsBefore.apiUser, apiPassword: '', windowMonths: '9', maxRecentInstallments: '', graceDays: '5', maxInvoicesPerRun: '', maxAmountPerRun: '', autoRunTime: '02:00' })
		settingsForm.append('importStatuses', 'ACTIVO')
		settingsForm.append('importStatuses', 'CORTADO')
		const saved = await fetch(`${panelUrl}/acciones/configuracion`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: settingsForm, redirect: 'manual' })
		assert.equal(saved.status, 303)
		assert.equal(store.getSettings().apiPassword, settingsBefore.apiPassword)
		const configPage = await (await fetch(`${panelUrl}/configuracion`)).text()
		assert.doesNotMatch(configPage, /cobrix-sandbox/)
		assert.match(configPage, /<strong>Fibra Norte<\/strong>/)
		assert.doesNotMatch(configPage, /Datos del espacio Cobrix para cobranza|Se inicia sesión por API; la contraseña nunca se vuelve a mostrar|Solo se crean clientes que tengan al menos una cuota importable|Programación diaria con zona horaria America\/Caracas/)
		const invalidCredentials = new URLSearchParams(settingsForm)
		invalidCredentials.set('apiUser', 'usuario-inexistente')
		const connectionError = await fetch(`${panelUrl}/acciones/probar`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: invalidCredentials })
		assert.equal(connectionError.status, 200)
		const errorPage = await connectionError.text()
		assert.match(errorPage, /El correo no se encuentra registrado/)
		assert.doesNotMatch(errorPage, /API 400|\{"detail"/)
		assert.match(errorPage, /name="apiUser" required value="usuario-inexistente"/)
		assert.equal(store.getSettings().apiUser, settingsBefore.apiUser)
	})
})
