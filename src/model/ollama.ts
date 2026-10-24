export type OllamaErrorKind =
	| 'unavailable'
	| 'modelMissing'
	| 'timeout'
	| 'httpError'
	| 'malformed';

export class OllamaError extends Error {
	readonly kind: OllamaErrorKind;
	readonly status?: number;

	constructor(kind: OllamaErrorKind, message: string, status?: number) {
		super(message);
		this.name = 'OllamaError';
		this.kind = kind;
		this.status = status;
	}
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface OllamaHealth {
	reachable: boolean;
	models: string[];
	error?: OllamaError;
}

interface GenerateResponse {
	response?: unknown;
	error?: unknown;
}

interface TagsResponse {
	models?: Array<{ name?: unknown }>;
}

// Thin client for Ollama's local HTTP API. fetch is injected so unit tests
// can run without a live server.
export class OllamaClient {
	constructor(
		public readonly baseUrl: string,
		private readonly timeoutMs: number,
		private readonly fetchImpl: FetchImpl = fetch,
		) {}

	private url(path: string): string {
		return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
	}

	private classify(err: unknown): OllamaError {
		if (err instanceof OllamaError) {
			return err;
		}
		const name = (err as { name?: string })?.name ?? '';
		const code = (err as { cause?: { code?: string } })?.cause?.code ?? '';
		if (name === 'TimeoutError' || name === 'AbortError') {
			return new OllamaError('timeout', `Request timed out after ${this.timeoutMs}ms.`);
		}
		if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
			return new OllamaError('unavailable', `Cannot connect to Ollama at ${this.baseUrl}.`);
		}
		return new OllamaError('unavailable', `Cannot reach Ollama at ${this.baseUrl}: ${(err as Error)?.message ?? String(err)}`);
	}

	private async get(path: string): Promise<Response> {
		return this.fetchImpl(this.url(path), {
			signal: AbortSignal.timeout(this.timeoutMs),
		});
	}

	async checkHealth(): Promise<OllamaHealth> {
		try {
			const res = await this.get('/api/tags');
			if (!res.ok) {
				return { reachable: false, models: [], error: new OllamaError('httpError', `Ollama answered ${res.status} at /api/tags.`, res.status) };
			}
			const body = (await res.json()) as TagsResponse;
			const models = (body.models ?? [])
				.map(m => (typeof m?.name === 'string' ? m.name : ''))
				.filter(Boolean);
			return { reachable: true, models };
		} catch (err) {
			return { reachable: false, models: [], error: this.classify(err) };
		}
	}

	async generate(model: string, system: string, prompt: string): Promise<string> {
		let res: Response;
		try {
			res = await this.fetchImpl(this.url('/api/generate'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model,
					system,
					prompt,
					stream: false,
					// Reasoning models (qwen3) spend most of their time on a hidden
					// thinking pass. Disabling it is several times faster for short
					// explanations; ignored by models/servers without thinking.
					think: false,
				}),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (err) {
			throw this.classify(err);
		}

		if (!res.ok) {
			if (res.status === 404) {
				throw new OllamaError('modelMissing', `Model "${model}" is not available in Ollama.`, 404);
			}
			const text = await res.text().catch(() => '');
			throw new OllamaError('httpError', `Ollama answered ${res.status}: ${text.slice(0, 200)}`, res.status);
		}

		let body: GenerateResponse;
		try {
			body = (await res.json()) as GenerateResponse;
		} catch {
			throw new OllamaError('malformed', 'Ollama returned a non-JSON response.');
		}
		if (typeof body.error === 'string' && body.error.length > 0) {
			throw new OllamaError('httpError', `Ollama error: ${body.error}`);
		}
		if (typeof body.response !== 'string') {
			throw new OllamaError('malformed', 'Ollama response had no text payload.');
		}
		return body.response;
	}
}
