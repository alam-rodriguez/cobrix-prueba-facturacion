import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { CSS, CONTRACT_STATUS_TONE, date, dateTime, esc, html, layout, pill, usd, type Raw, type Tone } from './layout.ts'
import { createStore, type Settings, type Store } from '../cobrix/store.ts'
import { Synchronizer } from '../cobrix/sync.ts'

type Row = Record<string, unknown>
export interface AppDeps { readonly simulatorUrl: string; readonly assignmentPath: string; readonly store?: Store }

const statusLabels: Record<string, string> = { open: 'Abierta', paid: 'Pagada' }
const resultLabels: Record<string, string> = {
	importada: 'Importada', se_importaria: 'Se importaría', ya_importada: 'Ya importada', excluida: 'Excluida',
	fuera_ventana: 'Fuera de ventana', fuera_limite_recientes: 'Fuera de límite reciente', saldo_residual: 'Saldo residual',
	sin_deuda: 'Sin deuda', frenada_por_tope: 'Frenada por tope', marcada_pagada: 'Marcada pagada', se_marcaria_pagada: 'Se marcaría pagada',
	abono_parcial: 'Abono parcial', sin_evidencia: 'Sin evidencia',
}
const summaryLabels: Record<string, string> = {
	imported: 'Importadas', alreadyImported: 'Ya importadas', excluded: 'Excluidas', throttled: 'Frenadas por tope',
	markedPaid: 'Marcadas pagadas', partial: 'Abonos parciales', noEvidence: 'Sin evidencia', errors: 'Errores',
}

export function createApp(deps: AppDeps): Server {
	const store = deps.store ?? createFallbackStore()
	const sync = new Synchronizer(store)
	const db = store.db

	async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://panel.local')
		const path = url.pathname.replace(/\/+$/, '') || '/'
		const flashText = url.searchParams.get('msg')
		const requestedTone = url.searchParams.get('tone') || 'info'
		const tone = (['ok', 'warn', 'bad', 'info', 'mute'].includes(requestedTone) ? requestedTone : 'info') as Tone
		const flash = flashText ? { tone, text: flashText } : undefined
		const settings = store.getSettings()
		const page = (title: string, active: string, body: Raw, company = settings.companyName || 'Cobrix'): void => sendHtml(res, 200, layout({ title, active, body, flash, company }))
		if (req.method === 'GET') {
			if (path === '/app.css') return send(res, 200, CSS + APP_CSS, 'text/css; charset=utf-8')
			if (path === '/enunciado') return page('Enunciado', '', assignmentPage(deps.assignmentPath))
			if (path === '/') return page('Resumen', '/', dashboard(db, settings))
			if (path === '/clientes') return page('Clientes', '/clientes', customersPage(db, url.searchParams.get('q') ?? ''))
			if (/^\/clientes\/[^/]+$/.test(path)) return page('Expediente', '/clientes', customerPage(db, decodeURIComponent(path.split('/').at(-1)!)))
			if (path === '/sincronizacion') return page('Sincronización', '/sincronizacion', runsPage(db, url.searchParams.get('run')))
			if (path === '/configuracion') return page('Configuración', '/configuracion', configurationPage(settings, deps.simulatorUrl))
		}
		if (req.method === 'POST') {
			const form = await readForm(req)
			if (path === '/acciones/importar' || path === '/acciones/pagos') {
				const isImport = path.endsWith('importar')
				const simulated = form.get('simulado') === '1'
				const id = isImport ? await sync.runImport(simulated) : await sync.runPayments(simulated)
				const run = db.prepare('SELECT status,error FROM run WHERE id=?').get(id) as { status: string; error: string | null }
				if (run.status === 'failed') return redirect(res, `/sincronizacion?run=${id}&tone=bad&msg=${encodeURIComponent(run.error ?? 'La corrida falló.')}`)
				return redirect(res, `/sincronizacion?run=${id}&tone=ok&msg=${encodeURIComponent(simulated ? 'Simulación completada sin modificar datos.' : 'Corrida completada.')}`)
			}
			if (path === '/acciones/probar') {
				let submitted: Settings
				try { submitted = parseSettings(form, settings) }
				catch (error) { return configurationResponse(res, settings, deps.simulatorUrl, error instanceof Error ? error.message : String(error), 'bad') }
				try {
					const result = await sync.testConnection(submitted)
					return configurationResponse(res, submitted, deps.simulatorUrl, `Conexión correcta · ${result.contracts} contratos encontrados.`, 'ok')
				} catch (error) {
					return configurationResponse(res, submitted, deps.simulatorUrl, error instanceof Error ? error.message : String(error), 'bad')
				}
			}
			if (path === '/acciones/configuracion') {
				try { store.saveSettings(parseSettings(form, settings)); return redirect(res, `/configuracion?tone=ok&msg=${encodeURIComponent('Configuración guardada.')}`) }
				catch (error) { return redirect(res, `/configuracion?tone=bad&msg=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`) }
			}
		}
		sendHtml(res, 404, layout({ title: 'No encontrado', active: '', company: settings.companyName, body: html`<div class="head"><h1>Página no encontrada</h1><a class="btn" href="/">Volver al resumen</a></div>` }))
	}
	return createServer((req, res) => {
		route(req, res).catch(error => {
			console.error('[panel]', error)
			if (!res.headersSent) sendHtml(res, 500, layout({ title: 'Error', active: '', company: '', body: html`<h1>No se pudo cargar la pantalla</h1><p class="muted">${error instanceof Error ? error.message : String(error)}</p><a href="/">Volver al resumen</a>` }))
		})
	})
}

function createFallbackStore(): Store {
	return createStore(':memory:')
}

function assignmentPage(path: string): Raw {
	let text = ''
	try { text = readFileSync(path, 'utf8') } catch { text = 'No se encontró docs/ENUNCIADO.md.' }
	return html`<div class="head"><div><h1>Enunciado</h1><p>Documento de referencia del caso.</p></div></div><section class="card"><div class="body"><pre class="doc">${text}</pre></div></section>`
}

function dashboard(db: Store['db'], settings: Settings): Raw {
	const customerCount = scalar(db, 'SELECT COUNT(*) n FROM customer')
	const contractCount = scalar(db, 'SELECT COUNT(*) n FROM contract')
	const openCount = scalar(db, "SELECT COUNT(*) n FROM invoice WHERE status='open'")
	const paidCount = scalar(db, "SELECT COUNT(*) n FROM invoice WHERE status='paid'")
	const debt = scalar(db, "SELECT COALESCE(SUM(balance_minor),0) n FROM invoice WHERE status='open'")
	const latest = db.prepare('SELECT * FROM run ORDER BY id DESC LIMIT 5').all() as unknown as Row[]
	return html`<div class="head"><div><p class="eyebrow">OPERACIÓN · FACTURACIÓN</p><h1>Resumen</h1><p>Estado de clientes, cartera y sincronización con ${settings.apiUrl}.</p></div><div class="actions"><a class="btn" href="/clientes">Ver clientes</a><a class="btn primary" href="/sincronizacion">Ir a sincronización →</a></div></div>
		<div class="tiles">${tile('Clientes', customerCount, 'Importados desde el ISP')}${tile('Contratos', contractCount, 'Vinculados a clientes')}${tile('Facturas abiertas', openCount, 'Pendientes de cobro')}${tile('Facturas pagadas', paidCount, 'Confirmadas por el ISP')}${tile('Deuda por cobrar', usd(debt), 'Saldo abierto en USD')}</div>
		<div class="grid2"><section class="card"><header><h2>Proveedor conectado</h2>${pill('API ISP', 'ok')}</header><div class="body"><dl class="facts"><dt>URL</dt><dd class="mono">${settings.apiUrl}</dd><dt>Usuario</dt><dd>${settings.apiUser}</dd><dt>Corrida automática</dt><dd>${settings.autoRunEnabled ? `Activa · diaria a las ${settings.autoRunTime} (Caracas)` : 'Desactivada'}</dd></dl><div class="actions"><a class="btn small" href="/configuracion">Configurar</a><a class="btn small" href="${settings.apiUrl}/docs" target="_blank" rel="noopener">Documentación API ↗</a></div></div></section>
		<section class="card"><header><h2>Acciones rápidas</h2></header><div class="body"><p class="muted">Importa cuotas pendientes y aplica pagos que el ISP haya confirmado.</p><div class="actions"><form method="post" action="/acciones/importar"><button class="btn primary">Importar ahora</button></form><form method="post" action="/acciones/pagos"><button class="btn">Actualizar pagadas</button></form></div><a href="/sincronizacion">Simular primero o revisar el historial →</a></div></section></div>
		<section class="card"><header><h2>Corridas recientes</h2><a href="/sincronizacion">Ver historial completo →</a></header>${runTable(latest)}</section>`
}

function tile(label: string, value: string | number, helper: string): Raw { return html`<article class="tile"><span>${label}</span><strong>${value}</strong><small>${helper}</small></article>` }

function customersPage(db: Store['db'], query: string): Raw {
	const q = `%${query.trim().toLocaleLowerCase('es')}%`
	const rows = db.prepare(`WITH contracts AS (SELECT customer_id,COUNT(*) contracts FROM contract GROUP BY customer_id),
		invoices AS (SELECT customer_id,SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open_count,
		SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) paid_count,
		SUM(CASE WHEN status='open' THEN balance_minor ELSE 0 END) debt,
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
	return html`<div class="table-wrap"><table><thead><tr><th>Cliente</th><th>N.º de documento<br><small>(cédula o RIF del titular)</small></th><th>Tipo</th><th class="num">Contratos</th><th class="num">Abiertas</th><th class="num">Pagadas</th><th class="num">Deuda</th><th>Vencimiento más antiguo</th><th></th></tr></thead><tbody>${rows.map(row => html`<tr><td><a href="/clientes/${row.id}"><strong>${row.name}</strong></a></td><td class="mono">${row.id}</td><td>${row.document_type === 'J' || row.document_type === 'G' ? 'Jurídico' : 'Natural'}</td><td class="num">${row.contracts}</td><td class="num">${Number(row.open_count ?? 0)}</td><td class="num">${Number(row.paid_count ?? 0)}</td><td class="num">${usd(row.debt)}</td><td>${date(row.oldest)}</td><td><a class="btn small" href="/clientes/${row.id}">Expediente →</a></td></tr>`)}</tbody></table></div>`
}

function customerPage(db: Store['db'], id: string): Raw {
	const customer = db.prepare('SELECT * FROM customer WHERE id=?').get(id) as Row | undefined
	if (!customer) return html`<div class="head"><div><h1>Cliente no encontrado</h1><p>Ese titular no está en la base de Cobrix.</p></div><a class="btn" href="/clientes">Volver a clientes</a></div>`
	const contracts = db.prepare('SELECT * FROM contract WHERE customer_id=? ORDER BY id').all(id) as unknown as Row[]
	const invoices = db.prepare('SELECT * FROM invoice WHERE customer_id=? ORDER BY period DESC, id DESC').all(id) as unknown as Row[]
	const events = db.prepare('SELECT e.*,i.external_id FROM event e LEFT JOIN invoice i ON i.id=e.invoice_id WHERE e.customer_id=? ORDER BY e.id DESC').all(id) as unknown as Row[]
	const open = invoices.filter(row => row.status === 'open')
	const paid = invoices.filter(row => row.status === 'paid')
	const balance = open.reduce((sum, row) => sum + Number(row.balance_minor), 0)
	return html`<div class="head"><div><a href="/clientes">← Clientes</a><p class="eyebrow">EXPEDIENTE DE CLIENTE</p><h1>${customer.name}</h1><p>${customer.id} · ${customer.document_type === 'J' || customer.document_type === 'G' ? 'Persona jurídica' : 'Persona natural'} · ${customer.origin}</p></div>${pill(open.length ? `${open.length} abiertas` : 'Al día', open.length ? 'warn' : 'ok')}</div>
		<div class="tiles">${tile('Contratos', contracts.length, 'Registrados en el administrador')}${tile('Facturas abiertas', open.length, 'Cuotas pendientes')}${tile('Facturas pagadas', paid.length, 'Pagos confirmados')}${tile('Saldo pendiente', usd(balance), 'Total a cobrar')}</div>
		<div class="grid2"><section class="card"><header><h2>Datos del titular</h2></header><div class="body"><dl class="facts"><dt>Documento</dt><dd class="mono">${customer.id}</dd><dt>Correo</dt><dd>${customer.email || '—'}</dd><dt>Teléfono</dt><dd>${customer.phone || '—'}</dd><dt>Origen</dt><dd>${customer.origin}</dd><dt>Alta en Cobrix</dt><dd>${dateTime(customer.created_at)}</dd></dl></div></section>
		<section class="card"><header><h2>Contratos del administrador</h2><span>${contracts.length}</span></header>${contracts.length ? html`<div class="table-wrap"><table><thead><tr><th>Contrato</th><th>Estado</th><th>Plan</th><th class="num">Precio</th><th>Sucursal</th></tr></thead><tbody>${contracts.map(contract => html`<tr><td class="mono">${contract.id}</td><td>${pill(String(contract.status), CONTRACT_STATUS_TONE[String(contract.status)] ?? 'mute')}</td><td>${contract.plan}</td><td class="num">${usd(contract.price_minor)}</td><td>${contract.branch || '—'}</td></tr>`)}</tbody></table></div>` : html`<div class="body muted">Todavía no hay contratos asociados.</div>`}</section></div>
		<section class="card"><header><h2>Facturas</h2><span>${invoices.length} cuotas</span></header>${invoices.length ? html`<div class="table-wrap"><table><thead><tr><th>Número Cobrix</th><th>Cuota ISP</th><th>Contrato</th><th>Periodo</th><th>Vencimiento</th><th>Corte</th><th class="num">Total</th><th class="num">Saldo</th><th>Estado</th><th>Pagada</th></tr></thead><tbody>${invoices.map(invoice => html`<tr><td class="mono">CB-${String(invoice.id).padStart(6,'0')}</td><td class="mono">${invoice.external_id}</td><td class="mono">${invoice.contract_id}</td><td>${invoice.period}</td><td>${date(invoice.due_date)}</td><td>${date(invoice.cutoff_date)}</td><td class="num">${usd(invoice.amount_minor)}</td><td class="num">${usd(invoice.balance_minor)}</td><td>${pill(statusLabels[String(invoice.status)] ?? String(invoice.status), invoice.status === 'paid' ? 'ok' : 'warn')}</td><td>${date(invoice.paid_at)}</td></tr>`)}</tbody></table></div>` : html`<div class="body muted">No hay facturas en el expediente.</div>`}</section>
		<section class="card"><header><h2>Actividad</h2><span>${events.length} eventos</span></header>${events.length ? html`<div class="body"><ol class="timeline">${events.map(event => html`<li><time>${dateTime(event.created_at)}</time><span><strong>${event.type === 'customer_created' ? 'Cliente creado' : event.type === 'invoice_imported' ? 'Factura importada' : 'Factura pagada'}</strong> · ${event.description}${event.type === 'invoice_paid' && event.external_id ? html` <span class="muted">(cuota ${event.external_id})</span>` : ''}</span></li>`)}</ol></div>` : html`<div class="body muted">Sin actividad registrada.</div>`}</section>`
}

function runsPage(db: Store['db'], runParam: string | null): Raw {
	const runs = db.prepare('SELECT * FROM run ORDER BY id DESC LIMIT 50').all() as unknown as Row[]
	const selected = runParam ? db.prepare('SELECT * FROM run WHERE id=?').get(Number(runParam)) as Row | undefined : undefined
	const detail = selected ? db.prepare(`SELECT ri.*,c.id AS linked_customer_id FROM run_item ri LEFT JOIN customer c ON c.id=ri.customer_id WHERE ri.run_id=? ORDER BY ri.id`).all(Number(selected.id)) as unknown as Row[] : []
	return html`<div class="head"><div><p class="eyebrow">OPERACIÓN</p><h1>Sincronización</h1><p>Importa cuotas nuevas y confirma los pagos del libro del ISP. Cada intento queda en el historial.</p></div><a class="btn" href="/configuracion">Ajustar reglas</a></div>
		<div class="grid2"><section class="card"><header><h2>Importar clientes y facturas</h2>${pill('No duplica cuotas', 'info')}</header><div class="body"><p>Recorre los contratos y aplica estados, ventana, cuotas recientes y topes configurados.</p><div class="actions"><form method="post" action="/acciones/importar"><button class="btn primary">Importar ahora</button></form><form method="post" action="/acciones/importar"><input type="hidden" name="simulado" value="1"><button class="btn">Simular importación</button></form></div></div></section>
		<section class="card"><header><h2>Actualizar facturas pagadas</h2>${pill('Solo pago confirmado', 'ok')}</header><div class="body"><p>Contrasta cada factura abierta con el libro de cuotas. Abonos y falta de evidencia no cierran facturas.</p><div class="actions"><form method="post" action="/acciones/pagos"><button class="btn primary">Actualizar pagadas</button></form><form method="post" action="/acciones/pagos"><input type="hidden" name="simulado" value="1"><button class="btn">Simular actualización</button></form></div></div></section></div>
		${selected ? html`<div class="actions"><a class="btn" href="/sincronizacion">← Volver atrás</a></div>${runDetail(selected, detail)}` : html`<section class="card"><header><h2>Historial de corridas</h2><span>${runs.length} recientes</span></header>${runTable(runs)}</section>`}`
}

function runTable(rows: Row[]): Raw {
	if (!rows.length) return html`<div class="body"><div class="empty"><strong>Aún no hay corridas</strong><span>Simula una importación para revisar qué cuotas cumplen las reglas antes de escribir datos.</span></div></div>`
	return html`<div class="table-wrap"><table><thead><tr><th>Corrida</th><th>Tipo</th><th>Fecha</th><th>Modo</th><th>Estado</th><th>Resultado</th><th></th></tr></thead><tbody>${rows.map(run => { const summary = JSON.parse(String(run.summary || '{}')) as Row; return html`<tr><td class="mono">#${run.id}</td><td>${run.kind === 'import' ? 'Importación' : 'Actualizar pagadas'}</td><td>${dateTime(run.started_at)}</td><td>${run.simulated ? pill('Simulación','info') : 'Real'}</td><td>${pill(run.status === 'completed' ? 'Completada' : 'Falló', run.status === 'completed' ? 'ok' : 'bad')}</td><td>${run.error ? String(run.error) : run.kind === 'import' ? `${summary.imported ?? 0} nuevas · ${summary.excluded ?? 0} excluidas` : `${summary.markedPaid ?? 0} pagadas · ${summary.partial ?? 0} abonos`}</td><td><a class="btn small" href="/sincronizacion?run=${run.id}">Detalle →</a></td></tr>`})}</tbody></table></div>`
}

function runDetail(run: Row, items: Row[]): Raw {
	const summary = JSON.parse(String(run.summary || '{}')) as Row
	const entries = Object.entries(summary).filter(([key]) => key !== 'total')
	const summaryTiles = entries.map(([key, value]) => tile(summaryLabels[key] ?? key, Number(value), 'registros'))
	const itemRows = items.map(item => {
		const result = String(item.result)
		const customer = item.customer_id ? String(item.customer_id) : ''
		return html`<tr><td class="mono">${item.contract_id ?? '—'}</td><td>${item.linked_customer_id && customer ? html`<a href="/clientes/${customer}">${customer}</a>` : customer || '—'}</td><td class="mono">${item.debt_id ?? '—'}</td><td>${item.period ?? '—'}</td><td class="num">${usd(item.amount_minor)}</td><td>${pill(resultLabels[result] ?? result, result === 'importada' || result === 'marcada_pagada' ? 'ok' : result.includes('exclu') || result.includes('tope') ? 'warn' : 'info')}</td><td>${item.reason}</td></tr>`
	})
	const itemTable = items.length
		? html`<div class="table-wrap"><table><thead><tr><th>Contrato</th><th>N.º de documento<br><small>(cédula o RIF del titular)</small></th><th>Cuota ISP</th><th>Periodo</th><th class="num">Monto</th><th>Resultado</th><th>Motivo</th></tr></thead><tbody>${itemRows}</tbody></table></div>`
		: html`<div class="body muted">No hay filas de detalle.${run.status === 'failed' ? ' Revisa el error anterior y vuelve a intentar.' : ''}</div>`
	return html`<section class="card"><header><div><h2>Detalle de corrida #${run.id}</h2><p class="muted">${run.kind === 'import' ? 'Importación' : 'Actualización de pagos'} · ${run.simulated ? 'simulación' : 'escritura'} · ${dateTime(run.started_at)}</p></div>${pill(run.status === 'completed' ? 'Completada' : 'Falló', run.status === 'completed' ? 'ok' : 'bad')}</header><div class="body"><div class="tiles compact">${summaryTiles}</div>${run.error ? html`<div class="flash bad">${run.error}</div>` : ''}</div>${itemTable}</section>`
}

function configurationPage(settings: Settings, simulatorUrl: string): Raw {
	const statuses = ['ACTIVO','CORTADO','CORTESIA','RETIRADO','RECHAZADO','ANULADO']
	const docTypes = ['V','E','J','G','P']
	const checked = (values: string[], value: string): string => values.includes(value) ? ' checked' : ''
	return html`<div class="head"><div><p class="eyebrow">ADMINISTRACIÓN</p><h1>Configuración</h1><p>Reglas de importación y credenciales del administrador de facturas.</p></div></div>
		<form method="post" action="/acciones/configuracion" class="config-form"><section class="card"><header><h2>Empresa</h2></header><div class="body grid2"><label class="field">Nombre de la empresa<input type="text" name="companyName" required value="${settings.companyName}"></label><label class="field">RIF<input type="text" name="companyTaxId" value="${settings.companyTaxId}"></label><label class="field">Correo de cobranza<input type="text" name="collectionsEmail" value="${settings.collectionsEmail}"></label></div></section>
		<section class="card"><header><h2>Administrador del ISP</h2><a href="${simulatorUrl}/docs" target="_blank" rel="noopener">Abrir Swagger ↗</a></header><div class="body"><div class="grid2 provider-fields"><label class="field">URL de la API<input type="url" name="apiUrl" required value="${settings.apiUrl}"></label><label class="field">Usuario<input type="text" name="apiUser" required value="${settings.apiUser}"></label><label class="field provider-password">Contraseña<input type="password" name="apiPassword" autocomplete="new-password" placeholder="Sin cambios si se deja vacío"><small>Guardada de forma local en la base de Cobrix.</small></label></div><div class="actions connection-actions"><button class="btn" formaction="/acciones/probar">Probar conexión</button><small>Inicia sesión y consulta el número de contratos.</small></div></div></section>
		<section class="card"><header><h2>Reglas de importación</h2></header><div class="body"><fieldset><legend>Estados de contrato</legend>${statuses.map(status => html`<label><input type="checkbox" name="importStatuses" value="${status}"${checked(settings.importStatuses,status)}> ${status}</label>`)}</fieldset><fieldset><legend>Excluir titulares por tipo de documento</legend>${docTypes.map(type => html`<label><input type="checkbox" name="excludedDocumentTypes" value="${type}"${checked(settings.excludedDocumentTypes,type)}> ${type}</label>`)}</fieldset>
		<div class="grid2 import-options"><label class="field">Ventana de importación<select name="windowMonths"><option value="3"${settings.windowMonths===3?' selected':''}>Últimos 3 meses</option><option value="6"${settings.windowMonths===6?' selected':''}>Últimos 6 meses</option><option value="9"${settings.windowMonths===9?' selected':''}>Últimos 9 meses</option><option value="12"${settings.windowMonths===12?' selected':''}>Últimos 12 meses</option><option value="all"${settings.windowMonths===null?' selected':''}>Sin ventana</option></select><small>Incluye el mes actual y el límite indicado.</small></label>
		<label class="field">Cuotas recientes por contrato<input type="number" min="1" max="60" name="maxRecentInstallments" value="${settings.maxRecentInstallments ?? ''}" placeholder="Todas"><small>Entre 1 y 60; vacío para todas.</small></label><label class="field">Días de gracia<input type="number" min="0" max="60" name="graceDays" value="${settings.graceDays}"></label><label class="field">Máximo de facturas nuevas por corrida<input type="number" min="1" name="maxInvoicesPerRun" value="${settings.maxInvoicesPerRun ?? ''}" placeholder="Sin límite"></label><label class="field">Máximo de monto nuevo (USD)<input type="number" min="0.01" step="0.01" name="maxAmountPerRun" value="${settings.maxAmountPerRun ?? ''}" placeholder="Sin límite"></label></div></div></section>
		<section class="card"><header><h2>Corrida automática</h2></header><div class="body grid2"><label class="checkline"><input type="checkbox" name="autoRunEnabled" value="1"${settings.autoRunEnabled?' checked':''}> Activar corrida diaria</label><label class="field">Hora local<input type="text" name="autoRunTime" pattern="([01][0-9]|2[0-3]):[0-5][0-9]" value="${settings.autoRunTime}" placeholder="02:00"></label><p class="note">La corrida automática se ejecuta mientras el proceso esté activo y queda registrada en el historial.</p></div></section>
		<div class="actions sticky-actions"><button class="btn primary">Guardar configuración</button></div></form>`
}

function parseSettings(form: URLSearchParams, old: Settings): Settings {
	const required = (name: string): string => { const value = (form.get(name) ?? '').trim(); if (!value) throw new Error(`El campo ${name} es obligatorio.`); return value }
	const optionalNumber = (name: string, min: number, max = Number.MAX_SAFE_INTEGER): number | null => {
		const raw = (form.get(name) ?? '').trim(); if (!raw) return null
		const value = Number(raw); if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} debe estar entre ${min} y ${max}.`); return value
	}
	const windowValue = form.get('windowMonths')
	const graceDays = optionalNumber('graceDays',0,60)
	const recent = optionalNumber('maxRecentInstallments',1,60)
	const maxInvoices = optionalNumber('maxInvoicesPerRun',1)
	const maxAmount = optionalNumber('maxAmountPerRun',0.01)
	const apiUrl = required('apiUrl')
	try { const parsed = new URL(apiUrl); if (!['http:','https:'].includes(parsed.protocol)) throw new Error() } catch { throw new Error('La URL de la API no es válida.') }
	const time = form.get('autoRunTime') ?? '02:00'
	if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('La hora automática debe tener formato HH:MM.')
	const statuses = form.getAll('importStatuses').map(String)
	if (!statuses.length) throw new Error('Selecciona al menos un estado de contrato.')
	return {
		...old, companyName: required('companyName'), companyTaxId: (form.get('companyTaxId') ?? '').trim(), collectionsEmail: (form.get('collectionsEmail') ?? '').trim(),
		apiUrl: apiUrl.replace(/\/+$/,''), apiUser: required('apiUser'), apiPassword: (form.get('apiPassword') ?? '') || old.apiPassword,
		importStatuses: statuses, windowMonths: windowValue === 'all' ? null : Number(windowValue), maxRecentInstallments: recent,
		graceDays: graceDays ?? 0, maxInvoicesPerRun: maxInvoices, maxAmountPerRun: maxAmount,
		excludedDocumentTypes: form.getAll('excludedDocumentTypes').map(String), autoRunEnabled: form.get('autoRunEnabled') === '1', autoRunTime: time,
	}
}

function empty(title: string, detail: string, href: string, label: string): Raw { return html`<div class="body"><div class="empty"><span class="empty-icon">✦</span><strong>${title}</strong><span>${detail}</span><a class="btn primary" href="${href}">${label}</a></div></div>` }
function configurationResponse(res: ServerResponse, settings: Settings, simulatorUrl: string, message: string, tone: Tone): void {
	const body = layout({ title: 'Configuración', active: '/configuracion', body: configurationPage(settings, simulatorUrl), flash: { tone, text: message }, company: settings.companyName || 'Cobrix' })
	sendHtml(res, 200, body)
}
function scalar(db: Store['db'], sql: string): number { return Number((db.prepare(sql).get() as { n: number }).n) }
async function readForm(req: IncomingMessage): Promise<URLSearchParams> { const chunks: Buffer[]=[]; for await (const chunk of req) chunks.push(chunk as Buffer); return new URLSearchParams(Buffer.concat(chunks).toString('utf8')) }
function redirect(res: ServerResponse, location: string): void { res.writeHead(303, { location }); res.end() }
function sendHtml(res: ServerResponse, status: number, body: string): void { send(res,status,body,'text/html; charset=utf-8') }
function send(res: ServerResponse, status: number, body: string, type: string): void { res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) }); res.end(body) }

const APP_CSS = `
.eyebrow { color:var(--primary); font-size:11px; font-weight:700; letter-spacing:.12em; margin:0 0 4px!important; }
.tile small { color:var(--muted); font-size:12px; }
.card p { margin:0; }
.card .body > p { color:var(--muted); }
.empty { min-height:190px; display:grid; align-content:center; justify-items:center; text-align:center; gap:9px; color:var(--muted); }
.empty strong { font-size:16px; color:var(--fg); }
.empty span { max-width:58ch; }
.empty-icon { width:40px; height:40px; border-radius:50%; display:grid; place-items:center; color:var(--primary); background:var(--primary-soft); font-size:20px; }
.empty .btn { margin-top:4px; }
.connection-actions small { color:var(--muted); }
.provider-fields { grid-template-columns:repeat(2,minmax(0,1fr)); }
.provider-password { grid-column:1; width:100%; justify-self:stretch; }
.checkline { display:flex; align-items:center; gap:8px; font-weight:600; }
.config-form { display:grid; gap:16px; }
.sticky-actions { position:sticky; bottom:12px; justify-self:start; padding:10px; background:var(--surface); border:1px solid var(--line); border-radius:10px; box-shadow:0 8px 32px #0002; z-index:2; }
.compact { grid-template-columns:repeat(auto-fit,minmax(135px,1fr)); }
.compact .tile { padding:8px 10px; }
.compact .tile strong { font-size:17px; }
.import-options { grid-template-columns:repeat(2,minmax(0,1fr)); }
.doc { margin:0; white-space:pre-wrap; font:13px/1.6 var(--mono); max-width:110ch; }
input[type=checkbox] { accent-color:var(--primary); }
@media(max-width:650px) { th,td { padding:8px; } .head .actions { width:100%; } }
@media(max-width:650px) { .import-options { grid-template-columns:minmax(0,1fr); } .provider-fields { grid-template-columns:minmax(0,1fr); } .provider-password { grid-column:auto; width:100%; } }
`
