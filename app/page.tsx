'use client';

import { useRef, useState } from 'react';
import type { Attempt, Plan } from '@/lib/agents';
import { googleUrl } from '@/lib/search';

type Msg = { role: 'user' | 'assistant'; content: string };

/** /api/plan answers with a plan — or, when no model replied, with just `error`. */
type PlanReply = Plan & { error?: string; attempts?: Attempt[] };

/** Offered in the dropdown. Same order as the auto chain in lib/providers. */
const PROVIDERS = [
	{ name: 'groq', label: 'Groq' },
	{ name: 'nim', label: 'NVIDIA NIM' },
	{ name: 'openrouter', label: 'OpenRouter free' },
];

type Pick = {
	url: string;
	title: string;
	company: string;
	location: string;
	why: string;
};
type Results = {
	pages: { url: string; title: string }[];
	summary: string;
	gaps: string;
	picks: Pick[];
	attempts?: Attempt[];
	empty?: string;
	error?: string;
};

const EXAMPLES = [
	'senior frontend entwickler angular, raum münchen',
	'fullstack entwickler java spring boot, remote',
	'backend, kotlin oder go, kein management',
	'cloud engineer aws, keine Rufbereitschaft',
	'schreib mir ein anschreiben für Zalando',
];

const post = async <T,>(path: string, body: unknown): Promise<T> => {
	// Both routes can die without a body — a killed handler or a refused
	// connection. Rejecting here used to strand the caller with `busy` still set,
	// so a failure became a spinner that never ends.
	try {
		const r = await fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		return (await r.json()) as T;
	} catch {
		return {
			error: 'Der Server hat nicht geantwortet. Erneut versuchen.',
		} as T;
	}
};

const dim = 'text-[var(--scr-dim)]';

export default function Page() {
	const [input, setInput] = useState('');
	const [messages, setMessages] = useState<Msg[]>([]);
	const [plan, setPlan] = useState<Plan | null>(null);
	const [queries, setQueries] = useState<string[]>([]);
	const [results, setResults] = useState<Results | null>(null);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState<'' | 'plan' | 'run'>('');
	const [provider, setProvider] = useState('');
	const [planTrace, setPlanTrace] = useState<Attempt[]>([]);
	const inputRef = useRef<HTMLInputElement>(null);

	async function propose(text: string) {
		// An answer to the agent's question continues the conversation; anything
		// else starts a new search. Only the first case has to carry history.
		const continuing = plan?.action === 'ask';
		const next: Msg[] = continuing
			? [...messages, { role: 'user', content: text }]
			: [{ role: 'user', content: text }];
		setInput('');
		setPlan(null);
		setResults(null);
		setError('');
		setPlanTrace([]);
		setBusy('plan');

		// The whole conversation goes over the wire. What the server does with it
		// is the server's business — see app/api/plan/route.ts.
		const p = await post<PlanReply>('/api/plan', {
			messages: next,
			provider,
		});
		setPlanTrace(p.attempts ?? []);
		if (p.error) {
			setError(p.error);
			setBusy('');
			return;
		}
		setMessages([
			...next,
			{
				role: 'assistant',
				content:
					p.action === 'ask'
						? p.question
						: p.queries?.join('\n') || p.reason,
			},
		]);
		setPlan(p);
		setQueries(p.queries ?? []);
		setBusy('');
		// The agent asked something — the fastest way to answer is already focused.
		if (p.action === 'ask') inputRef.current?.focus();
	}

	async function run() {
		setBusy('run');
		setError('');
		setResults(
			await post<Results>('/api/execute', { messages, queries, provider }),
		);
		setBusy('');
	}

	return (
		<main className='flex h-dvh flex-col px-8 py-5 text-base uppercase'>
			<div
				className={`flex items-center justify-between gap-4 border-b border-[var(--scr-dim)] pb-1`}
			>
				<span>STELLEN-RÖNTGEN</span>
				<label className={`flex items-center gap-2 text-sm ${dim}`}>
					INFERENCE
					<select
						value={provider}
						onChange={(e) => setProvider(e.target.value)}
						disabled={!!busy}
						className='px-2 py-0.5 text-sm normal-case disabled:opacity-40'
					>
						<option value=''>Auto (Kette)</option>
						{PROVIDERS.map((p) => (
							<option key={p.name} value={p.name}>
								{p.label}
							</option>
						))}
					</select>
				</label>
			</div>

			<form
				onSubmit={(e: React.FormEvent) => {
					e.preventDefault();
					if (input.trim() && !busy) propose(input);
				}}
				className='flex gap-2 py-3'
			>
				<span className='py-1'>===&gt;</span>
				<input
					ref={inputRef}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					placeholder='was suchst du?'
					className='flex-1 px-3 py-2 text-lg normal-case'
					autoFocus
				/>
				<button
					disabled={!!busy}
					className='px-4 py-2 disabled:opacity-40'
				>
					{busy === 'plan' ? '...' : 'VORSCHLAGEN'}
				</button>
			</form>

			<div className='flex-1 space-y-5 overflow-y-auto'>
				{!messages.length && !busy && (
					<div className='space-y-1'>
						<div className={dim}>ZUR AUSWAHL:</div>
						{EXAMPLES.map((e) => (
							<button
								key={e}
								onClick={() => propose(e)}
								className='block w-full border-0 px-0 text-left normal-case hover:text-[var(--scr-hi)]'
							>
								{e}
							</button>
						))}
					</div>
				)}

				{error && (
					<Panel warn label='KEINE ANTWORT VOM AGENTEN'>
						{error}
					</Panel>
				)}

				{!!planTrace.length && (
					<Trace label='PLAN-AGENT' attempts={planTrace} />
				)}

				{!!results?.attempts?.length && (
					<Trace label='PRÜFAGENT' attempts={results.attempts} />
				)}

				{plan?.action === 'ask' && (
					<Panel
						label='RÜCKFRAGE DES PLAN-AGENTEN'
						note='ANTWORT OBEN EINGEBEN — DANN ERNEUT VORSCHLAGEN'
					>
						{plan.question}
					</Panel>
				)}

				{plan?.action === 'reject' && (
					<Panel
						warn
						label='ABGELEHNT VOM PLAN-AGENTEN'
						note='ES WURDE NICHTS GESUCHT'
					>
						{plan.reason}
					</Panel>
				)}

				{plan?.action === 'search' && results && !results.error && (
					<div className={dim}>
						{queries.length} QUERIES GELAUFEN —{' '}
						<button
							onClick={() => setResults(null)}
							className='border-0 px-0 underline'
						>
							BEARBEITEN
						</button>
					</div>
				)}

				{plan?.action === 'search' && !results && (
					<div>
						<div className={dim}>
							QUERIES — BEARBEITEN ODER ENTFERNEN, DANN
							AUSFÜHREN. DER SITE-FILTER AUF DIE ATS-HOSTS
							WIRD ANGEHÄNGT
						</div>
						{queries.map((q, i) => (
							<div
								key={i}
								className='flex items-start gap-3 py-2'
							>
								<button
									onClick={() =>
										setQueries(
											queries.filter((_, n) => n !== i),
										)
									}
									className='border-0 px-0 pt-2 text-[var(--scr-warn)]'
								>
									[X]
								</button>
								{/* textarea, not input: a real boolean is two lines on a
								    projector and clipping it hides the point of the demo */}
								<textarea
									value={q}
									rows={2}
									onChange={(e) =>
										setQueries(
											queries.map((x, n) =>
												n === i ? e.target.value : x,
											),
										)
									}
									className='flex-1 resize-none px-3 py-2 text-lg normal-case leading-snug'
								/>
								<a
									href={googleUrl(q)}
									target='_blank'
									rel='noreferrer'
									className={`pt-2 text-sm underline ${dim}`}
								>
									GOOGLE
								</a>
							</div>
						))}

						<button
							onClick={run}
							disabled={!!busy || !queries.length}
							className='mt-3 px-4 py-2 disabled:opacity-40'
						>
							{busy === 'run'
								? 'LÄUFT...'
								: `AUSFÜHREN (${queries.length})`}
						</button>
					</div>
				)}

				{results?.error && (
					<Panel warn label='SUCHE FEHLGESCHLAGEN'>
						{results.error}
					</Panel>
				)}
				{results?.empty && (
					<Panel warn label='KEINE TREFFER'>
						{results.empty}
					</Panel>
				)}

				{results && !results.error && !results.empty && (
					<>
						<Panel
							label='PRÜFAGENT'
							note={`LÜCKEN: ${results.gaps}`}
						>
							{results.summary}
						</Panel>

						<div>
							<div className={dim}>
								{results.picks.length} AUSGEWÄHLT AUS{' '}
								{results.pages.length} GELESENEN SEITEN
							</div>
							<table className='w-full'>
								<tbody>
									{results.picks.map((p) => (
										<tr key={p.url} className='align-top'>
											<td className='w-48 py-2'>
												{p.company}
											</td>
											<td className='py-2 normal-case'>
												<a
													href={p.url}
													target='_blank'
													rel='noreferrer'
													className='underline'
												>
													{p.title}
												</a>
												<div
													className={`text-sm ${dim}`}
												>
													{p.location} — {p.why}
												</div>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</>
				)}
			</div>

			<div
				className={`flex justify-between border-t border-[var(--scr-dim)] pt-2 pl-12 text-xs ${dim}`}
			>
				<span>PLAN-AGENT SCHLÄGT VOR — DU SIEBST — DANN LÄUFT DIE SUCHE</span>
			</div>
		</main>
	);
}

function Panel({
	label,
	note,
	warn,
	children,
}: {
	label: string;
	note?: string;
	warn?: boolean;
	children: React.ReactNode;
}) {
	const c = warn ? 'var(--scr-warn)' : 'var(--scr-dim)';
	return (
		<div className='border p-3' style={{ borderColor: `${c}` }}>
			<div className='text-xs' style={{ color: c }}>
				{warn ? '** ' : ''}
				{label}
			</div>
			<p className='py-2 text-lg normal-case leading-relaxed text-[var(--scr-hi)]'>{children}</p>
			{note && (
				<p className='text-sm normal-case text-[var(--scr-warn)]'>
					{note}
				</p>
			)}
		</div>
	);
}

/**
 * One row per model the chain tried. The header is the part to read from
 * across a room: a fallback and a rate limit both look like a working tool
 * until someone says which one happened.
 */
function Trace({ label, attempts }: { label: string; attempts: Attempt[] }) {
	if (!attempts.length) return null;
	const last = attempts[attempts.length - 1];
	const failed = attempts.length - (last.ok ? 1 : 0);
	const wo = last.provider.toUpperCase();
	const headline = !last.ok
		? 'KEIN MODEL ANTWORTET'
		: failed
			? `${failed} FALLE${failed > 1 ? 'N' : ''} ZURÜCK — ${wo} ANTWORTET`
			: `${wo} ANTWORTET`;

	return (
		<div className='border p-3 border-[var(--scr-dim)]'>
			<div className={`text-xs ${last.ok ? dim : 'text-[var(--scr-warn)]'}`}>
				{label} · {headline}
			</div>
			{attempts.map((a, i) => (
				<div
					key={`${a.provider}${a.model}${i}`}
					className={`flex gap-3 pt-1 text-sm normal-case ${
						a.ok ? dim : 'text-[var(--scr-warn)]'
					}`}
				>
					<span className='w-24 shrink-0'>{a.provider}</span>
					<span className='flex-1 truncate'>{a.model}</span>
					<span className='w-14 shrink-0 text-right'>
						{a.ms < 1000 ? `${a.ms}ms` : `${(a.ms / 1000).toFixed(1)}s`}
					</span>
					<span className='w-56 shrink-0'>
						{a.note}
						{a.status ? ` (${a.status})` : ''}
					</span>
				</div>
			))}
		</div>
	);
}
