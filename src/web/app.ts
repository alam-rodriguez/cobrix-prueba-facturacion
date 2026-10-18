import { readFileSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { CSS, CONTRACT_STATUS_TONE, date, dateTime, esc, html, layout, period, pill, raw, usd, type Raw, type Tone } from './layout.ts'
import { createStore, type Settings, type Store } from '../cobrix/store.ts'
import { RunInProgressError, Synchronizer } from '../cobrix/sync.ts'
import { addCivilDays, today } from '../shared/dates.ts'

type Row = Record<string, unknown>
export interface AppDeps {
	readonly simulatorUrl: string
	readonly assignmentPath: string
	readonly auth: { readonly username: string; readonly password: string }
	readonly secureCookies?: boolean
	readonly store?: Store
}

class RequestInputError extends Error {
	readonly status: number
	constructor(status: number, message: string) { super(message); this.status = status }
}

const resultLabels: Record<string, string> = {
	importada: 'Importada', se_importaria: 'Se importaría', ya_importada: 'Ya importada', excluida: 'Excluida',
	fuera_ventana: 'Fuera de ventana', fuera_limite_recientes: 'Fuera de límite reciente', saldo_residual: 'Saldo residual',
	sin_deuda: 'Sin deuda', frenada_por_tope: 'Frenada por tope', marcada_pagada: 'Marcada pagada', se_marcaria_pagada: 'Se marcaría pagada',
	abono_parcial: 'Abono parcial', pendiente_confirmada: 'Pendiente confirmada', ausente_del_libro: 'Ausente del libro',
	exonerada: 'Exonerada', filas_inconsistentes: 'Filas inconsistentes', saldo_no_conciliado: 'Saldo no conciliado',
	no_aplicada_por_fallo: 'No aplicada · corrida fallida', sin_evidencia: 'Sin evidencia',
	reabierta_por_cambio_isp: 'Reabierta por cambio del ISP', sin_fila_previa: 'Sin fila actual del ISP',
	abono_previo_importacion: 'Pago previo a la importación',
}
const summaryLabels: Record<string, string> = {
	imported: 'Importadas', alreadyImported: 'Ya importadas', excluded: 'Excluidas', throttled: 'Frenadas por tope',
	markedPaid: 'Marcadas pagadas', partial: 'Abonos parciales', pending: 'Pendientes confirmadas', missingFromLedger: 'Ausentes del libro',
	exonerated: 'Exoneradas', inconsistent: 'Sin conciliar', noEvidence: 'Sin evidencia · total', unapplied: 'No aplicadas por fallo', errors: 'Errores',
	reopened: 'Reabiertas por cambio del ISP', noCurrentEvidence: 'Sin fila actual del ISP',
	preImportPaid: 'Pago previo a importar',
}

export function createApp(deps: AppDeps): Server {
	if (!deps.auth.username || !deps.auth.password) throw new Error('El panel requiere usuario y contraseña configurados.')
	const store = deps.store ?? createFallbackStore()
	const sync = new Synchronizer(store)
	const db = store.db
	const csrfSessions = new Map<string, { token: string; expiresAt: number }>()

	async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (isSecureRequest(req, deps.secureCookies === true)) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains')
		if (!validBasicAuth(req, deps.auth.username, deps.auth.password)) {
			res.setHeader('www-authenticate', 'Basic realm="Cobrix", charset="UTF-8"')
			sendHtml(res, 401, '<!doctype html><html lang="es"><meta charset="utf-8"><title>Autenticación requerida</title><h1>Autenticación requerida</h1></html>')
			return
		}
		const url = new URL(req.url ?? '/', 'http://panel.local')
		const path = url.pathname.replace(/\/+$/, '') || '/'
		const flashText = url.searchParams.get('msg')
		const requestedTone = url.searchParams.get('tone') || 'info'
		const tone = (['ok', 'warn', 'bad', 'info', 'mute'].includes(requestedTone) ? requestedTone : 'info') as Tone
		const flash = flashText ? { tone, text: flashText } : undefined
		const settings = store.getSettings()
		let form: URLSearchParams | undefined
		let csrfToken = ''
		if (req.method === 'GET') csrfToken = issueCsrfSession(req, res, csrfSessions, deps.secureCookies === true)
		if (req.method === 'POST') {
			form = await readForm(req)
			csrfToken = validCsrfPost(req, form, csrfSessions, deps.secureCookies === true)
			if (!csrfToken) {
				sendHtml(res, 403, layout({ title: 'Petición rechazada', active: '', company: settings.companyName, flash: { tone: 'bad', text: 'No se pudo validar el origen de esta acción. Recarga el panel e inténtalo de nuevo.' }, body: html`<section class="card"><div class="body"><h1>Petición rechazada</h1><p>La sesión de seguridad ha caducado o la petición no se originó en este panel.</p><a class="btn primary" href="/">Volver al resumen</a></div></section>` }))
				return
			}
		}
		const page = (title: string, active: string, body: Raw, company = settings.companyName || 'Cobrix'): void => sendHtml(res, 200, layout({ title, active, body: addCsrfInputs(body, csrfToken), flash, company }))
		if (req.method === 'GET') {
			if (path === '/app.css') return send(res, 200, CSS + APP_CSS, 'text/css; charset=utf-8')
			if (path === '/app.js') return send(res, 200, APP_JS, 'text/javascript; charset=utf-8')
			if (path === '/enunciado') return page('Enunciado', '', assignmentPage(deps.assignmentPath))
			if (path === '/') return page('Resumen', '/', dashboard(db, settings))
			if (path === '/clientes') return page('Clientes', '/clientes', customersPage(db, url.searchParams.get('q') ?? ''))
			if (/^\/clientes\/[^/]+$/.test(path)) return page('Expediente', '/clientes', customerPage(db, decodeURIComponent(path.split('/').at(-1)!)))
			if (path === '/facturas') return page('Facturas', '/facturas', invoicesPage(db, url.searchParams.get('q') ?? '', url.searchParams.get('estado') ?? ''))
			if (path === '/pagos') return page('Pagos', '/pagos', paymentsPage(db))
			if (path === '/sincronizacion') return page('Sincronización', '/sincronizacion', runsPage(db, url.searchParams.get('run')))
			if (path === '/informes') return page('Informes', '/informes', reportsPage(db))
			if (path === '/configuracion') return page('Configuración', '/configuracion', configurationPage(settings, deps.simulatorUrl))
		}
		if (req.method === 'POST') {
			const submittedForm = form!
			if (path === '/acciones/importar' || path === '/acciones/pagos') {
				const isImport = path.endsWith('importar')
				const simulated = submittedForm.get('simulado') === '1'
				let id: number
				try { id = isImport ? await sync.runImport(simulated) : await sync.runPayments(simulated) }
				catch (error) {
					if (error instanceof RunInProgressError) {
						sendHtml(res, 409, layout({ title: 'Corrida en curso', active: '/sincronizacion', company: settings.companyName, flash: { tone: 'warn', text: error.message }, body: html`<div class="head"><div><p class="eyebrow">OPERACIÓN EN CURSO</p><h1>Espera a que termine</h1><p>Ya hay una sincronización ejecutándose. No se inició otra corrida.</p></div><a class="btn primary" href="/sincronizacion">Ver sincronización</a></div>` }))
						return
					}
					throw error
				}
				const run = db.prepare('SELECT status,error FROM run WHERE id=?').get(id) as { status: string; error: string | null }
				if (run.status === 'failed') return redirect(res, `/sincronizacion?run=${id}&tone=bad&msg=${encodeURIComponent(run.error ?? 'La corrida falló.')}`)
				return redirect(res, `/sincronizacion?run=${id}&tone=ok&msg=${encodeURIComponent(simulated ? 'Simulación completada sin modificar datos.' : 'Corrida completada.')}`)
			}
			if (path === '/acciones/probar') {
				let submitted: Settings
				try { submitted = parseSettings(submittedForm, settings) }
				catch (error) { return configurationResponse(res, settings, deps.simulatorUrl, error instanceof Error ? error.message : String(error), 'bad', csrfToken) }
				try {
					const result = await sync.testConnection(submitted)
					return configurationResponse(res, submitted, deps.simulatorUrl, `Conexión correcta · ${result.contracts} contratos encontrados.`, 'ok', csrfToken)
				} catch (error) {
					return configurationResponse(res, submitted, deps.simulatorUrl, error instanceof Error ? error.message : String(error), 'bad', csrfToken)
				}
			}
			if (path === '/acciones/configuracion') {
				try { store.saveSettings(parseSettings(submittedForm, settings)); return redirect(res, `/configuracion?tone=ok&msg=${encodeURIComponent('Configuración guardada.')}`) }
				catch (error) { return redirect(res, `/configuracion?tone=bad&msg=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`) }
			}
		}
		sendHtml(res, 404, layout({ title: 'No encontrado', active: '', company: settings.companyName, body: html`<div class="head"><h1>Página no encontrada</h1><a class="btn" href="/">Volver al resumen</a></div>` }))
	}
	return createServer((req, res) => {
		route(req, res).catch(error => {
			if (error instanceof RequestInputError) {
				return sendHtml(res, error.status, layout({ title: 'Solicitud inválida', active: '', company: 'Cobrix', body: html`<section class="card"><div class="body"><h1>Solicitud rechazada</h1><p>${error.message}</p></div></section>` }))
			}
			console.error('[panel]', error)
			if (!res.headersSent) sendHtml(res, 500, layout({ title: 'Error', active: '', company: '', body: html`<h1>No se pudo cargar la pantalla</h1><p class="muted">${error instanceof Error ? error.message : String(error)}</p><a href="/">Volver al resumen</a>` }))
		})
	})
}

function createFallbackStore(): Store {
	return createStore(':memory:')
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
	return req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
}

function validBasicAuth(req: IncomingMessage, username: string, password: string): boolean {
	const header = req.headers.authorization
	if (!header?.startsWith('Basic ') || header.length > 8_192) return false
	const submitted = Buffer.from(header.slice(6), 'base64')
	const expected = Buffer.from(`${username}:${password}`)
	return submitted.length === expected.length && timingSafeEqual(submitted, expected)
}

function isSecureRequest(req: IncomingMessage, configuredSecure: boolean): boolean {
	return configuredSecure || (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted === true
}

function issueCsrfSession(req: IncomingMessage, res: ServerResponse, sessions: Map<string, { token: string; expiresAt: number }>, configuredSecure: boolean): string {
	const now = Date.now()
	const id = cookieValue(req, 'cobrix_session')
	const current = id ? sessions.get(id) : undefined
	if (id && current && current.expiresAt > now) return current.token
	if (id) sessions.delete(id)
	for (const [sessionId, session] of sessions) if (session.expiresAt <= now) sessions.delete(sessionId)
	const sessionId = randomBytes(32).toString('base64url')
	const token = randomBytes(32).toString('base64url')
	sessions.set(sessionId, { token, expiresAt: now + 12 * 60 * 60 * 1000 })
	const secure = isSecureRequest(req, configuredSecure) ? '; Secure' : ''
	res.setHeader('set-cookie', `cobrix_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`)
	return token
}

function validCsrfPost(req: IncomingMessage, form: URLSearchParams, sessions: Map<string, { token: string; expiresAt: number }>, configuredSecure: boolean): string {
	if (req.headers['sec-fetch-site'] === 'cross-site') return ''
	const origin = req.headers.origin
	if (origin) {
		try {
			const expected = `${isSecureRequest(req, configuredSecure) ? 'https' : 'http'}://${req.headers.host}`
			if (new URL(origin).origin !== new URL(expected).origin) return ''
		} catch { return '' }
	}
	const id = cookieValue(req, 'cobrix_session')
	const session = id ? sessions.get(id) : undefined
	if (!session || session.expiresAt <= Date.now()) {
		if (id) sessions.delete(id)
		return ''
	}
	const submitted = Buffer.from(form.get('_csrf') ?? '')
	const expected = Buffer.from(session.token)
	if (submitted.length !== expected.length || !timingSafeEqual(submitted, expected)) return ''
	session.expiresAt = Date.now() + 12 * 60 * 60 * 1000
	return session.token
}

function addCsrfInputs(body: Raw, token: string): Raw {
	const input = `<input type="hidden" name="_csrf" value="${esc(token)}">`
	return raw(body.html.replace(/<form\b(?=[^>]*\bmethod=["']post["'])[^>]*>/gi, opening => `${opening}${input}`))
}

function assignmentPage(path: string): Raw {
	let text = ''
	try { text = readFileSync(path, 'utf8') } catch { text = 'No se encontró docs/ENUNCIADO.md.' }
	return html`<div class="head"><div><h1>Enunciado</h1><p>Documento de referencia del caso.</p></div></div><section class="card"><div class="body"><pre class="doc">${text}</pre></div></section>`
}

function dashboard(db: Store['db'], settings: Settings): Raw {
	const currentDate = today()
	const nextWeek = addCivilDays(currentDate, 7)
	const openCount = scalar(db, "SELECT COUNT(*) n FROM invoice WHERE status='open'")
	const paidCount = scalar(db, "SELECT COUNT(*) n FROM invoice WHERE status='paid'")
	const debt = scalar(db, "SELECT COALESCE(SUM(COALESCE(provider_balance_minor,balance_minor)),0) n FROM invoice WHERE status='open'")
	const overdue = db.prepare("SELECT COUNT(*) count,COALESCE(SUM(COALESCE(provider_balance_minor,balance_minor)),0) debt FROM invoice WHERE status='open' AND due_date < ?").get(currentDate) as Row
	const overdueCount = Number(overdue.count)
	const overdueDebt = Number(overdue.debt)
	const dueToday = Number((db.prepare("SELECT COUNT(*) n FROM invoice WHERE status='open' AND due_date = ?").get(currentDate) as { n: number }).n)
	const dueSoon = Number((db.prepare("SELECT COUNT(*) n FROM invoice WHERE status='open' AND due_date BETWEEN ? AND ?").get(currentDate,nextWeek) as { n: number }).n)
	const paidThisMonth = Number((db.prepare("SELECT COALESCE(SUM(provider_paid_minor),0) n FROM invoice WHERE status='paid' AND substr(paid_at,1,7)=?").get(currentDate.slice(0,7)) as { n: number }).n)
	const periods = (db.prepare(`SELECT period,COUNT(*) AS total,
		SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open_count,
		SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid_count,
		SUM(CASE WHEN status='exempt' THEN 1 ELSE 0 END) AS exempt_count
		FROM invoice GROUP BY period ORDER BY period DESC LIMIT 6`).all() as unknown as Row[]).reverse()
	const followups = db.prepare(`SELECT i.*,c.name AS customer_name FROM invoice i JOIN customer c ON c.id=i.customer_id
		WHERE i.status='open' AND i.due_date < ? ORDER BY i.due_date ASC,COALESCE(i.provider_balance_minor,i.balance_minor) DESC LIMIT 5`).all(currentDate) as unknown as Row[]
	const latest = db.prepare('SELECT * FROM run ORDER BY id DESC LIMIT 5').all() as unknown as Row[]
	const exemptCount = scalar(db, "SELECT COUNT(*) n FROM invoice WHERE status='exempt'")
	return html`<div class="dashboard-heading"><div><p class="eyebrow">COBRANZA</p><h1>Resumen</h1><p>Prioridades de cartera · ${date(currentDate)}</p></div><a class="btn primary create-run" href="/sincronizacion">Sincronizar cartera <span aria-hidden="true">→</span></a></div>
		<div class="tiles dashboard-metrics">${metricTile('Saldo pendiente',usd(debt),`${openCount} facturas abiertas`,'balance','/facturas?estado=open')}${metricTile('Saldo vencido',usd(overdueDebt),`${overdueCount} facturas vencidas`,'open','/facturas?estado=vencidas')}${metricTile('Vence en 7 días',dueSoon,`${dueToday} vencen hoy`,'contract','/facturas?estado=proximas')}${metricTile('Cobrado este mes',usd(paidThisMonth),`Pagos conciliados · ${period(currentDate.slice(0,7))}`,'paid','/pagos')}</div>
		<section class="card followup-card"><header><div><h2>Requiere seguimiento</h2><small>Facturas vencidas · primero las de mayor antigüedad</small></div><a class="text-link" href="/facturas?estado=vencidas">Ver todas <span aria-hidden="true">→</span></a></header>
		${followups.length ? html`<div class="followup-list">${followups.map(invoice => html`<article class="followup-row"><div class="followup-customer"><a href="/clientes/${invoice.customer_id}"><strong>${invoice.customer_name}</strong></a><small>${invoice.customer_id} · Cuota ${invoice.external_id}</small></div><div class="followup-due">${dueState(invoice.due_date,currentDate)}<small>Vencimiento ${date(invoice.due_date)}</small></div><div class="followup-balance"><small>Saldo pendiente ISP</small><strong>${usd(invoice.provider_balance_minor ?? invoice.balance_minor)}</strong></div><a class="text-link followup-action" href="/clientes/${invoice.customer_id}">Ver cuenta →</a></article>`)}</div>` : html`<div class="followup-empty"><span class="followup-check" aria-hidden="true">✓</span><span><strong>Sin facturas vencidas</strong><small>No hay saldos que requieran seguimiento hoy.</small></span></div>`}</section>
		<div class="dashboard-overview"><section class="card invoice-chart-card"><header><div><h2>Facturas por período</h2><small>Distribución entre abiertas, pagadas y exoneradas</small></div><a class="text-link" href="/clientes">Ver cartera <span aria-hidden="true">→</span></a></header><div class="body"><div class="chart-total"><strong>${openCount + paidCount + exemptCount}</strong><span>facturas registradas</span></div>${invoicePeriodChart(periods)}<div class="chart-legend"><span><i class="legend-open"></i>Abiertas</span><span><i class="legend-paid"></i>Pagadas</span><span><i class="legend-exempt"></i>Exoneradas</span><span class="legend-note">Por mes de servicio</span></div></div></section>
		<div class="dashboard-aside"><section class="card quick-card"><header><div><h2>Acciones rápidas</h2><small>Operación de facturación</small></div></header><div class="body"><div class="quick-action"><span class="quick-action-icon import-icon">↓</span><div><strong>Importar facturas</strong><small>Traer cuotas pendientes</small></div><form method="post" action="/acciones/importar" data-confirm="¿Iniciar una importación real? Se guardarán los clientes y facturas aprobados."><button class="icon-action" aria-label="Importar facturas">→</button></form></div><div class="quick-action"><span class="quick-action-icon payment-icon">✓</span><div><strong>Actualizar pagos</strong><small>Conciliar pagos del ISP</small></div><form method="post" action="/acciones/pagos" data-confirm="¿Actualizar las facturas pagadas usando la evidencia del ISP?"><button class="icon-action" aria-label="Actualizar pagos">→</button></form></div><a class="quick-foot" href="/sincronizacion">Simular una corrida antes de aplicar cambios <span aria-hidden="true">↗</span></a></div></section>
		<section class="card provider-card"><header><div><h2>Proveedor conectado</h2><small>Administrador de facturación</small></div>${pill('Configurado', 'ok')}</header><div class="body"><div class="provider-endpoint"><span class="provider-led"></span><span><small>API DEL PROVEEDOR</small><strong class="mono">${settings.apiUrl}</strong></span></div><div class="provider-footer"><span>Corrida automática</span>${settings.autoRunEnabled ? pill(`Diaria · ${settings.autoRunTime}`, 'ok') : pill('Desactivada', 'mute')}<a href="/configuracion" aria-label="Editar proveedor">Editar →</a></div></div></section></div></div>
		<section class="card activity-card"><header><div><h2>Actividad reciente</h2><small>Últimas corridas de sincronización</small></div><a class="text-link" href="/sincronizacion">Ver historial completo <span aria-hidden="true">→</span></a></header>${runTable(latest)}</section>`
}

function tile(label: string, value: string | number, helper: string): Raw { return html`<article class="tile"><span>${label}</span><strong>${value}</strong><small>${helper}</small></article>` }

const METRIC_ICONS: Record<string, string> = {
	people: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19v-1.2a5.5 5.5 0 0 1 11 0V19M16 5.2a3.2 3.2 0 0 1 0 6.2m2 3a4.7 4.7 0 0 1 2.5 4.2V19"/></svg>',
	contract: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.8h8l4 4V20H6zM14 4v4h4M9 12h6m-6 3h6"/></svg>',
	open: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8m-8 4h8m-8 4h4"/></svg>',
	paid: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.3 2.3 4.8-5"/></svg>',
	balance: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 7.5c-.8-.9-2.1-1.4-3.8-1.4-2.2 0-3.7 1-3.7 2.7 0 4.1 7.7 1.7 7.7 6 0 1.8-1.6 3-4 3-1.8 0-3.3-.6-4.3-1.7M12.5 3.5v17"/></svg>',
}

function metricTile(label: string, value: string | number, helper: string, icon: string, href?: string): Raw {
	const content = html`<div class="metric-heading"><span>${label}</span><span class="metric-icon">${raw(METRIC_ICONS[icon] ?? METRIC_ICONS.open!)}</span></div><strong>${value}</strong><small>${helper}</small>`
	return href ? html`<a class="metric-card metric-link" href="${href}">${content}</a>` : html`<article class="metric-card">${content}</article>`
}

function dueState(value: unknown, todayValue: string): Raw {
	if (typeof value !== 'string' || !value) return html`<span class="due-state mute">Sin fecha</span>`
	const dueDate = value.slice(0,10)
	const days = Math.round((Date.parse(`${todayValue}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000)
	if (!Number.isFinite(days)) return html`<span class="due-state mute">Sin fecha</span>`
	if (days > 0) return html`<span class="due-state ${days > 30 ? 'bad' : 'warn'}">Vencida · ${days} día${days === 1 ? '' : 's'}</span>`
	if (days === 0) return html`<span class="due-state warn">Vence hoy</span>`
	if (days >= -7) return html`<span class="due-state warn">Vence en ${Math.abs(days)} día${days === -1 ? '' : 's'}</span>`
	return html`<span class="due-state mute">A tiempo</span>`
}

function invoiceState(status: unknown, dueDate: unknown, todayValue: string): Raw {
	if (status === 'paid') return pill('Pagada','ok')
	if (status === 'exempt') return pill('Exonerada','mute')
	if (typeof dueDate === 'string' && dueDate.slice(0,10) < todayValue) {
		const days = Math.round((Date.parse(`${todayValue}T00:00:00Z`) - Date.parse(`${dueDate.slice(0,10)}T00:00:00Z`)) / 86_400_000)
		return pill('Vencida', days > 30 ? 'bad' : 'warn')
	}
	return pill('Pendiente','info')
}

function invoicePeriodChart(periods: Row[]): Raw {
	if (!periods.length) return html`<div class="chart-empty">Todavía no hay facturas por período.</div>`
	const totals = periods.map(row => Number(row.total ?? 0))
	const max = Math.max(...totals, 1)
	const maxBar = 168
	const monthNames = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']
	return html`<div class="invoice-chart" role="img" aria-label="Facturas abiertas, pagadas y exoneradas agrupadas por mes de servicio">${periods.map(row => {
		const total = Number(row.total ?? 0)
		const open = Number(row.open_count ?? 0)
		const paid = Number(row.paid_count ?? 0)
		const exempt = Number(row.exempt_count ?? 0)
		const barPx = total ? Math.max(6, Math.round(total / max * maxBar)) : 0
		const openPx = total ? Math.round(barPx * (open / total)) : 0
		const paidPx = total ? Math.round(barPx * (paid / total)) : 0
		const month = String(row.period ?? '').split('-')[1]
		const label = monthNames[Number(month) - 1] ?? String(row.period ?? '')
		return html`<div class="chart-column"><div class="chart-track"><span class="chart-value">${total}</span><div class="chart-bar" style="height:${barPx}px"><span class="chart-segment chart-open" style="height:${openPx}px"></span><span class="chart-segment chart-paid" style="height:${paidPx}px"></span><span class="chart-segment chart-exempt" style="height:${Math.max(0,barPx-openPx-paidPx)}px"></span></div></div><span class="chart-label">${label}</span><div class="chart-counts"><span>${open} abiertas</span><span>${paid} pagadas</span><span>${exempt} exoneradas</span></div></div>`
	})}</div>`
}

function invoicesPage(db: Store['db'], query: string, requestedStatus: string): Raw {
	const status = ['open', 'paid', 'exempt', 'vencidas', 'proximas'].includes(requestedStatus) ? requestedStatus : ''
	const currentDate = today()
	const nextWeek = addCivilDays(currentDate, 7)
	const term = query.trim().toLocaleLowerCase('es')
	const like = `%${term}%`
	const rows = db.prepare(`SELECT i.*,c.name AS customer_name FROM invoice i JOIN customer c ON c.id=i.customer_id
		WHERE (?='' OR (?='open' AND i.status='open') OR (?='paid' AND i.status='paid') OR (?='exempt' AND i.status='exempt')
		OR (?='vencidas' AND i.status='open' AND i.due_date < ?)
		OR (?='proximas' AND i.status='open' AND i.due_date BETWEEN ? AND ?))
		AND (?='' OR lower(c.name) LIKE ? OR lower(c.phone) LIKE ? OR lower(c.id) LIKE ? OR lower(i.external_id) LIKE ? OR CAST(i.id AS TEXT) LIKE ?)
		ORDER BY CASE WHEN i.status='open' THEN 0 ELSE 1 END,
		CASE WHEN i.status='open' THEN i.due_date END ASC,i.paid_at DESC,i.id DESC`)
		.all(status,status,status,status,status,currentDate,status,currentDate,nextWeek,term,like,like,like,like,like) as unknown as Row[]
	const openCount = scalar(db, "SELECT COUNT(*) n FROM invoice WHERE status='open'")
	const paidCount = scalar(db, "SELECT COUNT(*) n FROM invoice WHERE status='paid'")
	const exemptCount = scalar(db, "SELECT COUNT(*) n FROM invoice WHERE status='exempt'")
	const debt = scalar(db, "SELECT COALESCE(SUM(COALESCE(provider_balance_minor,balance_minor)),0) n FROM invoice WHERE status='open'")
	const overdue = db.prepare("SELECT COUNT(*) count,COALESCE(SUM(COALESCE(provider_balance_minor,balance_minor)),0) debt FROM invoice WHERE status='open' AND due_date < ?").get(currentDate) as Row
	const dueSoonCount = Number((db.prepare("SELECT COUNT(*) n FROM invoice WHERE status='open' AND due_date BETWEEN ? AND ?").get(currentDate,nextWeek) as { n: number }).n)
	const activeFilter = status ? ({open:'Abiertas',paid:'Pagadas',exempt:'Exoneradas',vencidas:'Vencidas',proximas:'Vencen en 7 días'} as Record<string,string>)[status] : 'Todas'
	return html`<div class="head"><div><p class="eyebrow">CARTERA</p><h1>Cuentas por cobrar</h1><p>Ordenadas por vencimiento para facilitar el seguimiento de cada saldo.</p></div><a class="btn primary" href="/sincronizacion">Importar facturas →</a></div>
		<div class="tiles dashboard-metrics">${metricTile('Saldo pendiente ISP',usd(debt),`${openCount} facturas abiertas`,'balance','/facturas?estado=open')}${metricTile('Saldo vencido',usd(overdue.debt),`${overdue.count} cuentas requieren seguimiento`,'open','/facturas?estado=vencidas')}${metricTile('Vence en 7 días',dueSoonCount,'Incluye vencimientos de hoy','contract','/facturas?estado=proximas')}${metricTile('Pagado',paidCount,'Facturas conciliadas','paid','/facturas?estado=paid')}${metricTile('Exoneradas',exemptCount,'Cerradas sin registrarse como pago','open','/facturas?estado=exempt')}</div>
		<section class="card"><div class="body"><form class="search invoice-filters" method="get" action="/facturas"><label class="sr-only" for="invoice-search">Buscar cuentas por nombre, teléfono o documento</label><input id="invoice-search" type="search" name="q" placeholder="Cliente, teléfono o documento" value="${query}" aria-label="Buscar cuentas por nombre, teléfono o documento"><label class="sr-only" for="invoice-status">Filtrar cuentas por estado</label><select id="invoice-status" name="estado" aria-label="Filtrar por estado"><option value=""${status === '' ? ' selected' : ''}>Todos los estados</option><option value="open"${status === 'open' ? ' selected' : ''}>Abiertas</option><option value="vencidas"${status === 'vencidas' ? ' selected' : ''}>Vencidas</option><option value="proximas"${status === 'proximas' ? ' selected' : ''}>Vencen en 7 días</option><option value="paid"${status === 'paid' ? ' selected' : ''}>Pagadas</option><option value="exempt"${status === 'exempt' ? ' selected' : ''}>Exoneradas</option></select><button class="btn primary">Aplicar filtros</button>${query || status ? html`<a class="btn" href="/facturas">Limpiar</a>` : ''}<span class="filter-summary">${activeFilter} · ${rows.length} resultado${rows.length === 1 ? '' : 's'}</span></form></div>
			${rows.length ? html`<div class="table-wrap"><table class="invoice-table"><thead><tr><th>Cliente</th><th>Documento</th><th>Vencimiento</th><th class="num">Importe original</th><th class="num">Saldo pendiente ISP</th><th>Estado</th><th></th></tr></thead><tbody>${rows.map(invoice => html`<tr><td data-label="Cliente"><a href="/clientes/${invoice.customer_id}"><strong>${invoice.customer_name}</strong></a><small class="invoice-customer-id">${invoice.customer_id}</small></td><td data-label="Documento"><span class="mono">CB-${String(invoice.id).padStart(6,'0')}</span><small class="invoice-customer-id">Cuota ISP ${invoice.external_id}</small></td><td data-label="Vencimiento"><span>${date(invoice.due_date)}</span>${invoice.status === 'open' ? dueState(invoice.due_date,currentDate) : invoice.status === 'paid' ? html`<span class="due-state ok">Pagada · ${date(invoice.paid_at)}</span>` : ''}</td><td data-label="Importe original" class="num">${usd(invoice.amount_minor)}</td><td data-label="Saldo pendiente ISP" class="num balance-cell">${usd(invoice.provider_balance_minor ?? invoice.balance_minor)}</td><td data-label="Estado">${invoiceState(invoice.status,invoice.due_date,currentDate)}</td><td data-label="Próximo paso"><a class="text-link" href="/clientes/${invoice.customer_id}">Ver cuenta →</a></td></tr>`)}</tbody></table></div>` : empty('No hay cuentas en esta vista',term || status ? 'Cambia los filtros o límpialos para volver a ver todas las cuentas.' : 'Las facturas aparecerán aquí después de una importación.','/facturas','Ver todas las cuentas')}</section>`
}

function paymentsPage(db: Store['db']): Raw {
	const count = scalar(db, "SELECT COUNT(*) n FROM invoice WHERE status='paid'")
	const total = scalar(db, "SELECT COALESCE(SUM(provider_paid_minor),0) n FROM invoice WHERE status='paid'")
	const rows = db.prepare(`SELECT i.*,c.name AS customer_name FROM invoice i JOIN customer c ON c.id=i.customer_id
		WHERE i.status='paid' ORDER BY i.paid_at DESC,i.id DESC LIMIT 200`).all() as unknown as Row[]
	return html`<div class="head"><div><p class="eyebrow">COBRANZA</p><h1>Pagos</h1><p>Pagos confirmados por el proveedor y aplicados a las facturas de Cobrix.</p></div><a class="btn" href="/sincronizacion">Actualizar pagos →</a></div>
		<div class="tiles dashboard-metrics">${metricTile('Pagos confirmados',count,'Facturas cerradas','paid')}${metricTile('Total conciliado',usd(total),'Monto reportado por el ISP','balance')}</div>
		<section class="card"><header><div><h2>Pagos conciliados</h2><small>Más recientes primero · hasta 200 registros</small></div><a class="text-link" href="/facturas?estado=paid">Ver facturas pagadas →</a></header>
			${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Fecha de pago</th><th>Cliente</th><th>Factura</th><th>Cuota ISP</th><th>Periodo</th><th class="num">Monto pagado reportado</th><th>Estado</th></tr></thead><tbody>${rows.map(invoice => html`<tr><td>${date(invoice.paid_at)}</td><td><a href="/clientes/${invoice.customer_id}"><strong>${invoice.customer_name}</strong></a></td><td class="mono">CB-${String(invoice.id).padStart(6,'0')}</td><td class="mono">${invoice.external_id}</td><td>${period(invoice.period)}</td><td class="num">${usd(invoice.provider_paid_minor)}</td><td>${pill('Confirmado','ok')}</td></tr>`)}</tbody></table></div>` : empty('Aún no hay pagos conciliados','Los pagos confirmados aparecerán aquí después de actualizar los pagos desde el proveedor.','/sincronizacion','Actualizar pagos')}</section>`
}

function reportsPage(db: Store['db']): Raw {
	const customerCount = scalar(db, 'SELECT COUNT(*) n FROM customer')
	const invoiceCount = scalar(db, 'SELECT COUNT(*) n FROM invoice')
	const openDebt = scalar(db, "SELECT COALESCE(SUM(COALESCE(provider_balance_minor,balance_minor)),0) n FROM invoice WHERE status='open'")
	const paidAmount = scalar(db, "SELECT COALESCE(SUM(provider_paid_minor),0) n FROM invoice WHERE status='paid'")
	const periods = db.prepare(`SELECT period,COUNT(*) total,
		SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open_count,
		SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) paid_count,
		SUM(CASE WHEN status='exempt' THEN 1 ELSE 0 END) exempt_count,
		SUM(amount_minor) amount_minor,
		SUM(CASE WHEN status='paid' THEN provider_paid_minor ELSE 0 END) paid_minor,
		SUM(CASE WHEN status='open' THEN COALESCE(provider_balance_minor,balance_minor) ELSE 0 END) debt_minor
		FROM invoice GROUP BY period ORDER BY period DESC LIMIT 12`).all() as unknown as Row[]
	return html`<div class="head"><div><p class="eyebrow">ANÁLISIS</p><h1>Informes</h1><p>Resumen de cartera y facturación agrupado por periodo de servicio.</p></div><a class="btn" href="/facturas">Ver detalle de facturas →</a></div>
		<div class="tiles dashboard-metrics">${metricTile('Clientes',customerCount,'Titulares registrados','people')}${metricTile('Facturas',invoiceCount,'Total en cartera','contract')}${metricTile('Saldo abierto',usd(openDebt),'Pendiente de cobro','balance')}${metricTile('Pagos aplicados',usd(paidAmount),'Total confirmado','paid')}</div>
		<section class="card"><header><div><h2>Resumen por periodo</h2><small>Últimos 12 periodos con actividad</small></div></header>
			${periods.length ? html`<div class="table-wrap"><table><thead><tr><th>Periodo</th><th class="num">Facturas</th><th class="num">Abiertas</th><th class="num">Pagadas</th><th class="num">Exoneradas</th><th class="num">Facturado</th><th class="num">Pago ISP</th><th class="num">Saldo ISP</th></tr></thead><tbody>${periods.map(row => html`<tr><td><strong>${period(row.period)}</strong></td><td class="num">${row.total}</td><td class="num">${row.open_count}</td><td class="num">${row.paid_count}</td><td class="num">${row.exempt_count}</td><td class="num">${usd(row.amount_minor)}</td><td class="num">${usd(row.paid_minor)}</td><td class="num">${usd(row.debt_minor)}</td></tr>`)}</tbody></table></div>` : empty('Todavía no hay datos para informar','Importa facturas para ver el resumen de cartera por periodo.','/sincronizacion','Ir a sincronización')}</section>`
}

function customersPage(db: Store['db'], query: string): Raw {
	const q = `%${query.trim().toLocaleLowerCase('es')}%`
	const rows = db.prepare(`WITH contracts AS (SELECT customer_id,COUNT(*) contracts FROM contract GROUP BY customer_id),
		invoices AS (SELECT customer_id,SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open_count,
		SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) paid_count,
		SUM(CASE WHEN status='open' THEN COALESCE(provider_balance_minor,balance_minor) ELSE 0 END) debt,
		MIN(CASE WHEN status='open' THEN due_date END) oldest FROM invoice GROUP BY customer_id)
		SELECT c.id,c.name,c.document_type,COALESCE(k.contracts,0) contracts,COALESCE(i.open_count,0) open_count,
		COALESCE(i.paid_count,0) paid_count,COALESCE(i.debt,0) debt,i.oldest
		FROM customer c LEFT JOIN contracts k ON k.customer_id=c.id LEFT JOIN invoices i ON i.customer_id=c.id
		WHERE lower(c.name) LIKE ? OR lower(c.id) LIKE ? ORDER BY c.name`).all(q,q) as unknown as Row[]
	return html`<div class="head"><div><p class="eyebrow">CARTERA</p><h1>Clientes</h1><p>${rows.length} resultado${rows.length === 1 ? '' : 's'} · una ficha por titular.</p></div></div>
	<section class="card"><div class="body"><form class="search" method="get" action="/clientes"><input type="search" name="q" placeholder="Buscar por nombre, cédula o RIF" value="${query}" aria-label="Buscar clientes"><button class="btn primary">Buscar</button>${query ? html`<a class="btn" href="/clientes">Limpiar</a>` : ''}</form></div>
		${rows.length ? customerTable(rows) : empty('Aún no hay clientes importados', 'Ejecuta una importación para traer titulares con cuotas pendientes que cumplan las reglas.', '/sincronizacion', 'Ir a sincronización')}</section>`
}

function customerTable(rows: Row[]): Raw {
	return html`<div class="table-wrap"><table class="customer-table"><thead><tr><th>Cliente</th><th>N.º de documento<br><small>(cédula o RIF del titular)</small></th><th>Tipo</th><th class="num">Contratos</th><th class="num">Abiertas</th><th class="num">Pagadas</th><th class="num">Deuda</th><th>Vencimiento más antiguo</th><th></th></tr></thead><tbody>${rows.map(row => html`<tr><td data-label="Cliente"><a href="/clientes/${row.id}"><strong>${row.name}</strong></a></td><td data-label="Documento" class="mono">${row.id}</td><td data-label="Tipo">${row.document_type === 'J' || row.document_type === 'G' ? 'Jurídico' : 'Natural'}</td><td data-label="Contratos" class="num">${row.contracts}</td><td data-label="Abiertas" class="num">${Number(row.open_count ?? 0)}</td><td data-label="Pagadas" class="num">${Number(row.paid_count ?? 0)}</td><td data-label="Deuda" class="num balance-cell">${usd(row.debt)}</td><td data-label="Vencimiento más antiguo">${date(row.oldest)}</td><td data-label="Próximo paso"><a class="btn small" href="/clientes/${row.id}">Abrir cuenta →</a></td></tr>`)}</tbody></table></div>`
}

function customerPage(db: Store['db'], id: string): Raw {
	const customer = db.prepare('SELECT * FROM customer WHERE id=?').get(id) as Row | undefined
	if (!customer) return html`<div class="head"><div><h1>Cliente no encontrado</h1><p>Ese titular no está en la base de Cobrix.</p></div><a class="btn" href="/clientes">Volver a clientes</a></div>`
	const currentDate = today()
	const contracts = db.prepare('SELECT * FROM contract WHERE customer_id=? ORDER BY id').all(id) as unknown as Row[]
	const invoices = db.prepare('SELECT * FROM invoice WHERE customer_id=? ORDER BY period DESC, id DESC').all(id) as unknown as Row[]
	const events = db.prepare('SELECT e.*,i.external_id FROM event e LEFT JOIN invoice i ON i.id=e.invoice_id WHERE e.customer_id=? ORDER BY e.id DESC').all(id) as unknown as Row[]
	const open = invoices.filter(row => row.status === 'open')
	const paid = invoices.filter(row => row.status === 'paid')
	const balance = open.reduce((sum, row) => sum + Number(row.provider_balance_minor ?? row.balance_minor), 0)
	return html`<div class="head"><div><a href="/clientes">← Clientes</a><p class="eyebrow">EXPEDIENTE DE CLIENTE</p><h1>${customer.name}</h1><p>${customer.id} · ${customer.document_type === 'J' || customer.document_type === 'G' ? 'Persona jurídica' : 'Persona natural'} · ${customer.origin}</p></div>${pill(open.length ? `${open.length} abiertas` : 'Al día', open.length ? 'warn' : 'ok')}</div>
		<div class="tiles">${tile('Contratos', contracts.length, 'Registrados en el administrador')}${tile('Facturas abiertas', open.length, 'Cuotas pendientes')}${tile('Facturas pagadas', paid.length, 'Pagos confirmados')}${tile('Saldo pendiente ISP', usd(balance), 'Saldo actual reportado')}</div>
		<div class="grid2"><section class="card"><header><h2>Datos del titular</h2></header><div class="body"><dl class="facts"><dt>Documento</dt><dd class="mono">${customer.id}</dd><dt>Correo</dt><dd>${customer.email || '—'}</dd><dt>Teléfono</dt><dd>${customer.phone || '—'}</dd><dt>Origen</dt><dd>${customer.origin}</dd><dt>Alta en Cobrix</dt><dd>${dateTime(customer.created_at)}</dd></dl></div></section>
		<section class="card"><header><h2>Contratos del administrador</h2><span>${contracts.length}</span></header>${contracts.length ? html`<div class="table-wrap"><table><thead><tr><th>Contrato</th><th>Estado</th><th>Plan</th><th class="num">Precio</th><th>Sucursal</th></tr></thead><tbody>${contracts.map(contract => html`<tr><td class="mono">${contract.id}</td><td>${pill(String(contract.status), CONTRACT_STATUS_TONE[String(contract.status)] ?? 'mute')}</td><td>${contract.plan}</td><td class="num">${usd(contract.price_minor)}</td><td>${contract.branch || '—'}</td></tr>`)}</tbody></table></div>` : html`<div class="body muted">Todavía no hay contratos asociados.</div>`}</section></div>
		<section class="card"><header><h2>Facturas</h2><span>${invoices.length} cuotas</span></header>${invoices.length ? html`<div class="table-wrap"><table class="invoice-table"><thead><tr><th>Número Cobrix</th><th>Cuota ISP</th><th>Contrato</th><th>Periodo</th><th>Vencimiento</th><th>Corte</th><th class="num">Total</th><th class="num">Saldo ISP</th><th>Estado</th><th>Pagada</th></tr></thead><tbody>${invoices.map(invoice => html`<tr><td data-label="Factura" class="mono">CB-${String(invoice.id).padStart(6,'0')}</td><td data-label="Cuota ISP" class="mono">${invoice.external_id}</td><td data-label="Contrato" class="mono">${invoice.contract_id}</td><td data-label="Periodo">${period(invoice.period)}</td><td data-label="Vencimiento">${date(invoice.due_date)}${invoice.status === 'open' ? dueState(invoice.due_date,currentDate) : ''}</td><td data-label="Corte">${date(invoice.cutoff_date)}</td><td data-label="Importe original" class="num">${usd(invoice.amount_minor)}</td><td data-label="Saldo ISP" class="num balance-cell">${usd(invoice.provider_balance_minor ?? invoice.balance_minor)}</td><td data-label="Estado">${invoiceState(invoice.status,invoice.due_date,currentDate)}</td><td data-label="Pagada">${date(invoice.paid_at)}</td></tr>`)}</tbody></table></div>` : html`<div class="body muted">No hay facturas en el expediente.</div>`}</section>
		<section class="card"><header><h2>Actividad</h2><span>${events.length} eventos</span></header>${events.length ? html`<div class="body"><ol class="timeline">${events.map(event => html`<li><time>${dateTime(event.created_at)}</time><span><strong>${event.type === 'customer_created' ? 'Cliente creado' : event.type === 'invoice_imported' ? 'Factura importada' : event.type === 'invoice_paid' ? 'Factura pagada' : event.type === 'invoice_partial_payment' ? 'Abono observado' : event.type === 'invoice_provider_observation' ? 'Saldo ISP actualizado' : event.type === 'invoice_reopened' ? 'Factura reabierta' : event.type === 'invoice_exempted' ? 'Factura exonerada' : 'Actualización de factura'}</strong> · ${event.description}${event.external_id ? html` <span class="muted">(cuota ${event.external_id})</span>` : ''}</span></li>`)}</ol></div>` : html`<div class="body muted">Sin actividad registrada.</div>`}</section>`
}

function runsPage(db: Store['db'], runParam: string | null): Raw {
	const runs = db.prepare('SELECT * FROM run ORDER BY id DESC LIMIT 50').all() as unknown as Row[]
	const automaticRuns = db.prepare(`SELECT a.*,GROUP_CONCAT(s.stage || ':' || s.status, ', ') AS stages
		FROM automatic_run a LEFT JOIN automatic_run_stage s ON s.automatic_run_id=a.id
		GROUP BY a.id ORDER BY a.run_date DESC LIMIT 30`).all() as unknown as Row[]
	const selected = runParam ? db.prepare('SELECT * FROM run WHERE id=?').get(Number(runParam)) as Row | undefined : undefined
	const detail = selected ? db.prepare(`SELECT ri.*,c.id AS linked_customer_id FROM run_item ri LEFT JOIN customer c ON c.id=ri.customer_id WHERE ri.run_id=? ORDER BY ri.id`).all(Number(selected.id)) as unknown as Row[] : []
	return html`<div class="head"><div><p class="eyebrow">CENTRO DE CONTROL</p><h1>Sincronización</h1><p>Importa cuotas del administrador y concilia los pagos confirmados por el proveedor.</p></div><a class="btn" href="/configuracion"><span aria-hidden="true">⚙</span> Ajustar reglas</a></div>
		<div class="grid2 sync-grid"><section class="card sync-operation import-operation"><header><div class="card-title"><span class="section-icon import-icon">↓</span><div><h2>Importar facturas</h2><small>Clientes, contratos y cuotas pendientes</small></div></div>${pill('Idempotente', 'info')}</header><div class="body"><p>Lee todos los contratos del proveedor y aplica los estados, la ventana y los topes configurados.</p><div class="sync-actions"><form method="post" action="/acciones/importar" data-confirm="¿Iniciar una importación real? Se guardarán los clientes y facturas aprobados."><button class="btn primary">Importar ahora <span aria-hidden="true">→</span></button></form><form method="post" action="/acciones/importar"><input type="hidden" name="simulado" value="1"><button class="btn">Simular importación</button></form></div><div class="operation-note"><span>i</span> La simulación muestra el resultado sin escribir datos.</div></div></section>
		<section class="card sync-operation payment-operation"><header><div class="card-title"><span class="section-icon payment-icon">✓</span><div><h2>Actualizar pagos</h2><small>Conciliación con el libro del ISP</small></div></div>${pill('Pago confirmado', 'ok')}</header><div class="body"><p>Contrasta cada factura abierta con el libro. Los abonos y cuotas pendientes se mantienen abiertos.</p><div class="sync-actions"><form method="post" action="/acciones/pagos" data-confirm="¿Actualizar las facturas pagadas usando la evidencia del ISP?"><button class="btn primary">Actualizar pagadas <span aria-hidden="true">→</span></button></form><form method="post" action="/acciones/pagos"><input type="hidden" name="simulado" value="1"><button class="btn">Simular actualización</button></form></div><div class="operation-note"><span>i</span> Solo se cierran facturas con saldo cero y evidencia de pago.</div></div></section></div>
		${selected ? html`<div class="actions"><a class="btn" href="/sincronizacion">← Volver atrás</a></div>${runDetail(selected, detail)}` : html`${automaticRuns.length ? automaticRunHistory(automaticRuns) : ''}<section class="card"><header><h2>Historial de corridas</h2><span>${runs.length} recientes</span></header>${runTable(runs)}</section>`}`
}

function automaticRunHistory(rows: Row[]): Raw {
	const statuses: Record<string, string> = { pending: 'Pendiente/reintento', running: 'En curso', completed: 'Completada', failed: 'Falló' }
	const stageLabels: Record<string, string> = { import: 'Importación', payments: 'Pagos' }
	return html`<section class="card"><header><div><h2>Corridas automáticas</h2><small>Registro persistente de etapas y reintentos</small></div><span>${rows.length} recientes</span></header><div class="table-wrap"><table><thead><tr><th>Fecha Caracas</th><th>Estado</th><th>Etapas</th><th>Error reciente</th></tr></thead><tbody>${rows.map(run => {
		const status = String(run.status)
		const tone: Tone = status === 'completed' ? 'ok' : status === 'running' ? 'info' : status === 'failed' ? 'bad' : 'warn'
		const stages = String(run.stages ?? '').split(', ').filter(Boolean).map(part => {
			const [stage, state] = part.split(':')
			return `${stageLabels[stage ?? ''] ?? stage}: ${statuses[state ?? ''] ?? state}`
		}).join(' · ')
		return html`<tr><td>${run.run_date}</td><td>${pill(statuses[status] ?? status,tone)}</td><td>${stages || '—'}</td><td>${run.error ?? '—'}</td></tr>`
	})}</tbody></table></div></section>`
}

function runTable(rows: Row[]): Raw {
	if (!rows.length) return html`<div class="body"><div class="empty"><strong>Aún no hay corridas</strong><span>Simula una importación para revisar qué cuotas cumplen las reglas antes de escribir datos.</span></div></div>`
	return html`<div class="table-wrap"><table><thead><tr><th>Corrida</th><th>Tipo</th><th>Fecha de inicio</th><th>Modo</th><th>Estado</th><th>Resumen</th><th></th></tr></thead><tbody>${rows.map(run => {
		const summary = JSON.parse(String(run.summary || '{}')) as Row
		const statusLabel = run.status === 'completed' ? 'Completada' : run.status === 'running' ? 'En curso' : 'Falló'
		const statusTone: Tone = run.status === 'completed' ? 'ok' : run.status === 'running' ? 'info' : 'bad'
		const result = run.error ? String(run.error) : run.kind === 'import' ? `${summary.imported ?? 0} nuevas · ${summary.excluded ?? 0} excluidas` : `${summary.markedPaid ?? 0} pagadas · ${summary.partial ?? 0} abonos · ${summary.preImportPaid ?? 0} pagos previos · ${summary.reopened ?? 0} reabiertas`
		return html`<tr><td class="mono">#${run.id}</td><td>${run.kind === 'import' ? 'Importación' : 'Actualizar pagos'}</td><td>${dateTime(run.started_at)}</td><td>${run.simulated ? pill('Simulación','info') : 'Real'}</td><td>${pill(statusLabel, statusTone)}</td><td>${result}</td><td><a class="btn small" href="/sincronizacion?run=${run.id}">Ver detalle <span aria-hidden="true">→</span></a></td></tr>`
	})}</tbody></table></div>`
}

function runDetail(run: Row, items: Row[]): Raw {
	const summary = JSON.parse(String(run.summary || '{}')) as Row
	const entries = Object.entries(summary).filter(([key]) => key !== 'total')
	const statStrip = html`<div class="stats-strip">${entries.map(([key, value]) => {
		const number = Number(value)
		const tone: Tone = key === 'markedPaid' || key === 'imported' ? 'ok' : key === 'errors' || key === 'unapplied' || key === 'inconsistent' ? 'bad' : key === 'partial' || key === 'preImportPaid' || key === 'pending' || key === 'throttled' || key === 'reopened' || key === 'noCurrentEvidence' ? 'warn' : 'mute'
		return html`<div class="stat-card ${tone}"><strong>${number}</strong><span>${summaryLabels[key] ?? key}</span></div>`
	})}</div>`
	const itemRows = items.map(item => {
		const result = String(item.result)
		const customer = item.customer_id ? String(item.customer_id) : ''
		const resultTone: Tone = ['importada','marcada_pagada','se_marcaria_pagada'].includes(result) ? 'ok' : ['pendiente_confirmada','abono_parcial','abono_previo_importacion','frenada_por_tope','reabierta_por_cambio_isp'].includes(result) ? 'warn' : ['filas_inconsistentes','saldo_no_conciliado','no_aplicada_por_fallo'].includes(result) ? 'bad' : ['excluida','ausente_del_libro','exonerada','sin_fila_previa','sin_evidencia'].includes(result) ? 'mute' : 'info'
		return html`<tr><td class="mono">${item.contract_id ?? '—'}</td><td>${item.linked_customer_id && customer ? html`<a href="/clientes/${customer}">${customer}</a>` : customer || '—'}</td><td class="mono">${item.debt_id ?? '—'}</td><td>${item.period ?? '—'}</td><td class="num">${usd(item.amount_minor)}</td><td class="num">${item.observed_balance_minor == null ? '—' : usd(item.observed_balance_minor)}</td><td class="num">${item.observed_paid_minor == null ? '—' : usd(item.observed_paid_minor)}</td><td>${pill(resultLabels[result] ?? result, resultTone)}</td><td>${item.reason}</td></tr>`
	})
	const itemTable = items.length
		? html`<div class="table-wrap"><table><thead><tr><th>Contrato</th><th>N.º de documento<br><small>(cédula o RIF del titular)</small></th><th>Cuota ISP</th><th>Periodo</th><th class="num">Importe Cobrix</th><th class="num">Saldo ISP</th><th class="num">Pago ISP</th><th>Resultado</th><th>Motivo</th></tr></thead><tbody>${itemRows}</tbody></table></div>`
		: html`<div class="body muted">${run.status === 'running' ? 'La corrida continúa; el detalle se guardará al terminar.' : `No hay filas de detalle.${run.status === 'failed' ? ' Revisa el error anterior y vuelve a intentar.' : ''}`}</div>`
	const statusLabel = run.status === 'completed' ? 'Completada' : run.status === 'running' ? 'En curso' : 'Falló'
	const statusTone: Tone = run.status === 'completed' ? 'ok' : run.status === 'running' ? 'info' : 'bad'
	return html`<section class="card"><header><div><h2>Detalle de corrida #${run.id}</h2><p class="muted">${run.kind === 'import' ? 'Importación' : 'Actualización de pagos'} · ${run.simulated ? 'simulación' : 'escritura'} · ${dateTime(run.started_at)}</p></div>${pill(statusLabel, statusTone)}</header><div class="body">${statStrip}${run.error ? html`<div class="flash bad">${run.error}</div>` : ''}</div>${itemTable}</section>`
}

function configurationPage(settings: Settings, simulatorUrl: string): Raw {
	const statuses = ['ACTIVO','CORTADO','CORTESIA','RETIRADO','RECHAZADO','ANULADO']
	const docTypes = ['V','E','J','G','P']
	const checked = (values: string[], value: string): string => values.includes(value) ? ' checked' : ''
	return html`<div class="head"><div><p class="eyebrow">ADMINISTRACIÓN</p><h1>Configuración</h1><p>Reglas de importación y credenciales del administrador de facturas.</p></div></div>
		<form method="post" action="/acciones/configuracion" class="config-form"><section class="card"><header><h2>Empresa</h2></header><div class="body grid2"><label class="field">Nombre de la empresa<input type="text" name="companyName" required value="${settings.companyName}"></label><label class="field">RIF<input type="text" name="companyTaxId" value="${settings.companyTaxId}"></label><label class="field">Correo de cobranza<input type="text" name="collectionsEmail" value="${settings.collectionsEmail}"></label></div></section>
		<section class="card"><header><h2>Administrador del ISP</h2>${simulatorUrl ? html`<a href="${simulatorUrl}/docs" target="_blank" rel="noopener">Abrir Swagger ↗</a>` : ''}</header><div class="body"><div class="grid2 provider-fields"><label class="field">URL de la API<input type="url" name="apiUrl" required value="${settings.apiUrl}"></label><label class="field">Usuario<input type="text" name="apiUser" required value="${settings.apiUser}"></label><label class="field provider-password">Contraseña<input type="password" name="apiPassword" autocomplete="new-password" placeholder="Sin cambios si se deja vacío"><small>Cifrada en la base de Cobrix.</small></label></div><div class="actions connection-actions"><button class="btn" formaction="/acciones/probar">Probar conexión</button><small>Inicia sesión y consulta el número de contratos.</small></div></div></section>
		<section class="card"><header><h2>Reglas de importación</h2></header><div class="body"><fieldset><legend>Estados de contrato</legend>${statuses.map(status => html`<label><input type="checkbox" name="importStatuses" value="${status}"${checked(settings.importStatuses,status)}> ${status}</label>`)}</fieldset><fieldset><legend>Excluir titulares por tipo de documento</legend>${docTypes.map(type => html`<label><input type="checkbox" name="excludedDocumentTypes" value="${type}"${checked(settings.excludedDocumentTypes,type)}> ${type}</label>`)}</fieldset>
		<div class="grid2 import-options"><label class="field">Ventana de importación<select name="windowMonths"><option value="3"${settings.windowMonths===3?' selected':''}>Últimos 3 meses</option><option value="6"${settings.windowMonths===6?' selected':''}>Últimos 6 meses</option><option value="9"${settings.windowMonths===9?' selected':''}>Últimos 9 meses</option><option value="12"${settings.windowMonths===12?' selected':''}>Últimos 12 meses</option><option value="all"${settings.windowMonths===null?' selected':''}>Sin ventana</option></select><small>Incluye el mes actual y el límite indicado.</small></label>
		<label class="field">Cuotas recientes por contrato<input type="number" min="1" max="60" name="maxRecentInstallments" value="${settings.maxRecentInstallments ?? ''}" placeholder="Todas"><small>Entre 1 y 60; vacío para todas.</small></label><label class="field">Días de gracia<input type="number" min="0" max="60" name="graceDays" value="${settings.graceDays}"></label><label class="field">Máximo de facturas nuevas por corrida<input type="number" min="1" name="maxInvoicesPerRun" value="${settings.maxInvoicesPerRun ?? ''}" placeholder="Sin límite"></label><label class="field">Máximo de monto nuevo (USD)<input type="number" min="0.01" step="0.01" name="maxAmountPerRun" value="${settings.maxAmountPerRun ?? ''}" placeholder="Sin límite"></label></div></div></section>
		<section class="card"><header><h2>Corrida automática</h2></header><div class="body grid2"><label class="checkline"><input type="checkbox" name="autoRunEnabled" value="1"${settings.autoRunEnabled?' checked':''}> Activar corrida diaria</label><label class="field">Hora local<input type="text" name="autoRunTime" pattern="([01][0-9]|2[0-3]):[0-5][0-9]" value="${settings.autoRunTime}" placeholder="02:00"></label><p class="note">La corrida automática se ejecuta mientras el proceso esté activo y queda registrada en el historial.</p></div></section>
		<div class="actions sticky-actions"><button class="btn primary">Guardar configuración</button></div></form>`
}

function parseSettings(form: URLSearchParams, old: Settings): Settings {
	const required = (name: string): string => { const value = (form.get(name) ?? '').trim(); if (!value) throw new Error(`El campo ${name} es obligatorio.`); return value }
	const optionalNumber = (name: string, min: number, max = Number.MAX_SAFE_INTEGER, integer = true): number | null => {
		const raw = (form.get(name) ?? '').trim(); if (!raw) return null
		const value = Number(raw); if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error(`${name} debe estar entre ${min} y ${max}${integer ? ' y ser entero' : ''}.`); return value
	}
	const windowValue = form.get('windowMonths')
	const graceDays = optionalNumber('graceDays',0,60)
	const recent = optionalNumber('maxRecentInstallments',1,60)
	const maxInvoices = optionalNumber('maxInvoicesPerRun',1)
	const maxAmount = optionalNumber('maxAmountPerRun',0.01,Number.MAX_SAFE_INTEGER,false)
	const apiUrl = required('apiUrl')
	let apiOrigin: string
	try {
		const parsed = new URL(apiUrl)
		if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !['','/'].includes(parsed.pathname)) throw new Error()
		apiOrigin = parsed.origin
	} catch { throw new Error('La URL debe ser un origen HTTP(S) válido, sin credenciales, ruta ni parámetros.') }
	if (!['3','6','9','12','all'].includes(windowValue ?? '')) throw new Error('Selecciona una ventana de importación válida.')
	const time = form.get('autoRunTime') ?? '02:00'
	if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('La hora automática debe tener formato HH:MM.')
	const statuses = form.getAll('importStatuses').map(String)
	const allowedStatuses = new Set(['ACTIVO','CORTADO','CORTESIA','RETIRADO','RECHAZADO','ANULADO'])
	if (!statuses.length || statuses.some(status => !allowedStatuses.has(status)) || new Set(statuses).size !== statuses.length) throw new Error('Selecciona estados de contrato válidos y sin duplicados.')
	const excludedTypes = form.getAll('excludedDocumentTypes').map(String)
	if (excludedTypes.some(value => !['V','E','J','G','P'].includes(value)) || new Set(excludedTypes).size !== excludedTypes.length) throw new Error('Los tipos de documento excluidos no son válidos.')
	return {
		...old, companyName: required('companyName'), companyTaxId: (form.get('companyTaxId') ?? '').trim(), collectionsEmail: (form.get('collectionsEmail') ?? '').trim(),
		apiUrl: apiOrigin, apiUser: required('apiUser'), apiPassword: (form.get('apiPassword') ?? '') || old.apiPassword,
		importStatuses: statuses, windowMonths: windowValue === 'all' ? null : Number(windowValue), maxRecentInstallments: recent,
		graceDays: graceDays ?? 0, maxInvoicesPerRun: maxInvoices, maxAmountPerRun: maxAmount,
		excludedDocumentTypes: excludedTypes, autoRunEnabled: form.get('autoRunEnabled') === '1', autoRunTime: time,
	}
}

function empty(title: string, detail: string, href: string, label: string): Raw { return html`<div class="body"><div class="empty"><span class="empty-icon">✦</span><strong>${title}</strong><span>${detail}</span><a class="btn primary" href="${href}">${label}</a></div></div>` }
function configurationResponse(res: ServerResponse, settings: Settings, simulatorUrl: string, message: string, tone: Tone, csrfToken: string): void {
	const body = layout({ title: 'Configuración', active: '/configuracion', body: addCsrfInputs(configurationPage(settings, simulatorUrl), csrfToken), flash: { tone, text: message }, company: settings.companyName || 'Cobrix' })
	sendHtml(res, 200, body)
}
function scalar(db: Store['db'], sql: string): number { return Number((db.prepare(sql).get() as { n: number }).n) }
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
	const contentType = req.headers['content-type'] ?? ''
	if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) throw new RequestInputError(415, 'El formulario debe enviarse como application/x-www-form-urlencoded.')
	const limit = 64 * 1024
	const declaredLength = Number(req.headers['content-length'] ?? 0)
	if (declaredLength > limit) throw new RequestInputError(413, 'El formulario supera el límite de 64 KiB.')
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		size += buffer.length
		if (size > limit) throw new RequestInputError(413, 'El formulario supera el límite de 64 KiB.')
		chunks.push(buffer)
	}
	return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}
function redirect(res: ServerResponse, location: string): void { res.writeHead(303, { location, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin' }); res.end() }
function sendHtml(res: ServerResponse, status: number, body: string): void { send(res,status,body,'text/html; charset=utf-8') }
function send(res: ServerResponse, status: number, body: string, type: string): void {
	res.writeHead(status, {
		'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store',
		'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin',
		'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
	})
	res.end(body)
}

const APP_CSS = `
.eyebrow { color:var(--primary); font-size:10.5px; font-weight:800; letter-spacing:.14em; margin:0 0 5px!important; }
.card p { margin:0; }
.card .body > p { color:var(--muted); }
.dashboard-heading { display:flex; align-items:flex-end; justify-content:space-between; gap:20px; }
.dashboard-heading h1 { font-size:30px; }
.dashboard-heading p:last-child { color:var(--muted); margin:7px 0 0; font-size:13.5px; }
.create-run { min-height:40px; display:flex; align-items:center; gap:8px; }
.create-run > span { font-size:18px; font-weight:400; line-height:1; }
.dashboard-metrics { grid-template-columns:repeat(4,minmax(0,1fr)); }
.metric-card { min-width:0; min-height:132px; padding:17px 18px; border:1px solid var(--line); border-radius:11px; background:var(--surface); display:grid; align-content:space-between; gap:12px; box-shadow:0 2px 8px #263d5a08; }
.metric-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; color:#4d5f76; font-size:12.5px; font-weight:650; }
.metric-card > strong { font-size:30px; letter-spacing:-.045em; line-height:1; font-variant-numeric:tabular-nums; }
.metric-card > small { color:#8794a5; font-size:11.5px; }
.metric-icon,.section-icon { width:34px; height:34px; border-radius:9px; display:grid; place-items:center; color:var(--primary); background:#f0f0ff; }
.metric-icon svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
.dashboard-overview { display:grid; grid-template-columns:minmax(0,1.45fr) minmax(320px,.85fr); gap:16px; align-items:stretch; }
.dashboard-overview > .card { min-width:0; }
.dashboard-aside { display:grid; grid-template-rows:auto 1fr; gap:16px; }
.invoice-chart-card > .body { gap:14px; }
.invoice-chart-card > .body,.invoice-chart-card { display:flex; flex-direction:column; }
.invoice-chart-card > .body { flex:1; }
.invoice-chart-card > header small,.activity-card > header small,.quick-card > header small,.provider-card > header small { display:block; margin-top:4px; color:#8995a5; font-size:11.5px; }
.chart-total { display:flex; align-items:baseline; gap:8px; }
.chart-total strong { font-size:24px; letter-spacing:-.04em; }
.chart-total span { color:#8995a5; font-size:12px; }
.invoice-chart { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:12px; flex:1; min-height:210px; padding:0 2px; align-items:stretch; }
.chart-column { min-width:0; display:grid; grid-template-rows:minmax(0,1fr) auto auto; justify-items:center; gap:8px; }
.chart-track { width:100%; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; gap:7px; padding-top:8px; background:repeating-linear-gradient(to top,transparent,transparent 41px,#eef0f5 41px,#eef0f5 42px); border-bottom:1px solid #dfe4ec; }
.chart-value { color:#66788e; font-size:12px; font-weight:650; font-variant-numeric:tabular-nums; }
.chart-bar { width:min(38px,70%); display:flex; flex-direction:column; justify-content:flex-end; overflow:hidden; border-radius:6px 6px 0 0; background:#eef; }
.chart-segment { width:100%; display:block; }
.chart-open { background:#6b6eda; }
.chart-paid { background:#c6c8f3; }
.chart-exempt { background:#d5dbd4; }
.chart-label { color:#66788e; font-size:12px; font-weight:600; }
.chart-counts { display:grid; gap:1px; justify-items:center; color:#93a0b0; font-size:10px; }
.chart-legend { display:flex; align-items:center; flex-wrap:wrap; gap:18px; color:#65758a; font-size:11.5px; }
.chart-legend > span { display:flex; align-items:center; gap:7px; }
.chart-legend i { width:9px; height:9px; border-radius:3px; }
.legend-open { background:#6b6eda; }
.legend-paid { background:#c6c8f3; }
.legend-exempt { background:#d5dbd4; }
.chart-legend .legend-note { margin-left:auto; color:#98a2b0; }
.chart-empty { flex:1; min-height:160px; display:grid; place-items:center; color:#8794a5; font-size:13px; }
.card-title { display:flex; align-items:center; gap:11px; }
.card-title h2 { margin:0; }
.section-icon { width:36px; height:36px; flex:0 0 auto; font-weight:750; font-size:17px; }
.provider-card .body { gap:13px; }
.provider-endpoint { display:flex; align-items:center; gap:10px; min-width:0; padding:12px; border:1px solid #edf0f5; border-radius:9px; background:#fafbfe; }
.provider-led { width:8px; height:8px; flex:0 0 auto; border-radius:50%; background:#3f9c6c; box-shadow:0 0 0 3px #3f9c6c26; }
.provider-endpoint small,.provider-endpoint strong { display:block; min-width:0; }
.provider-endpoint small { color:#8995a5; font-size:9.5px; font-weight:750; letter-spacing:.08em; }
.provider-endpoint strong { margin-top:4px; overflow:hidden; text-overflow:ellipsis; color:#34475f; font-size:12px; white-space:nowrap; }
.provider-footer { display:flex; align-items:center; gap:9px; color:#65788e; font-size:12px; }
.provider-footer > span:first-child { margin-right:auto; }
.provider-footer > a { color:var(--primary); font-size:12px; font-weight:700; white-space:nowrap; }
.text-link { color:var(--primary); font-size:12.5px; font-weight:700; }
.text-link span { margin-left:4px; }
.quick-card .body { gap:0; }
.quick-action { display:grid; grid-template-columns:36px minmax(0,1fr) 30px; align-items:center; gap:11px; padding:11px 0; }
.quick-action + .quick-action { border-top:1px solid #edf0f5; }
.quick-action strong,.quick-action small { display:block; }
.quick-action strong { font-size:13px; }
.quick-action small { color:#8794a5; font-size:11.5px; margin-top:3px; }
.quick-action-icon { width:34px; height:34px; display:grid; place-items:center; border-radius:9px; font-size:16px; font-weight:750; }
.quick-action-icon.import-icon { color:#5b5fc7; background:#f0f0ff; }
.quick-action-icon.payment-icon { color:#238457; background:#e8f5ee; }
.icon-action { width:29px; height:29px; border:1px solid #e7eaf1; border-radius:8px; background:#fff; color:#718096; font-size:15px; cursor:pointer; }
.icon-action:hover { color:var(--primary); border-color:#c9c9ee; background:#f7f7ff; }
.quick-foot { display:flex; justify-content:space-between; align-items:center; padding-top:13px; margin-top:4px; border-top:1px solid #edf0f5; color:#708096; font-size:11.5px; }
.activity-card td { padding-top:13px; padding-bottom:13px; }
.stats-strip { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:10px; }
.stat-card { border:1px solid var(--line); border-radius:10px; padding:11px 13px; background:#fbfcfe; border-left-width:3px; }
.stat-card strong { display:block; font-size:21px; letter-spacing:-.03em; font-variant-numeric:tabular-nums; }
.stat-card span { display:block; margin-top:2px; color:#65788e; font-size:11.5px; font-weight:600; }
.stat-card.ok { border-left-color:#3f9c6c; } .stat-card.warn { border-left-color:#d9a03c; }
.stat-card.bad { border-left-color:#c25b5b; } .stat-card.mute { border-left-color:#c3ccd8; }
.sync-grid { align-items:stretch; }
.sync-operation { display:flex; flex-direction:column; }
.sync-operation > header { padding:18px 20px; }
.sync-operation h2 { font-size:16px; }
.sync-operation .body { flex:1; align-content:start; }
.sync-operation .body > p { min-height:40px; font-size:13.5px; line-height:1.65; }
.sync-actions { display:flex; flex-wrap:wrap; gap:9px; margin-top:4px; }
.sync-actions .btn { min-width:158px; }
.import-operation { border-top:3px solid #5b5fc7; }
.payment-operation { border-top:3px solid #6585b3; }
.import-icon { color:#5b5fc7; background:#f0f0ff; }
.payment-icon { color:#14734c; background:#e3f3eb; }
.operation-note { display:flex; align-items:center; gap:9px; margin-top:auto; padding-top:15px; border-top:1px solid #edf0f5; color:#708096; font-size:11.5px; }
.operation-note > span { width:17px; height:17px; border-radius:50%; display:grid; place-items:center; color:#fff; background:#8193aa; font:700 10.5px var(--font); }
.config-form > .card { overflow:visible; }
.search input { min-width:200px; }
.search .btn { flex:0 0 auto; }
.invoice-filters { max-width:760px; flex-wrap:wrap; }
.invoice-filters input { flex:1 1 220px; }
.invoice-filters select { width:auto; min-width:150px; }
.timeline li { padding-left:14px; border-left:2px solid #dce6f4; }
.empty { min-height:190px; display:grid; align-content:center; justify-items:center; text-align:center; gap:9px; color:var(--muted); font-size:13px; }
.empty strong { font-size:16px; color:var(--fg); }
.empty span { max-width:58ch; }
.empty-icon { width:40px; height:40px; border-radius:50%; display:grid; place-items:center; color:var(--primary); background:var(--primary-soft); font-size:20px; }
.empty .btn { margin-top:4px; }
.connection-actions small { color:var(--muted); }
.provider-fields { grid-template-columns:repeat(2,minmax(0,1fr)); }
.provider-password { grid-column:1; width:100%; justify-self:stretch; }
.checkline { display:flex; align-items:center; gap:8px; font-weight:600; }
.config-form { display:grid; gap:16px; }
.sticky-actions { position:sticky; bottom:0; justify-self:stretch; display:flex; justify-content:flex-end; gap:10px; margin-inline:calc(-1*clamp(20px,4vw,56px)); padding:14px clamp(20px,4vw,56px) 22px; background:#f4f6faee; backdrop-filter:blur(4px); border-top:1px solid var(--line); z-index:3; }
.import-options { grid-template-columns:repeat(2,minmax(0,1fr)); }
.doc { margin:0; white-space:pre-wrap; font:13px/1.6 var(--mono); max-width:110ch; }
input[type=checkbox] { accent-color:var(--primary); width:auto; }
label.field input,label.field select { min-height:42px; padding:9px 12px; border-radius:8px; border-color:#d7e0eb; }
label.field input:focus,label.field select:focus { border-color:#999de0; box-shadow:0 0 0 3px #5b5fc71c; outline:0; }
@media(max-width:1100px) { .dashboard-overview { grid-template-columns:minmax(0,1fr); } .dashboard-aside { grid-template-columns:repeat(2,minmax(0,1fr)); grid-template-rows:auto; } }
@media(max-width:900px) { .dashboard-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media(max-width:650px) { th,td { padding:9px 10px; } .head .actions { width:100%; } .dashboard-heading { align-items:flex-start; flex-direction:column; } .dashboard-heading h1 { font-size:26px; } .dashboard-overview { grid-template-columns:minmax(0,1fr); } .dashboard-aside { grid-template-columns:minmax(0,1fr); } .metric-card { min-height:116px; padding:14px; } .metric-card > strong { font-size:25px; } .invoice-chart { grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px 8px; } .chart-counts { display:none; } .activity-card > header,.invoice-chart-card > header { align-items:flex-start; } .chart-legend .legend-note { width:100%; margin-left:0; } .sticky-actions { margin-inline:-14px; padding:12px 14px 18px; } }
@media(max-width:650px) { .import-options { grid-template-columns:minmax(0,1fr); } .provider-fields { grid-template-columns:minmax(0,1fr); } .provider-password { grid-column:auto; width:100%; } .sync-actions form,.sync-actions .btn { width:100%; } }
@media(prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; transition:none!important; } }

/* Quiet, minimal visual language */
:root {
	--brand-darkest:#042F30; --brand-dark:#063B3B; --brand:#0B6B65; --brand-hover:#0F5552;
	--brand-active:#087F8C; --brand-accent:#2DD4BF; --brand-on-dark:#B8D3D0; --brand-border:#245653;
	--bg:#f8f9fa; --surface:#fff; --sunken:#f1f3f5; --fg:#1a1a2e; --muted:#667085; --line:#e4e7ec;
	--primary:var(--brand); --primary-soft:#e8f3f2; --primary-fg:#fff;
	--ok:#18794e; --ok-bg:#eaf5ee; --warn:#986b12; --warn-bg:#fff5dc; --bad:#a13d3d; --bad-bg:#fbeaea;
	--info:#2563eb; --info-bg:#eaf1ff; --mute:#667085; --mute-bg:#f1f3f5;
	/* shadcn/ui-compatible semantic tokens for Tailwind utilities and shared controls */
	--background:var(--bg); --foreground:var(--fg); --card:var(--surface); --card-foreground:var(--fg);
	--border:var(--line); --input:var(--line); --primary-foreground:var(--primary-fg);
	--secondary:var(--sunken); --secondary-foreground:var(--fg); --muted-foreground:var(--muted);
	--accent:var(--primary-soft); --accent-foreground:var(--primary); --destructive:var(--bad); --ring:#5faaa4; --radius:.625rem;
}
body { background:var(--bg); color:var(--fg); }
.shell { grid-template-columns:232px minmax(0,1fr); }
.side { gap:24px; padding:22px 14px 16px; border-color:var(--brand-border); background:var(--brand-darkest); color:#fff; overflow-y:auto; }
.brand { color:#fff; }
.brand-mark { width:30px; height:30px; border-radius:7px; background:var(--brand); box-shadow:none; }
.brand-copy strong { color:#fff; }
.brand-copy small { color:var(--brand-on-dark); }
.workspace-card,.environment-card { background:transparent; border-color:var(--line); border-radius:7px; }
.workspace-avatar { background:var(--primary-soft); color:var(--primary); border-radius:6px; }
.sidebar-action { min-height:39px; border-radius:6px; background:var(--primary); box-shadow:none; }
.sidebar-action:hover { background:var(--brand-hover); }
.primary-nav { gap:18px; }
.nav-group { gap:2px; }
.nav-group-label { color:var(--brand-on-dark); font-size:9px; }
.primary-nav a { min-height:36px; border-radius:6px; color:#e0ecea; font-weight:500; }
.primary-nav a:hover { color:#fff; background:var(--brand-hover); }
.primary-nav a[aria-current="page"] { color:#fff; background:var(--brand-active); }
.primary-nav a[aria-current="page"]::before { display:block; left:-14px; top:7px; bottom:7px; width:3px; background:var(--brand-accent); }
.nav-icon svg { stroke-width:1.7; }
.sidebar-footer { border-color:var(--brand-border); }
.environment-icon,.environment-badge { background:var(--sunken); color:var(--muted); }
.mobile-nav-toggle { display:none; }
.mobile-nav-toggle:focus-visible { outline:2px solid var(--brand-accent); outline-offset:2px; }
.topbar { background:var(--surface); border-color:var(--line); }
.breadcrumbs > span:first-child { color:#8b95a5; }
.breadcrumbs strong { color:var(--fg); }
.global-search { border-color:var(--line); border-radius:6px; background:var(--bg); }
.global-search:focus-within { border-color:#72aaa5; box-shadow:0 0 0 2px #0b6b6514; }
.content { gap:20px; padding-top:30px; }
h1 { color:var(--fg); font-weight:620; letter-spacing:-.04em; }
h2 { color:var(--fg); font-size:14px; font-weight:620; }
.head .eyebrow,.eyebrow { color:var(--primary); font-size:9.5px; letter-spacing:.12em; }
.card { border-color:var(--line); border-radius:7px; box-shadow:none; }
.card > header { border-color:var(--line); padding:15px 18px; }
.card > .body { padding:17px 18px; }
.dashboard-heading h1 { font-size:27px; }
.metric-card { min-height:106px; padding:14px 15px; border-color:var(--line); border-radius:7px; box-shadow:none; gap:8px; }
.metric-heading { color:#596579; font-size:12px; font-weight:500; }
.metric-card > strong { color:var(--fg); font-size:26px; font-weight:600; }
.metric-card > small { color:#818b9b; }
.metric-icon,.section-icon { border-radius:5px; color:var(--primary); background:transparent; }
.metric-icon { width:24px; height:24px; }
.metric-icon svg { width:17px; height:17px; }
.section-icon { width:30px; height:30px; }
.invoice-chart-card > header small,.activity-card > header small,.quick-card > header small,.provider-card > header small { color:#818b9b; }
.chart-track { background:repeating-linear-gradient(to top,transparent,transparent 41px,#f0f3f7 41px,#f0f3f7 42px); border-color:var(--line); }
.chart-open { background:var(--brand); }
.chart-paid { background:#b7d5d1; }
.chart-exempt { background:#d4d9d0; }
.legend-open { background:var(--brand); }
.legend-paid { background:#b7d5d1; }
.legend-exempt { background:#d4d9d0; }
.provider-endpoint { border:0; border-radius:0; background:transparent; padding:4px 0; }
.provider-led { box-shadow:none; }
.quick-action + .quick-action,.quick-foot { border-color:var(--line); }
.quick-action-icon { width:26px; height:26px; border-radius:0; background:transparent; }
.quick-action-icon.import-icon { color:var(--primary); background:transparent; }
.quick-action-icon.payment-icon { color:var(--ok); background:var(--ok-bg); }
.quick-action-icon.payment-icon { background:transparent; }
.icon-action { border-color:transparent; border-radius:5px; }
.text-link,.provider-footer > a { color:var(--primary); }
.tile { border-color:var(--line); border-radius:7px; box-shadow:none; }
.tile::before { display:none; }
th,td { border-color:var(--line); }
th { color:#707c8e; background:#f8fafc; font-size:10px; }
tbody tr:hover { background:#fafcff; }
.pill { padding:3px 8px; border-radius:5px; font-size:10.5px; font-weight:650; }
.btn { border-color:#dce3ec; border-radius:5px; font-weight:550; transition:background .12s ease,border-color .12s ease; }
.btn:hover { background:#f5f8fc; box-shadow:none; transform:none; }
.btn.primary { border-color:var(--primary); background:var(--primary); }
.btn.primary:hover { border-color:var(--brand-hover); background:var(--brand-hover); }
.flash { border-radius:7px; }
label.field input,label.field select,input[type=text],input[type=password],input[type=number],input[type=search],input[type=url],select { border-color:#dce3ec; border-radius:5px; }
label.field input:focus,label.field select:focus { border-color:#72aaa5; box-shadow:0 0 0 2px #0b6b6514; }
.import-operation,.payment-operation { border-top:1px solid var(--line); }
.operation-note { border-color:var(--line); }
.operation-note > span { color:var(--primary); background:var(--primary-soft); }
.stat-card { border-color:var(--line); border-radius:6px; background:var(--surface); }
.stat-card.ok { border-left-color:#719078; } .stat-card.warn { border-left-color:#c4a66b; }
.stat-card.bad { border-left-color:#c28279; } .stat-card.mute { border-left-color:#cfd2ca; }
.empty-icon { display:none; }
.sticky-actions { background:#f8f9faed; border-color:var(--line); }
.metric-link { color:inherit; text-decoration:none; }
.metric-link:hover { border-color:#b7d5d1; background:#fcfefe; }
.metric-link:focus-visible { outline:2px solid var(--brand); outline-offset:2px; }
.followup-list { padding:0 18px; }
.followup-row { display:grid; grid-template-columns:minmax(180px,1.5fr) minmax(150px,1fr) minmax(145px,.8fr) auto; align-items:center; gap:18px; padding:14px 0; border-bottom:1px solid var(--line); }
.followup-row:last-child { border-bottom:0; }
.followup-customer strong { color:var(--fg); font-weight:600; }
.followup-customer small,.followup-due small,.followup-balance small { display:block; margin-top:3px; color:var(--muted); font-size:11px; }
.followup-balance { text-align:right; }
.followup-balance strong { font-variant-numeric:tabular-nums; }
.followup-action { white-space:nowrap; }
.followup-empty { display:flex; align-items:center; gap:12px; padding:24px 18px; }
.followup-empty > span:last-child > * { display:block; }
.followup-empty small { margin-top:3px; color:var(--muted); }
.followup-check { display:grid; width:28px; height:28px; place-items:center; border-radius:50%; background:var(--ok-bg); color:var(--ok); }
.due-state { display:block; width:max-content; max-width:100%; margin-top:3px; font-size:11px; font-weight:600; }
.due-state.warn { color:var(--warn); }
.due-state.bad { color:var(--bad); }
.due-state.ok { color:var(--ok); }
.due-state.mute { color:var(--muted); }
.invoice-customer-id { display:block; margin-top:3px; color:var(--muted); font-size:11px; }
.balance-cell { color:var(--fg); font-weight:600; }
.filter-summary { align-self:center; margin-left:auto; color:var(--muted); font-size:12px; white-space:nowrap; }
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
@media(max-width:860px) {
	.shell { grid-template-columns:minmax(0,1fr); }
	.side { position:sticky; z-index:10; top:0; height:auto; display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px 12px; padding:10px 20px; border-right:0; border-bottom:1px solid var(--brand-border); overflow:visible; }
	.mobile-nav-toggle { display:inline-flex; align-items:center; gap:8px; min-height:38px; padding:0 11px; border:1px solid var(--brand-border); border-radius:6px; color:#fff; background:transparent; font:600 12px var(--font); cursor:pointer; }
	.mobile-nav-toggle svg { width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; }
	.mobile-nav-toggle:hover,.mobile-nav-toggle[aria-expanded="true"] { background:var(--brand-hover); }
	.primary-nav { display:none; grid-column:1/-1; gap:14px; padding:14px 0 6px; border-top:1px solid var(--brand-border); }
	.primary-nav.is-open { display:grid; }
	.nav-group { display:grid; gap:2px; }
	.nav-group-label { display:block; padding:0 11px 4px; }
	.primary-nav a { min-height:40px; padding:9px 11px; }
	.primary-nav a .nav-icon { display:grid; }
	.primary-nav a[aria-current="page"]::before { left:0; top:8px; bottom:8px; width:3px; }
	.topbar { padding:0 20px; }
	.content { padding-top:24px; }
	.followup-row { grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:12px; }
	.followup-action { justify-self:start; }
}
@media(max-width:650px) {
	.side { padding-left:14px; padding-right:14px; }
	.brand-copy small { font-size:8px; }
	.topbar { padding:0 14px; }
	.content { padding:20px 14px 42px; }
	.topbar-tools { flex:1; justify-content:flex-end; }
	.timezone-label { display:none; }
	.global-search { width:min(48vw,210px); }
	.invoice-table,.invoice-table tbody,.customer-table,.customer-table tbody { display:block; width:100%; }
	.invoice-table thead,.customer-table thead { display:none; }
	.invoice-table tbody,.customer-table tbody { display:grid; gap:10px; padding:0 12px 12px; }
	.invoice-table tbody tr,.customer-table tbody tr { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:0 12px; padding:6px 12px; border:1px solid var(--line); border-radius:8px; background:var(--surface); }
	.invoice-table tbody td,.customer-table tbody td { display:grid; align-content:start; gap:3px; padding:10px 0; border-bottom:1px solid var(--line); text-align:left; white-space:normal; }
	.invoice-table tbody td::before,.customer-table tbody td::before { content:attr(data-label); color:var(--muted); font-size:10px; font-weight:500; }
	.invoice-table tbody td[data-label="Cliente"],.invoice-table tbody td[data-label="Saldo pendiente"],.invoice-table tbody td[data-label="Próximo paso"],.customer-table tbody td[data-label="Cliente"],.customer-table tbody td[data-label="Deuda"],.customer-table tbody td[data-label="Próximo paso"] { grid-column:1/-1; }
	.invoice-table tbody td[data-label="Cliente"],.customer-table tbody td[data-label="Cliente"] { padding-top:8px; }
	.invoice-table tbody td[data-label="Saldo pendiente"],.customer-table tbody td[data-label="Deuda"] { font-size:15px; }
	.invoice-table tbody td[data-label="Saldo pendiente"]::before,.customer-table tbody td[data-label="Deuda"]::before { font-size:10px; }
	.invoice-table tbody td[data-label="Próximo paso"],.customer-table tbody td[data-label="Próximo paso"] { padding-bottom:7px; border-bottom:0; }
	.invoice-table tbody td[data-label="Próximo paso"]::before,.customer-table tbody td[data-label="Próximo paso"]::before { display:none; }
	.filter-summary { flex-basis:100%; margin-left:0; }
	.followup-list { padding:0 14px; }
	.followup-row { gap:10px; padding:13px 0; }
	.followup-balance { text-align:left; }
}
`

const APP_JS = `document.querySelector('.mobile-nav-toggle')?.addEventListener('click', event => {
	const button = event.currentTarget;
	const nav = document.getElementById(button.getAttribute('aria-controls'));
	const expanded = button.getAttribute('aria-expanded') !== 'true';
	button.setAttribute('aria-expanded', String(expanded));
	nav?.classList.toggle('is-open', expanded);
});
document.addEventListener('submit', event => {
	const form = event.target.closest('form[data-confirm]');
	if (form && !window.confirm(form.getAttribute('data-confirm') || '¿Confirmas esta acción?')) event.preventDefault();
}, true);`
