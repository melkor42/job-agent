# Stellen-Röntgen — job search agent (DACH)

> **Want to build this with me?** I'm running a 2-day workshop on building
> agents and setting up a RAG pipeline. **[Sign up here](https://form.typeform.com/to/qyEMw7Ao).**

Tippe, was du suchst. Ein Agent schreibt Booleans (oder lehnt ab, oder fragt
zurück), du wählst, was läuft, es läuft, und ein zweiter Agent liest die
Anzeigen und sagt dir, was sich zu öffnen lohnt.

```
"senior frontend, angular, raum münchen"
   │
   ▼  searchAgent          reject · ask (eine Rückfrage) · 1–5 Booleans
   │
   ▼  du                   entfernen oder bearbeiten, dann ausführen
   │
   ▼  Firecrawl            Suche über ATS-Boards, Seiten als Markdown
   │
   ▼  searchSummaryAgent   Auswahl, Warum, und was die Treffer nicht haben
```

## What you need before you start

Five keys, all free: Groq, NVIDIA NIM and OpenRouter for inference, Firecrawl
for search, LangSmith for tracing. Ten minutes total. None of them is required —
a provider whose key is missing drops out of every chain.

### 1. Inference — three free providers, one chain per role

Every model call goes through `lib/providers.ts`: three free endpoints, all
speaking OpenAI chat completions, so one `@ai-sdk/openai` client covers them and
a model is addressed `provider:id` — `groq:openai/gpt-oss-120b`, or a bare id for
openrouter. Each role has a chain across them and the first one that answers
wins.

| Rolle | Kette | Warum |
|---|---|---|
| plan | `groq:openai/gpt-oss-120b` → `groq:openai/gpt-oss-20b` → NIM → OpenRouter | Groq answers the few-shot prompt in 1.6–1.9 s. Everything else takes 10–30 s or does not answer |
| review | NIM ultra → NIM super → OpenRouter `:free` | **Not Groq.** Its free tier allows 8000 tokens/minute and the reviewer's 16 pages ask for 18090, so every review call there dies with a 413. NIM reads the same pages in 15–23 s |
| judge | NIM ultra → OpenRouter `:free` | No Groq on purpose: its judge-grade model is the one the planner runs on, and a judge that grades its own answers proves nothing |

```
GROQ_API_KEY=gsk_...         # https://console.groq.com -> API Keys
NVIDIA_API_KEY=nvapi-...     # https://build.nvidia.com -> any model -> Get API Key
OPENROUTER_API_KEY=sk-or-... # https://openrouter.ai -> Keys -> Create Key
```

A provider whose key is absent is dropped from every chain at startup, so a
half-configured `.env.local` degrades to what works instead of failing at call
time. On OpenRouter the `:free` suffix is what routes a call to the zero-cost
tier — without it you are billed. Its free tier is ~20 requests/minute and 50
requests/day; once you have bought $10 of credit the daily ceiling goes to ~1000.

> **Why a chain across providers at all:** each one runs out on its own clock. A
> request that dies on a 429 at OpenRouter answers in under two seconds at Groq,
> and a request too big for Groq's per-minute allowance is a normal afternoon at
> NIM. There are six distinguishable ways a call fails, and the difference is
> what you act on:
>
> - **429 rate limit** — clears in a minute, or when the day rolls over
> - **413 prompt too large** — waiting will never fix it; the prompt is bigger
>   than the whole allowance. Groq words this as a token-per-minute rate limit,
>   which is why `classify()` tests it first
> - **502/410 unavailable** — a dead upstream, or a model NIM retired with an
>   end-of-life date; both need a different provider, not a retry
> - **no tool call** — the model answered in prose, so it is worthless in a
>   structured chain and should leave it
> - **answered, wrong shape** — it made a tool call and zod refused the payload.
>   `nim:nvidia/nemotron-3-super-120b-a12b` does this on about one planner run in
>   three, answering `queries: ["(", "", ""]`. Nearly right rather than useless,
>   and `planSchema`'s per-query minimum is what turns it into a fall-through
> - **401/402** — the key or the credit, not the model
>
> The UI prints one row per attempt under the result — `PRÜFAGENT · 1 FALL
> ZURÜCK — NVIDIA NIM ANTWORTET`, then provider, model, seconds and the reason —
> because a fallback and a rate limit both look like a working tool until
> someone says which one happened.
>
> To change a chain, edit `.env.local` (`SEARCH_MODEL`, `SUMMARY_MODEL`,
> `JUDGE_MODEL`; a comma-separated list replaces that role's chain). The
> INFERENCE dropdown does the same thing for one run, without editing anything:
> it **reorders** the chain rather than filtering it, so the provider you picked
> is tried first and the fallbacks behind it stay.
>
> Pick OpenRouter ids from `https://openrouter.ai/api/v1/models`, and only take
> ones whose top-level `supported_parameters` include `"tools"` — both agents
> return structured output through tool calling. (The nested
> `parameters.supported_parameters` the same endpoint returns is empty on every
> model, so it will tell you nothing.) NIM and Groq do not publish that field;
> probe them with the real prompt.
>
> **Budget note:** a candidate sweep is not free on a free tier. Twelve models
> at three or four calls each is ~45 requests — most of a day's allowance on $0
> credit. Probe a handful of ids, with the prompt you actually ship, and keep
> `maxRetries: 0` so one dead model costs one request instead of five.

### 2. Firecrawl — search and scrape

One call searches Google scoped to the ATS hosts below and returns every result
page already cleaned to markdown.

```
jobs.personio.de · boards.greenhouse.io · jobs.lever.co
myworkdayjobs.com · jobs.smartrecruiters.com · stepstone.de
```

Measured on a live three-query run (the German/English Angular boolean the
example button runs): **24 hits → 16 pages**, ~2600 chars of markdown each, so
~42k chars in the reviewer's prompt. Workday, SmartRecruiters and stepstone
carry most of it; personio returns one or two; greenhouse and lever answer for
international employers rather than German ones. Two things follow from that
run, and both are handled in `lib/search.ts`: one posting arrives as several
URLs (`/en-US/…` vs `/it-IT/…`, plus an `/apply` tail), so pages are deduped on
a canonical key, and 16 pages is a size the reviewer has to survive — which is
what `MAX_PAGES` exists for.

1. Sign up at **https://firecrawl.dev** (free, no card)
2. **Dashboard → API Keys → copy**

```
FIRECRAWL_API_KEY=fc-...
```

Override the list with `SEARCH_DOMAINS=a.de,b.de` in `.env.local` — useful to
see what a single ATS actually holds.

Free tier: 500 credits and **10 requests a minute**. A query with scraping
costs about 10 credits, so that is ~50 queries a month — and each query is one
request against the per-minute limit. Use your own key; you cannot share one
with a room.

### 3. LangSmith — see what the agent saw

Every model call traced: the prompt it got, the tokens, the cost, the latency.
Optional, but you will not understand why the agent did something without it.

1. Sign up at **https://eu.smith.langchain.com** (free, no card)
2. **Settings → API Keys → Create API Key**

```
LANGSMITH_TRACING=true
LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com
LANGSMITH_API_KEY=lsv2_...
LANGSMITH_PROJECT=pr-earnest-worth-13
```

`LANGSMITH_ENDPOINT` is required — without it nothing is sent, silently. EU
accounts must use the `eu.` host or the traces are dropped just as quietly.

### Then

```bash
cp .env.example .env.local   # paste the keys in
npm install && npm run dev   # http://localhost:3000
```

## How to write one of these

Everything is in `lib/agents.ts`. An agent is a function that calls a model
with a schema and some examples:

```ts
export const searchAgent = (messages, preferred?) =>
  runChain('plan', preferred, (spec) =>         // the role's chain, in order,
    generateText({                               // spec = one `provider:id`
      model: languageModel(spec),
      maxRetries: 0,                             // retry = next provider, not this one
      output: Output.object({ schema: planSchema, name: 'plan' }),
      system: `Respond as in these examples.\n\n${shotsBlock}`,
      messages,
    }));
```

**Schema first.** Never ask for text you then have to parse. Ask for the shape
you want back and let zod refuse anything else:

```ts
const planSchema = z.object({
  action: z.enum(['search', 'ask', 'reject']),
  reason: z.string(),                       // making it explain improves the answer
  question: z.string(),                     // filled only when action is 'ask'
  queries: z.array(z.string().min(12)).max(5),
                                            // the ARRAY has no min — reject and ask
                                            // return none. Each query does: a fallback
                                            // that answers ["(", "", ""] must fail
                                            // validation, not run a nonsense search
});
```

**Examples, not prose.** The search agent has no system prompt. `PLAN_SHOTS` is
a list of German `{ request, output }` pairs and each `reason` states the rule
that example exists to teach. When the agent misbehaves, add an example — do not
add a paragraph. Watch one example over-generalise: the "we do not hire
juniors" shot also rejects "Berufseinsteiger", which is why that case now sits
in the eval.

**Reject before you spend.** The first agent runs on the small model and
decides whether to do anything at all. Junk, injection, and "who is the CEO"
stop there for a fraction of a cent.

**Human in the loop.** Queries go to the screen before they run. That is the
cheapest correction in the whole system.

**Trust nothing back.** The summary agent returns URLs; anything not in the
pages it was actually given is dropped before render.

**Assume the model is down.** On a shared free pool a failure is routine and
short-lived, so the answer is a second model, not a retry of the first:
`maxRetries: 0`, then the next id in the chain — and a route that replies with
a reason rather than an empty 500 the page cannot render.

## Evals

`npm run eval` with the dev server running. A case is a request, the action it
should take, and a rubric a second model grades against:

```ts
{ request: 'devops mit kubernetes, kein management', action: 'search',
  rubric: 'Titles cover platform/SRE and exclude Leiter and Director.' }
```

The judge is not deterministic — read the reasoning, not just the score. It
defaults to `nim:nvidia/nemotron-3-ultra-550b-a55b` (`JUDGE_MODEL`), a model
from outside the planner's chain: the judge scores only the planner's queries.
An unreachable judge is recorded as a `-1` row with the error, never thrown —
ten good cases are worth more than one verdict, and a judge that 403s
deterministically looks exactly like a broken eval otherwise.

Two smaller checks exist for the chains themselves, one request each:
`SEARCH_MODEL=<id> npm run probe:plan` runs the real few-shot prompt against one
planner, `SUMMARY_MODEL=<id> npm run probe:review` reviews three made-up pages —
a real match, a US-only posting, a Werkstudent job — and reports `invented=`.
Run them before you add an id to a chain, not after.

`npm run probe:search "<boolean>"` is the odd one out: one Firecrawl request and
**zero model calls**, which makes it the check to run when the OpenRouter daily
budget is gone and you still want to know whether the search works. It separates
the two failures `/api/execute` conflates — Google returned nothing versus the
scrape failed — and prints the total page size, which is what decides whether
the reviewer fits its time budget.

## What changed from upstream

The workshop ships `main` with four `TODO(n)` markers. All four are filled in
here, plus the two swaps this fork exists for:

1. the reviewer's system prompt — pinned to the pages it was given, invented
   URLs forbidden, Standort/Befristung/Sprache folded into the reasoning
2. follow-up questions — a third `ask` action, one clarifying question, and the
   page keeps the thread so the answer reaches the next call
3. an eval case for a request that names a salary
4. an eval case that catches the "no juniors" few-shot over-generalising
5. OpenAI → three free providers (Groq, NVIDIA NIM, OpenRouter `:free`), one
   fallback chain per role across all three, and both API routes answer with a
   German reason plus a per-attempt trace when the whole chain fails
6. Greenhouse-only → six DACH ATS hosts, German prompts and German output
