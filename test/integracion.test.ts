import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { seedBillingApi } from '../src/billing-api/seed.ts'
import { createBillingApiServer, type BillingApiServer } from '../src/billing-api/server.ts'
import { createStore, DEFAULT_SETTINGS, type Store } from '../src/cobrix/store.ts'
import { moneyToMinorUnits, normalizeDocument, parseInstallmentLabel, RunInProgressError, Synchronizer } from '../src/cobrix/sync.ts'
import { AutomaticRunner } from '../src/cobrix/scheduler.ts'
import { ensureSettingsEncryptionKeyFile } from '../src/cobrix/secrets.ts'
import { validateBillingApiUrl } from '../src/cobrix/url-policy.ts'
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
		panel = createApp({ simulatorUrl: apiUrl, assignmentPath: new URL('../docs/ENUNCIADO.md', import.meta.url).pathname, auth: { username: 'test-operator', password: 'test-panel-password-long-enough' }, store })
		await new Promise<void>(resolve => panel.listen(0, '127.0.0.1', resolve))
		const address = panel.address()
		panelUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
	})

	async function csrfState(): Promise<{ cookie: string; token: string }> {
		const response = await panelFetch(`${panelUrl}/configuracion`)
		const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
		const html = await response.text()
		const token = html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? ''
		assert.ok(cookie.startsWith('cobrix_session='))
		assert.match(response.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/)
		assert.ok(token)
		return { cookie, token }
	}

	async function panelFetch(input: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers)
		headers.set('authorization', `Basic ${Buffer.from('test-operator:test-panel-password-long-enough').toString('base64')}`)
		return fetch(input, { ...init, headers })
	}

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
		assert.equal(moneyToMinorUnits('1.005'), 101)
		assert.equal(moneyToMinorUnits('1.015'), 102)
		assert.equal(moneyToMinorUnits('2.9e-3'), 0)
		assert.throws(() => moneyToMinorUnits('NaN'), /Importe monetario inválido/)
	})

	it('limita destinos de la API y exige HTTPS y allowlist para proveedores remotos', async () => {
		const previousAllowlist = process.env.COBRIX_API_HOSTS
		try {
			delete process.env.COBRIX_API_HOSTS
			assert.equal((await validateBillingApiUrl('http://127.0.0.1:4310')).origin, 'http://127.0.0.1:4310')
			await assert.rejects(() => validateBillingApiUrl('http://example.com'), /HTTPS/)
			await assert.rejects(() => validateBillingApiUrl('https://example.com'), /COBRIX_API_HOSTS/)
			await assert.rejects(() => validateBillingApiUrl('http://169.254.169.254'), /HTTPS/)
			await assert.rejects(() => validateBillingApiUrl('file:///etc/passwd'), /origen HTTP/)
			process.env.COBRIX_API_HOSTS = 'isp.example.test'
			await assert.rejects(() => validateBillingApiUrl('https://other.example.test'), /no está en COBRIX_API_HOSTS/)
		} finally {
			if (previousAllowlist === undefined) delete process.env.COBRIX_API_HOSTS
			else process.env.COBRIX_API_HOSTS = previousAllowlist
		}
	})

	it('no sigue redirecciones del endpoint de login ni acepta respuestas HTTP enormes', async () => {
		const before = store.getSettings()
		let redirectHit = false
		const api = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://fake-isp.local')
			if (req.method === 'POST' && url.pathname === '/api/v1/usuario/login') {
				res.writeHead(307, { location: '/steal' }); res.end(); return
			}
			if (url.pathname === '/steal') redirectHit = true
			res.writeHead(404); res.end()
		})
		await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
		const address = api.address()
		const apiUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
		try {
			await assert.rejects(() => synchronizer.testConnection({ ...before, apiUrl }))
			assert.equal(redirectHit, false)
		} finally { await new Promise<void>(resolve => api.close(() => resolve())) }

		const oversized = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://fake-isp.local')
			if (req.method === 'POST' && url.pathname === '/api/v1/usuario/login') {
				res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"access_token":"test-token"}'); return
			}
			const payload = JSON.stringify({ success: true, pagination: { page: 1, per_page: 1, total: 1, total_pages: 1 }, data: ['x'.repeat(5 * 1024 * 1024 + 128)] })
			res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }); res.end(payload)
		})
		await new Promise<void>(resolve => oversized.listen(0, '127.0.0.1', resolve))
		const oversizedAddress = oversized.address()
		try {
			await assert.rejects(() => synchronizer.testConnection({ ...before, apiUrl: `http://127.0.0.1:${typeof oversizedAddress === 'object' && oversizedAddress ? oversizedAddress.port : 0}` }))
		} finally { await new Promise<void>(resolve => oversized.close(() => resolve())) }
	})

	it('renueva el token una vez cuando el ISP devuelve HTTP 401', async () => {
		const before = store.getSettings()
		let logins = 0
		let listCalls = 0
		const fakeApi = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://fake-isp.local')
			const sendJson = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
			if (req.method === 'POST' && url.pathname === '/api/v1/usuario/login') return sendJson(200, { access_token: `token-${++logins}` })
			if (req.method === 'GET' && url.pathname === '/api/v1/isp/lista_ids_contratos') {
				listCalls++
				if (req.headers.authorization === 'Bearer token-1') return sendJson(401, { detail: 'Token expirado.' })
				return sendJson(200, { success: true, pagination: { page: 1, per_page: 100, total: 0, total_pages: 1 }, data: [] })
			}
			return sendJson(404, { detail: 'Ruta inesperada.' })
		})
		await new Promise<void>(resolve => fakeApi.listen(0, '127.0.0.1', resolve))
		const address = fakeApi.address()
		try {
			const result = await synchronizer.testConnection({ ...before, apiUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` })
			assert.deepEqual(result, { contracts: 0 })
			assert.equal(logins, 2)
			assert.equal(listCalls, 2)
		} finally { await new Promise<void>(resolve => fakeApi.close(() => resolve())) }
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

	it('migra una base Cobrix anterior sin perder sus datos', () => {
		const legacyPath = join(directory, 'legacy-cobrix.sqlite')
		const legacy = new DatabaseSync(legacyPath)
		legacy.exec(`
			CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL);
			CREATE TABLE customer (id TEXT PRIMARY KEY,name TEXT NOT NULL,document_type TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL,origin TEXT NOT NULL DEFAULT 'Administrador ISP',created_at TEXT NOT NULL);
			CREATE TABLE contract (id INTEGER PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES customer(id),name TEXT NOT NULL,status TEXT NOT NULL,plan TEXT NOT NULL,price_minor INTEGER NOT NULL,branch TEXT NOT NULL,currency TEXT NOT NULL);
			CREATE TABLE invoice (id INTEGER PRIMARY KEY AUTOINCREMENT,external_id TEXT NOT NULL UNIQUE,contract_id INTEGER NOT NULL REFERENCES contract(id),customer_id TEXT NOT NULL REFERENCES customer(id),period TEXT NOT NULL,due_date TEXT NOT NULL,cutoff_date TEXT NOT NULL,amount_minor INTEGER NOT NULL,balance_minor INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',paid_at TEXT);
			CREATE TABLE run (id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,simulated INTEGER NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT NOT NULL,summary TEXT NOT NULL,error TEXT);
			CREATE TABLE run_item (id INTEGER PRIMARY KEY AUTOINCREMENT,run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,contract_id INTEGER,customer_id TEXT,debt_id TEXT,period TEXT,amount_minor INTEGER NOT NULL,result TEXT NOT NULL,reason TEXT NOT NULL);
			CREATE TABLE event (id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id TEXT NOT NULL REFERENCES customer(id),invoice_id INTEGER,created_at TEXT NOT NULL,type TEXT NOT NULL,description TEXT NOT NULL);
			CREATE TABLE scheduler_state (id INTEGER PRIMARY KEY CHECK (id=1),last_automatic_run TEXT NOT NULL DEFAULT '');
			INSERT INTO settings VALUES (1,'${JSON.stringify(DEFAULT_SETTINGS)}');
			INSERT INTO customer VALUES ('V12345678','CLIENTE LEGACY','V','','','Administrador ISP','2026-10-13T00:00:00.000Z');
			INSERT INTO contract VALUES (1,'V12345678','CLIENTE LEGACY','ACTIVO','PLAN',10000,'CCS','USD');
			INSERT INTO invoice (external_id,contract_id,customer_id,period,due_date,cutoff_date,amount_minor,balance_minor) VALUES ('42',1,'V12345678','2026-10','2026-10-01','2026-10-06',10000,10000);
			INSERT INTO scheduler_state VALUES (1,'');
		`)
		legacy.close()
		const migrated = createStore(legacyPath)
		assert.equal(Number((migrated.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), 3)
		const migratedInvoice = migrated.db.prepare('SELECT external_id,amount_minor,provider_balance_minor,status FROM invoice').get() as { external_id: string; amount_minor: number; provider_balance_minor: number | null; status: string }
		assert.deepEqual([migratedInvoice.external_id,migratedInvoice.amount_minor,migratedInvoice.provider_balance_minor,migratedInvoice.status], ['42',10000,null,'open'])
		assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), [])
		assert.throws(() => migrated.db.prepare("UPDATE invoice SET status='unknown' WHERE external_id='42'").run(), /invoice invariant violation/)
		assert.throws(() => migrated.db.prepare("UPDATE contract SET customer_id='V87654321' WHERE id=1").run(), /contract customer change requires invoice reassignment/)
		migrated.close()
		const reopened = createStore(legacyPath)
		assert.equal(Number((reopened.db.prepare('SELECT COUNT(*) n FROM invoice').get() as { n: number }).n), 1)
		reopened.close()
	})

	it('cifra las credenciales al guardar y cifra una configuración heredada al abrirla', () => {
		const path = join(directory, 'encrypted-settings.sqlite')
		const previousKey = process.env.COBRIX_SECRET_KEY
		try {
			delete process.env.COBRIX_SECRET_KEY
			const legacy = createStore(path)
			legacy.saveSettings({ ...legacy.getSettings(), apiPassword: 'isp-password-that-must-not-be-plaintext' })
			legacy.close()
			process.env.COBRIX_SECRET_KEY = 'ab'.repeat(32)
			const encrypted = createStore(path)
			const serialized = String((encrypted.db.prepare('SELECT value FROM settings WHERE id=1').get() as { value: string }).value)
			assert.doesNotMatch(serialized, /isp-password-that-must-not-be-plaintext/)
			assert.match(serialized, /enc:v1:/)
			assert.equal(encrypted.getSettings().apiPassword, 'isp-password-that-must-not-be-plaintext')
			encrypted.close()
		} finally {
			if (previousKey === undefined) delete process.env.COBRIX_SECRET_KEY
			else process.env.COBRIX_SECRET_KEY = previousKey
		}
	})

	it('crea una clave local persistente con permisos privados cuando no se configura una clave', () => {
		const keyPath = join(directory, 'local-secrets', 'cobrix.secret')
		const previousKey = process.env.COBRIX_SECRET_KEY
		try {
			delete process.env.COBRIX_SECRET_KEY
			ensureSettingsEncryptionKeyFile(keyPath)
			const generatedKey = process.env.COBRIX_SECRET_KEY
			assert.match(generatedKey ?? '', /^[\da-f]{64}$/)
			assert.equal(statSync(keyPath).mode & 0o777, 0o600)
			delete process.env.COBRIX_SECRET_KEY
			ensureSettingsEncryptionKeyFile(keyPath)
			assert.equal(process.env.COBRIX_SECRET_KEY, generatedKey)
		} finally {
			if (previousKey === undefined) delete process.env.COBRIX_SECRET_KEY
			else process.env.COBRIX_SECRET_KEY = previousKey
		}
	})

	it('simula sin escrituras, importa de forma idempotente y respeta las exclusiones', async () => {
		const simulatedRun = await synchronizer.runImport(true)
		assert.equal(Number((store.db.prepare('SELECT COUNT(*) n FROM customer').get() as { n: number }).n), 0)
		const simulatedItems = store.db.prepare('SELECT result FROM run_item WHERE run_id=?').all(simulatedRun) as Array<{ result: string }>
		assert.equal(simulatedItems.filter(row => row.result === 'se_importaria').length, 42)
		const excludedCustomer = store.db.prepare(`SELECT ri.customer_id FROM run_item ri LEFT JOIN customer c ON c.id=ri.customer_id
			WHERE ri.run_id=? AND ri.customer_id IS NOT NULL AND c.id IS NULL LIMIT 1`).get(simulatedRun) as { customer_id: string }
		const simulationDetail = await (await panelFetch(`${panelUrl}/sincronizacion?run=${simulatedRun}`)).text()
		assert.doesNotMatch(simulationDetail, new RegExp(`<a href="/clientes/${excludedCustomer.customer_id}">`))
		assert.match(simulationDetail, /Importadas/)
		assert.doesNotMatch(simulationDetail, /Imported|Already imported|Marked paid|No evidence/)
		assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM run_item WHERE run_id=? AND reason LIKE 'Estado %no configurado%' ").get(simulatedRun) as { n: number }).n), 9)
		assert.equal(Number((store.db.prepare("SELECT COUNT(DISTINCT contract_id) n FROM run_item WHERE run_id=? AND reason LIKE 'Moneda USD incoherente%' ").get(simulatedRun) as { n: number }).n), 1)
		assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM run_item WHERE run_id=? AND result='saldo_residual'").get(simulatedRun) as { n: number }).n), 1)
		const first = synchronizer.runImport(true)
		await assert.rejects(() => synchronizer.runPayments(true), RunInProgressError)
		await first

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
		assert.ok(runRows.some(row => row.result === 'pendiente_confirmada'))
		assert.ok(runRows.some(row => row.result === 'abono_parcial' && Number((store.db.prepare('SELECT observed_balance_minor FROM run_item WHERE run_id=? AND result=\'abono_parcial\' LIMIT 1').get(run) as { observed_balance_minor: number }).observed_balance_minor) > 0))
		assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM invoice WHERE status='open' AND provider_balance_minor < amount_minor").get() as { n: number }).n), 1)
		assert.match(String((store.db.prepare("SELECT description FROM event WHERE type='invoice_paid' LIMIT 1").get() as { description: string }).description), /facturas? ISP/)
		const repeated = await synchronizer.runPayments(false)
		assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM run_item WHERE run_id=? AND result='marcada_pagada'").get(repeated) as { n: number }).n), 0)
		const owner = store.db.prepare('SELECT customer_id FROM contract WHERE id=900101').get() as { customer_id: string }
		store.db.prepare('INSERT INTO invoice (external_id,contract_id,customer_id,period,due_date,cutoff_date,amount_minor,balance_minor) VALUES (?,?,?,?,?,?,?,?)')
			.run('989898989', 900101, owner.customer_id, '2026-10', '2026-10-01', '2026-10-06', 10000, 10000)
		try {
			const missingRun = await synchronizer.runPayments(true)
			assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM run_item WHERE run_id=? AND debt_id='989898989' AND result='ausente_del_libro'").get(missingRun) as { n: number }).n), 1)
			const summary = JSON.parse(String((store.db.prepare('SELECT summary FROM run WHERE id=?').get(missingRun) as { summary: string }).summary)) as { missingFromLedger: number; pending: number }
			assert.ok(summary.missingFromLedger >= 1)
			assert.ok(summary.pending >= 1)
		} finally { store.db.prepare("DELETE FROM invoice WHERE external_id='989898989'").run() }
	})

	it('reabre una factura cuando el ISP anula un pago ya conciliado', async () => {
		const candidate = store.db.prepare(`SELECT external_id,contract_id,period,amount_minor FROM invoice
			WHERE status='open' AND contract_id NOT IN (900101,900103,900104,900113,900114) ORDER BY contract_id,period LIMIT 1`).get() as { external_id: string; contract_id: number; period: string; amount_minor: number }
		const paymentResponse = await fetch(`${apiUrl}/__sim/pagar`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_contrato: candidate.contract_id, monto: candidate.amount_minor / 100 }) })
		assert.equal(paymentResponse.status, 200)
		const payment = await paymentResponse.json() as { id_factura: number; cuotas: Array<{ id_cuota: number }> }
		assert.ok(payment.cuotas.some(row => String(row.id_cuota) === candidate.external_id))

		const closeRun = await synchronizer.runPayments(false)
		assert.equal(String((store.db.prepare('SELECT status FROM invoice WHERE external_id=?').get(candidate.external_id) as { status: string }).status), 'paid')
		assert.ok(Number((store.db.prepare("SELECT COUNT(*) n FROM run_item WHERE run_id=? AND debt_id=? AND result='marcada_pagada'").get(closeRun, candidate.external_id) as { n: number }).n) === 1)

		const annul = await fetch(`${apiUrl}/__sim/anular`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_factura: payment.id_factura }) })
		assert.equal(annul.status, 200)
		const reopenRun = await synchronizer.runPayments(false)
		const invoice = store.db.prepare('SELECT status,provider_balance_minor FROM invoice WHERE external_id=?').get(candidate.external_id) as { status: string; provider_balance_minor: number }
		assert.equal(invoice.status, 'open')
		assert.equal(invoice.provider_balance_minor, candidate.amount_minor)
		assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM run_item WHERE run_id=? AND debt_id=? AND result='reabierta_por_cambio_isp'").get(reopenRun, candidate.external_id) as { n: number }).n), 1)
	})

	it('no cierra una cuota si el libro contradice el pago con id_factura cero', async () => {
		const before = store.getSettings()
		const invoice = store.db.prepare("SELECT external_id,contract_id,period FROM invoice WHERE status='open' ORDER BY id LIMIT 1").get() as { external_id: string; contract_id: number; period: string }
		const fakeApi = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://fake-isp.local')
			const sendJson = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
			if (req.method === 'POST' && url.pathname === '/api/v1/usuario/login') return sendJson(200, { access_token: 'test-token' })
			if (req.method === 'GET' && url.pathname === '/api/v1/isp/pago_informacion') {
				const contractId = Number(url.searchParams.get('id_contrato'))
				if (contractId !== invoice.contract_id) return sendJson(200, { success: false, data: [] })
				return sendJson(200, { success: false, data: [{ id_factura: 0, fecha_emision: '2026-10-13', num_factura: '', detalle_pago: { id_cuota: Number(invoice.external_id), id_contrato: contractId, periodo_cuota: invoice.period, saldo_cuota: 0, valor_pago: 1 } }] })
			}
			if (req.method === 'GET' && url.pathname === '/api/v1/isp/contrato/individual') return sendJson(200, [])
			return sendJson(404, { detail: 'Ruta inesperada.' })
		})
		await new Promise<void>(resolve => fakeApi.listen(0, '127.0.0.1', resolve))
		const address = fakeApi.address()
		store.saveSettings({ ...before, apiUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` })
		try {
			const runId = await synchronizer.runPayments(false)
			assert.equal(String((store.db.prepare('SELECT status FROM invoice WHERE external_id=?').get(invoice.external_id) as { status: string }).status), 'open')
			assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM run_item WHERE run_id=? AND debt_id=? AND result='filas_inconsistentes'").get(runId, invoice.external_id) as { n: number }).n), 1)
		} finally {
			store.saveSettings(before)
			await new Promise<void>(resolve => fakeApi.close(() => resolve()))
		}
	})

	it('cierra como exonerada una cuota con saldo cero y sin pago, sin contarla como deuda', async () => {
		const before = store.getSettings()
		const invoice = store.db.prepare("SELECT external_id,contract_id,period FROM invoice WHERE status='open' ORDER BY id LIMIT 1").get() as { external_id: string; contract_id: number; period: string }
		const fakeApi = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://fake-isp.local')
			const sendJson = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
			if (req.method === 'POST' && url.pathname === '/api/v1/usuario/login') return sendJson(200, { access_token: 'test-token' })
			if (req.method === 'GET' && url.pathname === '/api/v1/isp/pago_informacion') {
				const contractId = Number(url.searchParams.get('id_contrato'))
				if (contractId !== invoice.contract_id) return sendJson(200, { success: false, data: [] })
				return sendJson(200, { success: false, data: [{ id_factura: 0, fecha_emision: '2026-10-13', num_factura: '', detalle_pago: { id_cuota: Number(invoice.external_id), id_contrato: contractId, periodo_cuota: invoice.period, saldo_cuota: 0, valor_pago: 0 } }] })
			}
			if (req.method === 'GET' && url.pathname === '/api/v1/isp/contrato/individual') return sendJson(200, [])
			return sendJson(404, { detail: 'Ruta inesperada.' })
		})
		await new Promise<void>(resolve => fakeApi.listen(0, '127.0.0.1', resolve))
		const address = fakeApi.address()
		store.saveSettings({ ...before, apiUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` })
		try {
			const runId = await synchronizer.runPayments(false)
			const current = store.db.prepare('SELECT status,provider_balance_minor FROM invoice WHERE external_id=?').get(invoice.external_id) as { status: string; provider_balance_minor: number }
			assert.equal(current.status, 'exempt')
			assert.equal(current.provider_balance_minor, 0)
			assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM invoice WHERE status='open' AND external_id=?").get(invoice.external_id) as { n: number }).n), 0)
			assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM run_item WHERE run_id=? AND debt_id=? AND result='exonerada'").get(runId, invoice.external_id) as { n: number }).n), 1)
		} finally { store.saveSettings(before); await new Promise<void>(resolve => fakeApi.close(() => resolve())) }
	})

	it('el programador detiene pagos si falla la importación y reanuda solo la etapa pendiente', async () => {
		const automaticStore = createStore(join(directory, 'automatic-recovery.sqlite'))
		const validSettings = automaticStore.getSettings()
		automaticStore.saveSettings({ ...validSettings, apiUrl, autoRunEnabled: true, autoRunTime: '00:00', apiPassword: 'incorrecta' })
		const runner = new AutomaticRunner(automaticStore, new Synchronizer(automaticStore))
		try {
			await runner.tick(new Date())
			const workflow = automaticStore.db.prepare('SELECT id,status FROM automatic_run').get() as { id: number; status: string }
			assert.equal(workflow.status, 'pending')
			const stages = automaticStore.db.prepare('SELECT stage,status,attempt FROM automatic_run_stage WHERE automatic_run_id=? ORDER BY stage').all(workflow.id) as Array<{ stage: string; status: string; attempt: number }>
			assert.deepEqual(stages.map(stage => [stage.stage,stage.status,stage.attempt]), [
				['import','failed',1],
				['payments','pending',0],
			])
			const retryAt = String((automaticStore.db.prepare("SELECT next_retry_at FROM automatic_run_stage WHERE automatic_run_id=? AND stage='import'").get(workflow.id) as { next_retry_at: string }).next_retry_at)
			automaticStore.saveSettings({ ...validSettings, apiUrl, autoRunEnabled: true, autoRunTime: '00:00' })
			const retryTime = new Date(Date.parse(retryAt) + 1_000)
			await runner.tick(retryTime)
			assert.equal(String((automaticStore.db.prepare("SELECT status FROM automatic_run_stage WHERE automatic_run_id=? AND stage='import'").get(workflow.id) as { status: string }).status), 'completed')
			assert.equal(String((automaticStore.db.prepare("SELECT status FROM automatic_run_stage WHERE automatic_run_id=? AND stage='payments'").get(workflow.id) as { status: string }).status), 'pending')
			await runner.tick(new Date(retryTime.getTime() + 1_000))
			assert.equal(String((automaticStore.db.prepare('SELECT status FROM automatic_run WHERE id=?').get(workflow.id) as { status: string }).status), 'completed')
			assert.equal(Number((automaticStore.db.prepare("SELECT COUNT(*) n FROM automatic_run_stage WHERE automatic_run_id=? AND status='completed'").get(workflow.id) as { n: number }).n), 2)
		} finally { automaticStore.close() }
	})

	it('serializa la reclamación automática entre dos conexiones SQLite', async () => {
		const path = join(directory, 'automatic-concurrency.sqlite')
		const firstStore = createStore(path)
		const secondStore = createStore(path)
		for (const current of [firstStore, secondStore]) current.saveSettings({ ...current.getSettings(), apiUrl, autoRunEnabled: true, autoRunTime: '00:00' })
		const firstRunner = new AutomaticRunner(firstStore, new Synchronizer(firstStore))
		const secondRunner = new AutomaticRunner(secondStore, new Synchronizer(secondStore))
		try {
			await Promise.all([firstRunner.tick(new Date()), secondRunner.tick(new Date())])
			assert.equal(Number((firstStore.db.prepare('SELECT COUNT(*) n FROM automatic_run').get() as { n: number }).n), 1)
			assert.equal(Number((firstStore.db.prepare('SELECT COUNT(*) n FROM run WHERE kind=\'import\'').get() as { n: number }).n), 1)
		} finally { firstStore.close(); secondStore.close() }
	})

	it('fencea una corrida cuyo lease venció mientras la API seguía respondiendo', async () => {
		const path = join(directory, 'expired-run-lease.sqlite')
		const firstStore = createStore(path)
		const secondStore = createStore(path)
		let loginSeen = false
		const slowApi = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://fake-isp.local')
			const sendJson = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
			if (req.method === 'POST' && url.pathname === '/api/v1/usuario/login') {
				loginSeen = true
				return setTimeout(() => sendJson(200, { access_token: 'test-token' }), 150)
			}
			if (req.method === 'GET' && url.pathname === '/api/v1/isp/lista_ids_contratos') return sendJson(200, { success: true, pagination: { page: 1, per_page: 1, total: 1, total_pages: 1 }, data: [779001] })
			if (req.method === 'GET' && url.pathname === '/api/v1/isp/contrato/individual') return sendJson(200, [{ contrato_id: 779001, estado: 'ACTIVO', identificacion_contrato: 'V-77990001', nombre_contrato: 'CLIENTE LEASE', moneda_sigla: 'USD', moneda: 'DOLAR', precio_servicio: '100.00', nombre_plan: 'Plan prueba', nombre_sucursal: 'Centro', email: 'lease@example.test', telefono: '0000', deuda_id: '9190001', deuda: 35, detalle_deuda: ['Plan prueba - 2026 Agosto'] }])
			return sendJson(404, { detail: 'Ruta inesperada.' })
		})
		await new Promise<void>(resolve => slowApi.listen(0, '127.0.0.1', resolve))
		const address = slowApi.address()
		const slowUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
		for (const current of [firstStore,secondStore]) current.saveSettings({ ...current.getSettings(), apiUrl: slowUrl })
		const firstSync = new Synchronizer(firstStore)
		const secondSync = new Synchronizer(secondStore)
		try {
			const stalePromise = firstSync.runImport(true)
			while (!loginSeen) await new Promise(resolve => setTimeout(resolve, 5))
			firstStore.db.prepare('UPDATE run_lock SET lease_until=? WHERE id=1').run('2000-01-01T00:00:00.000Z')
			const staleCheck = assert.rejects(stalePromise, /Se perdió el bloqueo/)
			const currentRunId = await secondSync.runImport(true)
			await staleCheck
			const runs = firstStore.db.prepare('SELECT id,status FROM run ORDER BY id').all() as Array<{ id: number; status: string }>
			assert.deepEqual(runs.map(run => run.status), ['failed','completed'])
			assert.equal(currentRunId, runs[1]!.id)
			assert.equal(Number((firstStore.db.prepare('SELECT COUNT(*) n FROM invoice').get() as { n: number }).n), 0)
		} finally {
			firstStore.close()
			secondStore.close()
			await new Promise<void>(resolve => slowApi.close(() => resolve()))
		}
	})

	it('rechaza una lista de contratos success=false aunque incluya data vacía', async () => {
		const before = store.getSettings()
		const fakeApi = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://fake-isp.local')
			const sendJson = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
			if (req.method === 'POST' && url.pathname === '/api/v1/usuario/login') return sendJson(200, { access_token: 'test-token' })
			if (req.method === 'GET' && url.pathname === '/api/v1/isp/lista_ids_contratos') return sendJson(200, { success: false, pagination: { page: 1, per_page: 100, total: 0, total_pages: 1 }, data: [] })
			return sendJson(404, { detail: 'Ruta inesperada.' })
		})
		await new Promise<void>(resolve => fakeApi.listen(0, '127.0.0.1', resolve))
		const address = fakeApi.address()
		store.saveSettings({ ...before, apiUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` })
		try {
			const runId = await synchronizer.runImport(false)
			const run = store.db.prepare('SELECT status,error FROM run WHERE id=?').get(runId) as { status: string; error: string }
			assert.equal(run.status, 'failed')
			assert.match(run.error, /no confirmó una lista válida/)
		} finally { store.saveSettings(before); await new Promise<void>(resolve => fakeApi.close(() => resolve())) }
	})

	it('recorre todas las páginas de contratos antes de confirmar la importación', async () => {
		const before = store.getSettings()
		const requestedPages: number[] = []
		const contracts = new Map<number, string>([[778001, 'V-77880001'], [778002, 'V-77880002']])
		const fakeApi = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://fake-isp.local')
			const sendJson = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
			if (req.method === 'POST' && url.pathname === '/api/v1/usuario/login') return sendJson(200, { access_token: 'test-token' })
			if (req.method === 'GET' && url.pathname === '/api/v1/isp/lista_ids_contratos') {
				const page = Number(url.searchParams.get('page'))
				requestedPages.push(page)
				return sendJson(200, { success: true, pagination: { page, per_page: 1, total: 2, total_pages: 2 }, data: [page === 1 ? 778001 : 778002] })
			}
			if (req.method === 'GET' && url.pathname === '/api/v1/isp/contrato/individual') {
				const id = Number(url.searchParams.get('id_contrato'))
				const document = contracts.get(id)
				if (!document) return sendJson(404, { detail: 'Contrato inesperado.' })
				return sendJson(200, [{ contrato_id: id, estado: 'ACTIVO', identificacion_contrato: document, nombre_contrato: `CLIENTE ${id}`, moneda_sigla: 'USD', moneda: 'DOLAR', precio_servicio: '100.00', nombre_plan: 'Plan prueba', nombre_sucursal: 'Centro', email: 'cliente@example.test', telefono: '0000', deuda_id: String(9980000 + id - 778000), deuda: 35, detalle_deuda: ['Plan prueba - 2026 Agosto'] }])
			}
			return sendJson(404, { detail: 'Ruta inesperada.' })
		})
		await new Promise<void>(resolve => fakeApi.listen(0, '127.0.0.1', resolve))
		const address = fakeApi.address()
		store.saveSettings({ ...before, apiUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` })
		try {
			const runId = await synchronizer.runImport(false)
			assert.deepEqual(requestedPages, [1, 2])
			assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM run_item WHERE run_id=? AND result='importada'").get(runId) as { n: number }).n), 2)
		} finally { store.saveSettings(before); await new Promise<void>(resolve => fakeApi.close(() => resolve())) }
	})

	it('revierte las escrituras pendientes si la API falla a mitad de una importación', async () => {
		const before = store.getSettings()
		const apiFailure = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://fake-isp.local')
			const sendJson = (status: number, body: unknown): void => {
				res.writeHead(status, { 'content-type': 'application/json' })
				res.end(JSON.stringify(body))
			}
			if (req.method === 'POST' && url.pathname === '/api/v1/usuario/login') return sendJson(200, { access_token: 'test-token' })
			if (req.method === 'GET' && url.pathname === '/api/v1/isp/lista_ids_contratos') return sendJson(200, { success: true, pagination: { page: 1, per_page: 100, total: 2, total_pages: 1 }, data: [777001, 777002] })
			if (req.method === 'GET' && url.pathname === '/api/v1/isp/contrato/individual') {
				const id = Number(url.searchParams.get('id_contrato'))
				if (id === 777002) return sendJson(503, { detail: 'Fallo ISP simulado a mitad de corrida.' })
				return sendJson(200, [{ contrato_id: id, estado: 'ACTIVO', identificacion_contrato: 'V-77889900', nombre_contrato: 'CLIENTE DE PRUEBA', moneda_sigla: 'USD', moneda: 'DOLAR', precio_servicio: '100.00', nombre_plan: 'Plan prueba', nombre_sucursal: 'Centro', email: 'cliente@example.test', telefono: '0000', deuda_id: '9900001', deuda: 35, detalle_deuda: ['Plan prueba - 2026 Agosto'] }])
			}
			return sendJson(404, { detail: 'Ruta inesperada.' })
		})
		await new Promise<void>(resolve => apiFailure.listen(0, '127.0.0.1', resolve))
		const address = apiFailure.address()
		const failureUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
		store.saveSettings({ ...before, apiUrl: failureUrl })
		const customersBefore = Number((store.db.prepare('SELECT COUNT(*) n FROM customer').get() as { n: number }).n)
		const invoicesBefore = Number((store.db.prepare('SELECT COUNT(*) n FROM invoice').get() as { n: number }).n)
		try {
			const runId = await synchronizer.runImport(false)
			const run = store.db.prepare('SELECT status,error,summary FROM run WHERE id=?').get(runId) as { status: string; error: string; summary: string }
			assert.equal(run.status, 'failed')
			assert.match(run.error, /Fallo ISP simulado/)
			assert.equal(Number((store.db.prepare('SELECT COUNT(*) n FROM customer').get() as { n: number }).n), customersBefore)
			assert.equal(Number((store.db.prepare('SELECT COUNT(*) n FROM invoice').get() as { n: number }).n), invoicesBefore)
			assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM run_item WHERE run_id=? AND result='no_aplicada_por_fallo'").get(runId) as { n: number }).n), 1)
			assert.equal((JSON.parse(run.summary) as { unapplied: number }).unapplied, 1)
		} finally {
			store.saveSettings(before)
			await new Promise<void>(resolve => apiFailure.close(() => resolve()))
		}
	})

	it('no aplica pagos ya clasificados si falla una llamada posterior del administrador', async () => {
		const before = store.getSettings()
		const firstContract = Number((store.db.prepare("SELECT contract_id FROM invoice WHERE status='open' ORDER BY contract_id LIMIT 1").get() as { contract_id: number }).contract_id)
		const nextContract = Number((store.db.prepare("SELECT contract_id FROM invoice WHERE status='open' AND contract_id>? ORDER BY contract_id LIMIT 1").get(firstContract) as { contract_id: number }).contract_id)
		const payable = store.db.prepare("SELECT external_id,period,amount_minor FROM invoice WHERE status='open' AND contract_id=? ORDER BY period").all(firstContract) as Array<{ external_id: string; period: string; amount_minor: number }>
		const apiFailure = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://fake-isp.local')
			const sendJson = (status: number, body: unknown): void => {
				res.writeHead(status, { 'content-type': 'application/json' })
				res.end(JSON.stringify(body))
			}
			if (req.method === 'POST' && url.pathname === '/api/v1/usuario/login') return sendJson(200, { access_token: 'test-token' })
			if (req.method === 'GET' && url.pathname === '/api/v1/isp/pago_informacion') {
				const id = Number(url.searchParams.get('id_contrato'))
				if (id === nextContract) return sendJson(503, { detail: 'Fallo de pagos ISP simulado.' })
				if (id === firstContract) return sendJson(200, { data: payable.map((invoice, index) => ({ id_factura: index + 1, fecha_emision: '2026-10-13', num_factura: `TEST-PAGO-${index + 1}`, detalle_pago: { id_cuota: Number(invoice.external_id), id_contrato: id, periodo_cuota: invoice.period, saldo_cuota: 0, valor_pago: invoice.amount_minor / 100 } })) })
				return sendJson(200, { data: [] })
			}
			if (req.method === 'GET' && url.pathname === '/api/v1/isp/contrato/individual') return sendJson(200, [])
			return sendJson(404, { detail: 'Ruta inesperada.' })
		})
		await new Promise<void>(resolve => apiFailure.listen(0, '127.0.0.1', resolve))
		const address = apiFailure.address()
		const failureUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
		store.saveSettings({ ...before, apiUrl: failureUrl })
		const paidBefore = Number((store.db.prepare("SELECT COUNT(*) n FROM invoice WHERE status='paid'").get() as { n: number }).n)
		try {
			const runId = await synchronizer.runPayments(false)
			const run = store.db.prepare('SELECT status,error FROM run WHERE id=?').get(runId) as { status: string; error: string }
			assert.equal(run.status, 'failed')
			assert.match(run.error, /Fallo de pagos ISP simulado/)
			assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM invoice WHERE status='paid'").get() as { n: number }).n), paidBefore)
			assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM run_item WHERE run_id=? AND result='no_aplicada_por_fallo'").get(runId) as { n: number }).n), payable.length)
		} finally {
			store.saveSettings(before)
			await new Promise<void>(resolve => apiFailure.close(() => resolve()))
		}
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
		const unauthenticated = await fetch(`${panelUrl}/`)
		assert.equal(unauthenticated.status, 401)
		assert.match(unauthenticated.headers.get('www-authenticate') ?? '', /^Basic realm=/)
		for (const path of ['/', '/clientes', '/facturas', '/pagos', '/sincronizacion', '/informes', '/configuracion']) {
			const response = await panelFetch(`${panelUrl}${path}`)
			assert.equal(response.status, 200)
			assert.match(await response.text(), /<h1>/)
		}
		const dashboard = await (await panelFetch(`${panelUrl}/`)).text()
		assert.match(dashboard, /Facturas por período/)
		assert.match(dashboard, /class="global-search"/)
		assert.match(dashboard, /src="\/app\.js" defer/)
		assert.doesNotMatch(dashboard, /cdn\.jsdelivr\.net|cdn\.tailwindcss/)
		assert.doesNotMatch(dashboard, /onsubmit=/)
		assert.match(dashboard, /text-muted-foreground/)
		assert.match(dashboard, /aria-controls="primary-nav"/)
		assert.match(dashboard, /Requiere seguimiento/)
		assert.match(dashboard, /Saldo vencido/)
		assert.match(await (await panelFetch(`${panelUrl}/app.css`)).text(), /--brand-darkest:#042F30/)
		const panelScript = await (await panelFetch(`${panelUrl}/app.js`)).text()
		assert.match(panelScript, /mobile-nav-toggle/)
		assert.match(panelScript, /form\[data-confirm\]/)
		assert.match((await panelFetch(`${panelUrl}/`)).headers.get('content-security-policy') ?? '', /script-src 'self'/)
		assert.doesNotMatch(dashboard, /ESPACIO DE TRABAJO|Sandbox local|>DEV</)
		for (const href of ['/facturas', '/pagos', '/informes']) assert.match(dashboard, new RegExp(`href="${href}"`))
		assert.match(await (await panelFetch(`${panelUrl}/facturas?estado=open`)).text(), /Saldo pendiente/)
		assert.match(await (await panelFetch(`${panelUrl}/facturas?estado=vencidas`)).text(), /Vencida · \d+ días/)
		assert.match(await (await panelFetch(`${panelUrl}/pagos`)).text(), /Pagos conciliados/)
		assert.match(await (await panelFetch(`${panelUrl}/informes`)).text(), /Resumen por periodo/)
		const detail = await panelFetch(`${panelUrl}/clientes/9000123`)
		assert.match(await detail.text(), /ELENA RUIZ/)
		const history = await panelFetch(`${panelUrl}/sincronizacion`)
		assert.match(await history.text(), /Historial de corridas/)
		const latestRunId = Number((store.db.prepare('SELECT MAX(id) id FROM run').get() as { id: number }).id)
		const detailPage = await (await panelFetch(`${panelUrl}/sincronizacion?run=${latestRunId}`)).text()
		assert.match(detailPage, /Detalle de corrida/)
		assert.doesNotMatch(detailPage, /<h2>Historial de corridas<\/h2>/)
		assert.match(detailPage, /← Volver atrás/)
		const settingsBefore = store.getSettings()
		const csrf = await csrfState()
		const oversized = await panelFetch(`${panelUrl}/acciones/configuracion`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x'.repeat(65 * 1024) })
		assert.equal(oversized.status, 413)
		const forbidden = await panelFetch(`${panelUrl}/acciones/configuracion`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrf.cookie, origin: 'https://attacker.example' }, body: new URLSearchParams({ _csrf: csrf.token }), redirect: 'manual' })
		assert.equal(forbidden.status, 403)
		const missingToken = await panelFetch(`${panelUrl}/acciones/configuracion`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrf.cookie, origin: panelUrl }, body: new URLSearchParams(), redirect: 'manual' })
		assert.equal(missingToken.status, 403)
		const settingsForm = new URLSearchParams({ _csrf: csrf.token, companyName: 'Fibra Norte', companyTaxId: settingsBefore.companyTaxId, collectionsEmail: settingsBefore.collectionsEmail, apiUrl: settingsBefore.apiUrl, apiUser: settingsBefore.apiUser, apiPassword: '', windowMonths: '9', maxRecentInstallments: '', graceDays: '5', maxInvoicesPerRun: '', maxAmountPerRun: '', autoRunTime: '02:00' })
		settingsForm.append('importStatuses', 'ACTIVO')
		settingsForm.append('importStatuses', 'CORTADO')
		const saved = await panelFetch(`${panelUrl}/acciones/configuracion`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrf.cookie, origin: panelUrl }, body: settingsForm, redirect: 'manual' })
		assert.equal(saved.status, 303)
		assert.equal(store.getSettings().apiPassword, settingsBefore.apiPassword)
		const configPage = await (await panelFetch(`${panelUrl}/configuracion`)).text()
		assert.doesNotMatch(configPage, /cobrix-sandbox/)
		assert.match(configPage, /<title>Configuración · Fibra Norte \| Cobrix<\/title>/)
		assert.doesNotMatch(configPage, /Datos del espacio Cobrix para cobranza|Se inicia sesión por API; la contraseña nunca se vuelve a mostrar|Solo se crean clientes que tengan al menos una cuota importable|Programación diaria con zona horaria America\/Caracas/)
		const invalidCredentials = new URLSearchParams(settingsForm)
		invalidCredentials.set('apiUser', 'usuario-inexistente')
		const connectionError = await panelFetch(`${panelUrl}/acciones/probar`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrf.cookie, origin: panelUrl }, body: invalidCredentials })
		assert.equal(connectionError.status, 200)
		const errorPage = await connectionError.text()
		assert.match(errorPage, /El correo no se encuentra registrado/)
		assert.doesNotMatch(errorPage, /API 400|\{"detail"/)
		assert.match(errorPage, /name="apiUser" required value="usuario-inexistente"/)
		assert.equal(store.getSettings().apiUser, settingsBefore.apiUser)
	})
})
