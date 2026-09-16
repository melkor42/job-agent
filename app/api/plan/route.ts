import { searchAgent } from '@/lib/agents';
import { isProviderName } from '@/lib/providers';
import { initTracing } from '@/lib/tracing';

initTracing();

export const maxDuration = 30;

type Turn = { role: 'user' | 'assistant'; content: string };

/** Step 1. Propose queries, ask one clarifying question, or reject. Nothing is searched here. */
export async function POST(req: Request) {
  const {
    messages,
    provider,
  }: { messages: Turn[]; provider?: string } = await req.json();

  // The whole conversation, not just the first message: when this returns
  // `ask`, the answer arrives as the next user turn and the agent has to see
  // both halves to plan a search.
  //
  // Every model in the chain failing is a normal free-tier day, not a crash —
  // say so, and say what each of them did, because "rate limit at Groq" and
  // "this model cannot do tool calls" need different reactions.
  const { value, attempts, error } = await searchAgent(
    messages,
    isProviderName(provider) ? provider : undefined,
  );

  if (!value) {
    console.log(`plan failed: ${error}`);
    return Response.json({
      error: error ?? 'Kein Modell hat geantwortet.',
      attempts,
    });
  }

  const output = value.output;
  const winner = attempts.at(-1);
  console.log(
    `plan ${output.action} ${output.queries.length}q via ${winner?.provider}/${winner?.model} after ${attempts.length}`,
  );
  return Response.json({ ...output, attempts });
}
