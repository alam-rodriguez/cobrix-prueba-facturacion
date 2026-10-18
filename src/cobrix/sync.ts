import axios from 'axios'
import { QueryClient } from '@tanstack/query-core'
import { randomUUID } from 'node:crypto'

import { addCivilDays, addMonths, today } from '../shared/dates.ts'
import { validateBillingApiUrl } from './url-policy.ts'
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

class BillingHttpError extends Error {
	readonly status: number
	constructor(status: number, message: string) { super(message); this.status = status }
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
		if (!body || typeof body.access_token !== 'string' || !body.access_token.trim()) throw new Error('La API respondió sin access_token válido al iniciar sesión.')
		return body.access_token
	}
	async get(path: string, token: string): Promise<unknown> {
		const base = this.settings.apiUrl.replace(/\/+$/, '')
		const fullPath = `${API_PREFIX}${path}`
		try { return await this.fetchQuery(base, fullPath, token) }
		catch (error) {
			if (!(error instanceof BillingHttpError) || error.status !== 401) throw error
			const refreshed = await this.login()
			return this.fetchQuery(base, fullPath, refreshed)
		}
	}
	private fetchQuery(base: string, fullPath: string, token: string): Promise<unknown> {
		return this.queries.fetchQuery({
			queryKey: ['billing-api', base, fullPath],
			queryFn: ({ signal }) => this.request(fullPath, { headers: { authorization: `Bearer ${token}` }, signal }),
		})
	}
	dispose(): void { this.queries.clear() }
	private async request(path: string, options: HttpOptions = {}): Promise<unknown> {
		const base = this.settings.apiUrl.replace(/\/+$/, '')
		try {
			const safeBase = await validateBillingApiUrl(base)
			const response = await axios.request({
				url: `${safeBase.origin}${path}`,
				method: options.method ?? 'GET',
				headers: options.headers,
				data: options.data,
				signal: options.signal,
				timeout: 12_000,
				maxRedirects: 0,
				maxContentLength: 5 * 1024 * 1024,
				maxBodyLength: 64 * 1024,
			})
			return response.data as unknown
		} catch (error) {
			if (axios.isAxiosError(error)) {
				if (error.response) throw new BillingHttpError(error.response.status, apiErrorMessage(error.response.data, error.response.status))
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
const usdForReason = (minor: number): string => `USD ${(minor / 100).toFixed(2)}`
export function moneyToMinorUnits(value: unknown): number {
	const source = typeof value === 'number' ? (Number.isFinite(value) ? value.toString() : '') : typeof value === 'string' ? value.trim() : ''
	const match = source.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/)
	if (!match) throw new Error(`Importe monetario inválido: ${source || '(vacío)'}.`)
	const sign = match[1] === '-' ? -1n : 1n
	const fraction = match[3] ?? ''
	const exponent = Number(match[4] ?? 0)
	if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) throw new Error('Exponente monetario fuera de rango.')
	const digits = BigInt(`${match[2]}${fraction}`)
	const scale = fraction.length - exponent
	let minor: bigint
	if (scale <= 2) minor = digits * 10n ** BigInt(2 - scale)
	else {
		const divisor = 10n ** BigInt(scale - 2)
		const quotient = digits / divisor
		const remainder = digits % divisor
		minor = quotient + (remainder * 2n >= divisor ? 1n : 0n)
	}
	minor *= sign
	const result = Number(minor)
	if (!Number.isSafeInteger(result)) throw new Error('Importe monetario fuera del rango seguro.')
	return result
}
const sameScalar = (rows: Row[], key: string): boolean => rows.every(row => row[key] === rows[0]?.[key])

function positiveInteger(value: unknown): number | null {
	if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function canonicalId(value: unknown): string | null {
	if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null
	if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
	return value.replace(/^0+(?=\d)/, '')
}

function validIsoDate(value: unknown): value is string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
	const parsed = new Date(`${value}T00:00:00.000Z`)
	return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value
}

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
		plan: text(rows[0]!.nombre_plan), priceMinor: moneyToMinorUnits(price), branch: text(rows[0]!.nombre_sucursal),
		email: text(rows[0]!.email), phone: text(rows[0]!.telefono), currency, rows,
	} }
}

export interface RunRecord { id: number; kind: RunKind; simulated: boolean; status: string; started_at: string; finished_at: string; summary: string; error: string | null }

export class RunInProgressError extends Error {
	constructor() { super('Ya hay una corrida en curso. Espera a que termine antes de iniciar otra.') }
}

interface PendingMutation { apply(): void; item: RunItem }
const RUN_LEASE_MS = 60_000
const RUN_HEARTBEAT_MS = 10_000

export class Synchronizer {
	readonly store: Store
	constructor(store: Store) { this.store = store }
	async testConnection(settings = this.store.getSettings()): Promise<{ contracts: number }> {
		const client = new BillingClient(settings)
		try {
			const token = await client.login()
			return { contracts: (await this.listContractIds(client, token)).length }
		} finally { client.dispose() }
	}
	private async listContractIds(client: BillingClient, token: string): Promise<number[]> {
		const pageSize = 100
		const ids: number[] = []
		let totalPages = 1
		for (let page = 1; page <= totalPages; page++) {
			const response = await client.get(`/isp/lista_ids_contratos?page=${page}&per_page=${pageSize}`, token)
			if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('La respuesta de contratos no tiene el formato esperado.')
			const body = response as Row
			if (body.success !== true || !Array.isArray(body.data)) throw new Error('La API no confirmó una lista válida de contratos.')
			const pagination = body.pagination
			if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination)) throw new Error('La respuesta de contratos no incluye paginación válida.')
			const pageInfo = pagination as Row
			const reportedPage = Number(pageInfo.page)
			const reportedPageSize = Number(pageInfo.per_page)
			const reportedPages = Number(pageInfo.total_pages)
			const reportedTotal = Number(pageInfo.total)
			if (reportedPage !== page || !Number.isSafeInteger(reportedPageSize) || reportedPageSize < 1 || reportedPageSize > pageSize || !Number.isSafeInteger(reportedTotal) || reportedTotal < 0) {
				throw new Error(`La respuesta de contratos reporta metadatos inválidos para la página ${page}.`)
			}
			if (!Number.isSafeInteger(reportedPages) || reportedPages < 1 || reportedPages > 1_000) throw new Error('La cantidad de páginas de contratos no es válida.')
			if (page === 1) totalPages = reportedPages
			if (page > totalPages) throw new Error('La paginación de contratos cambió durante la consulta.')
			if (body.data.length === 0 && reportedTotal > 0) throw new Error(`La página ${page} está vacía aunque la API informa contratos.`)
			for (const value of body.data) {
				const id = positiveInteger(value)
				if (id === null) throw new Error('La lista de contratos contiene un identificador inválido.')
				ids.push(id)
			}
			if (body.data.length > pageSize) throw new Error('La API devolvió más contratos que el tamaño de página solicitado.')
		}
		return [...new Set(ids)]
	}
	async runImport(simulated = false): Promise<number> {
		return this.execute('import', simulated, async (client, token, items, mutations) => {
			const ids = await this.listContractIds(client, token)
			const settings = this.store.getSettings()
			const maxAmountMinor = settings.maxAmountPerRun === null ? null : moneyToMinorUnits(settings.maxAmountPerRun)
			let createdCount = 0
			let createdAmount = 0
			const scheduledExternalIds = new Set<string>()
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
					for (const row of candidateRows) items.push(this.item(id, contract.customerId, row, moneyToMinorUnits(row.deuda), 'excluida', `Estado ${contract.status} no configurado para importar.`))
					continue
				}
				if (settings.excludedDocumentTypes.includes(contract.documentType)) {
					for (const row of candidateRows) items.push(this.item(id, contract.customerId, row, moneyToMinorUnits(row.deuda), 'excluida', `Documento tipo ${contract.documentType} excluido por configuración.`))
					continue
				}
				const valid: Array<{ row: Row; parsed: { period: string; dueDate: string }; amount: number }> = []
				for (const row of rawRows) {
					const debtId = text(row.deuda_id)
					if (debtId === '0') { items.push(this.item(id, contract.customerId, row, 0, 'sin_deuda', 'deuda_id 0 representa un contrato sin cuota pendiente.')); continue }
					const amount = moneyToMinorUnits(row.deuda)
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
					const externalId = text(entry.row.deuda_id)
					const exists = this.store.db.prepare('SELECT id FROM invoice WHERE external_id=?').get(externalId)
					if (exists || scheduledExternalIds.has(externalId)) { items.push(this.item(id, contract.customerId, entry.row, entry.amount, 'ya_importada', 'La cuota ya está registrada o incluida en esta corrida; se omitió para mantener idempotencia.')); continue }
					const maxCount = settings.maxInvoicesPerRun
					if ((maxCount !== null && createdCount >= maxCount) || (maxAmountMinor !== null && createdAmount + entry.amount > maxAmountMinor)) {
						items.push(this.item(id, contract.customerId, entry.row, entry.amount, 'frenada_por_tope', 'Se alcanzó el tope configurado; la cuota no se importó.')); continue
					}
					if (!simulated) {
						const item = this.item(id, contract.customerId, entry.row, entry.amount, 'importada', 'Factura abierta creada en Cobrix.')
						mutations.push({ item, apply: () => this.persistInvoice(contract, entry.row, entry.parsed, entry.amount, settings.graceDays) })
						items.push(item)
					} else items.push(this.item(id, contract.customerId, entry.row, entry.amount, 'se_importaria', 'Cumple las reglas; simulación sin escrituras.'))
					scheduledExternalIds.add(externalId)
					createdCount++; createdAmount += entry.amount
				}
			}
		})
	}
	async runPayments(simulated = false): Promise<number> {
		return this.execute('payments', simulated, async (client, token, items, mutations) => {
			const invoices = this.store.db.prepare("SELECT * FROM invoice WHERE status IN ('open','paid','exempt') ORDER BY contract_id,period").all() as unknown as Array<Row & { external_id: string; contract_id: number; customer_id: string; period: string; amount_minor: number; balance_minor: number; status: string }>
			const byContract = new Map<number, typeof invoices>()
			for (const invoice of invoices) byContract.set(invoice.contract_id, [...(byContract.get(invoice.contract_id) ?? []), invoice])
			for (const [contractId, contractInvoices] of byContract) {
				const response = await client.get(`/isp/pago_informacion?id_contrato=${contractId}&tipo_busqueda=CUOTA&fecha_inicio=1900-01-01&fecha_fin=${today()}`, token) as Row
				if (!response || typeof response !== 'object' || Array.isArray(response) || !Array.isArray(response.data)) throw new Error(`El libro de cuotas del contrato ${contractId} no contiene data válida.`)
				const groups = new Map<string, Row[]>()
				for (const entry of response.data as Row[]) {
					if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`El libro de cuotas del contrato ${contractId} contiene una fila inválida.`)
					const rawDetail = entry.detalle_pago
					if (!rawDetail || typeof rawDetail !== 'object' || Array.isArray(rawDetail)) continue
					const detail: Row = { ...(rawDetail as Row), __fecha_emision: entry.fecha_emision, __isp_invoice: text(entry.num_factura) || String(entry.id_factura ?? ''), __isp_invoice_id: entry.id_factura }
					const canonical = canonicalId(detail.id_cuota)
					if (canonical === null) continue
					const id = canonical
					groups.set(id, [...(groups.get(id) ?? []), detail])
				}
				let currentDebt: Map<string, number> | null = null
				const currentInvoices = contractInvoices.filter(invoice => invoice.period === today().slice(0, 7))
				if (currentInvoices.some(invoice => !groups.has(canonicalId(invoice.external_id) ?? invoice.external_id))) {
					const rows = asRows(await client.get(`/isp/contrato/individual?id_contrato=${contractId}`, token), `contrato ${contractId} para verificar mes actual`)
					currentDebt = new Map()
					for (const row of rows) {
						if (Number(row.contrato_id) !== contractId) throw new Error(`El administrador devolvió un contrato distinto al verificar ${contractId}.`)
						const debtId = canonicalId(row.deuda_id)
						if (debtId === null) throw new Error(`El administrador devolvió una deuda_id inválida al verificar ${contractId}.`)
						const balance = moneyToMinorUnits(row.deuda)
						if (balance < 0) throw new Error(`El administrador devolvió un saldo negativo para la cuota ${debtId}.`)
						if (debtId !== '0') currentDebt.set(debtId, balance)
					}
				}
				for (const invoice of contractInvoices) {
					const normalizedInvoiceId = canonicalId(invoice.external_id) ?? invoice.external_id
					const rows = groups.get(normalizedInvoiceId)
					if (!rows?.length) {
						const currentBalance = invoice.period === today().slice(0, 7) ? currentDebt?.get(normalizedInvoiceId) : undefined
						if (currentBalance !== undefined) {
							const reopened = invoice.status !== 'open'
							const item: RunItem = { contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.amount_minor, observedBalance: currentBalance, observedPaid: 0, result: reopened ? 'reabierta_por_cambio_isp' : 'pendiente_confirmada', reason: 'El endpoint de cuotas confirma que la cuota conserva saldo; no hay pago que aplicar.' }
							if (!simulated) mutations.push({ item, apply: () => this.reopenInvoice(invoice, currentBalance, 0, 'El administrador confirma saldo pendiente y ya no confirma el pago anterior.') })
							items.push(item)
						} else {
							const previouslyClosed = invoice.status !== 'open'
							items.push({ contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.amount_minor, result: previouslyClosed ? 'sin_fila_previa' : 'ausente_del_libro', reason: previouslyClosed ? 'No hay una fila actual del proveedor para revisar el cierre previo; se conserva el estado local.' : 'La cuota no aparece en el libro de pagos; se mantiene abierta.' })
						}
						continue
					}
					const keyFields = ['id_cuota', 'id_contrato', 'periodo_cuota', 'saldo_cuota', 'valor_pago']
					if (rows.some(row => canonicalId(row.id_cuota) !== normalizedInvoiceId || Number(row.id_contrato) !== contractId) || keyFields.some(key => !sameScalar(rows, key)) || rows[0]!.periodo_cuota !== invoice.period) {
						items.push({ contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.amount_minor, result: 'filas_inconsistentes', reason: 'Identificador, contrato o periodo contradictorio para esta cuota; no se infiere el estado.' }); continue
					}
					const balanceValue = Number(rows[0]!.saldo_cuota)
					const paidValue = Number(rows[0]!.valor_pago)
					if (!Number.isFinite(balanceValue) || !Number.isFinite(paidValue) || balanceValue < 0 || paidValue < 0) {
						items.push({ contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.amount_minor, result: 'filas_inconsistentes', reason: 'Saldo o monto pagado no numérico o negativo; no se infiere el estado.' }); continue
					}
					const balance = moneyToMinorUnits(rows[0]!.saldo_cuota)
					const paid = moneyToMinorUnits(rows[0]!.valor_pago)
					const hasReceipt = rows.some(row => positiveInteger(row.__isp_invoice_id) !== null)
					if (paid > 0 && !hasReceipt) {
						items.push({ contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.amount_minor, observedBalance: balance, observedPaid: paid, result: 'filas_inconsistentes', reason: 'El libro reporta monto pagado pero no identifica una factura de cobro válida.' }); continue
					}
					if (paid > 0 && !rows.some(row => validIsoDate(row.__fecha_emision))) {
						items.push({ contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.amount_minor, observedBalance: balance, observedPaid: paid, result: 'filas_inconsistentes', reason: 'El pago no incluye una fecha de emisión válida.' }); continue
					}
					if (balance > invoice.amount_minor) {
						items.push({ contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.amount_minor, observedBalance: balance, observedPaid: paid, result: 'filas_inconsistentes', reason: 'El saldo del proveedor supera el importe original de la factura.' }); continue
					}
					if (balance === 0 && paid > 0) {
						const wasPaid = invoice.status === 'paid'
						const item: RunItem = { contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.amount_minor, observedBalance: balance, observedPaid: paid, result: simulated ? (wasPaid ? 'ya_pagada' : 'se_marcaria_pagada') : (wasPaid ? 'ya_pagada' : 'marcada_pagada'), reason: 'El saldo es cero, existe una factura de cobro válida y el importe pagado es positivo.' }
						if (!simulated) mutations.push({ item, apply: () => {
							if (!this.markPaid(invoice, rows, balance, paid)) { item.result = 'ya_pagada'; item.reason = 'La factura ya estaba pagada; se actualizó la observación del proveedor.' }
						} })
						items.push(item)
					} else if (balance === 0) {
						const item: RunItem = { contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.amount_minor, observedBalance: 0, observedPaid: 0, result: 'exonerada', reason: 'Saldo cero sin valor pagado; es una exoneración, no un pago.' }
						if (!simulated) mutations.push({ item, apply: () => this.markExempt(invoice) })
						items.push(item)
					} else if (invoice.status !== 'open') {
						const item: RunItem = { contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.amount_minor, observedBalance: balance, observedPaid: paid, result: 'reabierta_por_cambio_isp', reason: `El ISP volvió a informar saldo ${usdForReason(balance)}; se revierte el cierre local anterior.` }
						if (!simulated) mutations.push({ item, apply: () => this.reopenInvoice(invoice, balance, paid, 'El saldo reapareció en el libro de cuotas del ISP.') })
						items.push(item)
					} else if (paid > 0 && balance < invoice.amount_minor) {
						const item: RunItem = { contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.amount_minor, observedBalance: balance, observedPaid: paid, result: 'abono_parcial', reason: `Abono registrado: ${usdForReason(paid)}; saldo ISP ${usdForReason(balance)}. La factura sigue abierta.` }
						if (!simulated) mutations.push({ item, apply: () => this.recordProviderBalance(invoice, balance, paid, 'invoice_partial_payment') })
						items.push(item)
					} else if (paid > 0) {
						const item: RunItem = { contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.amount_minor, observedBalance: balance, observedPaid: paid, result: 'abono_previo_importacion', reason: `El ISP informa pago acumulado ${usdForReason(paid)}, pero el saldo actual coincide con el importe importado; se conserva el saldo y se registra la observación.` }
						if (!simulated) mutations.push({ item, apply: () => this.recordProviderBalance(invoice, balance, paid, 'invoice_provider_observation') })
						items.push(item)
					} else if (paid <= 0) {
						const item: RunItem = { contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.amount_minor, observedBalance: balance, observedPaid: paid, result: 'pendiente_confirmada', reason: 'El libro confirma que la cuota conserva saldo y no registra pagos.' }
						if (!simulated) mutations.push({ item, apply: () => this.recordProviderBalance(invoice, balance, paid, 'invoice_provider_observation') })
						items.push(item)
					} else {
						const item: RunItem = { contractId, customerId: invoice.customer_id, debtId: invoice.external_id, period: invoice.period, amount: invoice.amount_minor, observedBalance: balance, observedPaid: paid, result: 'saldo_no_conciliado', reason: 'El libro registra un pago, pero el saldo no cumple las reglas para confirmar pago completo o abono parcial.' }
						items.push(item)
					}
				}
			}
		})
	}
	private persistInvoice(contract: ContractData, row: Row, period: { period: string; dueDate: string }, amount: number, grace: number): void {
		const db = this.store.db
		const existingCustomer = db.prepare('SELECT id FROM customer WHERE id=?').get(contract.customerId)
		if (!existingCustomer) {
			db.prepare('INSERT INTO customer (id,name,document_type,email,phone,created_at) VALUES (?,?,?,?,?,?)').run(contract.customerId, contract.name, contract.documentType, contract.email, contract.phone, new Date().toISOString())
			db.prepare("INSERT INTO event (customer_id,created_at,type,description) VALUES (?,?,?,?)").run(contract.customerId, new Date().toISOString(), 'customer_created', 'Cliente importado desde el administrador ISP.')
		} else db.prepare('UPDATE customer SET name=?,email=?,phone=? WHERE id=?').run(contract.name, contract.email, contract.phone, contract.customerId)
		db.prepare(`INSERT INTO contract (id,customer_id,name,status,plan,price_minor,branch,currency) VALUES (?,?,?,?,?,?,?,?)
			ON CONFLICT(id) DO UPDATE SET customer_id=excluded.customer_id,name=excluded.name,status=excluded.status,plan=excluded.plan,price_minor=excluded.price_minor,branch=excluded.branch,currency=excluded.currency`)
			.run(contract.id, contract.customerId, contract.name, contract.status, contract.plan, contract.priceMinor, contract.branch, contract.currency)
		const invoice = db.prepare('INSERT INTO invoice (external_id,contract_id,customer_id,period,due_date,cutoff_date,amount_minor,balance_minor,provider_balance_minor,provider_paid_minor) VALUES (?,?,?,?,?,?,?,?,?,0)')
			.run(text(row.deuda_id), contract.id, contract.customerId, period.period, period.dueDate, addCivilDays(period.dueDate, grace), amount, amount, amount)
		db.prepare("INSERT INTO event (customer_id,invoice_id,created_at,type,description) VALUES (?,?,?,?,?)").run(contract.customerId, Number(invoice.lastInsertRowid), new Date().toISOString(), 'invoice_imported', `Cuota ${text(row.deuda_id)} · periodo ${period.period} importada.`)
	}
	private markPaid(invoice: Row, rows: Row[], balance: number, paid: number): boolean {
		const paidAt = rows.map(row => row.__fecha_emision).find(validIsoDate) ?? today()
		const ispInvoices = [...new Set(rows.map(row => text(row.__isp_invoice)).filter(Boolean))].join(', ')
		const customerId = String(invoice.customer_id)
		const db = this.store.db
		const result = db.prepare("UPDATE invoice SET status='paid',balance_minor=0,provider_balance_minor=?,provider_paid_minor=?,paid_at=? WHERE id=? AND status!='paid'").run(balance, paid, paidAt, Number(invoice.id))
		if (Number(result.changes) === 0) {
			db.prepare("UPDATE invoice SET provider_balance_minor=?,provider_paid_minor=? WHERE id=? AND status='paid'").run(balance, paid, Number(invoice.id))
			return false
		}
		const receipt = ispInvoices ? ` mediante factura${ispInvoices.includes(',') ? 's' : ''} ISP ${ispInvoices}` : ''
		db.prepare("INSERT INTO event (customer_id,invoice_id,created_at,type,description) VALUES (?,?,?,'invoice_paid',?)")
			.run(customerId, Number(invoice.id), new Date().toISOString(), `Pago confirmado en ISP${receipt} para la cuota ${invoice.external_id}.`)
		return true
	}
	private recordProviderBalance(invoice: Row, balance: number, paid: number, eventType: 'invoice_partial_payment' | 'invoice_provider_observation'): void {
		const db = this.store.db
		const old = db.prepare('SELECT provider_balance_minor,provider_paid_minor FROM invoice WHERE id=?').get(Number(invoice.id)) as { provider_balance_minor: number | null; provider_paid_minor: number } | undefined
		if (!old) throw new Error(`No existe la factura local ${invoice.external_id}.`)
		db.prepare('UPDATE invoice SET provider_balance_minor=?,provider_paid_minor=? WHERE id=?').run(balance, paid, Number(invoice.id))
		if (old.provider_balance_minor !== balance || old.provider_paid_minor !== paid) {
			const description = eventType === 'invoice_partial_payment'
				? `Abono parcial ISP para cuota ${invoice.external_id}: pagado acumulado ${usdForReason(paid)}, saldo ${usdForReason(balance)}.`
				: `Estado ISP para cuota ${invoice.external_id}: pagado acumulado ${usdForReason(paid)}, saldo ${usdForReason(balance)}.`
			db.prepare('INSERT INTO event (customer_id,invoice_id,created_at,type,description) VALUES (?,?,?, ?,?)')
				.run(String(invoice.customer_id), Number(invoice.id), new Date().toISOString(), eventType, description)
		}
	}
	private reopenInvoice(invoice: Row, balance: number, paid: number, reason: string): void {
		const db = this.store.db
		const previousStatus = String(invoice.status)
		db.prepare("UPDATE invoice SET status='open',balance_minor=amount_minor,provider_balance_minor=?,provider_paid_minor=?,paid_at=NULL WHERE id=?")
			.run(balance, paid, Number(invoice.id))
		if (previousStatus !== 'open') {
			db.prepare("INSERT INTO event (customer_id,invoice_id,created_at,type,description) VALUES (?,?,?,'invoice_reopened',?)")
				.run(String(invoice.customer_id), Number(invoice.id), new Date().toISOString(), `Cuota ${invoice.external_id} reabierta: ${reason}`)
		}
	}
	private markExempt(invoice: Row): void {
		const db = this.store.db
		const previousStatus = String(invoice.status)
		db.prepare("UPDATE invoice SET status='exempt',balance_minor=0,provider_balance_minor=0,provider_paid_minor=0,paid_at=NULL WHERE id=?")
			.run(Number(invoice.id))
		if (previousStatus !== 'exempt') {
			db.prepare("INSERT INTO event (customer_id,invoice_id,created_at,type,description) VALUES (?,?,?,'invoice_exempted',?)")
				.run(String(invoice.customer_id), Number(invoice.id), new Date().toISOString(), `Cuota ${invoice.external_id} exonerada en el administrador ISP; no se registró como pago.`)
		}
	}
	private item(contractId: number, customerId: string | null, row: Row, amount: number, result: string, reason: string): RunItem {
		return { contractId, customerId, debtId: text(row.deuda_id) || null, period: parseInstallmentLabel(row.detalle_deuda)?.period ?? null, amount, result, reason }
	}
	private async execute(kind: RunKind, simulated: boolean, work: (client: BillingClient, token: string, items: RunItem[], mutations: PendingMutation[]) => Promise<void>): Promise<number> {
		const { runId, owner } = this.reserveRun(kind, simulated)
		const items: RunItem[] = []
		const mutations: PendingMutation[] = []
		let errorText: string | null = null
		let client: BillingClient | undefined
		const heartbeat = setInterval(() => {
			try { this.refreshRunLease(owner) } catch (error) { console.error('[sync] no se pudo renovar el bloqueo de corrida', error) }
		}, RUN_HEARTBEAT_MS)
		try {
			client = new BillingClient(this.store.getSettings())
			const token = await client.login()
			await work(client, token, items, mutations)
		} catch (error) { errorText = error instanceof Error ? error.message : String(error) }
		finally { client?.dispose() }
		try {
			if (errorText) this.markUnapplied(mutations)
			this.finishRun(runId, owner, items, mutations, errorText)
			return runId
		} catch (error) {
			const finalError = error instanceof Error ? error.message : String(error)
			this.markUnapplied(mutations)
			this.finishRun(runId, owner, items, [], finalError)
			return runId
		} finally { clearInterval(heartbeat) }
	}
	private reserveRun(kind: RunKind, simulated: boolean): { runId: number; owner: string } {
		const db = this.store.db
		const owner = randomUUID()
		const now = new Date()
		db.exec('BEGIN IMMEDIATE')
		try {
			const active = db.prepare('SELECT run_id,owner,lease_until FROM run_lock WHERE id=1').get() as { run_id: number; owner: string; lease_until: string } | undefined
			if (active && active.lease_until > now.toISOString()) throw new RunInProgressError()
			if (active) {
				db.prepare("UPDATE run SET status='failed',finished_at=?,error='La corrida quedó interrumpida; expiró el bloqueo de ejecución.' WHERE id=? AND status='running'").run(now.toISOString(), active.run_id)
				db.prepare('DELETE FROM run_lock WHERE id=1').run()
			}
			const inserted = db.prepare('INSERT INTO run (kind,simulated,status,started_at,finished_at,summary,error) VALUES (?,?,\'running\',?,\'\',\'{}\',NULL)')
				.run(kind, simulated ? 1 : 0, now.toISOString())
			const runId = Number(inserted.lastInsertRowid)
			db.prepare('INSERT INTO run_lock (id,run_id,owner,lease_until) VALUES (1,?,?,?)').run(runId, owner, new Date(now.getTime() + RUN_LEASE_MS).toISOString())
			db.exec('COMMIT')
			return { runId, owner }
		} catch (error) { db.exec('ROLLBACK'); throw error }
	}
	private refreshRunLease(owner: string): void {
		this.store.db.prepare('UPDATE run_lock SET lease_until=? WHERE id=1 AND owner=?').run(new Date(Date.now() + RUN_LEASE_MS).toISOString(), owner)
	}
	private finishRun(runId: number, owner: string, items: RunItem[], mutations: PendingMutation[], error: string | null): void {
		const db = this.store.db
		db.exec('BEGIN IMMEDIATE')
		try {
			const lock = db.prepare('SELECT run_id FROM run_lock WHERE id=1 AND owner=?').get(owner) as { run_id: number } | undefined
			if (!lock || Number(lock.run_id) !== runId) throw new Error('Se perdió el bloqueo de esta corrida; no se aplicaron cambios.')
			if (!error) for (const mutation of mutations) mutation.apply()
			const insertItem = db.prepare('INSERT INTO run_item (run_id,contract_id,customer_id,debt_id,period,amount_minor,result,reason,observed_balance_minor,observed_paid_minor) VALUES (?,?,?,?,?,?,?,?,?,?)')
			for (const item of items) insertItem.run(runId, item.contractId, item.customerId, item.debtId, item.period, item.amount, item.result, item.reason, item.observedBalance ?? null, item.observedPaid ?? null)
			db.prepare('UPDATE run SET status=?,finished_at=?,summary=?,error=? WHERE id=?').run(error ? 'failed' : 'completed', new Date().toISOString(), JSON.stringify(summarize(items)), error, runId)
			db.prepare('DELETE FROM run_lock WHERE id=1 AND owner=?').run(owner)
			db.exec('COMMIT')
		} catch (failure) { db.exec('ROLLBACK'); throw failure }
	}
	private markUnapplied(mutations: PendingMutation[]): void {
		for (const { item } of mutations) {
			item.result = 'no_aplicada_por_fallo'
			item.reason = 'No se aplicó porque la corrida falló antes de confirmar sus cambios.'
		}
	}
}

export function summarize(items: RunItem[]): RunSummary {
	const count = (value: string): number => items.filter(item => item.result === value).length
	const pending = count('pendiente_confirmada')
	const missingFromLedger = count('ausente_del_libro')
	const exonerated = count('exonerada')
	const inconsistent = count('filas_inconsistentes') + count('saldo_no_conciliado')
	const reopened = count('reabierta_por_cambio_isp')
	const noCurrentEvidence = count('sin_fila_previa')
	const preImportPaid = count('abono_previo_importacion')
	return {
		total: items.length, imported: count('importada') + count('se_importaria'), alreadyImported: count('ya_importada'),
		excluded: items.filter(item => ['excluida', 'fuera_ventana', 'fuera_limite_recientes', 'saldo_residual', 'sin_deuda'].includes(item.result)).length,
		throttled: count('frenada_por_tope'), markedPaid: count('marcada_pagada') + count('se_marcaria_pagada'), partial: count('abono_parcial'),
		pending, missingFromLedger, exonerated, inconsistent, reopened, noCurrentEvidence, preImportPaid,
		noEvidence: pending + missingFromLedger + exonerated + inconsistent + noCurrentEvidence, unapplied: count('no_aplicada_por_fallo'),
	}
}
