# Guía de la API del administrador de facturas

Cómo está armado el entorno de la prueba y cómo se habla con la API. Lo que tienes que construir, las reglas y los criterios de aceptación están en [`ENUNCIADO.md`](ENUNCIADO.md).

## 1. Qué es la prueba

La prueba simula los **dos lados** de una integración con un ISP, en un solo proceso de Node:

```
 ┌────────────────────────────────────┐        HTTP + token        ┌──────────────────────────────┐
 │  Administrador de facturas (ISP)   │  ◄───────────────────────  │  Tu implementación (Cobrix)   │
 │  API simulada · puerto 4310        │   login, contratos,        │  puerto 4300                  │
 │  base: data/billing-api.sqlite     │   cuotas, libro de pagos   │  panel + sincronización       │
 │  (ya trae clientes y cuotas)       │                            │  (por construir)              │
 └────────────────────────────────────┘                            └──────────────────────────────┘
```

- **El administrador de facturas** es el sistema del ISP. Su base viene llena en el repositorio (`data/billing-api.sqlite`): 26 clientes, 27 contratos, unas 210 cuotas y los cobros que ya hizo.
- **Tu implementación** es el lado de Cobrix: guarda sus propios datos y solo habla con el administrador por HTTP, igual que con un ISP real. No leas `data/billing-api.sqlite` directamente.
- El **simulador** (rutas `/__sim/*`, sección «Simulador» del Swagger) hace de caja del ISP: crea pagos y anulaciones para que pruebes tu actualización de pagadas.

## 2. Cómo se levanta

```bash
npm install
npm start       # fija la fecha de la prueba en 2026-10-13
```

No hace falta configurar variables para el sandbox local: el panel usa `operador` / `cobrix-local-demo-2026` en loopback y genera `data/cobrix.secret` para cifrar las credenciales del ISP. Conserva ese archivo entre reinicios. Para personalizar el entorno puedes crear `.env` a partir de `.env.example`; no se requiere para el arranque.

| Qué | Dónde |
| --- | --- |
| Panel (requiere autenticación HTTP Basic) | http://127.0.0.1:4300 |
| API del administrador | http://127.0.0.1:4310/api/v1 |
| **Swagger para probar la API** | **http://127.0.0.1:4310/docs** |
| Especificación OpenAPI | http://127.0.0.1:4310/openapi.json |

Credenciales de la API: usuario `cobrix`, contraseña `cobrix-sandbox`. El simulador HTTP se inicia solo en modo loopback; al enlazar el panel fuera de loopback se omite el simulador y se exigen credenciales, clave de cifrado y HTTPS. Un ISP remoto debe usar HTTPS y estar incluido en `COBRIX_API_HOSTS` (nombres exactos separados por coma).

## 3. La API paso a paso

Todas las rutas de `/api/v1/isp/...` piden `Authorization: Bearer <token>`.

### 3.1 Iniciar sesión

```bash
curl -s -X POST http://127.0.0.1:4310/api/v1/usuario/login \
  -H 'content-type: application/json' \
  -d '{"user_name":"cobrix","password":"cobrix-sandbox"}'
```

```json
{ "usuario": "cobrix", "email": "cobrix@example.com", "access_token": "eyJhbGciOi…", "access_token_expires_in": "2026-10-13T10:00:00" }
```

El token dura 2 horas y no hay renovación: al vencer se hace otro login. La fecha de vencimiento viene en UTC sin zona.

### 3.2 Listar los contratos

```bash
TOKEN=…   # el access_token del paso anterior
curl -s http://127.0.0.1:4310/api/v1/isp/lista_ids_contratos -H "authorization: Bearer $TOKEN"
```

```json
{ "success": true, "message": "Lista de ids de contratos", "pagination": { "page": 1, "per_page": 27, "total": 27, "total_pages": 1 }, "errors": [ … ], "data": [900101, 900102, …] }
```

Ojo: si se manda `estado` con **cualquier** valor, la API devuelve solo los activos. Para recibirlos todos, no lo mandes o mándalo vacío.

### 3.3 Cuotas pendientes de un contrato

```bash
curl -s 'http://127.0.0.1:4310/api/v1/isp/contrato/individual?id_contrato=900101' -H "authorization: Bearer $TOKEN"
```

Devuelve una **lista sin envoltorio**, una fila por cuota pendiente (vencida o del mes), sin orden:

```json
[
  { "contrato_id": 900101, "identificacion_contrato": "V-12345678", "nombre_contrato": "ANA PEREZ", "estado": "ACTIVO",
    "deuda": 20, "deuda_id": "7000008", "detalle_deuda": ["PLAN15MB25 - 2026 Agosto"], "moneda_sigla": "USD", … },
  { … "deuda": 25, "deuda_id": "7000009", "detalle_deuda": ["PLAN15MB25 - 2026 Septiembre"] … }
]
```

Si el contrato no debe nada, viene **una** fila con `deuda_id: "0"` y `deuda: 0`, que hay que descartar.

### 3.4 Libro de cuotas y pagos

```bash
curl -s 'http://127.0.0.1:4310/api/v1/isp/pago_informacion?id_contrato=900101&tipo_busqueda=CUOTA&fecha_inicio=2026-03-01&fecha_fin=2026-10-31' \
  -H "authorization: Bearer $TOKEN"
```

Una fila por cuota y por cada factura de cobro que la tocó. Lo importante está en `detalle_pago`:

```json
{ "id_factura": 8800007, "num_factura": "008800007", "fecha_emision": "2026-08-06",
  "detalle_pago": { "id_cuota": 7000008, "periodo_cuota": "2026-08", "tarifa": 25, "valor_pago": 5, "saldo_cuota": 20, "descuento": 0 } }
```

- `id_factura: 0` = la cuota no tiene ningún cobro.
- Trae también cuotas **futuras**: no se puede sumar el saldo sin filtrar.
- `success` viene en `false` aunque haya datos; no hay que fiarse de ese campo.

### 3.5 Simulador (no es parte de la API real)

| Ruta | Qué hace |
| --- | --- |
| `GET /__sim/contratos` | Contratos con sus cuotas pendientes y últimas facturas |
| `POST /__sim/pagar` | `{"id_contrato": 900101}` paga toda la deuda; con `"monto": 25` hace un abono parcial |
| `POST /__sim/anular` | `{"id_factura": 8800118}` anula un cobro; sus cuotas vuelven a deber |
| `POST /__sim/reiniciar` | Vuelve la base del administrador a su estado inicial |

## 4. Fecha de la prueba

La base trae cuotas por periodo (`2026-03`, `2026-10`…). Lo que la API considera «pendiente» depende de la fecha de hoy, así que `npm start` fija la fecha en **2026-10-13** (`SANDBOX_TODAY`). Con esa fecha valen los números de los criterios de aceptación.

Si regeneras la base con `npm run seed`, se crea con el mes actual y los números cambian.
