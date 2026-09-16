import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, LoadAPIKeyError, NoObjectGeneratedError } from 'ai';

/**
 * Free inference is three APIs, not one. Groq, NVIDIA NIM and OpenRouter's
 * `:free` routes all speak OpenAI chat completions, and each one runs out on
 * its own clock: a request that dies on a 429 at OpenRouter answers in
 * under a second at Groq. So every model is addressed `provider:id` and each
 * role has a chain over all three.
 *
 * A bare id means openrouter, which keeps every id and env value written
 * before this file valid.
 */
const endpoint = (
	name: string,
	label: string,
	baseURL: string,
	envKey: string,
	headers?: Record<string, string>,
) => {
	// Read once, here: a provider whose key is absent is dropped from every
	// chain instead of failing at call time, so a half-configured .env.local
	// degrades to the providers that do work.
	const apiKey = process.env[envKey];
	return {
		label,
		envKey,
		apiKey,
		sdk: createOpenAI({ name, baseURL, apiKey, headers }),
	};
};

export const providers = {
	openrouter: endpoint(
		'openrouter',
		'OpenRouter free',
		'https://openrouter.ai/api/v1',
		'OPENROUTER_API_KEY',
		{
			'HTTP-Referer': 'http://localhost:3000',
			'X-Title': 'job-agent (DACH)',
		},
	),
	groq: endpoint(
		'groq',
		'Groq',
		'https://api.groq.com/openai/v1',
		'GROQ_API_KEY',
	),
	nim: endpoint(
		'nim',
		'NVIDIA NIM',
		'https://integrate.api.nvidia.com/v1',
		'NVIDIA_API_KEY',
	),
};

export type ProviderName = keyof typeof providers;
export const PROVIDER_NAMES = Object.keys(providers) as ProviderName[];

/** `groq:openai/gpt-oss-120b` → that model at Groq. Unknown prefix → openrouter. */
export type Spec = { provider: ProviderName; id: string; label: string };

const parse = (spec: string): Spec => {
	const [head, ...rest] = spec.split(':');
	// `poolside/laguna-s-2.1:free` has a colon too — the tier suffix. Only a
	// colon in a prefix without a slash addresses a provider.
	const name =
		rest.length && !head.includes('/') && head in providers
			? (head as ProviderName)
			: 'openrouter';
	const id = rest.length && name === head ? rest.join(':') : spec;
	return { provider: name, id, label: `${providers[name].label} · ${id}` };
};

export type Role = 'plan' | 'review' | 'judge';

const ROLE_ENV: Record<Role, string> = {
	plan: 'SEARCH_MODEL',
	review: 'SUMMARY_MODEL',
	judge: 'JUDGE_MODEL',
};

/**
 * Ids per role and provider, best-first within each. Not interchangeable:
 * the planner needs a reliable tool call, the reviewer needs to hold ~45k
 * chars of job text and still resist inventing a URL.
 */
const CHAINS: Record<Role, Record<ProviderName, string[]>> = {
	plan: {
		groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
		nim: [
			// Last resort, and qualified: probed three times on the real prompt, this
			// got the action right every time and the queries twice — the third run
			// answered `["(", "", ""]`, which planSchema's per-query minimum now
			// rejects so the chain moves on. At ~9-10s a call it only earns its place
			// once Groq is spent. `nemotron-3-nano-omni-30b-a3b-reasoning` is absent
			// because it never answered this prompt at all: prose with no tool call
			// (22s) or a 503.
			'nvidia/nemotron-3-super-120b-a12b',
		],
		openrouter: [
			'nex-agi/nex-n2.5-mini:free',
			'poolside/laguna-s-2.1:free',
			'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
		],
	},
	review: {
		// Empty on purpose, and measured: Groq's free tier allows 8000 tokens per
		// minute and the reviewer's ~42k chars of job pages ask for 18090, so every
		// review call there dies with a 413. NIM reads the same pages in 15s.
		groq: [],
		nim: [
			'nvidia/nemotron-3-ultra-550b-a55b',
			'nvidia/nemotron-3-super-120b-a12b',
		],
		openrouter: [
			'nvidia/nemotron-3-ultra-550b-a55b:free',
			'nvidia/nemotron-3-super-120b-a12b:free',
			'dots-studio/dots-3-note-preview:free',
		],
	},
	judge: {
		// Empty on purpose. Groq's only judge-grade model is the one the planner
		// runs on, and a judge that grades its own answers proves nothing — so the
		// chain starts at NIM.
		groq: [],
		nim: ['nvidia/nemotron-3-ultra-550b-a55b'],
		openrouter: ['nvidia/nemotron-3-ultra-550b-a55b:free'],
	},
};

/** Auto order. Groq first: fastest, roomiest free tier, and it leaves the
 *  OpenRouter daily budget for the models that only exist there. */
const AUTO: ProviderName[] = ['groq', 'nim', 'openrouter'];

/**
 * The chain a role runs, in the order to try it. `preferred` is the UI's
 * provider choice and reorders rather than filters: picking a provider should
 * not delete the fallbacks behind it. An env list, if set, wins outright and
 * is only reordered.
 */
export function chain(role: Role, preferred?: string): Spec[] {
	const configured = (process.env[ROLE_ENV[role]] ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	const specs = configured.length
		? configured.map(parse)
		: (preferred ? [preferred, ...AUTO.filter((p) => p !== preferred)] : AUTO)
				.filter((p): p is ProviderName => isProviderName(p))
				.flatMap((p) => CHAINS[role][p].map((id) => parse(`${p}:${id}`)));

	const ordered = preferred
		? [
				...specs.filter((s) => s.provider === preferred),
				...specs.filter((s) => s.provider !== preferred),
			]
		: specs;

	return ordered.filter((s) => providers[s.provider].apiKey);
}

export const isProviderName = (v: unknown): v is ProviderName =>
	typeof v === 'string' && v in providers;

export const languageModel = (spec: Spec) =>
	providers[spec.provider].sdk.chat(spec.id);

/** What a single try cost the user, in words the UI can print directly. */
export type AttemptKind =
	| 'ok'
	| 'rate-limit'
	| 'too-big'
	| 'unavailable'
	| 'no-answer'
	| 'bad-answer'
	| 'key'
	| 'error';

export type Attempt = {
	provider: ProviderName;
	model: string;
	ms: number;
	ok: boolean;
	kind: AttemptKind;
	note: string;
	status?: number;
};

/**
 * The free tiers fail in distinguishable ways and the distinction is what the
 * user acts on: a rate limit clears in a minute, a dead upstream needs a
 * different provider, and "no answer" means that model cannot do tool calls
 * and is worthless in the chain at all.
 */
export function classify(e: unknown): { kind: AttemptKind; note: string; status?: number } {
	if (NoObjectGeneratedError.isInstance(e)) {
		// The SDK raises this with three different messages. Only one of them
		// means "prose instead of a tool call" — the others are a model that
		// tried and answered in a shape the schema refuses, which is worth
		// seeing separately because that model is nearly right, not useless.
		return /did not return a response/.test(e.message)
			? { kind: 'no-answer', note: 'antwortet ohne Tool-Call' }
			: { kind: 'bad-answer', note: 'Antwort passt nicht ins Schema' };
	}
	if (LoadAPIKeyError.isInstance(e))
		return { kind: 'key', note: 'Key fehlt' };

	const api = APICallError.isInstance(e) ? e : undefined;
	const status = api?.statusCode;
	const text = `${api?.message ?? ''} ${api?.responseBody ?? ''} ${
		e instanceof Error ? e.message : String(e)
	}`.toLowerCase();

	if (status === 401 || status === 403)
		return { kind: 'key', note: 'Zugriff abgelehnt', status };
	if (status === 402) return { kind: 'key', note: 'Budget aufgebraucht', status };
	// Groq counts prompt size against its per-minute token allowance and answers
	// 413 with body text that says "tokens per minute". Waiting does not fix a
	// prompt bigger than the whole allowance, so this reads before rate-limit.
	if (
		status === 413 ||
		/too large|reduce (your|the) message size|context length|maximum context|context_window/.test(
			text,
		)
	)
		return { kind: 'too-big', note: 'Prompt zu groß für dieses Modell', status };
	if (status === 429 || /rate.?limit|too many requests|daily limit|quota/.test(text))
		return { kind: 'rate-limit', note: 'Rate-Limit erreicht', status };
	if (status !== undefined && status >= 500)
		return { kind: 'unavailable', note: 'Modell nicht erreichbar', status };
	// NIM retires models with a 410 naming the model and its end-of-life date.
	if (status === 404 || status === 410)
		return { kind: 'unavailable', note: 'Modell nicht mehr verfügbar', status };
	// OpenRouter wraps a dead upstream in an HTTP 200 body, so the status alone
	// is not enough to spot it.
	if (/502|503|bad gateway|no endpoints|is down|overloaded/.test(text))
		return { kind: 'unavailable', note: 'Upstream-Störung', status };
	if (/timeout|abort|terminated|connection/.test(text))
		return { kind: 'unavailable', note: 'Verbindung abgebrochen', status };
	return {
		kind: 'error',
		note: (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 70),
		status,
	};
}

export type ChainResult<T> = { value?: T; attempts: Attempt[]; error?: string };

/**
 * Walk a role's chain until one model answers. `maxRetries: 0` at the call
 * sites is what makes this worth reading: the SDK's own retries hit the same
 * exhausted pool and cost seconds each, whereas every retry here is a
 * different provider. Never throws — a spent budget is an ordinary free-tier
 * day, and the attempts say which one.
 */
export async function runChain<T>(
	role: Role,
	preferred: string | undefined,
	call: (spec: Spec) => Promise<T>,
): Promise<ChainResult<T>> {
	const specs = chain(role, preferred);
	const attempts: Attempt[] = [];

	if (!specs.length)
		return {
			attempts,
			error: `Kein Provider-Key für ${ROLE_ENV[role]}.`,
		};

	let lastNote = '';
	for (const [i, spec] of specs.entries()) {
		const t0 = Date.now();
		try {
			const value = await call(spec);
			attempts.push({
				provider: spec.provider,
				model: spec.id,
				ms: Date.now() - t0,
				ok: true,
				kind: 'ok',
				note: 'geantwortet',
			});
			return { value, attempts };
		} catch (e) {
			const { kind, note, status } = classify(e);
			const ms = Date.now() - t0;
			lastNote = note;
			attempts.push({
				provider: spec.provider,
				model: spec.id,
				ms,
				ok: false,
				kind,
				note,
				status,
			});
			console.log(
				`${role} ${spec.provider}/${spec.id} ${i + 1}/${specs.length} ${kind} ${ms}ms ${note}`,
			);
		}
	}

	return {
		attempts,
		error: `Keine Antwort aus der Kette (${attempts.length} versucht): ${lastNote}.`,
	};
}
