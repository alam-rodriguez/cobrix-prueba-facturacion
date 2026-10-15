# Integración Cobrix

- `store.ts`: base SQLite propia de Cobrix, modelo de empresa/proveedor, clientes, contratos, facturas, corridas e historial.
- `sync.ts`: cliente HTTP con Axios y TanStack Query Core, login por corrida, validación de respuestas, reglas de importación e interpretación conservadora del libro de pagos. Las consultas usan caché breve y se limpian al terminar cada operación.

El panel (`src/web/app.ts`) recibe una instancia del store y del sincronizador. Las decisiones de clasificación quedan en `run_item` para que la UI y las pruebas puedan explicar por qué se importó, excluyó o mantuvo abierta cada cuota.

La especificación de comportamiento es [`docs/ENUNCIADO.md`](../../docs/ENUNCIADO.md); los detalles y rarezas de HTTP están en [`docs/API.md`](../../docs/API.md).
