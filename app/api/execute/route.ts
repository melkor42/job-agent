import { searchSummaryAgent } from '@/lib/agents';
import { isProviderName } from '@/lib/providers';
import { search } from '@/lib/search';
import { initTracing } from '@/lib/tracing';

initTracing();

export const maxDuration = 60;

type Msg = { role: 'user' | 'assistant'; content: string };

/** Step 2. Search, fetch the pages, clean them, hand the text to the agent. */
export async function POST(req: Request) {
	const {
		messages,
		queries,
		provider,
	}: { messages: Msg[]; queries: string[]; provider?: string } =
		await req.json();
	// With a follow-up question the request is spread over turns: the vague
	// opener plus the answer. The reviewer needs both, not just the first.
	const request = messages
		.filter((m) => m.role === 'user')
		.map((m) => m.content)
		.join(' — ');

	let pages, searched;
	try {
		({ pages, searched } = await search(queries));
	} catch (e) {
		return Response.json({ error: e instanceof Error ? e.message : String(e) });
	}

	if (!pages.length)
		return Response.json({
			pages: [],
			picks: [],
			empty: 'Nichts gefunden. Titel weiter fassen oder ein Keyword streichen.',
		});

	// A rate-limited model is ordinary here, and so is a model that answers in
	// prose instead of the tool call. Which of them happened decides whether to
	// wait a minute or change provider, so the trace goes back with the error.
	const { value, attempts, error } = await searchSummaryAgent(
		request,
		pages,
		isProviderName(provider) ? provider : undefined,
	);
	const head = {
		pages: pages.map(({ url, title }) => ({ url, title })),
		attempts,
	};

	if (!value) {
		console.log(`execute failed after ${attempts.length}: ${error}`);
		return Response.json({
			...head,
			picks: [],
			error: `${error ?? 'Kein Modell hat geantwortet.'} Erneut ausführen startet auch die Suche neu.`,
		});
	}

	// The agent can only pick from what it read, but it can still invent a URL.
	const known = new Set(pages.map((p) => p.url));
	const picks = value.output.picks.filter((p) => known.has(p.url));
	const winner = attempts.at(-1);

	console.log(
		`execute ${searched} urls, ${pages.length} pages read, ${picks.length} picks via ${winner?.provider}/${winner?.model} after ${attempts.length}`,
	);
	return Response.json({
		...head,
		summary: value.output.summary,
		gaps: value.output.gaps,
		picks,
	});
}
