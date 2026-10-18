import { randomUUID } from 'node:crypto'

import { RunInProgressError, Synchronizer } from './sync.ts'
import type { Store } from './store.ts'

const LEASE_MS = 60_000
const HEARTBEAT_MS = 10_000
const MAX_ATTEMPTS = 4

interface ClaimedStage { automaticRunId: number; runDate: string; stage: 'import' | 'payments'; attempt: number; owner: string }
interface AutomaticRunRow { id: number; run_date: string; owner: string | null; lease_until: string | null }
interface AutomaticStageRow { stage: 'import' | 'payments'; status: string; attempt: number; next_retry_at: string | null }

export class AutomaticRunner {
	private readonly store: Store
	private readonly synchronizer: Synchronizer
	private readonly owner = randomUUID()
	private running = false
	constructor(store: Store, synchronizer: Synchronizer) { this.store = store; this.synchronizer = synchronizer }

	async tick(now = new Date()): Promise<void> {
		if (this.running || !this.store.getSettings().autoRunEnabled) return
		const caracas = caracasDateTime(now)
		const stage = this.claimNextStage(caracas.date, caracas.time, this.store.getSettings().autoRunTime, now)
		if (!stage) return
		this.running = true
		const heartbeat = setInterval(() => {
			try { this.renewLease(stage, new Date()) }
			catch (error) { console.error('[scheduler] no se pudo renovar el lease automático', error) }
		}, HEARTBEAT_MS)
		try {
			const runId = stage.stage === 'import'
				? await this.synchronizer.runImport(false)
				: await this.synchronizer.runPayments(false)
			const run = this.store.db.prepare('SELECT status,error FROM run WHERE id=?').get(runId) as { status: string; error: string | null }
			if (run.status !== 'completed') {
				this.failStage(stage, run.error ?? `La etapa ${stage.stage} falló.`, new Date())
				return
			}
			this.completeStage(stage, runId, new Date())
		} catch (error) {
			if (error instanceof RunInProgressError) {
				this.deferStage(stage, error.message, new Date())
				return
			}
			this.failStage(stage, error instanceof Error ? error.message : String(error), new Date())
		} finally {
			clearInterval(heartbeat)
			this.running = false
		}
	}

	async waitForIdle(): Promise<void> {
		while (this.running) await new Promise(resolve => setTimeout(resolve, 50))
	}

	private claimNextStage(today: string, time: string, scheduledTime: string, now: Date): ClaimedStage | null {
		const db = this.store.db
		db.exec('BEGIN IMMEDIATE')
		try {
			let run = db.prepare("SELECT id,run_date,owner,lease_until FROM automatic_run WHERE run_date<=? AND status IN ('pending','running') ORDER BY run_date,id LIMIT 1")
				.get(today) as AutomaticRunRow | undefined
			if (!run) {
				if (time < scheduledTime) { db.exec('COMMIT'); return null }
				const existing = db.prepare('SELECT id,status FROM automatic_run WHERE run_date=?').get(today) as { id: number; status: string } | undefined
				if (existing) { db.exec('COMMIT'); return null }
				const inserted = db.prepare("INSERT INTO automatic_run (run_date,status,started_at) VALUES (?,'pending',?)").run(today, now.toISOString())
				const id = Number(inserted.lastInsertRowid)
				db.prepare("INSERT INTO automatic_run_stage (automatic_run_id,stage,status) VALUES (?,?,'pending'), (?,?,'pending')").run(id, 'import', id, 'payments')
				run = { id, run_date: today, owner: null, lease_until: null }
			}
			if (run.owner && run.owner !== this.owner && run.lease_until && run.lease_until > now.toISOString()) { db.exec('COMMIT'); return null }
			if (run.owner && run.lease_until && run.lease_until <= now.toISOString()) {
				db.prepare("UPDATE automatic_run_stage SET status='failed',error='El proceso se interrumpió y venció su lease.',next_retry_at=? WHERE automatic_run_id=? AND status='running'").run(now.toISOString(), run.id)
			}
			const stages = db.prepare("SELECT stage,status,attempt,next_retry_at FROM automatic_run_stage WHERE automatic_run_id=? ORDER BY CASE stage WHEN 'import' THEN 0 ELSE 1 END").all(run.id) as unknown as AutomaticStageRow[]
			const next = stages.find(item => item.status !== 'completed')
			if (!next) {
				db.prepare("UPDATE automatic_run SET status='completed',finished_at=?,owner=NULL,lease_until=NULL,error=NULL WHERE id=?").run(now.toISOString(), run.id)
				db.prepare('UPDATE scheduler_state SET last_automatic_run=? WHERE id=1').run(run.run_date)
				db.exec('COMMIT')
				return null
			}
			if (next.attempt >= MAX_ATTEMPTS) {
				db.prepare("UPDATE automatic_run SET status='failed',finished_at=?,owner=NULL,lease_until=NULL,error=? WHERE id=?").run(now.toISOString(), `La etapa ${next.stage} agotó ${MAX_ATTEMPTS} intentos.`, run.id)
				db.exec('COMMIT')
				return null
			}
			if (next.next_retry_at && next.next_retry_at > now.toISOString()) {
				db.prepare("UPDATE automatic_run SET status='pending',owner=NULL,lease_until=NULL WHERE id=? AND owner=?").run(run.id, run.owner)
				db.exec('COMMIT')
				return null
			}
			const attempt = next.attempt + 1
			db.prepare("UPDATE automatic_run SET status='running',owner=?,lease_until=?,finished_at=NULL,error=NULL WHERE id=?")
				.run(this.owner, leaseUntil(now), run.id)
			db.prepare("UPDATE automatic_run_stage SET status='running',attempt=?,started_at=?,finished_at=NULL,error=NULL,next_retry_at=NULL WHERE automatic_run_id=? AND stage=?")
				.run(attempt, now.toISOString(), run.id, next.stage)
			db.exec('COMMIT')
			return { automaticRunId: run.id, runDate: run.run_date, stage: next.stage, attempt, owner: this.owner }
		} catch (error) {
			db.exec('ROLLBACK')
			throw error
		}
	}

	private renewLease(stage: ClaimedStage, now: Date): void {
		const result = this.store.db.prepare('UPDATE automatic_run SET lease_until=? WHERE id=? AND owner=? AND status=\'running\'')
			.run(leaseUntil(now), stage.automaticRunId, stage.owner)
		if (Number(result.changes) === 0) console.error('[scheduler] se perdió el lease de la corrida automática', stage.automaticRunId)
	}

	private completeStage(stage: ClaimedStage, runId: number, now: Date): void {
		const db = this.store.db
		db.exec('BEGIN IMMEDIATE')
		try {
			this.assertOwner(stage)
			db.prepare("UPDATE automatic_run_stage SET status='completed',run_id=?,finished_at=?,error=NULL,next_retry_at=NULL WHERE automatic_run_id=? AND stage=?")
				.run(runId, now.toISOString(), stage.automaticRunId, stage.stage)
			const pending = Number((db.prepare("SELECT COUNT(*) n FROM automatic_run_stage WHERE automatic_run_id=? AND status!='completed'").get(stage.automaticRunId) as { n: number }).n)
			if (pending === 0) {
				db.prepare("UPDATE automatic_run SET status='completed',finished_at=?,owner=NULL,lease_until=NULL,error=NULL WHERE id=?").run(now.toISOString(), stage.automaticRunId)
				db.prepare('UPDATE scheduler_state SET last_automatic_run=? WHERE id=1').run(stage.runDate)
			} else db.prepare("UPDATE automatic_run SET status='running',lease_until=? WHERE id=? AND owner=?").run(leaseUntil(now), stage.automaticRunId, stage.owner)
			db.exec('COMMIT')
		} catch (error) { db.exec('ROLLBACK'); throw error }
	}

	private failStage(stage: ClaimedStage, error: string, now: Date): void {
		const delay = Math.min(60_000 * 2 ** (stage.attempt - 1), 15 * 60_000)
		const retryAt = new Date(now.getTime() + delay).toISOString()
		const exhausted = stage.attempt >= MAX_ATTEMPTS
		const db = this.store.db
		db.exec('BEGIN IMMEDIATE')
		try {
			this.assertOwner(stage)
			db.prepare("UPDATE automatic_run_stage SET status='failed',finished_at=?,next_retry_at=?,error=? WHERE automatic_run_id=? AND stage=?")
				.run(now.toISOString(), exhausted ? null : retryAt, error, stage.automaticRunId, stage.stage)
			db.prepare('UPDATE automatic_run SET status=?,finished_at=?,owner=NULL,lease_until=NULL,error=? WHERE id=? AND owner=?')
				.run(exhausted ? 'failed' : 'pending', exhausted ? now.toISOString() : null, error, stage.automaticRunId, stage.owner)
			db.exec('COMMIT')
		} catch (failure) { db.exec('ROLLBACK'); throw failure }
	}

	private deferStage(stage: ClaimedStage, reason: string, now: Date): void {
		const db = this.store.db
		db.exec('BEGIN IMMEDIATE')
		try {
			this.assertOwner(stage)
			db.prepare("UPDATE automatic_run_stage SET status='pending',attempt=MAX(attempt-1,0),started_at=NULL,next_retry_at=?,error=? WHERE automatic_run_id=? AND stage=?")
				.run(new Date(now.getTime() + 30_000).toISOString(), reason, stage.automaticRunId, stage.stage)
			db.prepare("UPDATE automatic_run SET status='pending',owner=NULL,lease_until=NULL,error=? WHERE id=? AND owner=?")
				.run(reason, stage.automaticRunId, stage.owner)
			db.exec('COMMIT')
		} catch (failure) { db.exec('ROLLBACK'); throw failure }
	}

	private assertOwner(stage: ClaimedStage): void {
		const owner = this.store.db.prepare("SELECT id FROM automatic_run WHERE id=? AND owner=? AND status='running'").get(stage.automaticRunId, stage.owner)
		if (!owner) throw new Error('Se perdió el lease de la corrida automática; no se avanzó la etapa.')
	}
}

function leaseUntil(now: Date): string { return new Date(now.getTime() + LEASE_MS).toISOString() }

function caracasDateTime(date: Date): { date: string; time: string } {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
	}).formatToParts(date)
	const value = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
	return { date: `${value('year')}-${value('month')}-${value('day')}`, time: `${value('hour')}:${value('minute')}` }
}
