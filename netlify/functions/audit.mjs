// GET /api/audit?placeId=ChIJ...
// 1. Pull Place Details for the business
// 2. Pull top competitors in the same category nearby
// 3. Run the deterministic scoring engine
// 4. Ask Claude for the plain-English narrative
// Total external cost per audit: ~2 Places calls + 1 small Claude call.

import { scorePlace, compareCompetitors } from './lib/scoring.mjs';
import { buildNarrative } from './lib/narrative.mjs';

const DETAILS_FIELDS = [
  'id',
  'displayName',
  'formattedAddress',
  'businessStatus',
  'nationalPhoneNumber',
  'internationalPhoneNumber',
  'websiteUri',
  'regularOpeningHours',
  'types',
  'primaryType',
  'primaryTypeDisplayName',
  'rating',
  'userRatingCount',
  'reviews',
  'photos',
  'editorialSummary',
  'location',
  'googleMapsUri',
].join(',');

const COMPETITOR_FIELDS = [
  'places.id',
  'places.displayName',
  'places.rating',
  'places.userRatingCount',
  'places.photos',
].join(',');

export default async (req) => {
  const url = new URL(req.url);
  const placeId = url.searchParams.get('placeId');
  if (!placeId || !/^[\w-]{10,300}$/.test(placeId)) {
    return json({ error: 'Missing or invalid placeId' }, 400);
  }

  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return json({ error: 'Server not configured' }, 500);

  try {
    // 1. Place details
    const detailsRes = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': DETAILS_FIELDS },
    });
    if (!detailsRes.ok) {
      console.error('Details failed', detailsRes.status, await detailsRes.text());
      return json({ error: 'Could not load that business from Google' }, 502);
    }
    const place = await detailsRes.json();

    // 2. Competitors: same category near the business location
    let competitors = [];
    const category = place.primaryTypeDisplayName?.text;
    const loc = place.location;
    if (category && loc) {
      try {
        const compRes = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Goog-Api-Key': key,
            'X-Goog-FieldMask': COMPETITOR_FIELDS,
          },
          body: JSON.stringify({
            textQuery: category,
            pageSize: 5,
            locationBias: {
              circle: { center: { latitude: loc.latitude, longitude: loc.longitude }, radius: 5000 },
            },
          }),
        });
        if (compRes.ok) {
          competitors = (await compRes.json()).places || [];
        }
      } catch (err) {
        console.error('Competitor search failed (non-fatal):', err.message);
      }
    }

    // 3. Deterministic score
    const result = scorePlace(place);
    const comparison = compareCompetitors(place, competitors);

    // 4. AI narrative (falls back gracefully if the API key is absent or the call fails)
    const narrative = await buildNarrative({ place, result, comparison });

    return json({
      business: {
        name: place.displayName?.text,
        address: place.formattedAddress,
        category: place.primaryTypeDisplayName?.text || null,
        mapsUrl: place.googleMapsUri || null,
        rating: place.rating || null,
        reviews: place.userRatingCount || 0,
      },
      score: result.score,
      grade: result.grade,
      breakdown: result.breakdown,
      issues: result.issues,
      manualCheckItems: result.manualCheckItems,
      comparison,
      narrative,
    });
  } catch (err) {
    console.error(err);
    return json({ error: 'Audit failed, please try again' }, 500);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export const config = { path: '/api/audit' };
