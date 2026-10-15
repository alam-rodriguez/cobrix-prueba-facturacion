/**
 * Dates as civil strings (`YYYY-MM-DD`, `YYYY-MM`) in America/Caracas, like Cobrix.
 * The "today" of the whole sandbox can be pinned with SANDBOX_TODAY to make runs repeatable.
 */

const TIME_ZONE = 'America/Caracas'

export function today(): string {
	const pinned = process.env.SANDBOX_TODAY
	if (pinned && /^\d{4}-\d{2}-\d{2}$/.test(pinned)) return pinned
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: TIME_ZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(new Date())
}

export function currentPeriod(): string {
	return today().slice(0, 7)
}

/** `2026-10` + 3 → `2027-01`. */
export function addMonths(period: string, months: number): string {
	const [year, month] = period.split('-').map(Number) as [number, number]
	const index = year * 12 + (month - 1) + months
	return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}

export function addCivilDays(date: string, days: number): string {
	const value = new Date(`${date}T00:00:00Z`)
	value.setUTCDate(value.getUTCDate() + days)
	return value.toISOString().slice(0, 10)
}

export function lastDayOfPeriod(period: string): string {
	return addCivilDays(`${addMonths(period, 1)}-01`, -1)
}

const MONTHS_ES = [
	'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
	'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

/** `2026-08` → `2026 Agosto`, the way the invoice manager labels an installment. */
export function periodLabel(period: string): string {
	const [year, month] = period.split('-').map(Number) as [number, number]
	return `${year} ${MONTHS_ES[month - 1]}`
}
