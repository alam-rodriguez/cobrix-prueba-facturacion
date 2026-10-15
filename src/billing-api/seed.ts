/**
 * Generates data/billing-api.sqlite: a synthetic invoice-manager database whose shapes follow the
 * sanitized captures of the real sandbox (2026-09-30). Periods are relative to "today", so
 * the data always has overdue, current and future installments.
 *
 * Every holder covers one case the Cobrix sync has to handle (see CASES below).
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { addMonths, currentPeriod } from '../shared/dates.ts'
import { BILLING_API_SCHEMA } from './schema.ts'

export const SANDBOX_API_USER = {
	user_name: 'cobrix',
	email: 'cobrix@example.com',
	password: 'cobrix-sandbox',
} as const

interface PlanSeed {
	readonly codigo: string
	readonly nombre: string
	readonly precio: number
	readonly tipo: string
}

const PLANS: readonly PlanSeed[] = [
	{ codigo: 'PLAN15MB25', nombre: 'PLAN15MB25', precio: 25, tipo: 'HOGAR' },
	{ codigo: 'PLAN3MB20', nombre: 'PLAN3MB20', precio: 20, tipo: 'HOGAR' },
	{ codigo: 'PLAN30MB35', nombre: 'PLAN30MB35', precio: 35, tipo: 'HOGAR' },
	{ codigo: 'EMPRESA50MB', nombre: 'EMPRESA50MB', precio: 60, tipo: 'EMPRESA' },
]

/** What happens to each installment, relative to the current period (0 = this month). */
type Fate = 'paid' | 'pending' | { partialPaid: number } | { residual: number } | 'exempt'

interface ContractSeed {
	readonly estado: 'AP' | 'CO' | 'CR' | 'CA' | 'RE' | 'AN'
	readonly plan: string
	readonly sucursal: 1 | 2
	/** Offsets from the current period with their fate; offsets > 0 are generated futures. */
	readonly cuotas: ReadonlyArray<readonly [number, Fate]>
	readonly futuras?: number
	readonly fantasma?: boolean
	readonly ves?: boolean
}

interface HolderSeed {
	readonly identificacion: string
	readonly nombre: string
	readonly caso: string
	readonly contratos: readonly ContractSeed[]
}

const paidUntil = (from: number, to: number): Array<readonly [number, Fate]> =>
	Array.from({ length: to - from + 1 }, (_, i) => [from + i, 'paid'] as const)
const pendingFrom = (from: number, to = 0): Array<readonly [number, Fate]> =>
	Array.from({ length: to - from + 1 }, (_, i) => [from + i, 'pending'] as const)

/** The cases the sync must get right. `caso` is shown in the simulator. */
export const CASES: readonly HolderSeed[] = [
	{ identificacion: 'V-12345678', nombre: 'ANA PEREZ', caso: 'Activo con abono parcial, futuras y cuota fantasma 2025-08',
		contratos: [{ estado: 'AP', plan: 'PLAN15MB25', sucursal: 2, futuras: 5, fantasma: true,
			cuotas: [...paidUntil(-8, -3), [-2, { partialPaid: 5 }], ...pendingFrom(-1)] }] },
	{ identificacion: 'V-9876543', nombre: 'LUIS GOMEZ', caso: 'Un titular con dos contratos (activo y cortado)',
		contratos: [
			{ estado: 'AP', plan: 'PLAN30MB35', sucursal: 1, futuras: 3, cuotas: [...paidUntil(-6, -1), ...pendingFrom(0)] },
			{ estado: 'CO', plan: 'PLAN3MB20', sucursal: 1, cuotas: [...paidUntil(-8, -4), ...pendingFrom(-3)] },
		] },
	{ identificacion: 'J-40123456-7', nombre: 'COMERCIAL EL FARO, C.A.', caso: 'Persona jurídica (J): se puede excluir por tipo de documento',
		contratos: [{ estado: 'AP', plan: 'EMPRESA50MB', sucursal: 1, futuras: 3, cuotas: [...paidUntil(-6, -2), ...pendingFrom(-1)] }] },
	{ identificacion: 'E-81234567', nombre: 'MARIA SILVA', caso: 'Extranjera (E), al día salvo el mes actual',
		contratos: [{ estado: 'AP', plan: 'PLAN15MB25', sucursal: 1, cuotas: [...paidUntil(-5, -1), ...pendingFrom(0)] }] },
	{ identificacion: 'V-15111222', nombre: 'CARLOS ROJAS', caso: 'Cortesía con deuda: no se importa por defecto',
		contratos: [{ estado: 'CR', plan: 'PLAN3MB20', sucursal: 2, cuotas: pendingFrom(-2) }] },
	{ identificacion: 'V-16222333', nombre: 'ROSA DIAZ', caso: 'Retirado con deuda vieja: no se importa por defecto',
		contratos: [{ estado: 'CA', plan: 'PLAN15MB25', sucursal: 1, cuotas: [...paidUntil(-9, -6), ...pendingFrom(-5, -3)] }] },
	{ identificacion: 'V-17333444', nombre: 'PEDRO LEON', caso: 'Rechazado con deuda',
		contratos: [{ estado: 'RE', plan: 'PLAN3MB20', sucursal: 1, cuotas: pendingFrom(0) }] },
	{ identificacion: 'V-18444555', nombre: 'LAURA MENDEZ', caso: 'Activo sin deuda: el administrador de facturas devuelve la fila con deuda_id "0"',
		contratos: [{ estado: 'AP', plan: 'PLAN15MB25', sucursal: 1, futuras: 2, cuotas: paidUntil(-6, 0) }] },
	{ identificacion: 'V-19555666', nombre: 'JORGE CASTILLO', caso: 'Contrato en VES que contrato/individual reporta como USD 0,05',
		contratos: [{ estado: 'AP', plan: 'PLAN3MB20', sucursal: 1, ves: true, cuotas: pendingFrom(-1) }] },
	{ identificacion: 'V-20666777', nombre: 'SOFIA TORRES', caso: 'Saldo residual 0,001317 (el administrador de facturas lo sigue listando con deuda 0)',
		contratos: [{ estado: 'AP', plan: 'PLAN15MB25', sucursal: 2, cuotas: [...paidUntil(-4, -2), [-1, { residual: 0.001317 }], ...pendingFrom(0)] }] },
	{ identificacion: 'V-21777888', nombre: 'ANDRES VARGAS', caso: 'Anulado con deuda',
		contratos: [{ estado: 'AN', plan: 'PLAN15MB25', sucursal: 1, cuotas: pendingFrom(-1) }] },
	{ identificacion: '09000123', nombre: 'ELENA RUIZ', caso: 'Identificación sin letra y con ceros a la izquierda',
		contratos: [{ estado: 'AP', plan: 'PLAN15MB25', sucursal: 2, cuotas: [...paidUntil(-4, -2), ...pendingFrom(-1)] }] },
	{ identificacion: 'V-23999000', nombre: 'MIGUEL ANGEL SOTO', caso: 'Ocho cuotas vencidas: prueba la ventana y el límite de recientes',
		contratos: [{ estado: 'AP', plan: 'PLAN30MB35', sucursal: 1, cuotas: [...paidUntil(-10, -8), ...pendingFrom(-7)] }] },
	{ identificacion: 'V-24111222', nombre: 'VALENTINA PAZ', caso: 'Exonerada un mes (descuento = -tarifa)',
		contratos: [{ estado: 'AP', plan: 'PLAN15MB25', sucursal: 2, futuras: 2, cuotas: [...paidUntil(-4, -3), [-2, 'exempt'], ...pendingFrom(-1)] }] },
]

const FIRST_NAMES = ['JOSE', 'CARMEN', 'LUISA', 'RAFAEL', 'GABRIELA', 'DANIEL', 'PATRICIA', 'ALEJANDRO', 'ISABEL', 'FERNANDO', 'ADRIANA', 'RICARDO']
const LAST_NAMES = ['HERNANDEZ', 'GARCIA', 'MARTINEZ', 'RODRIGUEZ', 'LOPEZ', 'GONZALEZ', 'PEREZ', 'SANCHEZ', 'RAMIREZ', 'FLORES', 'MORALES', 'MEDINA']

/** Ordinary active customers, so the customers table looks like a real base. */
function ordinaryHolders(count: number): HolderSeed[] {
	let seed = 20260930
	const next = (): number => {
		seed = (seed * 1103515245 + 12345) % 2147483648
		return seed / 2147483648
	}
	return Array.from({ length: count }, (_, i) => {
		const overdue = Math.floor(next() * 3)
		const plan = PLANS[Math.floor(next() * 3)]!.codigo
		return {
			identificacion: `V-${String(10_000_000 + Math.floor(next() * 19_000_000))}`,
			nombre: `${FIRST_NAMES[i % FIRST_NAMES.length]} ${LAST_NAMES[(i * 5 + 3) % LAST_NAMES.length]}`,
			caso: overdue === 0 ? 'Al día salvo el mes actual' : `${overdue + 1} cuotas pendientes`,
			contratos: [{
				estado: 'AP' as const, plan, sucursal: (next() < 0.85 ? 1 : 2) as 1 | 2, futuras: 2,
				cuotas: [...paidUntil(-6, -overdue - 1), ...pendingFrom(-overdue)],
			}],
		}
	})
}

export interface SeedSummary {
	readonly path: string
	readonly period: string
	readonly holders: number
	readonly contracts: number
	readonly installments: number
}

const TABLES = ['factura_cuota', 'factura', 'cuota', 'contrato', 'plan', 'cliente', 'usuario_api', 'sucursal', 'empresa']

/** Creates a fresh database file. */
export function seedBillingApi(path: string, options: { ordinary?: number } = {}): SeedSummary {
	mkdirSync(dirname(path), { recursive: true })
	for (const suffix of ['', '-wal', '-shm']) {
		if (existsSync(path + suffix)) rmSync(path + suffix)
	}
	const db = new DatabaseSync(path)
	try {
		return { path, ...seedInto(db, options) }
	} finally {
		db.close()
	}
}

/** Drops and refills every table on an open connection (the simulator's reset uses it). */
export function seedInto(db: DatabaseSync, options: { ordinary?: number } = {}): Omit<SeedSummary, 'path'> {
	for (const table of TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`)
	db.exec(BILLING_API_SCHEMA)
	const period = currentPeriod()

	db.prepare('INSERT INTO empresa VALUES (1, ?, ?, ?)').run('ISP DE PRUEBA, C.A.', 'ISP PRUEBA', 'J-00000000-0')
	db.prepare('INSERT INTO sucursal VALUES (?, ?, ?)').run(1, 'CCS', 'CARACAS')
	db.prepare('INSERT INTO sucursal VALUES (?, ?, ?)').run(2, 'VLN', 'VALENCIA')
	db.prepare('INSERT INTO usuario_api (user_name, email, password) VALUES (?, ?, ?)').run(
		SANDBOX_API_USER.user_name, SANDBOX_API_USER.email, SANDBOX_API_USER.password,
	)
	const insertPlan = db.prepare('INSERT INTO plan VALUES (?, ?, ?, ?)')
	for (const plan of PLANS) insertPlan.run(plan.codigo, plan.nombre, plan.precio, plan.tipo)

	const insertCliente = db.prepare('INSERT INTO cliente VALUES (?, ?, ?, ?, ?, ?)')
	const insertContrato = db.prepare(
		'INSERT INTO contrato VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 26, 4, ?, ?)',
	)
	const insertCuota = db.prepare(
		'INSERT INTO cuota (id, id_contrato, periodo, tipo, tarifa, valor_pago, descuento, saldo, id_detalle, fantasma) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
	)
	const insertFactura = db.prepare('INSERT INTO factura (id, num_factura, id_contrato, fecha_emision, referencia) VALUES (?, ?, ?, ?, ?)')
	const insertFacturaCuota = db.prepare('INSERT INTO factura_cuota VALUES (?, ?, ?)')

	let clienteId = 900001
	let contratoId = 900101
	let cuotaId = 7000001
	let detalleId = 8000001
	let facturaId = 8800001
	let installments = 0
	let contracts = 0
	const holders = [...CASES, ...ordinaryHolders(options.ordinary ?? 12)]

	const pay = (contrato: number, cuota: number, cuotaPeriod: string, amount: number): void => {
		const id = facturaId++
		insertFactura.run(id, String(id).padStart(9, '0'), contrato, `${addMonths(cuotaPeriod, 0)}-06`, `REF${id}`)
		insertFacturaCuota.run(id, cuota, amount)
	}

	db.exec('BEGIN')
	for (const [index, holder] of holders.entries()) {
		const cliente = clienteId++
		const slug = holder.nombre.toLowerCase().replaceAll(/[^a-z]+/g, '.').replaceAll(/^\.|\.$/g, '')
		insertCliente.run(
			cliente, holder.identificacion, holder.nombre,
			`0412${String(1_000_000 + index * 7919).slice(-7)}`, `${slug}@example.com`,
			`CALLE ${index + 1}, URB. DE PRUEBA, ${index % 3 === 0 ? 'VALENCIA' : 'CARACAS'}`,
		)
		for (const contrato of holder.contratos) {
			const id = contratoId++
			contracts++
			const plan = PLANS.find(p => p.codigo === contrato.plan)!
			insertContrato.run(
				id, `0${id}`, cliente, contrato.sucursal, contrato.estado, plan.codigo,
				contrato.ves ? 'BOLIVARES' : 'DOLAR', contrato.ves ? 'VES' : 'USD',
				`${addMonths(period, -24)}-15`, contrato.sucursal === 2 ? 'OFICINA VALENCIA' : 'OFICINA CARACAS',
				contrato.ves ? 1 : 0,
			)
			const tarifa = contrato.ves ? 0.05 : plan.precio
			if (contrato.fantasma) {
				insertCuota.run(cuotaId++, id, '2025-08', 'M', tarifa, 0, 0, tarifa, detalleId++, 1)
				installments++
			}
			const futures: Array<readonly [number, Fate]> = Array.from(
				{ length: contrato.futuras ?? 0 }, (_, i) => [i + 1, 'pending'] as const,
			)
			for (const [offset, fate] of [...contrato.cuotas, ...futures]) {
				const cuotaPeriod = addMonths(period, offset)
				const cuota = cuotaId++
				installments++
				if (fate === 'paid') {
					insertCuota.run(cuota, id, cuotaPeriod, 'M', tarifa, tarifa, 0, 0, detalleId++, 0)
					pay(id, cuota, cuotaPeriod, tarifa)
				} else if (fate === 'pending') {
					insertCuota.run(cuota, id, cuotaPeriod, 'M', tarifa, 0, 0, tarifa, detalleId++, 0)
				} else if (fate === 'exempt') {
					insertCuota.run(cuota, id, cuotaPeriod, 'M', tarifa, 0, -tarifa, 0, detalleId++, 0)
				} else if ('partialPaid' in fate) {
					insertCuota.run(cuota, id, cuotaPeriod, 'M', tarifa, fate.partialPaid, 0, tarifa - fate.partialPaid, detalleId++, 0)
					pay(id, cuota, cuotaPeriod, fate.partialPaid)
				} else {
					insertCuota.run(cuota, id, cuotaPeriod, 'M', tarifa, tarifa - fate.residual, 0, fate.residual, detalleId++, 0)
					pay(id, cuota, cuotaPeriod, tarifa - fate.residual)
				}
			}
		}
	}
	db.exec('COMMIT')
	return { period, holders: holders.length, contracts, installments }
}

export const DEFAULT_BILLING_API_DB = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/billing-api.sqlite')

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const summary = seedBillingApi(process.env.BILLING_API_DB ?? DEFAULT_BILLING_API_DB)
	console.log(
		`Administrador de facturas sembrado en ${summary.path}: ${summary.holders} titulares, ${summary.contracts} contratos, ` +
		`${summary.installments} cuotas (mes actual ${summary.period}).`,
	)
}
