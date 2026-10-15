# Nota de entrega

## Decisiones

- Mantuve Node/TypeScript, el servidor web nativo y `node:sqlite`; la base Cobrix es independiente de la base del ISP. El adaptador HTTP usa Axios y `@tanstack/query-core` para centralizar las peticiones y deduplicar lecturas concurrentes sin convertir el panel server-rendered a React.
- La configuración es el único estado gestionado por Zustand: se hidrata desde SQLite al iniciar, se comparte en memoria durante la ejecución y cada actualización se persiste antes de actualizar el store.
- La importación usa `lista_ids_contratos` sin filtro de estado: la API interpreta cualquier `estado` enviado como «solo activos». Se validan filas y cuotas antes de importar; estados o formatos desconocidos no se adivinan.
- La ventana predeterminada es de 9 meses para reproducir el ciclo de aceptación, incluida la cuota antigua de Miguel. La identificación se normaliza antes de agrupar y `deuda_id` es la clave idempotente de las facturas.
- Se ignora el `success: false` del libro cuando la respuesta sí contiene `data`. Los abonos, las exoneraciones, las cuotas sin evidencia y las anulaciones no se convierten en pagos. Cada conciliación completa guarda la referencia de factura del ISP.
- Una corrida, incluida una fallida, conserva estado, resumen y una fila por cuota con su resultado y motivo. La simulación usa las mismas reglas y no escribe clientes, contratos ni facturas.
- Elegí renderizado HTML del lado del servidor con CSS propio y responsive: el panel no necesita un paso de compilación.

## Punto diferencial

El detalle de corrida funciona como una bitácora de decisión: además del resultado muestra la evidencia o regla que lo produjo y permite saltar desde una fila al expediente del cliente. La simulación de importación ofrece esa revisión antes de persistir.

## Alcance pendiente

- La contraseña se conserva en la base local de desarrollo. En producción la movería a un almacén de secretos o la cifraría con una clave fuera de la base.
- La corrida automática funciona dentro del proceso de Node; una instalación con varias réplicas debería usar un scheduler distribuido y un bloqueo por proveedor para evitar ejecuciones simultáneas.
- Con más tiempo agregaría paginación/reintentos con backoff y métricas operativas al adaptador, además de autenticación y autorización para el panel.

## Uso de IA

Usé un asistente de IA para desglosar el enunciado, proponer la estructura de persistencia y desarrollar el adaptador, el panel y las pruebas. Revisé las respuestas contra `docs/API.md`, el servidor simulado y los resultados de aceptación. Corregí especialmente la consulta de contratos (sin filtro `estado`), el uso de `success: false` con datos válidos y el valor predeterminado de la ventana: 6 meses dejaba fuera una cuota de marzo y no alcanzaba los 42 registros; 9 meses sí reproduce el resultado solicitado. También ejecuté el ciclo completo en pruebas automatizadas antes de darlo por válido.
