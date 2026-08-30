// GET /api/place-search?q=three+bros+stechford
// Proxies Places API (New) autocomplete so the Google key never ships to the browser.

export default async (req) => {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 3) return json({ suggestions: [] });

  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return json({ error: 'Server not configured' }, 500);

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': key,
      },
      body: JSON.stringify({
        input: q,
        includedRegionCodes: ['gb'],
        // Bias to the West Midlands without excluding the rest of the UK
        locationBias: {
          circle: {
            center: { latitude: 52.4862, longitude: -1.8904 },
            radius: 50000,
          },
        },
      }),
    });
    if (!res.ok) {
      console.error('Autocomplete failed', res.status, await res.text());
      return json({ error: 'Search failed' }, 502);
    }
    const data = await res.json();
    const suggestions = (data.suggestions || [])
      .map((s) => s.placePrediction)
      .filter(Boolean)
      .slice(0, 6)
      .map((p) => ({
        placeId: p.placeId,
        name: p.structuredFormat?.mainText?.text || p.text?.text || '',
        address: p.structuredFormat?.secondaryText?.text || '',
      }));
    return json({ suggestions });
  } catch (err) {
    console.error(err);
    return json({ error: 'Search failed' }, 502);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export const config = { path: '/api/place-search' };
