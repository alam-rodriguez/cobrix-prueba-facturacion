/**
 * Invoice manager API simulated over SQLite. It reproduces the behaviour observed on a
 * real sandbox on 2026-09-30, quirks included, for the endpoints the sync reads:
 *
 *   POST /api/v1/usuario/login             token of 2 h, naive-UTC expiry, no refresh
 *   GET  /api/v1/isp/lista_ids_contratos   any `estado` value → only AP; paging ignored
 *   GET  /api/v1/isp/contrato/individual   unwrapped list, one row per pending installment,
 *                                          unordered, `deuda_id: "0"` row when there is no debt
 *   GET  /api/v1/isp/pago_informacion      `success: false` with data, future and phantom
 *                                          installments, one row per linked invoice
 *
 * `/__sim/*` is NOT part of the API: it lets the sandbox act as the invoice manager's cashier (pay, annul).
 * `/docs` serves Swagger UI and `/openapi.json` the specification.
 */

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'

import { addCivilDays, addMonths, currentPeriod, lastDayOfPeriod, periodLabel, today } from '../shared/dates.ts'
import { OPENAPI_SPEC, SWAGGER_HTML } from './openapi.ts'
import { CASES, seedInto } from './seed.ts'

const TOKEN_TTL_SECONDS = 7_200
const STATUS_TEXT: Record<string, string> = {
	AP: 'ACTIVO', CO: 'CORTADO', CR: 'CORTESIA', CA: 'RETIRADO', RE: 'RECHAZADO', AN: 'ANULADO',
}

type Row = Record<string, unknown>

interface ContratoRow {
	id: number; codigo: string; id_cliente: number; id_sucursal: number; estado: string; plan: string
	moneda: string; moneda_sigla: string; fecha_contrato: string; dia_cobro: number; dia_corte: number
	vendedor: string; reporta_usd_incoherente: number
	identificacion: string; nombre: string; telefono: string; email: string; direccion: string
	sigla: string; sucursal_nombre: string; precio: number; tipo_servicio: string
}

interface CuotaRow {
	id: number; id_contrato: number; periodo: string; tipo: string; tarifa: number; valor_pago: number
	descuento: number; saldo: number; id_detalle: number; fantasma: number
}

class HttpError extends Error {
	readonly status: number
	readonly body: unknown
	constructor(status: number, body: unknown) {
		super(`HTTP ${status}`)
		this.status = status
		this.body = body
	}
}

const parametros = (mensaje: string) => new HttpError(400, { detail: { type: 'parametros', mensaje } })

export interface BillingApiServer {
	readonly server: Server
	readonly db: DatabaseSync
	listen(port: number, host?: string): Promise<number>
	close(): Promise<void>
}

export function createBillingApiServer(dbPath: string): BillingApiServer {
	const db = new DatabaseSync(dbPath)
	db.exec('PRAGMA foreign_keys = ON')
	const tokens = new Map<string, number>()

	const contratoQuery = `
		SELECT c.*, cl.identificacion, cl.nombre, cl.telefono, cl.email, cl.direccion,
			s.sigla, s.nombre AS sucursal_nombre, p.precio, p.tipo_servicio
		FROM contrato c
		JOIN cliente cl ON cl.id = c.id_cliente
		JOIN sucursal s ON s.id = c.id_sucursal
		JOIN plan p ON p.codigo_producto = c.plan`

	const empresa = () => db.prepare('SELECT * FROM empresa WHERE id = 1').get() as Row

	// ---------------------------------------------------------------- auth

	function login(body: Row): Row {
		const email = typeof body.email === 'string' ? body.email : undefined
		const userName = typeof body.user_name === 'string' ? body.user_name : undefined
		const user = (email
			? db.prepare('SELECT * FROM usuario_api WHERE email = ?').get(email)
			: userName
				? db.prepare('SELECT * FROM usuario_api WHERE user_name = ?').get(userName)
				: undefined) as Row | undefined
		if (!user) {
			throw new HttpError(400, { detail: { type: 'email', mensaje: 'El correo no se encuentra registrado' } })
		}
		if (user.password !== body.password) {
			throw new HttpError(400, { detail: { type: 'password', mensaje: 'Contraseña Incorrecta' } })
		}
		const iat = Math.floor(Date.now() / 1000)
		const exp = iat + TOKEN_TTL_SECONDS
		const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
		const token = [
			b64({ alg: 'HS256', typ: 'JWT' }),
			b64({ fresh: false, iat, jti: randomBytes(8).toString('hex'), type: 'access', sub: user.user_name, nbf: iat, exp, roles: ['user'] }),
			randomBytes(24).toString('base64url'),
		].join('.')
		tokens.set(token, exp)
		return {
			usuario: user.user_name,
			email: user.email,
			access_token: token,
			// Naive UTC, no zone, exactly like the real API.
			access_token_expires_in: new Date(exp * 1000).toISOString().slice(0, 19),
		}
	}

	function requireToken(req: IncomingMessage): void {
		const header = req.headers.authorization
		if (!header?.startsWith('Bearer ')) {
			throw new HttpError(401, { detail: { type: 'auth_api', mensaje: 'MissingTokenError, Token expirado' } })
		}
		const exp = tokens.get(header.slice(7).trim())
		if (exp === undefined || exp * 1000 < Date.now()) {
			throw new HttpError(401, { detail: { type: 'auth_api', mensaje: 'InvalidHeaderError, Token invalido, consulte con el administrador' } })
		}
	}

	// ---------------------------------------------------------------- reads

	function envelope(message: string, data: unknown[], success = true): Row {
		return {
			success,
			message,
			pagination: { page: 1, per_page: data.length, total: data.length, total_pages: 1 },
			errors: [{ id: 0, message: '', code: '', uuid_code: '' }],
			data,
		}
	}

	function validateIntegers(query: URLSearchParams, fields: readonly string[]): void {
		const errors = fields
			.filter(field => query.has(field) && !/^-?\d+$/.test(query.get(field) ?? ''))
			.map(field => ({ source: 'query', field, message: 'value is not a valid integer' }))
		if (errors.length) throw new HttpError(400, errors)
	}

	function listaIdsContratos(query: URLSearchParams): Row {
		validateIntegers(query, ['page', 'per_page', 'id_empresa', 'id_sucursal'])
		const empresaId = query.get('id_empresa')
		if (empresaId && !['0', '1'].includes(empresaId)) return envelope('Lista de ids de contratos', [])
		const conditions: string[] = []
		const params: number[] = []
		// Any non-empty `estado` returns the active contracts only.
		if ((query.get('estado') ?? '') !== '') conditions.push("estado = 'AP'")
		if (query.get('id_sucursal')) {
			conditions.push('id_sucursal = ?')
			params.push(Number(query.get('id_sucursal')))
		}
		const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
		const ids = db.prepare(`SELECT id FROM contrato ${where} ORDER BY id`).all(...params) as Array<{ id: number }>
		return envelope('Lista de ids de contratos', ids.map(row => row.id))
	}

	function findContracts(query: URLSearchParams): ContratoRow[] | undefined {
		const idContrato = query.get('id_contrato')
		const codigo = query.get('codigo')
		const identificacion = query.get('identificacion')
		if (!idContrato && !codigo && !identificacion) return undefined
		const conditions: string[] = []
		const params: Array<string | number> = []
		if (idContrato) { conditions.push('c.id = ?'); params.push(Number(idContrato)) }
		if (codigo) { conditions.push('c.codigo = ?'); params.push(codigo) }
		if (identificacion) { conditions.push('cl.identificacion = ?'); params.push(identificacion) }
		return db.prepare(`${contratoQuery} WHERE ${conditions.join(' AND ')} ORDER BY c.id`).all(...params) as unknown as ContratoRow[]
	}

	function nextDayOfMonth(day: number): string {
		const now = today()
		const candidate = `${now.slice(0, 7)}-${String(day).padStart(2, '0')}`
		return candidate > now ? candidate : `${addMonths(now.slice(0, 7), 1)}-${String(day).padStart(2, '0')}`
	}

	function contractRow(c: ContratoRow, cuota: CuotaRow | undefined, empresaRow: Row): Row {
		const reportedUsd = c.reporta_usd_incoherente === 1
		const label = cuota ? `${c.plan} - ${periodLabel(cuota.periodo)}` : undefined
		// Key order copied from the real capture (contrato-individual-activo.json).
		return {
			dia_cobro: c.dia_cobro,
			dia_corte: c.dia_corte,
			id_tipo_duracion: 0,
			duracion: 0,
			tipo_duracion: '',
			fecha_cobro_prox: nextDayOfMonth(c.dia_cobro),
			fecha_corte_prox: nextDayOfMonth(c.dia_corte),
			contrato_id: c.id,
			id_empresa: 0,
			codigo: c.codigo,
			identificacion_contrato: c.identificacion,
			nombre_contrato: c.nombre,
			telefono: c.telefono,
			email: c.email.toUpperCase(),
			estado: STATUS_TEXT[c.estado],
			tipo_contrato_de_cobro: 'PREPAGO',
			direccion: c.direccion,
			cuotas_vencidad: 1,
			deuda: cuota ? Math.round(cuota.saldo * 100) / 100 : 0,
			detalle_tipo_deuda: ['CUOTA'],
			tipo_deuda: 'cuota',
			deuda_id: cuota ? String(cuota.id) : '0',
			nombre_servicio: 'Internet',
			precio_servicio: c.precio.toFixed(6),
			nombre_plan: c.plan,
			nombre_empresa: empresaRow.nombre,
			nombre_comercial_empresa: empresaRow.nombre_comercial,
			identificacion_empresa: empresaRow.identificacion,
			nombre_sucursal: c.sucursal_nombre,
			identificacion_sucursal: '',
			sigla_sucursal: c.sigla,
			informacion_adicional: '',
			detalle_deuda: label ? [label] : [],
			detalle: cuota ? [`${c.plan} - ${cuota.id} - ${cuota.id_detalle}`] : [],
			// VES contracts are reported as USD here: reproduced on purpose.
			moneda: reportedUsd ? 'DOLAR' : c.moneda,
			moneda_sigla: reportedUsd ? 'USD' : c.moneda_sigla,
			tipo_servicio: c.tipo_servicio,
			id_tipo_cont_serv: 8,
			saldo_a_f_v: 0,
			saldo_a_f_sn: 'N',
			fecha_contrato: c.fecha_contrato,
			fecha_instalacion: c.fecha_contrato,
			fecha_ultimo_corte: addCivilDays(today(), -90),
			sector: '',
			barrio: '',
			ruta: '',
			vendedor_contrato: c.vendedor,
			id_tipo_factura: 1,
			tipo_factura: 'FACTURA DIGITAL',
			coordenadas: null,
		}
	}

	function contratoIndividual(query: URLSearchParams): unknown[] {
		const contracts = findContracts(query)
		if (contracts === undefined) return []
		if (contracts.length === 0) throw parametros('17.1) No se pudo recuperar la informacion')
		const empresaRow = empresa()
		const period = currentPeriod()
		const rows: Row[] = []
		for (const c of contracts) {
			const pending = db.prepare(
				'SELECT * FROM cuota WHERE id_contrato = ? AND fantasma = 0 AND periodo <= ? AND saldo > 0',
			).all(c.id, period) as unknown as CuotaRow[]
			if (pending.length === 0) {
				rows.push(contractRow(c, undefined, empresaRow))
				continue
			}
			// The API does not sort them: a stable scramble keeps tests repeatable.
			pending.sort((a, b) => ((a.id * 7919) % 13) - ((b.id * 7919) % 13) || a.id - b.id)
			for (const cuota of pending) rows.push(contractRow(c, cuota, empresaRow))
		}
		return rows
	}

	function pagoInformacion(query: URLSearchParams): Row {
		const tipo = query.get('tipo_busqueda')
		if (tipo !== 'FACTURA' && tipo !== 'CUOTA') {
			throw new HttpError(400, [{ source: 'query', field: 'tipo_busqueda', message: "value is not a valid enumeration member; permitted: 'FACTURA', 'CUOTA'" }])
		}
		// Without dates the API answers a fixed window, not one computed from today.
		const from = query.get('fecha_inicio') ?? '2025-06-01'
		const to = query.get('fecha_fin') ?? '2026-05-31'
		const contracts = findContracts(query) ?? []
		const data: Row[] = []
		for (const c of contracts) {
			const cuotas = db.prepare('SELECT * FROM cuota WHERE id_contrato = ? ORDER BY periodo, id').all(c.id) as unknown as CuotaRow[]
			for (const cuota of cuotas) {
				const links = db.prepare(
					`SELECT f.id, f.num_factura, f.fecha_emision FROM factura_cuota fc
					 JOIN factura f ON f.id = fc.id_factura WHERE fc.id_cuota = ? ORDER BY f.id`,
				).all(cuota.id) as Array<{ id: number; num_factura: string; fecha_emision: string }>
				const invoices = links.length ? links : [{ id: 0, num_factura: '', fecha_emision: lastDayOfPeriod(cuota.periodo) }]
				for (const invoice of invoices) {
					if (invoice.fecha_emision < from || invoice.fecha_emision > to) continue
					if (tipo === 'FACTURA' && invoice.id === 0) continue
					data.push(pagoInformacionRow(c, cuota, invoice, tipo))
				}
			}
		}
		// `success: false` even with data, as observed.
		return envelope('Lista de la informacion general de los pagos por contrato', data, false)
	}

	function pagoInformacionRow(
		c: ContratoRow, cuota: CuotaRow, invoice: { id: number; num_factura: string; fecha_emision: string },
		tipo: string,
	): Row {
		// Every row shows the installment's CURRENT state, whatever that invoice contributed.
		const detalle = {
			id_contrato: c.id, id_cliente: c.id_cliente, id_cuota: cuota.id, id_detalle_cuota: cuota.id_detalle,
			tipo: cuota.tipo, periodo_detalle_cuota: cuota.periodo, tipo_nombre: 'MENSUALIDAD', codigo_producto: c.plan,
			detalle_producto: c.plan, nombre_producto: 'MENSUALIDAD', nombre_paquete: c.plan, nombre_tipo_producto: 'INTERNET',
			tarifa: cuota.tarifa, dias_uso: 30, valor_uso: 0, valor_no_uso: 0, valor_pago: cuota.valor_pago,
			valor_nota_credito: 0, descuento: cuota.descuento, saldo_cuota: cuota.saldo,
		}
		return {
			id_factura: invoice.id,
			cod_empresa: 1, cod_sucursal: c.id_sucursal, dmcc_cod_empresa: 0, dmcc_cod_sucursal: 0, cod_tran: '', asiento: '',
			identificacion_cliente_factura: c.identificacion, nombre_cliente_factura: c.nombre,
			nombre_cliente: c.nombre, identificacion_cliente: c.identificacion, codigo_cliente: c.codigo,
			tipo_contrato: 'Internet', num_factura: invoice.num_factura, ejercio_fiscal: 43, id_cliente: c.id_cliente,
			fecha_vence: invoice.fecha_emision, fecha_emision: invoice.fecha_emision, periodo_fecha: invoice.fecha_emision.slice(0, 7),
			// In FACTURA mode the contract arrives as 0 and lives in fact_cod_contr.
			id_contrato: tipo === 'FACTURA' ? 0 : c.id,
			fact_cod_contr: String(c.id),
			compara_id_contrato_1: 'igual', compara_id_contrato_2: 'igual',
			detalle_pago: {
				id_contrato: c.id, id_cliente: c.id_cliente, id_cuota: cuota.id, tipo_contrato: 'Internet',
				periodo_cuota: cuota.periodo, tarifa: cuota.tarifa, total_adicional: 0, valor_pago: cuota.valor_pago,
				valor_uso: 0, valor_no_uso: 0, descuento: cuota.descuento, valor_nota_credito: 0, saldo_cuota: cuota.saldo,
				detalle: [detalle], detalle_dfac: `${c.plan} ${periodLabel(cuota.periodo)}`,
			},
		}
	}

	// ---------------------------------------------------------------- cashier (not part of the API)

	function simContratos(): unknown[] {
		const contracts = db.prepare(`${contratoQuery} ORDER BY c.id`).all() as unknown as ContratoRow[]
		const period = currentPeriod()
		return contracts.map(c => {
			const cuotas = db.prepare('SELECT * FROM cuota WHERE id_contrato = ? AND fantasma = 0 ORDER BY periodo').all(c.id) as unknown as CuotaRow[]
			const facturas = db.prepare(
				`SELECT f.id, f.num_factura, f.fecha_emision, f.anulada, f.referencia, SUM(fc.monto) AS monto
				 FROM factura f JOIN factura_cuota fc ON fc.id_factura = f.id WHERE f.id_contrato = ?
				 GROUP BY f.id ORDER BY f.id DESC LIMIT 6`,
			).all(c.id)
			return {
				id: c.id, codigo: c.codigo, estado: STATUS_TEXT[c.estado], plan: c.plan, sucursal: c.sigla,
				titular: c.nombre, identificacion: c.identificacion, moneda: c.moneda_sigla,
				pendientes: cuotas.filter(q => q.saldo > 0 && q.periodo <= period)
					.map(q => ({ id: q.id, periodo: q.periodo, saldo: q.saldo, tarifa: q.tarifa })),
				futuras: cuotas.filter(q => q.saldo > 0 && q.periodo > period).length,
				facturas,
			}
		})
	}

	/** Pays pending installments oldest first, like the invoice manager's cashier; `monto` allows partials. */
	function simPagar(body: Row): Row {
		const contratoId = Number(body.id_contrato)
		const contrato = db.prepare('SELECT id FROM contrato WHERE id = ?').get(contratoId)
		if (!contrato) throw parametros('Contrato no encontrado')
		// Without explicit installments the cashier collects what is owed today, never future months.
		const ids = Array.isArray(body.id_cuotas) ? body.id_cuotas.map(Number) : undefined
		const pending = (db.prepare(
			'SELECT * FROM cuota WHERE id_contrato = ? AND fantasma = 0 AND saldo > 0 ORDER BY periodo, id',
		).all(contratoId) as unknown as CuotaRow[]).filter(q => (ids ? ids.includes(q.id) : q.periodo <= currentPeriod()))
		if (pending.length === 0) throw parametros('No hay cuotas pendientes que pagar')
		let remaining = typeof body.monto === 'number' ? body.monto : Number.POSITIVE_INFINITY
		const facturaId = Number((db.prepare('SELECT COALESCE(MAX(id), 8800000) + 1 AS id FROM factura').get() as Row).id)
		db.exec('BEGIN')
		try {
			db.prepare('INSERT INTO factura (id, num_factura, id_contrato, fecha_emision, referencia) VALUES (?, ?, ?, ?, ?)')
				.run(facturaId, String(facturaId).padStart(9, '0'), contratoId, today(), typeof body.referencia === 'string' ? body.referencia : `SIM${facturaId}`)
			const paid: Row[] = []
			for (const cuota of pending) {
				if (remaining <= 0) break
				const amount = Math.min(cuota.saldo, remaining)
				remaining -= amount
				db.prepare('UPDATE cuota SET saldo = ROUND(saldo - ?, 6), valor_pago = ROUND(valor_pago + ?, 6) WHERE id = ?').run(amount, amount, cuota.id)
				db.prepare('INSERT INTO factura_cuota VALUES (?, ?, ?)').run(facturaId, cuota.id, amount)
				paid.push({ id_cuota: cuota.id, periodo: cuota.periodo, monto: amount })
			}
			db.exec('COMMIT')
			return { id_factura: facturaId, num_factura: String(facturaId).padStart(9, '0'), cuotas: paid }
		} catch (error) {
			db.exec('ROLLBACK')
			throw error
		}
	}

	/** Annuls an invoice: the installments owe again, the link stays. */
	function simAnular(body: Row): Row {
		const id = Number(body.id_factura)
		const factura = db.prepare('SELECT * FROM factura WHERE id = ? AND anulada = 0').get(id)
		if (!factura) throw new HttpError(400, { detail: { type: 'registro_deposito', mensaje: `No se encontro el deposito con id: ${id}, o ya ingreso la solicitud de anulacion` } })
		db.exec('BEGIN')
		const links = db.prepare('SELECT * FROM factura_cuota WHERE id_factura = ?').all(id) as Array<{ id_cuota: number; monto: number }>
		for (const link of links) {
			db.prepare('UPDATE cuota SET saldo = ROUND(saldo + ?, 6), valor_pago = ROUND(valor_pago - ?, 6) WHERE id = ?').run(link.monto, link.monto, link.id_cuota)
		}
		db.prepare('UPDATE factura SET anulada = 1 WHERE id = ?').run(id)
		db.exec('COMMIT')
		return { id_factura: id, detalle_anulacion: `ANULACION EXITOSA FACTURA:${String(id).padStart(9, '0')}` }
	}

	// ---------------------------------------------------------------- routing

	async function readJson(req: IncomingMessage): Promise<Row> {
		const chunks: Buffer[] = []
		for await (const chunk of req) chunks.push(chunk as Buffer)
		if (!chunks.length) return {}
		try {
			const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
			return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {}
		} catch {
			throw new HttpError(400, [{ source: 'body', field: '__root__', message: 'invalid json' }])
		}
	}

	async function handle(req: IncomingMessage): Promise<[number, unknown]> {
		const url = new URL(req.url ?? '/', 'http://billing-api.local')
		const route = `${req.method} ${url.pathname.replace(/\/+$/, '')}`
		switch (route) {
			case 'POST /api/v1/usuario/login':
				return [200, login(await readJson(req))]
			case 'POST /api/v1/usuario/logout':
				return [200, { status: 'success' }]
			case 'POST /api/v1/usuario/me':
				return [500, { title: 'Internal Server Error', detail: 'Se produjo un error interno, lo estamos revisando', errors: [{ message: 'Se produjo un error interno, lo estamos revisando', businessMessage: 'Internal Server Error' }], instance: '500', type: '/api/v1/usuario/me' }]
			case 'GET /api/v1/isp/lista_ids_contratos':
				requireToken(req)
				return [200, listaIdsContratos(url.searchParams)]
			case 'GET /api/v1/isp/contrato/individual':
				requireToken(req)
				return [200, contratoIndividual(url.searchParams)]
			case 'GET /api/v1/isp/pago_informacion':
				requireToken(req)
				return [200, pagoInformacion(url.searchParams)]
			case 'GET /__sim/contratos':
				return [200, simContratos()]
			case 'POST /__sim/pagar':
				return [200, simPagar(await readJson(req))]
			case 'POST /__sim/anular':
				return [200, simAnular(await readJson(req))]
			case 'POST /__sim/reiniciar':
				tokens.clear()
				return [200, seedInto(db)]
			case 'GET /__sim/casos':
				return [200, CASES.map(item => ({ identificacion: item.identificacion, nombre: item.nombre, caso: item.caso }))]
			case 'GET /__sim/salud':
				return [200, { ok: true, hoy: today(), periodo: currentPeriod() }]
			default:
				return url.pathname.startsWith('/api/v1/') ? [405, { detail: 'Method Not Allowed' }] : [404, { detail: 'Not Found' }]
		}
	}

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const pathname = new URL(req.url ?? '/', 'http://billing-api.local').pathname.replace(/\/+$/, '') || '/'
		if (req.method === 'GET' && (pathname === '/docs' || pathname === '/')) {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
			res.end(SWAGGER_HTML)
			return
		}
		if (req.method === 'GET' && pathname === '/openapi.json') return send(res, 200, OPENAPI_SPEC)
		handle(req)
			.then(([status, body]) => send(res, status, body))
			.catch((error: unknown) => {
				if (error instanceof HttpError) return send(res, error.status, error.body)
				console.error('[billing-api] error interno', error)
				send(res, 500, { title: 'Internal Server Error', detail: 'Se produjo un error interno, lo estamos revisando' })
			})
	})

	return {
		server,
		db,
		listen: (port, host = '127.0.0.1') => new Promise(resolvePort => {
			server.listen(port, host, () => {
				const address = server.address()
				resolvePort(typeof address === 'object' && address ? address.port : port)
			})
		}),
		close: () => new Promise(resolveClose => {
			server.close(() => {
				db.close()
				resolveClose()
			})
		}),
	}
}

function send(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body)
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
	res.end(payload)
}
