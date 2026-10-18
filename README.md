# Cobrix · integración de facturación ISP

Panel operativo para importar clientes y cuotas desde el administrador del ISP, registrar facturas abiertas y conciliar pagos confirmados por el libro de cuotas.

En este proyecto, uso **ISP** para referirme al sistema del proveedor que expone los datos de clientes, contratos, cuotas y pagos.

## Requisitos y arranque

Requiere **Node.js 24**.

`npm install` instala las dependencias del proyecto, incluida Zustand. En esta implementación uso Zustand exclusivamente para mantener en memoria el estado de la configuración y SQLite para conservarla entre reinicios. No se requiere un comando de compilación adicional.

```bash
npm install
npm start
```

No hace falta crear `.env` para ejecutar el sandbox local. El panel usa por defecto el usuario `operador` y la contraseña `cobrix-local-demo-2026`, y escucha solo en `127.0.0.1`. Genera automáticamente `data/cobrix.secret` con permisos privados para cifrar las credenciales del ISP; conserva ese archivo junto con la base de datos, ya que perderlo impide descifrar la contraseña guardada. `.env.example` ofrece overrides opcionales y `.env` está excluido de Git.

| Servicio | Dirección |
| --- | --- |
| Panel Cobrix | http://127.0.0.1:4300 |
| API simulada del ISP | http://127.0.0.1:4310/api/v1 |
| Swagger y simulador de caja | http://127.0.0.1:4310/docs |

El panel solicita autenticación HTTP Basic; las credenciales locales predeterminadas se pueden cambiar con `COBRIX_PANEL_USER` y `COBRIX_PANEL_PASSWORD` en `.env` o en el entorno. Credenciales iniciales del ISP: usuario `cobrix`, contraseña `cobrix-sandbox`. La fecha del sandbox queda fijada en `2026-10-13` para reproducir los criterios de aceptación. El panel y sus datos Cobrix se guardan en `data/cobrix.sqlite`, independiente de la base del ISP. Para usar otra ruta: `COBRIX_DB=/ruta/al/archivo.sqlite npm start`.

La API local del simulador usa HTTP y loopback, y solo se inicia cuando el panel también escucha en loopback. Para conectar un ISP remoto, configura `COBRIX_API_HOSTS` con los hosts exactos permitidos, separados por coma, y usa una URL HTTPS en el panel. Si expones el panel fuera de loopback, colócalo detrás de un proxy HTTPS y configura `HOST`, credenciales y clave de cifrado propias, `COBRIX_SECURE_COOKIES=1` y `COBRIX_API_HOSTS`.

## Operación

1. En **Configuración**, ajusta empresa, URL y credenciales del proveedor, estados importables, ventana, límites y gracia. Las credenciales se editan con campo vacío para conservar la contraseña guardada.
2. En **Sincronización**, ejecuta primero **Simular importación** para revisar las cuotas y motivos; luego importa.
3. Registra cobros de prueba desde la sección **Simulador** de Swagger (`POST /__sim/pagar`, `POST /__sim/anular`).
4. Ejecuta **Simular actualización** y después **Actualizar pagadas**. Una cuota solo se cierra con saldo cero y evidencia de pago coincidente en el libro.
5. Consulta el resultado en el historial y abre cualquier cliente para revisar contratos, facturas y actividad.

La corrida automática se configura por día y hora de Caracas. El proceso de Node conserva el flujo y el estado de cada etapa en SQLite. Si falla la importación, no inicia la conciliación; reintenta la etapa fallida con espera incremental, y al reiniciar reanuda desde la etapa pendiente. Para reiniciar el administrador a su estado original, usa `POST /__sim/reiniciar` en Swagger; esto no borra los datos ya importados en Cobrix.

La importación y la conciliación pueden repetirse de forma segura: la primera es idempotente por identificador externo y la segunda reconcilia el estado actual del proveedor. Un pago anulado después de conciliarse reabre la factura; las exoneraciones quedan cerradas en un estado distinto de pagada.

## Decisiones críticas

- Elegí Node.js con TypeScript y el servidor web nativo para mantener una aplicación sencilla de ejecutar y sin paso de compilación. Mantengo los datos de Cobrix en una base SQLite independiente y consulto el ISP solo por HTTP, para no acoplar ni modificar su base. Elegí Axios para centralizar las peticiones HTTP, TanStack Query Core para reutilizar y deduplicar lecturas concurrentes, y Zustand vanilla porque solo necesito un estado compartido pequeño para la configuración, que persisto en SQLite.
- Normalizo los documentos y uso `deuda_id` como identificador estable de cada cuota para evitar duplicados al repetir una importación. Consulto los contratos sin filtro de estado —la API lo interpreta como «solo activos»—. La ventana predeterminada de nueve meses permite incluir las cuotas históricas contempladas en el conjunto de datos de prueba. Con la base inicial, la simulación propone 42 cuotas.
- Solo marco una factura como pagada cuando todas las filas de su cuota coinciden, el saldo es cero, hay monto pagado positivo y las filas incluyen una factura de cobro válida. Los saldos y pagos deben ser números finitos y no negativos, y el periodo debe coincidir con la cuota importada. Una anulación posterior reabre la factura; una exoneración se cierra con estado propio y nunca se suma como pago.
- `amount_minor` conserva el importe de la factura; `provider_balance_minor` y `provider_paid_minor` conservan las últimas observaciones del ISP para informar saldo vigente y pago reportado. Las conciliaciones guardan saldo y pago observados en el historial.
- El resultado de pagos separa cuotas pendientes confirmadas, cuotas ausentes del libro, exoneraciones y datos inconsistentes. Las importaciones y actualizaciones preparan sus cambios durante la consulta a la API y los confirman en una única transacción SQLite; una corrida fallida no deja escrituras parciales. Un bloqueo con vencimiento protege la escritura, y el propietario se verifica antes de confirmar.
- En `pago_informacion`, `success: false` es una particularidad documentada de la API: también aparece en respuestas que contienen el libro en `data` ([contrato de la API](docs/API.md#34-libro-de-cuotas-y-pagos)). Se valida la forma de `data`, los identificadores, el periodo, el saldo, el pago y la referencia de factura; las demás rutas exigen `success: true`. El listado de contratos se procesa con su paginación documentada.
- La simulación usa estas mismas reglas sin escribir datos en Cobrix, y cada corrida conserva su resultado y el motivo por cuota.
- Todas las pantallas y acciones requieren autenticación HTTP Basic. Los formularios mutables también incluyen token CSRF de sesión, cookie `HttpOnly`/`SameSite=Strict` y comprobación del origen del POST. Las acciones reales también piden confirmación antes de ejecutarse.
- Las credenciales del ISP se cifran en SQLite con una clave proporcionada fuera de la base. Para hosts remotos se exige HTTPS y una lista de hosts permitidos; no se siguen redirecciones y se limitan el tamaño de las respuestas y formularios.
- Las migraciones SQLite usan `PRAGMA user_version`, transacciones y validadores para estados, saldos y relación entre factura, contrato y titular. El programador registra una corrida y sus etapas, errores e intentos para recuperar importación o pagos de forma independiente.
- En la interfaz, aclaré el documento como cédula o RIF, limité los enlaces al expediente a clientes existentes y adapté los contadores, la navegación y Configuración a los ajustes solicitados; también simplifiqué el formulario y adapté el diseño a pantallas angostas.

Fijé la fecha del sandbox en `2026-10-13` para reproducir la aceptación. Verifico el proyecto con `npm test` y `npm run typecheck`.

## Restablecer el entorno de prueba

Para volver a tener la base de Cobrix vacía y el simulador del ISP con sus datos iniciales:

1. Detén `npm start` con `Ctrl+C`.
2. Borra solo la base local de Cobrix y sus archivos auxiliares:
   ```bash
   rm -f data/cobrix.sqlite data/cobrix.sqlite-wal data/cobrix.sqlite-shm
   ```
3. Inicia de nuevo con `npm start`.
4. En Swagger, ejecuta `POST /__sim/reiniciar`.

No borres `data/billing-api.sqlite`: es la base entregada del administrador del ISP.

## Pruebas y tipos

```bash
npm test
npm run typecheck
```

Las pruebas usan bases SQLite temporales y verifican reglas de identificación, periodo e importes, migración desde el esquema anterior, cifrado de credenciales, simulación, importación idempotente y paginada, conciliación de pagos, anulaciones posteriores, respuestas contradictorias, exoneraciones, rollback ante fallos, recuperación por etapas, concurrencia entre conexiones, autenticación, límites de formulario y CSRF.

## Estructura principal

- `src/cobrix/sync.ts`: validación de respuestas del ISP, simulación e importación de cuotas, conciliación de pagos y registro auditable de corridas.
- `src/cobrix/store.ts`: estructura de datos Cobrix y operaciones de persistencia para configuración, clientes, contratos, facturas, eventos y corridas.
- `src/web/app.ts`: rutas y vistas del panel para resumen, configuración, sincronización, clientes, expedientes e historial.
- `src/billing-api/` y `data/billing-api.sqlite`: implementación y datos del simulador del ISP.
- [`docs/NOTA-ENTREGA.md`](docs/NOTA-ENTREGA.md): alcance de la entrega, decisiones complementarias y uso de IA.

## Resultado esperado en la base entregada

Con una base Cobrix vacía, la simulación propone 42 cuotas. La importación crea 20 clientes y 42 facturas por USD 1.235,00. El ciclo de aceptación deja 8 pagadas y 34 abiertas; el importe original de esas facturas es USD 955,00 y el saldo actual reportado por el ISP es USD 950,00 al descontar el abono parcial. El detalle de las corridas muestra cada cuota procesada, excluida o sin evidencia.
