// Is this reviewer model fast enough, German, and honest about URLs? One
// request over made-up pages, so it needs no Firecrawl key:
// `SUMMARY_MODEL=<one id> npm run probe:review`. The three pages are the three
// ways a review can mislead — a real match, a US-only posting, and a
// Werkstudent job — so `invented=0` plus a pick count of 1 is the pass.
import { config } from 'dotenv';

config({ path: ['.env.local', '.env'] });

// agents.ts builds its provider at module scope, so it must not be imported
// before the env is loaded.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { searchSummaryAgent } = require('../lib/agents') as typeof import('../lib/agents');

const PAGES = [
	{
		url: 'https://jobs.personio.de/de/p/111-alpha',
		title: 'Senior Frontend Entwickler (m/w/d)',
		text: `Senior Frontend Entwickler (m/w/d)
 ALPHA GmbH · Remote-first, Berlin
 Deine Skills: Sehr gute Kenntnisse in Angular und TypeScript, Redux.
 Befristung: unbefristet. Vollzeit. Reisebereitschaft: gering.
 Sprache: Deutsch C1, Englisch B2. Gehalt: ab 78.000 €.`,
	},
	{
		url: 'https://boards.greenhouse.io/beta/jobs/222',
		title: 'Software Engineer, Web',
		text: `Software Engineer, Web
 BETA Inc. — Fully remote within the US only.
 You will work in React and TypeScript on our dashboard.
 No sponsorship available. Must be authorised to work in the US.`,
	},
	{
		url: 'https://jobs.smartrecruiters.com/gamma/333',
		title: 'Werkstudent (m/w/d) Marketing',
		text: `Werkstudent Marketing (m/w/d)
 GAMMA SE, München. Du unterstützt unser Team bei Social Media.
 Erste Erfahrungen mit Canva. 20 h/Woche.`,
	},
];

const REQUEST = 'senior frontend entwickler angular, raum berlin';

async function main() {
	console.log(`### ${process.env.SUMMARY_MODEL ?? 'Auto-Kette'}`);
	const t0 = Date.now();
	let result;
	try {
		result = await Promise.race([
			searchSummaryAgent(REQUEST, PAGES),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('gave up after 90s')), 90000).unref(),
			),
		]);
	} catch (e) {
		console.log(
			`FAIL ${String(Date.now() - t0)}ms ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200)}`,
		);
		return;
	}
	const { value, attempts, error } = result;
	for (const a of attempts)
		console.log(
			`    ${a.ok ? 'ok' : '!!'} ${a.provider}/${a.model} ${a.ms}ms ${a.kind}${a.status ? ` ${a.status}` : ''} ${a.note}`,
		);
	if (!value) {
		console.log(`keine Antwort nach ${Date.now() - t0}ms: ${error}`);
		return;
	}

	const { output, usage } = value;
	const o = output as {
		summary: string;
		gaps: string;
		picks: { url: string; title: string; company: string; location: string; why: string }[];
	};
	const known = new Set(PAGES.map((p) => p.url));
	const invented = o.picks.filter((p) => !known.has(p.url));
	console.log(
		`ok ${String(Date.now() - t0)}ms in=${usage.inputTokens} out=${usage.outputTokens} picks=${o.picks.length} invented=${invented.length}`,
	);
	console.log(`summary: ${o.summary.slice(0, 220)}`);
	console.log(`gaps:    ${o.gaps.slice(0, 160)}`);
	for (const p of o.picks)
		console.log(`  - ${p.url} | ${p.company} | ${p.location} | ${p.why.slice(0, 90)}`);
	if (invented.length)
		for (const p of invented) console.log(`  INVENTED: ${p.url}`);
	const ascii = [...o.summary].filter((c) => c.charCodeAt(0) > 127).length;
	console.log(`nicht-ascii in summary: ${ascii} (0 = englisch)`);
}

main();
