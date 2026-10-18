# Nota de entrega

## Acceso para evaluación

Ejecutar `npm install` y `npm start`; no hace falta crear `.env`. El panel queda en http://127.0.0.1:4300 con usuario `operador` y contraseña `cobrix-local-demo-2026` (también se muestran en la consola al iniciar). Son las credenciales del panel. Las del ISP simulado, si se solicitan en Configuración, son `cobrix` / `cobrix-sandbox`.

## Decisiones

- Mantuve Node/TypeScript, el servidor web nativo y `node:sqlite`; la base Cobrix es independiente de la base del ISP. El adaptador HTTP usa Axios y `@tanstack/query-core` para centralizar las peticiones y deduplicar lecturas concurrentes sin convertir el panel server-rendered a React.
- La configuración es el único estado gestionado por Zustand: se hidrata desde SQLite al iniciar, se comparte en memoria durante la ejecución y cada actualización se persiste antes de actualizar el store.
- La importación usa `lista_ids_contratos` sin filtro de estado: la API interpreta cualquier `estado` enviado como «solo activos». Se validan filas y cuotas antes de importar; estados o formatos desconocidos no se adivinan.
- La ventana predeterminada es de 9 meses para reproducir el ciclo de aceptación, incluida la cuota antigua de Miguel. La identificación se normaliza antes de agrupar y `deuda_id` es la clave idempotente de las facturas.
- Se ignora `success: false` únicamente en el libro de pagos, donde el contrato de la API lo documenta. Una cuota se marca pagada si saldo y pago son válidos, el saldo queda en cero y existe una referencia de factura. La conciliación vuelve a revisar pagadas, reabre las que el ISP volvió a dejar con saldo y distingue las exoneradas.
- `amount_minor` conserva el importe original; `provider_balance_minor` y `provider_paid_minor` conservan las observaciones vigentes del ISP. Así se muestran abonos y saldo actual sin perder el importe de facturación. El detalle de corrida registra la evidencia monetaria por cuota.
- Las corridas persisten sus estados y las automáticas tienen registro por fecha y etapa. Si falla la importación, pagos no se ejecuta; la etapa fallida se reintenta con espera incremental. Una transacción SQLite confirma escrituras de negocio e historial; el lock con lease y propietario evita commits de una ejecución antigua.
- Todas las pantallas requieren Basic Auth. Los POST usan además token CSRF, cookie `HttpOnly`/`SameSite=Strict`, origen del mismo sitio y límite de tamaño. Las credenciales ISP se cifran con AES-256-GCM usando una clave externa a SQLite.
- Los destinos remotos del ISP requieren HTTPS y una allowlist de hosts, las redirecciones HTTP están deshabilitadas y se limita el tamaño de respuesta. El simulador queda enlazado a loopback.
- Las migraciones versionadas se ejecutan en transacción y añaden validadores de integridad para estados, saldos y relación factura/contrato/titular.
- Elegí renderizado HTML del lado del servidor con identidad visual propia, navegación operativa, paleta verde profunda y responsive: el panel no necesita un paso de compilación ni cargar Tailwind desde un CDN.

## Punto diferencial

El detalle de corrida funciona como una bitácora de decisión: además del resultado muestra la evidencia o regla que lo produjo y permite saltar desde una fila al expediente del cliente. La simulación de importación ofrece esa revisión antes de persistir.

## Alcance pendiente

- En local, la clave AES se genera en `data/cobrix.secret`, separada de la base y con permisos privados; perderla impide descifrar credenciales guardadas. Para despliegues se proporciona desde el entorno y, en varias máquinas, se debería guardar en un KMS o gestor de secretos.
- El scheduler sigue dentro del proceso Node y el lease usa SQLite local. Un despliegue multi-host requiere almacenamiento transaccional compartido y coordinación distribuida; SQLite sobre un sistema de archivos de red no es el objetivo.
- El panel tiene un usuario operativo único, no un sistema multiusuario con roles. Si se necesita separar permisos, conviene añadir identidades y autorización explícita.
- El adaptador reintenta etapas automáticas completas, no solicitudes HTTP individuales. Se puede agregar backoff por endpoint y métricas si el ISP impone límites o la cartera crece considerablemente.

## Uso de IA

Usé un asistente de IA para desglosar el enunciado, proponer la estructura de persistencia y desarrollar el adaptador, el panel y las pruebas. Revisé las respuestas contra `docs/API.md`, el servidor simulado y los resultados de aceptación. Corregí especialmente la consulta de contratos (sin filtro `estado`), el uso de `success: false` con datos válidos y el valor predeterminado de la ventana: 6 meses dejaba fuera una cuota de marzo y no alcanzaba los 42 registros; 9 meses sí reproduce el resultado solicitado. También ejecuté el ciclo completo en pruebas automatizadas antes de darlo por válido.
