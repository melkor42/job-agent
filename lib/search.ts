import Firecrawl from '@mendable/firecrawl-js';

export type Page = { url: string; title: string; text: string };

/**
 * DACH employers rarely publish on one shared board — each runs its own ATS
 * host. Searching all of them at once is what `includeDomains` is for.
 * Override per deployment with SEARCH_DOMAINS="a.com,b.com".
 */
const DEFAULT_DOMAINS = [
	'jobs.personio.de',
	'boards.greenhouse.io',
	'jobs.lever.co',
	'myworkdayjobs.com',
	'jobs.smartrecruiters.com',
	'stepstone.de',
];

const domains = () => {
	const configured = (process.env.SEARCH_DOMAINS ?? '')
		.split(',')
		.map((d) => d.trim())
		.filter(Boolean);
	return configured.length ? configured : DEFAULT_DOMAINS;
};

/** Pages above this make the reviewer's prompt noisy, not smarter. */
const MAX_PAGES = 24;

/** Shown next to each query so the user can run it on Google themselves. */
export const googleUrl = (q: string) => {
	const sites = domains().map((d) => `site:${d}`).join(' OR ');
	return `https://www.google.com/search?q=${encodeURIComponent(`(${sites}) ${q}`)}`;
};

const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });

/**
 * One posting arrives as several URLs: Workday and SmartRecruiters put the
 * locale in the path (`/en-US/…` vs `/it-IT/…`) and both append an apply flow
 * (`/apply`, `/apply/autofillWithResume`). Measured on a live three-query run:
 * 24 hits, 19 raw-unique pages, and the WEX and dentsu jobs were among the
 * repeats. Keyed canonically so a duplicate cannot spend a page of the
 * reviewer's budget.
 */
const canonical = (url: string) =>
	url
		.split(/[?#]/)[0]
		.replace(/\/apply(\/.*)?$/i, '')
		.replace(/^(https?:\/\/[^/]+)\/[a-z]{2}-[A-Z]{2}\//i, '$1/')
		.replace(/\/+$/i, '')
		.toLowerCase();

/**
 * One call per query: Google-backed search scoped to the ATS hosts, and each
 * result's page fetched and cleaned to markdown.
 *
 * Free tier is 10 requests a minute and each query is one request.
 */
export async function search(queries: string[]) {
  const runs = await Promise.all(
    queries.map((query) =>
      firecrawl.search(query, {
        limit: 8,
        includeDomains: domains(),
        scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
      }),
    ),
  );

  // With scrapeOptions each hit is a scraped Document: url and title sit on
  // metadata, the clean text on markdown.
  const hits = runs.flatMap((r) => r.web ?? []);
  const seen = new Map<string, Page>();
  for (const hit of hits) {
    if (!('markdown' in hit) || !hit.markdown) continue;
    const url = (hit.metadata?.sourceURL ?? hit.metadata?.url ?? '').split('?')[0];
    const key = canonical(url);
    if (!url || seen.has(key)) continue;
    // Measured: ~2300 chars of markdown per page, so MAX_PAGES of these is
    // ~45k chars in one prompt. The cap is what keeps the reviewer inside its
    // time budget, not what makes the answer cleaner.
    seen.set(key, { url, title: hit.metadata?.title ?? url, text: hit.markdown.slice(0, 4000) });
    if (seen.size >= MAX_PAGES) break;
  }
  return { pages: [...seen.values()], searched: hits.length };
}
