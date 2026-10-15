import { DatabaseSync } from 'node:sqlite'
import { createStore as createZustandStore } from 'zustand/vanilla'

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
export interface RunItem { contractId: number | null; customerId: string | null; debtId: string | null; period: string | null; amount: number; result: string; reason: string }
export interface RunSummary { total: number; imported?: number; alreadyImported?: number; excluded?: number; throttled?: number; markedPaid?: number; partial?: number; noEvidence?: number; errors?: number }

interface ConfigurationState {
	settings: Settings
	replaceSettings(settings: Settings): void
}

export function createStore(path = ':memory:') {
	const db = new DatabaseSync(path)
	db.exec(`PRAGMA foreign_keys = ON;
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
	INSERT OR IGNORE INTO scheduler_state (id,last_automatic_run) VALUES (1,'');`)
	if (!db.prepare('SELECT id FROM settings WHERE id=1').get()) {
		db.prepare('INSERT INTO settings (id,value) VALUES (1,?)').run(JSON.stringify(DEFAULT_SETTINGS))
	}
	const storedSettings = JSON.parse(String((db.prepare('SELECT value FROM settings WHERE id=1').get() as { value: string }).value)) as Settings
	const configuration = createZustandStore<ConfigurationState>()(set => ({
		settings: storedSettings,
		replaceSettings: settings => set({ settings }),
	}))
	return {
		db,
		getSettings(): Settings { return configuration.getState().settings },
		saveSettings(value: Settings): void {
			db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(value))
			configuration.getState().replaceSettings(value)
		},
		configuration,
		getLastAutomaticRunDate(): string { return String((db.prepare('SELECT last_automatic_run FROM scheduler_state WHERE id=1').get() as { last_automatic_run: string }).last_automatic_run) },
		setLastAutomaticRunDate(date: string): void { db.prepare('UPDATE scheduler_state SET last_automatic_run=? WHERE id=1').run(date) },
		close(): void { db.close() },
	}
}

export type Store = ReturnType<typeof createStore>
