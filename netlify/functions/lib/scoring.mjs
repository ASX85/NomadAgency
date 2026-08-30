// GBP Audit — deterministic scoring engine
// Input: a Place Details response from Google Places API (New) v1.
// Output: { score, grade, breakdown[], issues[], manualCheckItems[] }
// No AI here on purpose: numbers must be reproducible and defensible.

const WEIGHTS = {
  operational: 6,
  website: 12,
  phone: 6,
  hours: 10,
  categories: 8,
  rating: 12,
  reviewCount: 18,
  reviewRecency: 12,
  photos: 12,
  description: 4,
};

// Generic types that don't count as a specific category
const GENERIC_TYPES = new Set([
  'point_of_interest',
  'establishment',
  'store',
  'food',
  'health',
  'finance',
  'place_of_worship',
  'general_contractor',
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function scoreOperational(place) {
  const ok = place.businessStatus === 'OPERATIONAL';
  return {
    key: 'operational',
    label: 'Business status',
    earned: ok ? WEIGHTS.operational : 0,
    max: WEIGHTS.operational,
    detail: ok
      ? 'Listed as operational on Google'
      : `Google shows this business as ${place.businessStatus || 'unknown'} — this suppresses the profile entirely`,
  };
}

function scoreWebsite(place) {
  const ok = Boolean(place.websiteUri);
  return {
    key: 'website',
    label: 'Website link',
    earned: ok ? WEIGHTS.website : 0,
    max: WEIGHTS.website,
    detail: ok ? `Linked to ${safeHost(place.websiteUri)}` : 'No website linked — Google and customers have nowhere to go',
  };
}

function scorePhone(place) {
  const ok = Boolean(place.nationalPhoneNumber || place.internationalPhoneNumber);
  return {
    key: 'phone',
    label: 'Phone number',
    earned: ok ? WEIGHTS.phone : 0,
    max: WEIGHTS.phone,
    detail: ok ? 'Phone number present' : 'No phone number — kills call-through from the local pack',
  };
}

function scoreHours(place) {
  const periods = place.regularOpeningHours?.periods || [];
  // A 24/7 business is one period with no close; otherwise count distinct open days
  const is247 = periods.length === 1 && periods[0].open && !periods[0].close;
  const daysCovered = is247 ? 7 : new Set(periods.map((p) => p.open?.day).filter((d) => d !== undefined)).size;
  const earned = Math.round((Math.min(daysCovered, 7) / 7) * WEIGHTS.hours);
  return {
    key: 'hours',
    label: 'Opening hours',
    earned,
    max: WEIGHTS.hours,
    detail:
      daysCovered === 0
        ? 'No opening hours set — Google may show "Hours might differ" and rank you lower for "open now" searches'
        : daysCovered < 7
          ? `Hours set for ${daysCovered}/7 days (closed days should still be marked as closed)`
          : 'Hours fully set for the week',
  };
}

function scoreCategories(place) {
  const primary = place.primaryType || '';
  const types = (place.types || []).filter((t) => !GENERIC_TYPES.has(t));
  const hasSpecificPrimary = Boolean(primary) && !GENERIC_TYPES.has(primary);
  const secondaryCount = Math.max(0, types.length - (hasSpecificPrimary ? 1 : 0));
  let earned = 0;
  if (hasSpecificPrimary) earned += 5;
  if (secondaryCount >= 1) earned += 3;
  return {
    key: 'categories',
    label: 'Categories',
    earned,
    max: WEIGHTS.categories,
    detail: hasSpecificPrimary
      ? `Primary category: ${place.primaryTypeDisplayName?.text || primary}${secondaryCount ? ` (+${secondaryCount} secondary)` : ' — no secondary categories'}`
      : 'No specific primary category — Google is guessing what this business is',
  };
}

function scoreRating(place) {
  const r = place.rating || 0;
  let earned = 0;
  if (r >= 4.8) earned = WEIGHTS.rating;
  else if (r >= 4.5) earned = 10;
  else if (r >= 4.2) earned = 8;
  else if (r >= 3.8) earned = 6;
  else if (r >= 3.3) earned = 3;
  // below 3.3 → 0
  return {
    key: 'rating',
    label: 'Average rating',
    earned,
    max: WEIGHTS.rating,
    detail: r ? `${r.toFixed(1)} stars` : 'No rating yet',
  };
}

function scoreReviewCount(place) {
  const n = place.userRatingCount || 0;
  let earned = 0;
  if (n >= 200) earned = WEIGHTS.reviewCount;
  else if (n >= 100) earned = 16;
  else if (n >= 50) earned = 14;
  else if (n >= 25) earned = 11;
  else if (n >= 10) earned = 8;
  else if (n >= 1) earned = 4;
  return {
    key: 'reviewCount',
    label: 'Review volume',
    earned,
    max: WEIGHTS.reviewCount,
    detail: n ? `${n} reviews` : 'No reviews — the single biggest local ranking gap',
  };
}

function scoreReviewRecency(place, now = Date.now()) {
  const times = (place.reviews || [])
    .map((rv) => Date.parse(rv.publishTime))
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) {
    return {
      key: 'reviewRecency',
      label: 'Review recency',
      earned: 0,
      max: WEIGHTS.reviewRecency,
      detail: 'No recent reviews to assess',
    };
  }
  const newest = Math.max(...times);
  const ageDays = Math.floor((now - newest) / DAY_MS);
  let earned = 0;
  if (ageDays <= 30) earned = WEIGHTS.reviewRecency;
  else if (ageDays <= 90) earned = 9;
  else if (ageDays <= 180) earned = 6;
  else if (ageDays <= 365) earned = 3;
  return {
    key: 'reviewRecency',
    label: 'Review recency',
    earned,
    max: WEIGHTS.reviewRecency,
    detail: `Most recent review ~${ageDays} day${ageDays === 1 ? '' : 's'} ago`,
  };
}

function scorePhotos(place) {
  // Field mask returns up to 10 photo refs; treat 10 as "10+"
  const n = (place.photos || []).length;
  const earned = Math.round((Math.min(n, 10) / 10) * WEIGHTS.photos);
  return {
    key: 'photos',
    label: 'Photos',
    earned,
    max: WEIGHTS.photos,
    detail: n >= 10 ? '10+ photos on the profile' : n ? `Only ${n} photo${n === 1 ? '' : 's'}` : 'No photos — profiles with photos get far more direction requests and calls',
  };
}

function scoreDescription(place) {
  const ok = Boolean(place.editorialSummary?.text);
  return {
    key: 'description',
    label: 'Profile summary',
    earned: ok ? WEIGHTS.description : 0,
    max: WEIGHTS.description,
    detail: ok ? 'Google shows an editorial summary' : 'No summary shown — thin profile signal',
  };
}

export function scorePlace(place, { now = Date.now() } = {}) {
  const breakdown = [
    scoreOperational(place),
    scoreWebsite(place),
    scorePhone(place),
    scoreHours(place),
    scoreCategories(place),
    scoreRating(place),
    scoreReviewCount(place),
    scoreReviewRecency(place, now),
    scorePhotos(place),
    scoreDescription(place),
  ];

  const score = breakdown.reduce((s, b) => s + b.earned, 0);
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';

  // Prioritised issues: biggest missed points first
  const issues = breakdown
    .filter((b) => b.earned < b.max)
    .sort((a, b) => (b.max - b.earned) - (a.max - a.earned))
    .map((b) => ({ area: b.label, pointsMissed: b.max - b.earned, detail: b.detail }));

  // Things the Places API can't see — sold as part of the full manual audit
  const manualCheckItems = [
    'Google Posts frequency (weekly posting signal)',
    'Owner responses to reviews (response rate and tone)',
    'Q&A section — seeded questions and answers',
    'Services / products lists with descriptions',
    'Business description keyword optimisation',
    'Duplicate or conflicting listings (NAP consistency)',
    'UTM tracking on the website link',
    'AI visibility — whether ChatGPT and Gemini surface this business',
  ];

  return { score, grade, breakdown, issues, manualCheckItems };
}

export function compareCompetitors(place, competitors) {
  const self = {
    name: place.displayName?.text || 'Your business',
    rating: place.rating || 0,
    reviews: place.userRatingCount || 0,
    photos: (place.photos || []).length,
    isSelf: true,
  };
  const rows = (competitors || [])
    .filter((c) => c.id !== place.id)
    .slice(0, 3)
    .map((c) => ({
      name: c.displayName?.text || 'Competitor',
      rating: c.rating || 0,
      reviews: c.userRatingCount || 0,
      photos: (c.photos || []).length,
      isSelf: false,
    }));
  const maxReviews = Math.max(self.reviews, ...rows.map((r) => r.reviews), 0);
  return {
    rows: [self, ...rows],
    reviewGap: maxReviews > self.reviews ? maxReviews - self.reviews : 0,
  };
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export { WEIGHTS };
