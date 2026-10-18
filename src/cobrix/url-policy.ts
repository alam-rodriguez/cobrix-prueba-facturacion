import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
	return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

function isPrivateAddress(address: string): boolean {
	const value = address.toLowerCase().split('%')[0] ?? address.toLowerCase()
	if (isIP(value) === 4) {
		const octets = value.split('.').map(Number)
		const a = octets[0] ?? 0
		const b = octets[1] ?? 0
		const c = octets[2] ?? 0
		return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || (a === 100 && b >= 64 && b <= 127) || a >= 224
	}
	if (isIP(value) === 6) {
		if (value === '::' || value === '::1') return true
		if (/^(fc|fd|fe[89ab])/i.test(value)) return true
		const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
		if (mapped) return isPrivateAddress(mapped[1]!)
		const mappedHex = value.match(/^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/i)
		if (mappedHex) {
			const high = Number.parseInt(mappedHex[1]!,16)
			const low = Number.parseInt(mappedHex[2]!,16)
			return isPrivateAddress(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`)
		}
		return /^2001:db8:/i.test(value)
	}
	return true
}

export async function validateBillingApiUrl(value: string): Promise<URL> {
	let url: URL
	try { url = new URL(value) } catch { throw new Error('La URL del administrador no es válida.') }
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
		throw new Error('La URL del administrador debe ser un origen HTTP(S) sin credenciales, ruta, parámetros ni fragmento.')
	}
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
	if (!hostname) throw new Error('La URL del administrador no contiene un host.')
	const local = isLoopbackHost(hostname)
	if (url.protocol === 'http:' && !local) throw new Error('Se requiere HTTPS para conectarse a un administrador remoto.')
	const allowlist = (process.env.COBRIX_API_HOSTS ?? '').split(',').map(host => host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')).filter(Boolean)
	const allowlisted = url.port ? allowlist.includes(`${hostname}:${url.port}`) : allowlist.includes(hostname)
	if (!local && !allowlist.length) throw new Error('Define COBRIX_API_HOSTS antes de configurar un administrador remoto.')
	if (!local && !allowlisted) throw new Error(`El origen ${url.host} no está en COBRIX_API_HOSTS.`)
	if (isIP(hostname)) {
		if (!local && !allowlisted && isPrivateAddress(hostname)) throw new Error('El host del administrador apunta a una red privada no permitida.')
	} else {
		let addresses: Array<{ address: string; family: number }>
		try { addresses = await lookup(hostname, { all: true, verbatim: true }) }
		catch { throw new Error(`No se pudo resolver el host del administrador: ${hostname}.`) }
		if (!addresses.length) throw new Error(`El host del administrador no tiene direcciones DNS: ${hostname}.`)
		if (!local && !allowlisted && addresses.some(result => isPrivateAddress(result.address))) {
			throw new Error('El host del administrador resuelve a una red privada no permitida.')
		}
	}
	return url
}

export function isLoopbackBind(host: string): boolean {
	return isLoopbackHost(host)
}
