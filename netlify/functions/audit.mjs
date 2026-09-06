// GET /api/audit?placeId=ChIJ...
// Original text-search competitor logic + confidence gate:
// the comparison table is only returned when we're sure it's right.

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

// places.types added so we can verify each competitor actually overlaps
const COMPETITOR_FIELDS = [
  'places.id',
  'places.displayName',
  'places.rating',
  'places.userRatingCount',
  'places.photos',
  'places.types',
].join(',');

// Buckets too vague to define a market
const GENERIC_TYPES = new Set([
  'point_of_interest',
  'establishment',
  'store',
  'food',
  'health',
  'finance',
  'education',
  'school',
  'place_of_worship',
  'general_contractor',
]);

const specificTypes = (types) => (types || []).filter((t) => t && !GENERIC_TYPES.has(t));

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

    // 2. Competitors — original approach: text search on the category label,
    //    biased to the business's area
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
            pageSize: 8,
            locationBias: {
              circle: { center: { latitude: loc.latitude, longitude: loc.longitude }, radius: 5000 },
            },
          }),
        });
        if (compRes.ok) competitors = (await compRes.json()).places || [];
      } catch (err) {
        console.error('Competitor search failed (non-fatal):', err.message);
      }
    }

    // --- Confidence gate ----------------------------------------------------
    // Only show the comparison when all three hold:
    //  a) the business's own primary category is specific (not a generic bucket)
    //  b) each competitor shares >=1 specific type with the business
    //  c) at least 2 genuine competitors survive the filter
    const ownSpecific = new Set(specificTypes([place.primaryType, ...(place.types || [])]));
    const hasSpecificCategory = ownSpecific.size > 0 && place.primaryType && !GENERIC_TYPES.has(place.primaryType);

    let vetted = [];
    if (hasSpecificCategory) {
      vetted = competitors
        .filter((c) => c.id !== place.id)
        .filter((c) => specificTypes(c.types).some((t) => ownSpecific.has(t)));
    }
    const confident = hasSpecificCategory && vetted.length >= 2;

    if (!confident && competitors.length) {
      console.log(
        `Comparison suppressed for "${place.displayName?.text}" (${place.primaryType || 'no type'}): ` +
        `${vetted.length} vetted of ${competitors.length} found`
      );
    }

    // 3. Deterministic score (unchanged, always shown)
    const result = scorePlace(place);
    const comparison = confident
      ? { ...compareCompetitors(place, vetted), confident: true }
      : { ...compareCompetitors(place, []), confident: false }; // self row only -> frontend hides card

    // 4. Narrative — never mention rivals we didn't show
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
