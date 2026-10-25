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

export interface GenerateOptions {
	think?: boolean;
	numPredict?: number;
	keepAlive?: string;
	signal?: AbortSignal;
	onToken?: (accumulated: string) => void;
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface OllamaHealth {
	reachable: boolean;
	models: string[];
	error?: OllamaError;
}

interface GenerateResponse {
	response?: unknown;
	error?: unknown;
}

interface ChatResponse {
	message?: { content?: unknown };
	error?: unknown;
}

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

	private signalFor(userSignal?: AbortSignal): AbortSignal {
		return userSignal
			? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), userSignal])
			: AbortSignal.timeout(this.timeoutMs);
	}

	private async get(path: string): Promise<Response> {
		return this.fetchImpl(this.url(path), { signal: AbortSignal.timeout(this.timeoutMs) });
	}

	async checkHealth(): Promise<OllamaHealth> {
		try {
			const res = await this.get('/api/tags');
			if (!res.ok) {
				return { reachable: false, models: [], error: new OllamaError('httpError', `Ollama answered ${res.status} at /api/tags.`, res.status) };
			}
			const body = (await res.json()) as { models?: Array<{ name?: unknown }> };
			const models = (body.models ?? []).map(m => typeof m?.name === 'string' ? m.name : '').filter(Boolean);
			return { reachable: true, models };
		} catch (err) {
			return { reachable: false, models: [], error: this.classify(err) };
		}
	}

	async generate(model: string, system: string, prompt: string, options: GenerateOptions = {}): Promise<string> {
		const streaming = options.onToken !== undefined;
		const userSignal = options.signal;
		let res: Response;
		try {
			res = await this.fetchImpl(this.url('/api/generate'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model, system, prompt, stream: streaming,
					think: options.think ?? false,
					keep_alive: options.keepAlive ?? '10m',
					...(options.numPredict !== undefined ? { options: { num_predict: options.numPredict } } : {}),
				}),
				signal: this.signalFor(userSignal),
			});
		} catch (err) {
			throw this.classify(err, userSignal);
		}
		return streaming
			? this.handleStatus(res, model).then(r => this.readStream(r, options.onToken!, userSignal))
			: this.handleStatus(res, model).then(r => this.readJson(r));
	}

	async chat(model: string, messages: ChatMessage[], options: GenerateOptions = {}): Promise<string> {
		const streaming = options.onToken !== undefined;
		const userSignal = options.signal;
		let res: Response;
		try {
			res = await this.fetchImpl(this.url('/api/chat'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model, messages, stream: streaming,
					think: options.think ?? false,
					keep_alive: options.keepAlive ?? '10m',
					...(options.numPredict !== undefined ? { options: { num_predict: options.numPredict } } : {}),
				}),
				signal: this.signalFor(userSignal),
			});
		} catch (err) {
			throw this.classify(err, userSignal);
		}
		return streaming
			? this.handleStatus(res, model).then(r => this.readChatStream(r, options.onToken!, userSignal))
			: this.handleStatus(res, model).then(r => this.readChatJson(r));
	}

	private async handleStatus(res: Response, model: string): Promise<Response> {
		if (res.ok) {
			return res;
		}
		if (res.status === 404) {
			throw new OllamaError('modelMissing', `Model "${model}" is not available in Ollama.`, 404);
		}
		const text = await res.text().catch(() => '');
		throw new OllamaError('httpError', `Ollama answered ${res.status}: ${text.slice(0, 200)}`, res.status);
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

	private async readChatJson(res: Response): Promise<string> {
		let body: ChatResponse;
		try {
			body = (await res.json()) as ChatResponse;
		} catch {
			throw new OllamaError('malformed', 'Ollama returned a non-JSON response.');
		}
		if (typeof body.error === 'string' && body.error.length > 0) {
			throw new OllamaError('httpError', `Ollama error: ${body.error}`);
		}
		if (typeof body.message?.content !== 'string') {
			throw new OllamaError('malformed', 'Ollama chat response had no text payload.');
		}
		return body.message.content;
	}

	private async readLines(
		res: Response,
		onLine: (line: string) => void,
		userSignal?: AbortSignal,
	): Promise<void> {
		if (!res.body) {
			throw new OllamaError('malformed', 'Ollama stream had no body.');
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) if (line.trim()) onLine(line);
			}
			buffer += decoder.decode();
			if (buffer.trim()) onLine(buffer);
		} catch (err) {
			if (err instanceof OllamaError) throw err;
			throw this.classify(err, userSignal);
		} finally {
			reader.releaseLock();
		}
	}

	private async readStream(res: Response, onToken: (text: string) => void, userSignal?: AbortSignal): Promise<string> {
		let accumulated = '';
		await this.readLines(res, line => {
			let chunk: GenerateResponse;
			try { chunk = JSON.parse(line) as GenerateResponse; } catch {
				throw new OllamaError('malformed', 'Ollama returned a malformed stream chunk.');
			}
			if (typeof chunk.error === 'string' && chunk.error.length > 0) throw new OllamaError('httpError', `Ollama error: ${chunk.error}`);
			if (typeof chunk.response === 'string' && chunk.response.length > 0) {
				accumulated += chunk.response;
				onToken(accumulated);
			}
		}, userSignal);
		return accumulated;
	}

	private async readChatStream(res: Response, onToken: (text: string) => void, userSignal?: AbortSignal): Promise<string> {
		let accumulated = '';
		await this.readLines(res, line => {
			let chunk: ChatResponse;
			try { chunk = JSON.parse(line) as ChatResponse; } catch {
				throw new OllamaError('malformed', 'Ollama returned a malformed chat stream chunk.');
			}
			if (typeof chunk.error === 'string' && chunk.error.length > 0) throw new OllamaError('httpError', `Ollama error: ${chunk.error}`);
			const content = chunk.message?.content;
			if (typeof content === 'string' && content.length > 0) {
				accumulated += content;
				onToken(accumulated);
			}
		}, userSignal);
		return accumulated;
	}
}
