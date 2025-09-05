function toPeerIdString(id: unknown): string | null {
	try {
		if (id == null) return null
		// PeerId instance
		if (typeof (id as any)?.toString === 'function') return (id as any).toString()
		// Wrapped object { id: PeerId | string }
		const inner = (id as any).id
		if (inner && typeof inner.toString === 'function') return inner.toString()
		if (typeof inner === 'string') return inner
		// Raw string
		if (typeof id === 'string') return id
		return null
	} catch {
		return null
	}
}

export function peersEqual(a: unknown, b: unknown): boolean {
	const as = toPeerIdString(a)
	const bs = toPeerIdString(b)
	return as != null && bs != null && as === bs
}


