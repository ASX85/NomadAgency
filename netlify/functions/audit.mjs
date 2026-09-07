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

// WHITELIST: the comparison table only renders for storefront consumer
// categories where nearby businesses genuinely compete for the same walk-in
// customer. Everything else (B2B, service-area, unusual categories) shows
// no table at all. Fails closed: unknown category means no comparison.
const STOREFRONT_TYPES = new Set([
  // food & drink
  'meal_takeaway', 'meal_delivery', 'sandwich_shop', 'cafe', 'coffee_shop',
  'bakery', 'ice_cream_shop', 'dessert_shop', 'donut_shop', 'tea_house',
  'bar', 'pub', 'fast_food_restaurant',
  // personal care
  'barber_shop', 'hair_salon', 'beauty_salon', 'nail_salon', 'spa',
  'tanning_studio', 'massage',
  // health storefronts
  'dentist', 'dental_clinic', 'pharmacy', 'drugstore', 'optician',
  'veterinary_care', 'physiotherapist', 'chiropractor',
  // fitness
  'gym', 'fitness_center', 'yoga_studio',
  // auto storefronts
  'car_repair', 'car_wash', 'tire_shop', 'car_dealer',
  // retail
  'florist', 'butcher_shop', 'grocery_store', 'supermarket',
  'convenience_store', 'clothing_store', 'shoe_store', 'jewelry_store',
  'book_store', 'pet_store', 'hardware_store', 'furniture_store',
  'electronics_store', 'cell_phone_store', 'gift_shop', 'toy_store',
  'bicycle_store', 'liquor_store',
]);

// Any cuisine-specific restaurant type counts (indian_restaurant,
// hamburger_restaurant, turkish_restaurant, ...) plus 'restaurant' itself.
const isStorefrontType = (t) =>
  Boolean(t) && (t === 'restaurant' || t.endsWith('_restaurant') || STOREFRONT_TYPES.has(t));

const storefrontTypes = (types) => (types || []).filter(isStorefrontType);

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

    // --- Whitelist gate -----------------------------------------------------
    // The table renders only when ALL hold:
    //  a) the business itself is a whitelisted storefront category
    //  b) each competitor shares >=1 whitelisted type with the business
    //  c) at least 2 genuine competitors survive the filter
    // Anything not on the whitelist fails closed: no table, no mention.
    const ownStorefront = new Set(storefrontTypes([place.primaryType, ...(place.types || [])]));
    const isStorefrontBusiness = ownStorefront.size > 0;

    let vetted = [];
    if (isStorefrontBusiness) {
      vetted = competitors
        .filter((c) => c.id !== place.id)
        .filter((c) => storefrontTypes(c.types).some((t) => ownStorefront.has(t)));
    }
    const confident = isStorefrontBusiness && vetted.length >= 2;

    if (!confident && competitors.length) {
      console.log(
        `Comparison suppressed for "${place.displayName?.text}" (${place.primaryType || 'no type'}): ` +
        `storefront=${isStorefrontBusiness}, ${vetted.length} vetted of ${competitors.length} found`
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
