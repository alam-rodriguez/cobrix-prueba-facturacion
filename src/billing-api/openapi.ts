/**
 * OpenAPI 3.0 description of the simulated invoice manager API, served at /openapi.json and
 * rendered by Swagger UI at /docs. Examples are real responses of this simulator.
 */

const bearer = [{ bearerAuth: [] }]

const errorDetail = (type: string, mensaje: string) => ({
	type: 'object',
	properties: { detail: { type: 'object', properties: { type: { type: 'string' }, mensaje: { type: 'string' } } } },
	example: { detail: { type, mensaje } },
})

const unauthorized = {
	description: 'Sin token, token inválido o vencido.',
	content: { 'application/json': { schema: errorDetail('auth_api', 'MissingTokenError, Token expirado') } },
}

const validationList = {
	description: 'Parámetro con tipo inválido. La API responde una lista, no un objeto.',
	content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ValidationError' } } } },
}

export const OPENAPI_SPEC = {
	openapi: '3.0.3',
	info: {
		title: 'API del administrador de facturas (simulada)',
		version: '1.0.0',
		description: [
			'API de un administrador de facturas de ISP, simulada sobre SQLite (`data/billing-api.sqlite`).',
			'Cobrix la usa para **importar clientes y cuotas pendientes** y para **saber qué cuotas ya se pagaron**.',
			'',
			'**Cómo probar aquí:**',
			'1. `POST /usuario/login` con `{"user_name": "cobrix", "password": "cobrix-sandbox"}` y copia el `access_token`.',
			'2. Pulsa **Authorize** y pega el token.',
			'3. Prueba `lista_ids_contratos`, luego `contrato/individual` con un ID (por ejemplo `900101`) y luego `pago_informacion`.',
			'',
			'Las rutas de **Simulador** no son parte de la API real: hacen de caja del ISP para crear pagos y anulaciones.',
			'Guía completa en `docs/API.md` del repositorio.',
		].join('\n'),
	},
	servers: [{ url: '/', description: 'Este servidor' }],
	tags: [
		{ name: 'Sesión', description: 'Token de acceso. Dura 2 horas y no se renueva: se pide otro login.' },
		{ name: 'Contratos', description: 'Lo que Cobrix lee para importar clientes y facturas.' },
		{ name: 'Pagos', description: 'Lo que Cobrix lee para saber qué cuotas se pagaron.' },
		{ name: 'Simulador', description: 'No es parte de la API real. Caja del ISP para la prueba.' },
	],
	components: {
		securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
		schemas: {
			ValidationError: {
				type: 'object',
				properties: { source: { type: 'string', example: 'query' }, field: { type: 'string', example: 'page' }, message: { type: 'string', example: 'value is not a valid integer' } },
			},
			Envelope: {
				type: 'object',
				properties: {
					success: { type: 'boolean', description: 'No es confiable: `pago_informacion` responde `false` aunque traiga datos.' },
					message: { type: 'string' },
					pagination: { type: 'object', properties: { page: { type: 'integer' }, per_page: { type: 'integer' }, total: { type: 'integer' }, total_pages: { type: 'integer' } } },
					errors: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, message: { type: 'string' }, code: { type: 'string' }, uuid_code: { type: 'string' } } } },
				},
			},
			CuotaPendiente: {
				type: 'object',
				description: 'Una fila por cuota pendiente. Los datos del contrato y del cliente se repiten en cada fila. **Cobrix crea una factura por fila.**',
				properties: {
					contrato_id: { type: 'integer', example: 900101, description: 'Contrato del ISP.' },
					codigo: { type: 'string', example: '0900101' },
					identificacion_contrato: { type: 'string', example: 'V-12345678', description: 'Cédula o RIF del titular. **Cobrix crea un cliente por identificación.**' },
					nombre_contrato: { type: 'string', example: 'ANA PEREZ' },
					telefono: { type: 'string', example: '04121000000' },
					email: { type: 'string', example: 'ANA.PEREZ@EXAMPLE.COM' },
					estado: { type: 'string', enum: ['ACTIVO', 'CORTADO', 'CORTESIA', 'RETIRADO', 'RECHAZADO', 'ANULADO'], description: 'Por defecto Cobrix importa ACTIVO y CORTADO.' },
					direccion: { type: 'string' },
					deuda: { type: 'number', example: 20, description: 'Saldo de la cuota, redondeado a 2 decimales. Es el monto de la factura en Cobrix.' },
					deuda_id: { type: 'string', example: '7000008', description: 'ID de la cuota. Es el ID externo de la factura en Cobrix. `"0"` = el contrato no tiene deuda (fila que se descarta).' },
					detalle_deuda: { type: 'array', items: { type: 'string' }, example: ['PLAN15MB25 - 2026 Agosto'], description: 'Plan y periodo. De aquí sale el periodo (`2026-08`) y el vencimiento (`2026-08-01`).' },
					precio_servicio: { type: 'string', example: '25.000000' },
					nombre_plan: { type: 'string', example: 'PLAN15MB25' },
					moneda: { type: 'string', example: 'DOLAR' },
					moneda_sigla: { type: 'string', example: 'USD', description: 'Solo se importa USD coherente con el precio del plan.' },
					sigla_sucursal: { type: 'string', example: 'VLN' },
					dia_cobro: { type: 'integer', example: 26 },
					dia_corte: { type: 'integer', example: 4 },
				},
			},
			FilaLibro: {
				type: 'object',
				description: 'Una fila por cuota y por cada factura que la tocó. Cada fila muestra el estado ACTUAL de la cuota.',
				properties: {
					id_factura: { type: 'integer', example: 8800001, description: '0 = la cuota no tiene ninguna factura de cobro.' },
					num_factura: { type: 'string', example: '008800001' },
					fecha_emision: { type: 'string', format: 'date', example: '2026-10-06' },
					id_contrato: { type: 'integer', example: 900101 },
					detalle_pago: {
						type: 'object',
						properties: {
							id_cuota: { type: 'integer', example: 7000008, description: 'Igual a `deuda_id` de contrato/individual.' },
							periodo_cuota: { type: 'string', example: '2026-08' },
							tarifa: { type: 'number', example: 25 },
							valor_pago: { type: 'number', example: 25, description: 'Lo pagado de la cuota.' },
							saldo_cuota: { type: 'number', example: 0, description: 'Lo que falta. **Cobrix marca pagada la factura si es 0 y `valor_pago` > 0.**' },
							descuento: { type: 'number', example: 0, description: 'Igual a `-tarifa` cuando la cuota se exoneró.' },
						},
					},
				},
			},
		},
	},
	paths: {
		'/api/v1/usuario/login': {
			post: {
				tags: ['Sesión'],
				summary: 'Iniciar sesión',
				description: 'Acepta `user_name` o `email`. El token dura 2 horas; `access_token_expires_in` viene en UTC sin zona horaria.',
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { type: 'object', properties: { user_name: { type: 'string' }, email: { type: 'string' }, password: { type: 'string' } } }, example: { user_name: 'cobrix', password: 'cobrix-sandbox' } } },
				},
				responses: {
					200: {
						description: 'Sesión iniciada.',
						content: { 'application/json': { example: { usuario: 'cobrix', email: 'cobrix@example.com', access_token: 'eyJhbGciOi…', access_token_expires_in: '2026-10-13T10:00:00' } } },
					},
					400: { description: 'Correo no registrado o contraseña incorrecta.', content: { 'application/json': { schema: errorDetail('password', 'Contraseña Incorrecta') } } },
				},
			},
		},
		'/api/v1/isp/lista_ids_contratos': {
			get: {
				tags: ['Contratos'],
				summary: 'Listar los IDs de contrato',
				description: 'Paso 1 de la importación: Cobrix recorre estos IDs uno por uno. Sin `estado` devuelve **todos**. Con cualquier valor de `estado` devuelve **solo los activos** (comportamiento real de la API). `page` y `per_page` se ignoran.',
				security: bearer,
				parameters: [
					{ name: 'estado', in: 'query', schema: { type: 'string' }, description: 'Cualquier valor = solo activos.' },
					{ name: 'id_sucursal', in: 'query', schema: { type: 'integer', enum: [1, 2] } },
					{ name: 'page', in: 'query', schema: { type: 'integer' } },
				],
				responses: {
					200: {
						description: 'Envoltorio con la lista de IDs en `data`.',
						content: { 'application/json': { schema: { allOf: [{ $ref: '#/components/schemas/Envelope' }, { type: 'object', properties: { data: { type: 'array', items: { type: 'integer' } } } }] }, example: { success: true, message: 'Lista de ids de contratos', pagination: { page: 1, per_page: 3, total: 3, total_pages: 1 }, errors: [{ id: 0, message: '', code: '', uuid_code: '' }], data: [900101, 900102, 900103] } } },
					},
					400: validationList,
					401: unauthorized,
				},
			},
		},
		'/api/v1/isp/contrato/individual': {
			get: {
				tags: ['Contratos'],
				summary: 'Cuotas pendientes de un contrato',
				description: 'Paso 2 de la importación. Devuelve una **lista sin envoltorio**, con una fila por cuota pendiente (vencida o del mes; nunca futuras), **sin orden**. Si el contrato no debe nada devuelve una sola fila con `deuda_id: "0"`. Con `identificacion` devuelve las cuotas de todos los contratos del titular.',
				security: bearer,
				parameters: [
					{ name: 'id_contrato', in: 'query', schema: { type: 'integer' }, example: 900101 },
					{ name: 'codigo', in: 'query', schema: { type: 'string' } },
					{ name: 'identificacion', in: 'query', schema: { type: 'string' } },
				],
				responses: {
					200: { description: 'Cuotas pendientes. Sin parámetros, lista vacía.', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/CuotaPendiente' } } } } },
					400: { description: 'Contrato inexistente.', content: { 'application/json': { schema: errorDetail('parametros', '17.1) No se pudo recuperar la informacion') } } },
					401: unauthorized,
				},
			},
		},
		'/api/v1/isp/pago_informacion': {
			get: {
				tags: ['Pagos'],
				summary: 'Libro de cuotas y pagos de un contrato',
				description: 'Lo usa «Actualizar pagadas». Trae también cuotas **futuras** y una cuota antigua que ningún otro endpoint cuenta: no se puede sumar sin filtrar. Pasa siempre `fecha_inicio` y `fecha_fin` (filtran por `fecha_emision`); sin ellas la API usa una ventana fija vieja. `success` llega `false` aunque haya datos.',
				security: bearer,
				parameters: [
					{ name: 'id_contrato', in: 'query', required: true, schema: { type: 'integer' }, example: 900101 },
					{ name: 'tipo_busqueda', in: 'query', required: true, schema: { type: 'string', enum: ['CUOTA', 'FACTURA'] }, example: 'CUOTA' },
					{ name: 'fecha_inicio', in: 'query', schema: { type: 'string', format: 'date' }, example: '2026-03-01' },
					{ name: 'fecha_fin', in: 'query', schema: { type: 'string', format: 'date' }, example: '2026-12-31' },
				],
				responses: {
					200: { description: 'Envoltorio con las filas en `data`.', content: { 'application/json': { schema: { allOf: [{ $ref: '#/components/schemas/Envelope' }, { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/FilaLibro' } } } }] } } } },
					400: validationList,
					401: unauthorized,
				},
			},
		},
		'/__sim/contratos': {
			get: { tags: ['Simulador'], summary: 'Ver contratos, cuotas pendientes y últimas facturas', responses: { 200: { description: 'Resumen por contrato.' } } },
		},
		'/__sim/pagar': {
			post: {
				tags: ['Simulador'],
				summary: 'Registrar un pago en la caja del ISP',
				description: 'Paga las cuotas pendientes de la más vieja a la más nueva. Sin `monto` cobra toda la deuda vencida y del mes; con `monto` puede quedar un abono parcial.',
				requestBody: { required: true, content: { 'application/json': { example: { id_contrato: 900101, monto: 25 } } } },
				responses: { 200: { description: 'Factura creada y cuotas cobradas.', content: { 'application/json': { example: { id_factura: 8800118, num_factura: '008800118', cuotas: [{ id_cuota: 7000008, periodo: '2026-08', monto: 20 }, { id_cuota: 7000009, periodo: '2026-09', monto: 5 }] } } } } },
			},
		},
		'/__sim/anular': {
			post: {
				tags: ['Simulador'],
				summary: 'Anular una factura del ISP',
				description: 'Las cuotas vuelven a deber. La factura sigue enlazada a la cuota, como en la API real.',
				requestBody: { required: true, content: { 'application/json': { example: { id_factura: 8800118 } } } },
				responses: { 200: { description: 'Factura anulada.' }, 400: { description: 'No existe o ya estaba anulada.' } },
			},
		},
		'/__sim/reiniciar': {
			post: { tags: ['Simulador'], summary: 'Volver la base a su estado inicial', responses: { 200: { description: 'Base regenerada.' } } },
		},
	},
} as const

const SWAGGER_UI_VERSION = '5.17.14'

/** Swagger UI page; loads the UI from unpkg (needs internet), the spec from this server. */
export const SWAGGER_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API del administrador de facturas · Swagger</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css">
<style>body { margin: 0; } .fallback { font: 15px system-ui, sans-serif; padding: 24px; }</style>
</head>
<body>
<div id="swagger"><p class="fallback">Cargando Swagger… Si no aparece, no hay internet: la especificación está en <a href="/openapi.json">/openapi.json</a>.</p></div>
<script src="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js"></script>
<script>
window.SwaggerUIBundle && SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger', persistAuthorization: true, tryItOutEnabled: true })
</script>
</body>
</html>`
