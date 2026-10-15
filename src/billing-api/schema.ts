/**
 * Database of the invoice manager as this sandbox models it. Only what the endpoints the
 * sync reads need, with the API's own field names.
 */

export const BILLING_API_SCHEMA = `
CREATE TABLE IF NOT EXISTS empresa (
	id INTEGER PRIMARY KEY,
	nombre TEXT NOT NULL,
	nombre_comercial TEXT NOT NULL,
	identificacion TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sucursal (
	id INTEGER PRIMARY KEY,
	sigla TEXT NOT NULL,
	nombre TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usuario_api (
	id INTEGER PRIMARY KEY,
	user_name TEXT NOT NULL UNIQUE,
	email TEXT NOT NULL UNIQUE,
	password TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cliente (
	id INTEGER PRIMARY KEY,
	identificacion TEXT NOT NULL,
	nombre TEXT NOT NULL,
	telefono TEXT NOT NULL,
	email TEXT NOT NULL,
	direccion TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan (
	codigo_producto TEXT PRIMARY KEY,
	nombre TEXT NOT NULL,
	precio REAL NOT NULL,
	tipo_servicio TEXT NOT NULL
);

-- estado: AP ACTIVO · CO CORTADO · CR CORTESIA · CA RETIRADO · RE RECHAZADO · AN ANULADO
CREATE TABLE IF NOT EXISTS contrato (
	id INTEGER PRIMARY KEY,
	codigo TEXT NOT NULL UNIQUE,
	id_cliente INTEGER NOT NULL REFERENCES cliente(id),
	id_sucursal INTEGER NOT NULL REFERENCES sucursal(id),
	estado TEXT NOT NULL CHECK (estado IN ('AP','CO','CR','CA','RE','AN')),
	plan TEXT NOT NULL REFERENCES plan(codigo_producto),
	moneda TEXT NOT NULL,
	moneda_sigla TEXT NOT NULL,
	fecha_contrato TEXT NOT NULL,
	dia_cobro INTEGER NOT NULL,
	dia_corte INTEGER NOT NULL,
	vendedor TEXT NOT NULL,
	-- Contracts billed in VES report USD with tiny amounts in contrato/individual.
	reporta_usd_incoherente INTEGER NOT NULL DEFAULT 0
);

-- One installment per contract and period. saldo keeps six decimals like the invoice manager.
CREATE TABLE IF NOT EXISTS cuota (
	id INTEGER PRIMARY KEY,
	id_contrato INTEGER NOT NULL REFERENCES contrato(id),
	periodo TEXT NOT NULL,
	tipo TEXT NOT NULL DEFAULT 'M',
	tarifa REAL NOT NULL,
	valor_pago REAL NOT NULL DEFAULT 0,
	descuento REAL NOT NULL DEFAULT 0,
	saldo REAL NOT NULL,
	id_detalle INTEGER NOT NULL,
	-- An old installment that pago_informacion lists and no other endpoint counts.
	fantasma INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS factura (
	id INTEGER PRIMARY KEY,
	num_factura TEXT NOT NULL,
	id_contrato INTEGER NOT NULL REFERENCES contrato(id),
	fecha_emision TEXT NOT NULL,
	anulada INTEGER NOT NULL DEFAULT 0,
	referencia TEXT
);

-- What each invoice paid on each installment.
CREATE TABLE IF NOT EXISTS factura_cuota (
	id_factura INTEGER NOT NULL REFERENCES factura(id),
	id_cuota INTEGER NOT NULL REFERENCES cuota(id),
	monto REAL NOT NULL,
	PRIMARY KEY (id_factura, id_cuota)
);

CREATE INDEX IF NOT EXISTS cuota_contrato ON cuota(id_contrato, periodo);
CREATE INDEX IF NOT EXISTS factura_cuota_cuota ON factura_cuota(id_cuota);
`
