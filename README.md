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

| Servicio | Dirección |
| --- | --- |
| Panel Cobrix | http://127.0.0.1:4300 |
| API simulada del ISP | http://127.0.0.1:4310/api/v1 |
| Swagger y simulador de caja | http://127.0.0.1:4310/docs |

Credenciales iniciales del ISP: usuario `cobrix`, contraseña `cobrix-sandbox`. La fecha del sandbox queda fijada en `2026-10-13` para reproducir los criterios de aceptación. El panel y sus datos Cobrix se guardan en `data/cobrix.sqlite`, independiente de la base del ISP. Para usar otra ruta: `COBRIX_DB=/ruta/al/archivo.sqlite npm start`.

## Operación

1. En **Configuración**, ajusta empresa, URL y credenciales del proveedor, estados importables, ventana, límites y gracia. Las credenciales se editan con campo vacío para conservar la contraseña guardada.
2. En **Sincronización**, ejecuta primero **Simular importación** para revisar las cuotas y motivos; luego importa.
3. Registra cobros de prueba desde la sección **Simulador** de Swagger (`POST /__sim/pagar`, `POST /__sim/anular`).
4. Ejecuta **Simular actualización** y después **Actualizar pagadas**. Una cuota solo se cierra con saldo cero y evidencia de pago coincidente en el libro.
5. Consulta el resultado en el historial y abre cualquier cliente para revisar contratos, facturas y actividad.

La corrida automática se configura por día y hora de Caracas. El proceso de Node la ejecuta mientras el servicio esté activo. Para reiniciar el administrador a su estado original, usa `POST /__sim/reiniciar` en Swagger; esto no borra los datos ya importados en Cobrix.

La fecha de la última corrida automática queda persistida en la base Cobrix para evitar que un reinicio repita la corrida del mismo día. Si se activa o inicia el proceso después de la hora programada y todavía no hubo corrida ese día, ejecuta una recuperación.

## Decisiones críticas

- Elegí Node.js con TypeScript y el servidor web nativo para mantener una aplicación sencilla de ejecutar y sin paso de compilación. Mantengo los datos de Cobrix en una base SQLite independiente y consulto el ISP solo por HTTP, para no acoplar ni modificar su base. Elegí Axios para centralizar las peticiones HTTP, TanStack Query Core para reutilizar y deduplicar lecturas concurrentes, y Zustand vanilla porque solo necesito un estado compartido pequeño para la configuración, que persisto en SQLite.
- Normalizo los documentos y uso `deuda_id` como identificador estable de cada cuota para evitar duplicados al repetir una importación. Consulto los contratos sin filtro de estado —la API lo interpreta como «solo activos»—. La ventana predeterminada de nueve meses permite incluir las cuotas históricas contempladas en el conjunto de datos de prueba. Con la base inicial, la simulación propone 42 cuotas.
- Solo marco una factura como pagada cuando todas las filas de su cuota coinciden, el saldo es cero y existe un monto pagado mayor que cero. Los abonos parciales, exoneraciones, anulaciones, filas contradictorias y cuotas sin evidencia no se convierten en pagos completos.
- En `pago_informacion`, `success: false` es una particularidad documentada de la API: también aparece en respuestas que contienen el libro en `data` ([contrato de la API](docs/API.md#34-libro-de-cuotas-y-pagos)). Por eso no uso ese booleano como señal de error para este endpoint, ni extiendo esta excepción a las demás rutas. Primero exijo una respuesta HTTP exitosa y que `data` sea una lista; agrupo las filas por `id_cuota`, compruebo que correspondan a la cuota y al contrato consultados, y verifico que coincidan entre sí el identificador, periodo, saldo y monto pagado. Solo después aplico las reglas de conciliación. Si falla la petición HTTP —incluidos errores de autenticación o conexión—, falta `data` o su forma no es válida, la corrida se registra como fallida. Si faltan filas o son contradictorias, la factura queda abierta y sin evidencia; para una cuota del mes en curso que no aparece, consulto el contrato antes de concluir que sigue pendiente.
- La simulación usa estas mismas reglas sin escribir datos en Cobrix, y cada corrida conserva su resultado y el motivo por cuota.
- Programé la ejecución automática por día y hora de Caracas. Persisto la fecha de la última corrida para evitar repetirla tras un reinicio y recuperar la ejecución del día si el proceso inicia tarde.
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

Las pruebas usan bases SQLite temporales y verifican reglas de identificación y periodo, simulación sin escrituras, importación idempotente, exclusiones y monedas, ciclo importar → pagar → conciliar, pagos parciales/anulados, registro de errores y pantallas principales.

## Estructura principal

- `src/cobrix/sync.ts`: validación de respuestas del ISP, simulación e importación de cuotas, conciliación de pagos y registro auditable de corridas.
- `src/cobrix/store.ts`: estructura de datos Cobrix y operaciones de persistencia para configuración, clientes, contratos, facturas, eventos y corridas.
- `src/web/app.ts`: rutas y vistas del panel para resumen, configuración, sincronización, clientes, expedientes e historial.
- `src/billing-api/` y `data/billing-api.sqlite`: implementación y datos del simulador del ISP.
- [`docs/NOTA-ENTREGA.md`](docs/NOTA-ENTREGA.md): alcance de la entrega, decisiones complementarias y uso de IA.

## Resultado esperado en la base entregada

Con una base Cobrix vacía, la simulación propone 42 cuotas. La importación crea 20 clientes y 42 facturas abiertas por USD 1.235,00; el ciclo de pagos de aceptación deja 8 pagadas y 34 abiertas por USD 955,00. El detalle de las corridas muestra cada cuota procesada, excluida o sin evidencia.
