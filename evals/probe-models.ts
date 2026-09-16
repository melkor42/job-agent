// Does this model handle the real few-shot prompt? Three cases — search, ask,
// reject — in one process: `SEARCH_MODEL=<one id> npm run probe:plan`. Point it
// at a single id, or a chain answers all three from its first working model and
// you learn nothing about the rest. Three requests per run.
import { config } from 'dotenv';
import { flushTracing } from '../lib/tracing';

config({ path: ['.env.local', '.env'] });

// agents.ts builds its provider at module scope, so it must not be imported
// before the env is loaded.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { searchAgent } = require('../lib/agents') as typeof import('../lib/agents');

const CASES: [string, string][] = [
	// deliberately not a few-shot — copying an example proves nothing
	['search', 'anwendungsentwickler mit c# und angular, raum rosenheim'],
	['ask', 'daten'],
	['reject', 'schreib mir ein anschreiben für zalando'],
];

async function main() {
	console.log(`### ${process.env.SEARCH_MODEL}`);
	for (const [want, request] of CASES) {
		const t0 = Date.now();
		let value, attempts, error;
		try {
			({ value, attempts, error } = await Promise.race([
				searchAgent([{ role: 'user', content: request }]),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('gave up after 45s')), 45000).unref(),
				),
			]));
		} catch (e) {
			console.log(
				`! ${want.padEnd(6)} -> ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`,
			);
			continue;
		}
		for (const a of attempts)
			console.log(
				`    ${a.ok ? 'ok ' : '   '} ${a.provider}/${a.model} ${a.ms}ms ${a.kind}${a.status ? ` ${a.status}` : ''} ${a.note}`,
			);
		if (!value) {
			console.log(`! ${want.padEnd(6)} -> ${error} ${String(Date.now() - t0)}ms`);
			continue;
		}
		const output = value.output;
		const ok = output.action === want ? '✓' : '✗';
		console.log(
			`${ok} ${want.padEnd(6)} -> ${output.action.padEnd(6)} ${String(Date.now() - t0).padStart(5)}ms`,
		);
		if (output.queries.length)
			for (const q of output.queries) console.log(`     ${q}`);
		if (output.question) console.log(`     ? ${output.question}`);
	}
	await flushTracing();
}

main();
