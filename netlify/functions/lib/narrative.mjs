// Claude narrative layer: turns the deterministic score into plain-English
// findings. Numbers come from scoring.mjs only — Claude is never asked to
// invent or restate figures beyond what it is given.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

export async function buildNarrative({ place, result, comparison }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallbackNarrative(result, comparison);

  const businessName = place.displayName?.text || 'this business';
  const category = place.primaryTypeDisplayName?.text || 'local business';

  const facts = {
    businessName,
    category,
    score: result.score,
    grade: result.grade,
    topIssues: result.issues.slice(0, 5),
    competitorTable: comparison.rows,
    reviewGapToLocalLeader: comparison.reviewGap,
  };

  const prompt = `You are a UK local SEO specialist writing the summary section of a Google Business Profile audit for a small business owner in the West Midlands. They are not technical. Be direct, specific and encouraging, never salesy or jargon-heavy. Use British English. Do not use em dashes. Do not use the word "however".

Here are the audit facts. Use ONLY these numbers, never invent figures:
${JSON.stringify(facts, null, 2)}

Context you may draw on: a well-optimised Google Business Profile now decides visibility in Google's local pack AND whether AI assistants like ChatGPT and Gemini recommend a business, because review volume, completeness and photos are the signals those systems lean on.

Respond with ONLY a JSON object, no markdown fences, no preamble, in exactly this shape:
{
  "headline": "one sentence, max 14 words, stating the single most important finding",
  "summary": "2-3 sentences explaining what the score means for this specific business",
  "topFixes": ["three items, each one sentence, the highest-impact actions in priority order"],
  "aiVisibilityNote": "1-2 sentences on what this profile's state means for being recommended by AI assistants"
}`;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    if (!parsed.headline || !parsed.topFixes) throw new Error('Malformed narrative');
    return parsed;
  } catch (err) {
    console.error('Narrative generation failed, using fallback:', err.message);
    return fallbackNarrative(result, comparison);
  }
}

// Deterministic fallback so the audit never fails because of the AI layer
function fallbackNarrative(result, comparison) {
  const worst = result.issues.slice(0, 3);
  return {
    headline: `Your profile scores ${result.score}/100 (grade ${result.grade}).`,
    summary:
      result.score >= 70
        ? 'Your profile has solid foundations. The remaining gaps below are what separate you from the top of the local pack.'
        : 'Your profile has significant gaps that are costing you visibility in Google search and Maps. The fixes below are where to start.',
    topFixes: worst.map((i) => `${i.area}: ${i.detail}`),
    aiVisibilityNote:
      comparison.reviewGap > 0
        ? `The local leader in your category has ${comparison.reviewGap} more reviews than you, and review volume is the strongest signal AI assistants use when recommending businesses.`
        : 'Your review position is competitive locally, which supports visibility in both Google and AI assistant recommendations.',
  };
}
