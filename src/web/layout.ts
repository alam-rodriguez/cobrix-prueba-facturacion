/**
 * Cobrix application shell and small rendering helpers (escaping, money, dates and status pills).
 */

export const esc = (value: unknown): string =>
	String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** Tagged template that escapes interpolations unless they are `raw()`. */
export class Raw {
	readonly html: string
	constructor(html: string) {
		this.html = html
	}
}
export const raw = (html: string): Raw => new Raw(html)
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
	let out = strings[0] ?? ''
	values.forEach((value, i) => {
		const render = (v: unknown): string =>
			v instanceof Raw ? v.html : Array.isArray(v) ? v.map(render).join('') : v === undefined || v === null || v === false ? '' : esc(v)
		out += render(value) + (strings[i + 1] ?? '')
	})
	return new Raw(out)
}

const money = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const usd = (minor: unknown): string => `USD ${money.format(Number(minor ?? 0) / 100)}`

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
export function date(value: unknown): string {
	if (typeof value !== 'string' || !value) return '—'
	const [y, m, d] = value.slice(0, 10).split('-')
	return d ? `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}` : `${MONTHS[Number(m) - 1]} ${y}`
}
export function dateTime(value: unknown): string {
	if (typeof value !== 'string' || !value) return '—'
	return new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
export const period = (value: unknown): string => (typeof value === 'string' ? date(value) : '—')

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'mute'
export const pill = (label: string, tone: Tone): Raw => html`<span class="pill ${tone}">${label}</span>`

export const CONTRACT_STATUS_TONE: Record<string, Tone> = {
	ACTIVO: 'ok', CORTADO: 'bad', CORTESIA: 'info', RETIRADO: 'mute', RECHAZADO: 'mute', ANULADO: 'mute', status_unrecognized: 'bad',
}

const NAV_GROUPS = [
	{ label: 'GENERAL', items: [
		['/', 'Resumen', '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>'],
	] },
	{ label: 'CARTERA', items: [
		['/clientes', 'Clientes', '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19v-1.2a5.5 5.5 0 0 1 11 0V19M16 5.2a3.2 3.2 0 0 1 0 6.2m2 3a4.7 4.7 0 0 1 2.5 4.2V19"/></svg>'],
		['/facturas', 'Cuentas por cobrar', '<svg viewBox="0 0 24 24"><path d="M6 3.5h12v17l-3-1.8-3 1.8-3-1.8-3 1.8zM9 9h6m-6 4h6"/></svg>'],
		['/pagos', 'Pagos recibidos', '<svg viewBox="0 0 24 24"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M3.5 10h17m-12 4h3"/></svg>'],
	] },
	{ label: 'ADMINISTRACIÓN', items: [
		['/sincronizacion', 'Sincronización', '<svg viewBox="0 0 24 24"><path d="M20 7v5h-5M4.5 10a7.5 7.5 0 0 1 12.8-3L20 9M4 17v-5h5m10.5 2a7.5 7.5 0 0 1-12.8 3L4 15"/></svg>'],
	] },
	{ label: 'ANÁLISIS', items: [
		['/informes', 'Informes', '<svg viewBox="0 0 24 24"><path d="M4 19.5h16M6.5 16v-5m5 5V5m5 11v-8"/></svg>'],
	] },
	{ label: 'SISTEMA', items: [
		['/configuracion', 'Configuración', '<svg viewBox="0 0 24 24"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="m19.4 15 .1.1 1.2.9-1.5 2.6-1.4-.6a7.8 7.8 0 0 1-1.5.9l-.2 1.5h-3l-.3-1.5a7.8 7.8 0 0 1-1.5-.9l-1.4.6-1.5-2.6 1.2-.9a7 7 0 0 1 0-1.8l-1.2-.9 1.5-2.6 1.4.6a7.8 7.8 0 0 1 1.5-.9l.3-1.5h3l.2 1.5a7.8 7.8 0 0 1 1.5.9l1.4-.6 1.5 2.6-1.2.9a7 7 0 0 1 0 1.8Z"/></svg>'],
	] },
] as const

export function layout(input: { title: string; active: string; body: Raw; flash?: { tone: Tone; text: string } | undefined; company: string }): string {
	const company = input.company.trim() || 'Cobrix'
	return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f8fafc">
<title>${esc(input.title)} · ${esc(company)} | Cobrix</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<div class="shell min-h-screen bg-background text-foreground">
	<aside class="side">
		<a class="brand inline-flex items-center gap-3" href="/" aria-label="Cobrix · inicio"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M23.4 10.3a9.1 9.1 0 1 0 0 11.4"/><path d="M21.5 9.1 24 10.5l-.5 2.8"/></svg></span><span class="brand-copy"><strong>cobrix</strong><small>GESTIÓN DE CARTERA</small></span></a>
		<button class="mobile-nav-toggle" type="button" aria-expanded="false" aria-controls="primary-nav"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg><span>Menú</span></button>
		<nav class="primary-nav" id="primary-nav" aria-label="Navegación principal">${NAV_GROUPS.map(group => `<div class="nav-group grid gap-1"><span class="nav-group-label">${group.label}</span>${group.items.map(([href, label, icon]) => `<a class="flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" href="${href}"${input.active === href ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span><span class="nav-link-label">${label}</span></a>`).join('')}</div>`).join('')}</nav>
	</aside>
	<main class="main">
		<header class="topbar"><div class="breadcrumbs"><span>COBRIX</span><span class="topbar-separator">/</span><strong>${esc(input.title)}</strong></div><div class="topbar-tools"><form class="global-search" method="get" action="/clientes" role="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 4.3 4.3"/></svg><input type="search" name="q" placeholder="Buscar clientes…" aria-label="Buscar clientes"></form><span class="timezone-label"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.2 2"/></svg> Caracas · UTC−4</span></div></header>
		<div class="content">
		${input.flash ? `<div class="flash ${input.flash.tone}" role="status">${esc(input.flash.text)}</div>` : ''}
		${input.body.html}
		</div>
	</main>
</div>
</body>
</html>`
}

export const CSS = `
:root {
	--brand-darkest: #042F30; --brand-dark: #063B3B; --brand: #0B6B65; --brand-hover: #0F5552;
	--brand-active: #087F8C; --brand-accent: #2DD4BF; --brand-on-dark: #B8D3D0; --brand-border: #245653;
	--bg: #f8f9fa; --surface: #fff; --sunken: #f1f3f5; --fg: #1a1a2e; --muted: #667085; --line: #e4e7ec;
	--primary: var(--brand); --primary-soft: #e8f3f2; --primary-fg: #fff;
	--ok: #18794e; --ok-bg: #eaf5ee; --warn: #986b12; --warn-bg: #fff5dc; --bad: #a13d3d; --bad-bg: #fbeaea;
	--info: #2563eb; --info-bg: #eaf1ff; --mute: #667085; --mute-bg: #f1f3f5;
	--font: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	--mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
	color-scheme: light;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.55 var(--font); -webkit-font-smoothing: antialiased; }
a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: none; }
.shell { display: grid; grid-template-columns: 258px minmax(0, 1fr); min-height: 100vh; }
.side { background: #fff; color: var(--fg); border-right: 1px solid var(--line); padding: 22px 15px 16px; display: flex; flex-direction: column; gap: 23px; position: sticky; top: 0; height: 100vh; }
.brand { display: flex; gap: 11px; align-items: center; padding: 2px 8px; color: inherit; }
.brand:hover { text-decoration: none; }
.brand-mark { width: 38px; height: 38px; border-radius: 11px; background: #5b5fc7; color: #fff; display: grid; place-items: center; box-shadow: 0 3px 8px #5b5fc72b; }
.brand-mark svg { width: 25px; height: 25px; fill: none; stroke: currentColor; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }
.brand-copy strong { display: block; color: #1a2c43; font-size: 20px; letter-spacing: -.055em; line-height: 1.15; }
.brand-copy small { display: block; color: #7c8ba0; font-size: 9px; font-weight: 750; letter-spacing: .14em; margin-top: 4px; }
.workspace-card { min-width:0; display:flex; align-items:center; gap:10px; padding:11px; background:#f7f9fc; border:1px solid #e8edf4; border-radius:10px; }
.workspace-avatar { width:32px; height:32px; flex:0 0 auto; display:grid; place-items:center; border-radius:8px; color:#5359bd; background:#e9eaff; font-size:13px; font-weight:800; }
.workspace-copy { min-width:0; flex:1; }
.workspace-copy small,.workspace-copy strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.workspace-copy small { color:#8290a3; font-size:9px; font-weight:750; letter-spacing:.1em; }
.workspace-copy strong { margin-top:3px; color:#24364c; font-size:13px; }
.sidebar-action { min-height:42px; display:flex; align-items:center; justify-content:center; gap:8px; color:#fff; background:#5b5fc7; border-radius:9px; font-size:13px; font-weight:650; box-shadow:0 3px 8px #5b5fc728; }
.sidebar-action:hover { color:#fff; background:#4e52b5; }
.sidebar-action > span { width:18px; height:18px; display:grid; place-items:center; border:1px solid #ffffff70; border-radius:5px; font-size:15px; line-height:1; }
.primary-nav { display:grid; gap:24px; }
.nav-group { display:grid; gap:3px; }
.nav-group-label { color:#8b98aa; padding:0 11px 6px; font-size:10px; font-weight:800; letter-spacing:.13em; }
.primary-nav a { position:relative; min-height:42px; color:#4f6178; padding:9px 11px; border-radius:9px; font-size:13px; font-weight:600; display:flex; align-items:center; gap:12px; transition:background .15s ease,color .15s ease; }
.primary-nav a:hover { color:#4c51ae; background:#f6f6ff; }
.primary-nav a[aria-current="page"] { color:#4e53b5; background:#f0f0ff; }
.primary-nav a[aria-current="page"]::before { content:""; position:absolute; left:-15px; top:9px; bottom:9px; width:3px; border-radius:0 3px 3px 0; background:#6569d3; }
.nav-icon { width:19px; height:19px; display:grid; place-items:center; flex:0 0 auto; }
.nav-icon svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.nav-link-label { flex:1; }
.sidebar-footer { margin-top:auto; padding-top:14px; border-top:1px solid #edf0f5; }
.environment-card { display:flex; align-items:center; gap:10px; padding:11px; background:#f7f9fc; border:1px solid #e9edf3; border-radius:9px; }
.environment-icon { width:30px; height:30px; flex:0 0 auto; display:grid; place-items:center; color:#71849b; background:#e9eef5; border-radius:7px; }
.environment-icon svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.environment-card > span:nth-child(2) { flex:1; min-width:0; }
.environment-card small,.environment-card strong { display:block; }
.environment-card small { color:#8592a4; font-size:9px; font-weight:750; letter-spacing:.1em; }
.environment-card strong { margin-top:3px; color:#394b61; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.environment-badge { padding:3px 6px; border-radius:5px; color:#697b90; background:#e9eef5; font-size:9px; font-weight:800; }
.sidebar-caption { display:block; padding:12px 3px 0; color:#93a0b0; font-size:10.5px; }
.main { min-width: 0; background: var(--bg); }
.topbar { height: 68px; border-bottom: 1px solid var(--line); padding: 0 clamp(20px, 4vw, 56px); display: flex; align-items: center; justify-content: space-between; background: #fff; }
.breadcrumbs { display:flex; align-items:center; gap:11px; }
.breadcrumbs > span:first-child { color:#8996a7; font-size:10.5px; font-weight:800; letter-spacing:.13em; }
.topbar-separator { color:#c3cbd5; }
.breadcrumbs strong { color:#23364c; font-size:13px; font-weight:700; }
.topbar-tools { display:flex; align-items:center; gap:16px; }
.global-search { width:270px; height:38px; display:flex; align-items:center; gap:9px; padding:0 12px; border:1px solid #e4e9f0; border-radius:9px; background:#f8f9fc; }
.global-search svg { width:16px; height:16px; flex:0 0 auto; fill:none; stroke:#8b97a8; stroke-width:1.7; stroke-linecap:round; }
.global-search input { width:100%; min-width:0; padding:0; border:0; outline:0; background:transparent; color:var(--fg); font:13px var(--font); }
.global-search input::placeholder { color:#98a3b2; }
.global-search:focus-within { border-color:#a6a9e2; background:#fff; box-shadow:0 0 0 3px #5b5fc714; }
.timezone-label { display:flex; align-items:center; gap:7px; color:#708096; font-size:12px; font-weight:550; }
.timezone-label svg { width:16px; height:16px; fill:none; stroke:#8291a4; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.content { width: 100%; margin: 0; padding: 38px clamp(20px, 4vw, 56px) 64px; display: grid; gap: 22px; align-content: start; }
h1 { font-size: clamp(26px, 2.4vw, 34px); letter-spacing: -.045em; line-height: 1.15; margin: 0; font-weight: 730; }
h2 { font-size: 15px; letter-spacing: -.015em; margin: 0; }
.head { display: flex; flex-wrap: wrap; gap: 16px; align-items: end; justify-content: space-between; margin-bottom: 3px; }
.head p { margin: 7px 0 0; color: var(--muted); max-width: 80ch; }
.head .eyebrow { color: var(--primary); font-size: 10.5px; font-weight: 800; letter-spacing: .15em; margin: 0 0 8px!important; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 13px; min-width: 0; box-shadow: 0 2px 10px #263d5a08; overflow: hidden; }
.card > header { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid #e9edf3; background: #fff; }
.card > .body { padding: 19px; display: grid; gap: 15px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(165px, 1fr)); gap: 13px; }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 15px 17px; display: grid; gap: 5px; position: relative; overflow: hidden; }
.tile::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; background: #9eb9e1; }
.tile span { color: var(--muted); font-size: 12px; font-weight: 600; }
.tile strong { font-size: 23px; letter-spacing: -.035em; font-variant-numeric: tabular-nums; }
.tile small { color: var(--muted); font-size: 11px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 11px 14px; border-bottom: 1px solid #e9edf3; vertical-align: top; }
th { font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; color: #708097; font-weight: 800; background: #f6f8fb; white-space: nowrap; }
th small { display:block; font-size:9.5px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; opacity:.75; }
tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: #f8faff; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.mono { font-family: var(--mono); font-size: 12px; }
td.mono { white-space: nowrap; }
td a strong { color:#22364e; transition:color .12s ease; }
td a:hover strong { color:var(--primary); }
.muted { color: var(--muted); }
.pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.pill.ok { color: var(--ok); background: var(--ok-bg); } .pill.warn { color: var(--warn); background: var(--warn-bg); }
.pill.bad { color: var(--bad); background: var(--bad-bg); } .pill.info { color: var(--info); background: var(--info-bg); }
.pill.mute { color: var(--mute); background: var(--mute-bg); }
.flash { padding: 12px 16px; border: 1px solid transparent; border-radius: 11px; font-weight: 600; }
.flash.ok { background: var(--ok-bg); color: var(--ok); } .flash.bad { background: var(--bad-bg); color: var(--bad); }
.flash.info { background: var(--info-bg); color: var(--info); } .flash.warn { background: var(--warn-bg); color: var(--warn); }
.btn { font: 650 13px var(--font); border: 1px solid #d8e0eb; background: var(--surface); color: var(--fg); padding: 9px 15px; border-radius: 8px; cursor: pointer; white-space: nowrap; transition: transform .12s ease, background .12s ease, box-shadow .12s ease; }
.btn:hover { background: #f5f8fc; box-shadow: 0 3px 9px #1b355210; transform: translateY(-1px); }
.btn.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-fg); }
.btn.primary:hover { background: #4e52b5; }
.btn.small { padding: 6px 11px; font-size: 12px; }
.btn:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.actions { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; }
form.inline { display: inline; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
label.field { display: grid; gap: 6px; font-weight: 600; font-size: 13.5px; }
label.field small { font-weight: 400; color: var(--muted); font-size: 12px; }
input[type=text], input[type=password], input[type=number], input[type=search], input[type=url], select {
	font: 14px var(--font); padding: 9px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--fg); width: 100%; }
fieldset { border: 1px solid var(--line); border-radius: 10px; padding: 13px 16px; margin: 0; display: flex; flex-wrap: wrap; gap: 10px 18px; }
fieldset legend { font-weight: 600; font-size: 13px; padding: 0 4px; }
fieldset label { display: inline-flex; gap: 7px; align-items: center; font-size: 13.5px; }
dl.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 16px; margin: 0; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; }
.timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.timeline li { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 10px; }
.timeline time { color: var(--muted); font-size: 12.5px; }
.note { background: var(--sunken); border-radius: 10px; padding: 12px 15px; color: var(--muted); font-size: 13px; }
.search { display: flex; gap: 9px; max-width: 440px; }
details summary { cursor: pointer; font-weight: 600; }
@media (max-width: 860px) {
	.shell { grid-template-columns: minmax(0, 1fr); }
	.side { position: sticky; z-index: 10; top: 0; height: auto; padding: 10px 20px 0; gap: 8px; box-shadow:0 3px 10px #23364c0a; }
	.workspace-card,.sidebar-action,.sidebar-footer { display:none; }
	.primary-nav { display:flex; gap:4px; overflow-x:auto; scrollbar-width:thin; border-top:1px solid #edf0f5; }
	.nav-group { display:contents; }
	.nav-group-label { display:none; }
	.primary-nav a { flex:0 0 auto; min-height:42px; padding:9px 12px; }
	.primary-nav a[aria-current="page"]::before { left:9px; right:9px; top:auto; bottom:0; height:2px; width:auto; border-radius:2px 2px 0 0; }
	.topbar { height: 56px; padding:0 20px; }
	.global-search { width:180px; }
	.content { padding-top: 26px; }
	.timeline li { grid-template-columns: minmax(0, 1fr); gap: 2px; }
}
@media (max-width: 540px) {
	.side { padding-left:14px; padding-right:14px; }
	.primary-nav a { min-height:40px; padding:8px 10px; font-size:12.5px; }
	.primary-nav a .nav-icon { display:none; }
	.timezone-label { display:none; }
	.topbar-tools { flex:1; justify-content:flex-end; }
	.global-search { width:min(48vw,210px); }
	.content { padding: 22px 14px 44px; }
	.head .actions { width: 100%; }
	.search { max-width: none; }
}
`
