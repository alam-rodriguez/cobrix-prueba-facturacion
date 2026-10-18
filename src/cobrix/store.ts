import { DatabaseSync } from 'node:sqlite'
import { createStore as createZustandStore } from 'zustand/vanilla'
import { decodeSettings, encodeSettings, hasSettingsEncryptionKey, settingsPasswordIsEncrypted } from './secrets.ts'

export interface Settings {
	companyName: string
	companyTaxId: string
	collectionsEmail: string
	apiUrl: string
	apiUser: string
	apiPassword: string
	importStatuses: string[]
	windowMonths: number | null
	maxRecentInstallments: number | null
	graceDays: number
	maxInvoicesPerRun: number | null
	maxAmountPerRun: number | null
	excludedDocumentTypes: string[]
	autoRunEnabled: boolean
	autoRunTime: string
}

export const DEFAULT_SETTINGS: Settings = {
	companyName: 'Cobrix Demo', companyTaxId: '', collectionsEmail: '',
	apiUrl: 'http://127.0.0.1:4310', apiUser: 'cobrix', apiPassword: 'cobrix-sandbox',
	importStatuses: ['ACTIVO', 'CORTADO'], windowMonths: 9, maxRecentInstallments: null,
	graceDays: 5, maxInvoicesPerRun: null, maxAmountPerRun: null,
	excludedDocumentTypes: [], autoRunEnabled: false, autoRunTime: '02:00',
}

export type RunKind = 'import' | 'payments'
export interface RunItem {
	contractId: number | null; customerId: string | null; debtId: string | null; period: string | null
	amount: number; result: string; reason: string; observedBalance?: number | null; observedPaid?: number | null
}
export interface RunSummary {
	total: number; imported?: number; alreadyImported?: number; excluded?: number; throttled?: number
	markedPaid?: number; partial?: number; pending?: number; missingFromLedger?: number
	exonerated?: number; inconsistent?: number; noEvidence?: number; unapplied?: number; errors?: number
	reopened?: number; noCurrentEvidence?: number; preImportPaid?: number
}

const MIGRATIONS: readonly { version: number; sql: string }[] = [
	{ version: 1, sql: `
		CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS customer (
			id TEXT PRIMARY KEY, name TEXT NOT NULL, document_type TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL,
			origin TEXT NOT NULL DEFAULT 'Administrador ISP', created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS contract (
			id INTEGER PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customer(id), name TEXT NOT NULL,
			status TEXT NOT NULL, plan TEXT NOT NULL, price_minor INTEGER NOT NULL, branch TEXT NOT NULL, currency TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS invoice (
			id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, contract_id INTEGER NOT NULL REFERENCES contract(id),
			customer_id TEXT NOT NULL REFERENCES customer(id), period TEXT NOT NULL, due_date TEXT NOT NULL, cutoff_date TEXT NOT NULL,
			amount_minor INTEGER NOT NULL, balance_minor INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', paid_at TEXT
		);
		CREATE TABLE IF NOT EXISTS run (
			id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, simulated INTEGER NOT NULL, status TEXT NOT NULL,
			started_at TEXT NOT NULL, finished_at TEXT NOT NULL, summary TEXT NOT NULL, error TEXT
		);
		CREATE TABLE IF NOT EXISTS run_item (
			id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
			contract_id INTEGER, customer_id TEXT, debt_id TEXT, period TEXT, amount_minor INTEGER NOT NULL,
			result TEXT NOT NULL, reason TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS event (
			id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL REFERENCES customer(id), invoice_id INTEGER,
			created_at TEXT NOT NULL, type TEXT NOT NULL, description TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS scheduler_state (
			id INTEGER PRIMARY KEY CHECK (id = 1), last_automatic_run TEXT NOT NULL DEFAULT ''
		);
		INSERT OR IGNORE INTO scheduler_state (id,last_automatic_run) VALUES (1,'');
	` },
	{ version: 2, sql: `
		CREATE TABLE IF NOT EXISTS run_lock (
			id INTEGER PRIMARY KEY CHECK (id = 1), run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
			owner TEXT NOT NULL UNIQUE, lease_until TEXT NOT NULL
		);
	` },
	{ version: 3, sql: `
		ALTER TABLE invoice ADD COLUMN provider_balance_minor INTEGER;
		ALTER TABLE invoice ADD COLUMN provider_paid_minor INTEGER NOT NULL DEFAULT 0;
		ALTER TABLE run_item ADD COLUMN observed_balance_minor INTEGER;
		ALTER TABLE run_item ADD COLUMN observed_paid_minor INTEGER;
		CREATE TABLE IF NOT EXISTS automatic_run (
			id INTEGER PRIMARY KEY AUTOINCREMENT, run_date TEXT NOT NULL UNIQUE,
			status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
			owner TEXT, lease_until TEXT, started_at TEXT NOT NULL, finished_at TEXT, error TEXT
		);
		CREATE TABLE IF NOT EXISTS automatic_run_stage (
			automatic_run_id INTEGER NOT NULL REFERENCES automatic_run(id) ON DELETE CASCADE,
			stage TEXT NOT NULL CHECK (stage IN ('import','payments')),
			status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
			attempt INTEGER NOT NULL DEFAULT 0, started_at TEXT, finished_at TEXT, next_retry_at TEXT,
			run_id INTEGER REFERENCES run(id), error TEXT,
			PRIMARY KEY (automatic_run_id, stage)
		);
		CREATE INDEX IF NOT EXISTS invoice_status_contract_period ON invoice(status,contract_id,period);
		CREATE INDEX IF NOT EXISTS run_item_run_id ON run_item(run_id,id);
		CREATE INDEX IF NOT EXISTS event_customer_id ON event(customer_id,id);
		UPDATE invoice SET status='open',balance_minor=amount_minor WHERE status='paid' AND paid_at IS NULL;
		CREATE TRIGGER IF NOT EXISTS invoice_validate_insert BEFORE INSERT ON invoice
		WHEN NEW.status NOT IN ('open','paid','exempt') OR NEW.amount_minor < 0 OR NEW.balance_minor < 0 OR NEW.balance_minor > NEW.amount_minor
			OR (NEW.provider_balance_minor IS NOT NULL AND (NEW.provider_balance_minor < 0 OR NEW.provider_balance_minor > NEW.amount_minor))
			OR NEW.provider_paid_minor < 0
			OR (NEW.status = 'paid' AND NEW.paid_at IS NULL)
			OR (NEW.status != 'paid' AND NEW.paid_at IS NOT NULL)
		BEGIN SELECT RAISE(ABORT, 'invoice invariant violation'); END;
		CREATE TRIGGER IF NOT EXISTS invoice_validate_update BEFORE UPDATE ON invoice
		WHEN NEW.status NOT IN ('open','paid','exempt') OR NEW.amount_minor < 0 OR NEW.balance_minor < 0 OR NEW.balance_minor > NEW.amount_minor
			OR (NEW.provider_balance_minor IS NOT NULL AND (NEW.provider_balance_minor < 0 OR NEW.provider_balance_minor > NEW.amount_minor))
			OR NEW.provider_paid_minor < 0
			OR (NEW.status = 'paid' AND NEW.paid_at IS NULL)
			OR (NEW.status != 'paid' AND NEW.paid_at IS NOT NULL)
		BEGIN SELECT RAISE(ABORT, 'invoice invariant violation'); END;
		CREATE TRIGGER IF NOT EXISTS invoice_contract_customer_insert BEFORE INSERT ON invoice
		WHEN (SELECT customer_id FROM contract WHERE id=NEW.contract_id) IS NOT NEW.customer_id
		BEGIN SELECT RAISE(ABORT, 'invoice customer must match contract customer'); END;
		CREATE TRIGGER IF NOT EXISTS invoice_contract_customer_update BEFORE UPDATE OF contract_id,customer_id ON invoice
		WHEN (SELECT customer_id FROM contract WHERE id=NEW.contract_id) IS NOT NEW.customer_id
		BEGIN SELECT RAISE(ABORT, 'invoice customer must match contract customer'); END;
		CREATE TRIGGER IF NOT EXISTS contract_validate_insert BEFORE INSERT ON contract
		WHEN NEW.status NOT IN ('ACTIVO','CORTADO','CORTESIA','RETIRADO','RECHAZADO','ANULADO') OR NEW.price_minor <= 0 OR NEW.currency != 'USD'
		BEGIN SELECT RAISE(ABORT, 'contract invariant violation'); END;
		CREATE TRIGGER IF NOT EXISTS contract_validate_update BEFORE UPDATE ON contract
		WHEN NEW.status NOT IN ('ACTIVO','CORTADO','CORTESIA','RETIRADO','RECHAZADO','ANULADO') OR NEW.price_minor <= 0 OR NEW.currency != 'USD'
		BEGIN SELECT RAISE(ABORT, 'contract invariant violation'); END;
		CREATE TRIGGER IF NOT EXISTS contract_customer_immutable_with_invoices BEFORE UPDATE OF customer_id ON contract
		WHEN NEW.customer_id IS NOT OLD.customer_id AND EXISTS (SELECT 1 FROM invoice WHERE contract_id=OLD.id)
		BEGIN SELECT RAISE(ABORT, 'contract customer change requires invoice reassignment'); END;
		CREATE TRIGGER IF NOT EXISTS run_item_validate_insert BEFORE INSERT ON run_item
		WHEN NEW.amount_minor < 0 OR NEW.result = '' OR NEW.reason = ''
		BEGIN SELECT RAISE(ABORT, 'run item invariant violation'); END;
		CREATE TRIGGER IF NOT EXISTS event_invoice_customer_insert BEFORE INSERT ON event
		WHEN NEW.invoice_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM invoice WHERE id=NEW.invoice_id AND customer_id=NEW.customer_id
		)
		BEGIN SELECT RAISE(ABORT, 'event invoice must match customer'); END;
	` },
]

function migrate(db: ReturnType<typeof openDatabase>): void {
	db.exec('PRAGMA foreign_keys = ON')
	let version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
	if (version > MIGRATIONS.at(-1)!.version) throw new Error(`La base Cobrix usa una versión de esquema futura (${version}).`)
	for (const migration of MIGRATIONS) {
		if (migration.version <= version) continue
		db.exec('BEGIN IMMEDIATE')
		try {
			db.exec(migration.sql)
			db.exec(`PRAGMA user_version = ${migration.version}`)
			db.exec('COMMIT')
			version = migration.version
		} catch (error) {
			db.exec('ROLLBACK')
			throw new Error(`Falló la migración Cobrix ${migration.version}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}
}

function openDatabase(path: string) {
	return new DatabaseSync(path)
}

interface ConfigurationState {
	settings: Settings
	replaceSettings(settings: Settings): void
}

export function createStore(path = ':memory:') {
	const db = openDatabase(path)
	try { migrate(db) } catch (error) { db.close(); throw error }
	if (!db.prepare('SELECT id FROM settings WHERE id=1').get()) {
		db.prepare('INSERT INTO settings (id,value) VALUES (1,?)').run(encodeSettings(DEFAULT_SETTINGS))
	}
	const settingsValue = String((db.prepare('SELECT value FROM settings WHERE id=1').get() as { value: string }).value)
	const storedSettings = decodeSettings(settingsValue)
	if (hasSettingsEncryptionKey() && !settingsPasswordIsEncrypted(settingsValue)) db.prepare('UPDATE settings SET value=? WHERE id=1').run(encodeSettings(storedSettings))
	const configuration = createZustandStore<ConfigurationState>()(set => ({
		settings: storedSettings,
		replaceSettings: settings => set({ settings }),
	}))
	return {
		db,
		getSettings(): Settings { return configuration.getState().settings },
		saveSettings(value: Settings): void {
			db.prepare('UPDATE settings SET value=? WHERE id=1').run(encodeSettings(value))
			configuration.getState().replaceSettings(value)
		},
		configuration,
		getLastAutomaticRunDate(): string { return String((db.prepare('SELECT last_automatic_run FROM scheduler_state WHERE id=1').get() as { last_automatic_run: string }).last_automatic_run) },
		setLastAutomaticRunDate(date: string): void { db.prepare('UPDATE scheduler_state SET last_automatic_run=? WHERE id=1').run(date) },
		close(): void { db.close() },
	}
}

export type Store = ReturnType<typeof createStore>
