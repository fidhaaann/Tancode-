export type OllamaErrorKind =
	| 'unavailable'
	| 'modelMissing'
	| 'timeout'
	| 'httpError'
	| 'malformed'
	| 'cancelled';

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

// Per-request generation tuning. `numPredict` caps output length per mode
// (the single biggest latency lever after thinking), `keepAlive` keeps the
// model resident between requests, `signal` cancels stale requests when the
// user moves on, and `onToken` turns on streaming — it receives the text
// accumulated so far after every chunk.
export interface GenerateOptions {
	think?: boolean;
	numPredict?: number;
	keepAlive?: string;
	signal?: AbortSignal;
	onToken?: (accumulated: string) => void;
}

export interface OllamaHealth {
	reachable: boolean;
	models: string[];
	error?: OllamaError;
}

interface GenerateResponse {
	response?: unknown;
	thinking?: unknown;
	done?: unknown;
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

	private classify(err: unknown, userSignal?: AbortSignal): OllamaError {
		if (err instanceof OllamaError) {
			return err;
		}
		if (userSignal?.aborted) {
			return new OllamaError('cancelled', 'Request was cancelled by a newer update.');
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

	async generate(model: string, system: string, prompt: string, options: GenerateOptions = {}): Promise<string> {
		const streaming = options.onToken !== undefined;
		const userSignal = options.signal;
		const signals = userSignal
			? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), userSignal])
			: AbortSignal.timeout(this.timeoutMs);

		let res: Response;
		try {
			res = await this.fetchImpl(this.url('/api/generate'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model,
					system,
					prompt,
					stream: streaming,
					// Reasoning models (qwen3) spend most of their time on a hidden
					// thinking pass. Disabling it is several times faster for short
					// explanations; ignored by models/servers without thinking.
					think: options.think ?? false,
					// Keep the model resident between requests instead of paying
					// a load on every explanation.
					keep_alive: options.keepAlive ?? '10m',
					// Ollama generation options — capped per mode so routine
					// answers can't ramble past their useful length.
					...(options.numPredict !== undefined
						? { options: { num_predict: options.numPredict } }
						: {}),
				}),
				signal: signals,
			});
		} catch (err) {
			throw this.classify(err, userSignal);
		}

		if (!res.ok) {
			if (res.status === 404) {
				throw new OllamaError('modelMissing', `Model "${model}" is not available in Ollama.`, 404);
			}
			const text = await res.text().catch(() => '');
			throw new OllamaError('httpError', `Ollama answered ${res.status}: ${text.slice(0, 200)}`, res.status);
		}

		if (streaming) {
			return this.readStream(res, options.onToken!, userSignal);
		}
		return this.readJson(res);
	}

	private async readJson(res: Response): Promise<string> {
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

	// Ollama streams newline-delimited JSON: one object per chunk with a
	// `response` fragment, `done` on the last, and possibly a `thinking`
	// field — thinking is ignored, never rendered. Malformed chunks abort
	// the request as 'malformed' rather than silently corrupting the answer.
	private async readStream(
		res: Response,
		onToken: (accumulated: string) => void,
		userSignal?: AbortSignal,
	): Promise<string> {
		if (!res.body) {
			throw new OllamaError('malformed', 'Ollama stream had no body.');
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let accumulated = '';

		const handleLine = (line: string): void => {
			if (!line.trim()) {
				return;
			}
			let chunk: GenerateResponse;
			try {
				chunk = JSON.parse(line) as GenerateResponse;
			} catch {
				throw new OllamaError('malformed', 'Ollama returned a malformed stream chunk.');
			}
			if (typeof chunk.error === 'string' && chunk.error.length > 0) {
				throw new OllamaError('httpError', `Ollama error: ${chunk.error}`);
			}
			if (typeof chunk.response === 'string' && chunk.response.length > 0) {
				accumulated += chunk.response;
				onToken(accumulated);
			}
		};

		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					handleLine(line);
				}
			}
			buffer += decoder.decode();
			handleLine(buffer);
		} catch (err) {
			if (err instanceof OllamaError) {
				throw err;
			}
			throw this.classify(err, userSignal);
		} finally {
			reader.releaseLock();
		}
		return accumulated;
	}
}
