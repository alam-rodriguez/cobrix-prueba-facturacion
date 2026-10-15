import axios from 'axios'
import { QueryClient } from '@tanstack/query-core'

import { addCivilDays, addMonths, today } from '../shared/dates.ts'
import type { RunItem, RunKind, RunSummary, Settings, Store } from './store.ts'

type Row = Record<string, unknown>
const API_PREFIX = '/api/v1'
const MONTHS: Record<string, string> = {
	enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
	julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10', noviembre: '11', diciembre: '12',
}
const STATUSES = new Set(['ACTIVO', 'CORTADO', 'CORTESIA', 'RETIRADO', 'RECHAZADO', 'ANULADO'])

interface HttpOptions {
	method?: 'GET' | 'POST'
	headers?: Record<string, string>
	data?: unknown
	signal?: AbortSignal
}

export class BillingClient {
	readonly settings: Settings
	private readonly queries = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 2_000, gcTime: 30_000 } },
	})
	constructor(settings: Settings) { this.settings = settings }
	async login(): Promise<string> {
		const body = await this.request(`${API_PREFIX}/usuario/login`, {
			method: 'POST',
			data: { user_name: this.settings.apiUser, password: this.settings.apiPassword },
		}) as Row
		if (typeof body.access_token !== 'string') throw new Error('La API respondió sin access_token al iniciar sesión.')
		return body.access_token
	}
	async get(path: string, token: string): Promise<unknown> {
		const base = this.settings.apiUrl.replace(/\/+$/, '')
		const fullPath = `${API_PREFIX}${path}`
		return this.queries.fetchQuery({
			queryKey: ['billing-api', base, fullPath],
			queryFn: ({ signal }) => this.request(fullPath, { headers: { authorization: `Bearer ${token}` }, signal }),
		})
	}
	dispose(): void { this.queries.clear() }
	private async request(path: string, options: HttpOptions = {}): Promise<unknown> {
		const base = this.settings.apiUrl.replace(/\/+$/, '')
		try {
			const response = await axios.request({
				url: `${base}${path}`,
				method: options.method ?? 'GET',
				headers: options.headers,
				data: options.data,
				signal: options.signal,
				timeout: 12_000,
			})
			return response.data as unknown
		} catch (error) {
			if (axios.isAxiosError(error)) {
				if (error.response) throw new Error(apiErrorMessage(error.response.data, error.response.status))
				throw new Error(`No se pudo conectar con ${base}: ${error.message}`)
			}
			throw error
		}
	}
}

function apiErrorMessage(payload: unknown, status: number): string {
	if (payload && typeof payload === 'object') {
		const body = payload as Row
		const detail = body.detail
		if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
			const message = (detail as Row).mensaje
			if (typeof message === 'string' && message.trim()) return message
		}
		if (typeof detail === 'string' && detail.trim()) return detail
		if (Array.isArray(detail)) {
			const messages = detail.map(item => item && typeof item === 'object' && typeof (item as Row).message === 'string' ? (item as Row).message : '').filter(Boolean)
			if (messages.length) return messages.join('; ')
		}
		if (typeof body.message === 'string' && body.message.trim()) return body.message
	}
	return `La API devolvió un error (HTTP ${status}).`
}

export function normalizeDocument(raw: unknown): { id: string; type: string } | null {
	if (typeof raw !== 'string') return null
	const compact = raw.toUpperCase().replace(/[.\s-]/g, '')
	const match = compact.match(/^([VEJGP]?)(\d{6,12})$/)
	if (!match) return null
	const type = match[1] ?? ''
	const digits = match[2]!.replace(/^0+/, '')
	if (digits.length < 6 || digits.length > 12) return null
	return { id: `${type}${digits}`, type }
}

export function parseInstallmentLabel(value: unknown): { period: string; dueDate: string } | null {
	if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string') return null
	const match = value[0].match(/-\s*(\d{4})\s+([\p{L}]+)/u)
	if (!match) return null
	const month = MONTHS[match[2]!.toLocaleLowerCase('es')]
	if (!month) return null
	const period = `${match[1]}-${month}`
	return { period, dueDate: `${period}-01` }
}

function asRows(value: unknown, where: string): Row[] {
	if (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error(`Respuesta inesperada en ${where}.`)
	return value as Row[]
}
const text = (v: unknown): string => typeof v === 'string' ? v : ''
const cents = (v: unknown): number => Math.round(Number(v) * 100)
const sameScalar = (rows: Row[], key: string): boolean => rows.every(row => row[key] === rows[0]?.[key])

interface ContractData { id: number; customerId: string; documentType: string; name: string; status: string; plan: string; priceMinor: number; branch: string; email: string; phone: string; currency: string; rows: Row[] }

function classifyContract(id: number, rows: Row[]): { data?: ContractData; reason?: string } {
	if (!rows.length) return { reason: 'El administrador no devolvió información del contrato.' }
	const contractFields = ['estado', 'identificacion_contrato', 'nombre_contrato', 'moneda_sigla', 'moneda', 'precio_servicio', 'nombre_plan', 'nombre_sucursal', 'email', 'telefono']
	if (rows.some(row => Number(row.contrato_id) !== id) || contractFields.some(field => !sameScalar(rows, field))) {
		return { reason: 'Respuesta contradictoria: datos del contrato distintos entre sus cuotas.' }
	}
	const seen = new Set<string>()
	for (const row of rows) {
		if (typeof row.deuda_id !== 'string' || !Number.isFinite(Number(row.deuda)) || Number(row.deuda) < 0) return { reason: 'Respuesta contradictoria: identificador o saldo de cuota inválido.' }
		const debtId = text(row.deuda_id)
		if (!debtId) return { reason: 'Respuesta contradictoria: identificador de cuota vacío.' }
		if (debtId === '0' && Number(row.deuda) !== 0) return { reason: 'Respuesta contradictoria: deuda_id 0 tiene saldo distinto de cero.' }
		if (debtId && debtId !== '0') {
			if (seen.has(debtId)) return { reason: `Respuesta contradictoria: cuota duplicada ${debtId}.` }
			seen.add(debtId)
		}
	}
	const status = text(rows[0]!.estado)
	if (!STATUSES.has(status)) return { reason: `Estado de contrato desconocido: ${status || '(vacío)'}.` }
	const document = normalizeDocument(rows[0]!.identificacion_contrato)
	if (!document) return { reason: 'Identificación del titular inválida; no se puede agrupar el cliente.' }
	const price = Number(rows[0]!.precio_servicio)
	if (!Number.isFinite(price) || price <= 0) return { reason: 'Precio de plan inválido.' }
	const currency = text(rows[0]!.moneda_sigla)
	const realDebt = rows.filter(row => text(row.deuda_id) !== '0' && Number(row.deuda) > 0)
	if (currency !== 'USD' || realDebt.some(row => Number(row.deuda) < price * 0.01)) return { reason: 'Moneda USD incoherente: saldo inferior al 1 % del precio del plan.' }
	return { data: {
		id, customerId: document.id, documentType: document.type, name: text(rows[0]!.nombre_contrato), status,
		plan: text(rows[0]!.nombre_plan), priceMinor: cents(price), branch: text(rows[0]!.nombre_sucursal),
		email: text(rows[0]!.email), phone: text(rows[0]!.telefono), currency, rows,
	} }
}

export interface RunRecord { id: number; kind: RunKind; simulated: boolean; status: string; started_at: string; finished_at: string; summary: string; error: string | null }

export class Synchronizer {
	readonly store: Store
	constructor(store: Store) { this.store = store }
	async testConnection(settings = this.store.getSettings()): Promise<{ contracts: number }> {
		const client = new BillingClient(settings)
		try {
			const token = await client.login()
			const response = await client.get('/isp/lista_ids_contratos', token) as Row
			if (!Array.isArray(response.data)) throw new Error('La respuesta de contratos no contiene la lista data.')
			return { contracts: response.data.length }
		} finally { client.dispose() }
	}
	async runImport(simulated = false): Promise<number> {
		return this.execute('import', simulated, async (client, token, items) => {
			const list = await client.get('/isp/lista_ids_contratos', token) as Row
			if (!Array.isArray(list.data) || list.data.some(id => !Number.isInteger(Number(id)))) throw new Error('La lista de contratos no es válida.')
			const ids = [...new Set((list.data as unknown[]).map(Number))]
			const settings = this.store.getSettings()
			let createdCount = 0
			let createdAmount = 0
			for (const id of ids) {
				const rawRows = asRows(await client.get(`/isp/contrato/individual?id_contrato=${encodeURIComponent(id)}`, token), `contrato ${id}`)
				const classified = classifyContract(id, rawRows)
				const candidateRows = rawRows.filter(row => text(row.deuda_id) !== '0' && Number(row.deuda) > 0)
				if (!classified.data) {
					for (const row of candidateRows) items.push(this.item(id, null, row, 0, 'excluida', classified.reason!))
					continue
				}
				const contract = classified.data
				if (!settings.importStatuses.includes(contract.status)) {
					for (const row of candidateRows) items.push(this.item(id, contract.customerId, row, cents(row.deuda), 'excluida', `Estado ${contract.status} no configurado para importar.`))
					continue
				}
				if (settings.excludedDocumentTypes.includes(contract.documentType)) {
					for (const row of candidateRows) items.push(this.item(id, contract.customerId, row, cents(row.deuda), 'excluida', `Documento tipo ${contract.documentType} excluido por configuración.`))
					continue
				}
				const valid: Array<{ row: Row; parsed: { period: string; dueDate: string }; amount: number }> = []
				for (const row of rawRows) {
					const debtId = text(row.deuda_id)
					if (debtId === '0') { items.push(this.item(id, contract.customerId, row, 0, 'sin_deuda', 'deuda_id 0 representa un contrato sin cuota pendiente.')); continue }
					const amount = cents(row.deuda)
					if (amount <= 0) { items.push(this.item(id, contract.customerId, row, amount, 'saldo_residual', 'Saldo menor a un centavo; no se crea factura.')); continue }
					const parsed = parseInstallmentLabel(row.detalle_deuda)
					if (!parsed) { items.push(this.item(id, contract.customerId, row, amount, 'excluida', 'No se pudo interpretar el periodo de detalle_deuda.')); continue }
					if (settings.windowMonths !== null && parsed.period < addMonths(today().slice(0, 7), -settings.windowMonths)) {
						items.push(this.item(id, contract.customerId, row, amount, 'fuera_ventana', `Periodo ${parsed.period} anterior a la ventana configurada.`)); continue
					}
					valid.push({ row, parsed, amount })
				}
				valid.sort((a, b) => a.parsed.period.localeCompare(b.parsed.period) || text(a.row.deuda_id).localeCompare(text(b.row.deuda_id)))
				const eligible = settings.maxRecentInstallments === null ? valid : valid.slice(-settings.maxRecentInstallments)
				const eligibleIds = new Set(eligible.map(entry => text(entry.row.deuda_id)))
				for (const entry of valid) if (!eligibleIds.has(text(entry.row.deuda_id))) items.push(this.item(id, contract.customerId, entry.row, entry.amount, 'fuera_limite_recientes', 'Se conservaron las cuotas más recientes por contrato.'))
				for (const entry of eligible) {
					const exists = this.store.db.prepare('SELECT id FROM invoice WHERE external_id=?').get(text(entry.row.deuda_id))
					if (exists) { items.push(this.item(id, contract.customerId, entry.row, entry.amount, 'ya_importada', 'La cuota ya está registrada; se omitió para mantener idempotencia.')); continue }
					const maxCount = settings.maxInvoicesPerRun
					if ((maxCount !== null && createdCount >= maxCount) || (settings.maxAmountPerRun !== null && createdAmount + entry.amount > settings.maxAmountPerRun * 100)) {
						items.push(this.item(id, contract.customerId, entry.row, entry.amount, 'frenada_por_tope', 'Se alcanzó el tope configurado; la cuota no se importó.')); continue
					}
					if (!simulated) this.persistInvoice(contract, entry.row, entry.parsed, entry.amount, settings.graceDays)
					createdCount++; createdAmount += entry.amount
					items.push(this.item(id, contract.customerId, entry.row, entry.amount, simulated ? 'se_importaria' : 'importada', simulated ? 'Cumple las reglas; simulación sin escrituras.' : 'Factura abierta creada en Cobrix.'))
				}
			}
		})
	}
	async runPayments(simulated = false): Promise<number> {
		return this.execute('payments', simulated, async (client, token, items) => {
			const open = this.store.db.prepare("SELECT i.*, c.id AS cid FROM invoice i JOIN contract c ON c.id=i.contract_id WHERE i.status='open' ORDER BY i.contract_id,i.period").all() as unknown as Array<Row & { external_id: string; contract_id: number; customer_id: string; period: string; amount_minor: number; balance_minor: number }>
			const byContract = new Map<number, typeof open>()
			for (const invoice of open) byContract.set(invoice.contract_id, [...(byContract.get(invoice.contract_id) ?? []), invoice])
			for (const [contractId, invoices] of byContract) {
				const response = await client.get(`/isp/pago_informacion?id_contrato=${contractId}&tipo_busqueda=CUOTA&fecha_inicio=2000-01-01&fecha_fin=2035-12-31`, token) as Row
				if (!Array.isArray(response.data)) throw new Error(`El libro de cuotas del contrato ${contractId} no contiene data.`)
				const groups = new Map<string, Row[]>()
				for (const entry of response.data as Row[]) {
					const rawDetail = entry.detalle_pago as Row | undefined
					const detail: Row | undefined = rawDetail ? { ...rawDetail, __fecha_emision: entry.fecha_emision, __isp_invoice: text(entry.num_factura) || String(entry.id_factura ?? '') } : undefined
					if (!detail || detail.id_cuota === undefined) continue
					const id = String(detail.id_cuota)
					groups.set(id, [...(groups.get(id) ?? []), detail])
				}
				let currentDebt: Set<string> | null = null
				const currentInvoices = invoices.filter(invoice => invoice.period === today().slice(0, 7))
				if (currentInvoices.some(invoice => !groups.has(invoice.external_id))) {
					const rows = asRows(await client.get(`/isp/contrato/individual?id_contrato=${contractId}`, token), `contrato ${contractId} para verificar mes actual`)
					currentDebt = new Set(rows.map(row => text(row.deuda_id)).filter(Boolean))
				}
				for (const invoice of invoices) {
					const rows = groups.get(invoice.external_id)
					if (!rows?.length) {
						const currentPending = invoice.period === today().slice(0, 7) && currentDebt?.has(invoice.external_id)
						items.push({ contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.balance_minor, result: 'sin_evidencia', reason: currentPending ? 'El contrato confirma que la cuota del mes sigue pendiente; no hay pago que aplicar.' : 'La cuota no aparece en el libro de pagos; se mantiene abierta.' })
						continue
					}
					const keyFields = ['id_cuota', 'periodo_cuota', 'saldo_cuota', 'valor_pago']
					if (rows.some(row => Number(row.id_cuota) !== Number(invoice.external_id) || Number(row.id_contrato) !== contractId) || keyFields.some(key => !sameScalar(rows, key))) {
						items.push({ contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.balance_minor, result: 'sin_evidencia', reason: 'Filas contradictorias para la misma cuota; no se infiere el estado.' }); continue
					}
					const balance = Number(rows[0]!.saldo_cuota)
					const paid = Number(rows[0]!.valor_pago)
					if (balance <= 0.005 && paid > 0) {
						const marked = simulated || this.markPaid(invoice, rows)
						items.push({ contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.balance_minor, result: simulated ? 'se_marcaria_pagada' : marked ? 'marcada_pagada' : 'ya_pagada', reason: marked ? 'Todas las filas coinciden, el saldo es cero y existe un pago.' : 'La factura ya había sido marcada pagada por otra corrida.' })
					} else if (paid > 0 && balance > 0 && cents(balance) < Number(invoice.balance_minor)) {
						items.push({ contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.balance_minor, result: 'abono_parcial', reason: `Abono registrado: ${paid.toFixed(2)}; saldo ISP ${balance.toFixed(2)}. La factura sigue abierta.` })
					} else {
						items.push({ contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.balance_minor, result: 'sin_evidencia', reason: balance <= 0.005 ? 'Saldo cero sin valor pagado (exoneración); no es un pago.' : 'El libro no acredita pago completo; la factura sigue abierta.' })
					}
				}
			}
		})
	}
	private persistInvoice(contract: ContractData, row: Row, period: { period: string; dueDate: string }, amount: number, grace: number): void {
		const db = this.store.db
		db.exec('BEGIN IMMEDIATE')
		try {
			const existingCustomer = db.prepare('SELECT id FROM customer WHERE id=?').get(contract.customerId)
			if (!existingCustomer) {
				db.prepare('INSERT INTO customer (id,name,document_type,email,phone,created_at) VALUES (?,?,?,?,?,?)').run(contract.customerId, contract.name, contract.documentType, contract.email, contract.phone, new Date().toISOString())
				db.prepare("INSERT INTO event (customer_id,created_at,type,description) VALUES (?,?,?,?)").run(contract.customerId, new Date().toISOString(), 'customer_created', 'Cliente importado desde el administrador ISP.')
			} else db.prepare('UPDATE customer SET name=?,email=?,phone=? WHERE id=?').run(contract.name, contract.email, contract.phone, contract.customerId)
			db.prepare(`INSERT INTO contract (id,customer_id,name,status,plan,price_minor,branch,currency) VALUES (?,?,?,?,?,?,?,?)
				ON CONFLICT(id) DO UPDATE SET customer_id=excluded.customer_id,name=excluded.name,status=excluded.status,plan=excluded.plan,price_minor=excluded.price_minor,branch=excluded.branch,currency=excluded.currency`)
				.run(contract.id, contract.customerId, contract.name, contract.status, contract.plan, contract.priceMinor, contract.branch, contract.currency)
			const invoice = db.prepare('INSERT INTO invoice (external_id,contract_id,customer_id,period,due_date,cutoff_date,amount_minor,balance_minor) VALUES (?,?,?,?,?,?,?,?)')
				.run(text(row.deuda_id), contract.id, contract.customerId, period.period, period.dueDate, addCivilDays(period.dueDate, grace), amount, amount)
			db.prepare("INSERT INTO event (customer_id,invoice_id,created_at,type,description) VALUES (?,?,?,?,?)").run(contract.customerId, Number(invoice.lastInsertRowid), new Date().toISOString(), 'invoice_imported', `Cuota ${text(row.deuda_id)} · periodo ${period.period} importada.`)
			db.exec('COMMIT')
		} catch (error) { db.exec('ROLLBACK'); throw error }
	}
	private markPaid(invoice: Row, rows: Row[]): boolean {
		const paidAt = rows.map(row => text(row.__fecha_emision)).find(Boolean) ?? today()
		const ispInvoices = [...new Set(rows.map(row => text(row.__isp_invoice)).filter(Boolean))].join(', ')
		const externalId = String(invoice.external_id)
		const customerId = String(invoice.customer_id)
		const db = this.store.db
		db.exec('BEGIN IMMEDIATE')
		try {
			const result = db.prepare("UPDATE invoice SET status='paid',balance_minor=0,paid_at=? WHERE external_id=? AND status='open'").run(paidAt, externalId)
			if (Number(result.changes) === 0) { db.exec('COMMIT'); return false }
			const receipt = ispInvoices ? ` mediante factura${ispInvoices.includes(',') ? 's' : ''} ISP ${ispInvoices}` : ''
			db.prepare("INSERT INTO event (customer_id,invoice_id,created_at,type,description) SELECT ?,id,?,'invoice_paid',? FROM invoice WHERE external_id=?").run(customerId, new Date().toISOString(), `Pago confirmado en ISP${receipt} para la cuota ${externalId}.`, externalId)
			db.exec('COMMIT')
			return true
		} catch (error) { db.exec('ROLLBACK'); throw error }
	}
	private item(contractId: number, customerId: string | null, row: Row, amount: number, result: string, reason: string): RunItem {
		return { contractId, customerId, debtId: text(row.deuda_id) || null, period: parseInstallmentLabel(row.detalle_deuda)?.period ?? null, amount, result, reason }
	}
	private async execute(kind: RunKind, simulated: boolean, work: (client: BillingClient, token: string, items: RunItem[]) => Promise<void>): Promise<number> {
		const started = new Date().toISOString()
		const items: RunItem[] = []
		let errorText: string | null = null
		let client: BillingClient | undefined
		try {
			client = new BillingClient(this.store.getSettings())
			const token = await client.login()
			await work(client, token, items)
		} catch (error) { errorText = error instanceof Error ? error.message : String(error) }
		finally { client?.dispose() }
		const summary = summarize(items)
		const db = this.store.db
		db.exec('BEGIN IMMEDIATE')
		try {
			const inserted = db.prepare('INSERT INTO run (kind,simulated,status,started_at,finished_at,summary,error) VALUES (?,?,?,?,?,?,?)')
				.run(kind, simulated ? 1 : 0, errorText ? 'failed' : 'completed', started, new Date().toISOString(), JSON.stringify(summary), errorText)
			const runId = Number(inserted.lastInsertRowid)
			const insertItem = db.prepare('INSERT INTO run_item (run_id,contract_id,customer_id,debt_id,period,amount_minor,result,reason) VALUES (?,?,?,?,?,?,?,?)')
			for (const item of items) insertItem.run(runId, item.contractId, item.customerId, item.debtId, item.period, item.amount, item.result, item.reason)
			db.exec('COMMIT')
			return runId
		} catch (error) { db.exec('ROLLBACK'); throw error }
	}
}

export function summarize(items: RunItem[]): RunSummary {
	const count = (value: string): number => items.filter(item => item.result === value).length
	return { total: items.length, imported: count('importada') + count('se_importaria'), alreadyImported: count('ya_importada'), excluded: items.filter(item => ['excluida', 'fuera_ventana', 'fuera_limite_recientes', 'saldo_residual', 'sin_deuda'].includes(item.result)).length, throttled: count('frenada_por_tope'), markedPaid: count('marcada_pagada') + count('se_marcaria_pagada'), partial: count('abono_parcial'), noEvidence: count('sin_evidencia') }
}
