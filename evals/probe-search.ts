// Does the search step work at all? One Firecrawl request, ZERO model calls —
// so this is the check to run when the OpenRouter daily budget is spent:
// `npm run probe:search "<boolean>"`.
//
// It answers the two questions /api/execute cannot tell apart: did Google
// return nothing, or did the scraping fail? And how big are the pages, since
// the reviewer gets MAX_PAGES x 4000 chars of them.
import { config } from 'dotenv';

config({ path: ['.env.local', '.env'] });

// search.ts builds its Firecrawl client at module scope, so it must not be
// imported before the env is loaded.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { search } = require('../lib/search') as typeof import('../lib/search');

const QUERIES = process.argv.slice(2).filter(Boolean);
if (!QUERIES.length)
	QUERIES.push(
		'("Frontend Entwickler" OR "Frontend Engineer") ("Angular" OR "TypeScript")',
	);

async function main() {
	if (!process.env.FIRECRAWL_API_KEY) {
		console.log('FEHLT: FIRECRAWL_API_KEY ist nicht in .env.local');
		return;
	}
	for (const q of QUERIES) console.log(`query:   ${q}`);
	console.log(
		`domains: ${process.env.SEARCH_DOMAINS ?? '(Default-Liste aus lib/search.ts)'}`,
	);

	const t0 = Date.now();
	try {
		const { pages, searched } = await search(QUERIES);
		console.log(
			`\n${searched} urls, ${pages.length} seiten gelesen in ${Date.now() - t0}ms (${QUERIES.length} queries parallel)`,
		);
		const chars = pages.map((p) => p.text.length);
		const sum = chars.reduce((a, b) => a + b, 0);
		console.log(
			`text: ${sum} chars gesamt, im schnitt ${Math.round(sum / (chars.length || 1))}, groesstes ${Math.max(0, ...chars)}`,
		);
		const byHost = new Map<string, number>();
		for (const p of pages) {
			const host = new URL(p.url).hostname;
			byHost.set(host, (byHost.get(host) ?? 0) + 1);
		}
		console.log(`hosts:  ${[...byHost].map(([h, n]) => `${h}=${n}`).join('  ')}`);
		console.log('\nerste sechs:');
		for (const p of pages.slice(0, 6)) console.log(`  ${p.url}\n     ${p.title.slice(0, 78)}`);
	} catch (e) {
		console.log(`FAIL ${Date.now() - t0}ms ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 260)}`);
	}
}

main();
