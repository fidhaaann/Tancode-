// In-memory explanation cache. Keyed by file identity + content version +
// model + mode so stale or differently-configured results never collide.
// Unbounded growth is prevented with a simple LRU eviction.
export class ExplanationCache<T> {
	private readonly map = new Map<string, T>();

	constructor(private readonly maxEntries = 100) {}

	static key(uri: string, version: number, model: string, mode: string): string {
		return `${uri}#v${version}@${model}:${mode}`;
	}

	get(key: string): T | undefined {
		const value = this.map.get(key);
		if (value !== undefined) {
			// Refresh recency for LRU eviction.
			this.map.delete(key);
			this.map.set(key, value);
		}
		return value;
	}

	set(key: string, value: T): void {
		this.map.set(key, value);
		while (this.map.size > this.maxEntries) {
			const oldest = this.map.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.map.delete(oldest);
		}
	}

	get size(): number {
		return this.map.size;
	}

	clear(): void {
		this.map.clear();
	}
}
