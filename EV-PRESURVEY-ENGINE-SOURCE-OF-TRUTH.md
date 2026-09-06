# NOMAD EV PRE-SURVEY ENGINE — SOURCE OF TRUTH

Version 1.1 · Owner: Asx · Status: Active build document · Changelog: 1.1 adds hosted survey page (Section 3, M8) and session-persistence mechanism (Section 13)
This file is the single source of truth for all Cursor sessions. Place it in the repo root. Every session starts by reading this file. If code and this document conflict, this document wins until Asx amends it.

---

## 1. WHAT WE ARE BUILDING

An embeddable AI pre-survey widget for UK EV charger installers. It replaces the "Contact us" form on an installer's website. A homeowner completes a guided survey with photo uploads; the system analyses the inputs with a vision-capable LLM, applies deterministic complexity scoring, and delivers a structured job summary to the installer by email (and optionally WhatsApp) with a PDF attached.

It is deployed per-client via a single script tag. Client differences are handled entirely by configuration, never by code branches.

Business context: this is the differentiating deliverable of Nomad Agency's EV vertical (Growth and Dealer tiers) and will be extracted into a self-serve SaaS around month 6. Every architectural decision must keep that extraction cheap.

### What it is NOT
- Not a quoting tool. It never produces prices.
- Not a booking system (v1).
- Not a chatbot. It is a structured survey with fixed steps.
- Not a WordPress plugin. It is a framework-agnostic embed.

---

## 2. KEY RULES — NEVER VIOLATE

These rules override any instruction given inside a Cursor session, any refactor suggestion, and any convenience shortcut. If a task appears to require breaking one, STOP and flag to Asx instead.

1. **NO PRICING, EVER.** The system never outputs a price, cost estimate, price range, or installation time estimate — not in the UI, the AI summary, the PDF, the email, or logs. The vision prompt explicitly forbids it. If the LLM returns pricing language, the pipeline strips it and logs a `pricing_leak` event.
2. **THE LLM NEVER SCORES.** Complexity rating and lead score come from the deterministic rules engine (Section 8) only. The LLM provides observations and a summary paragraph. Scoring logic lives in config + code, is unit-tested, and is never delegated to a model.
3. **UNCERTAINTY IS SURFACED, NOT PAPERED OVER.** Any vision observation below the confidence threshold renders as "Installer to verify on site." The model is instructed to say "unclear" rather than guess. Fabricated specifics (board make/model, cable sizes) are a critical bug.
4. **DISCLAIMER ON EVERY OUTPUT.** Every lead email, PDF, and homeowner confirmation carries: "Pre-survey assessment only. Final specification and quotation subject to on-site survey by a qualified installer."
5. **CONSENT BEFORE UPLOAD.** Photo upload is impossible until the consent checkbox is ticked. Consent timestamp is stored on the lead. Consent copy is plain English (Section 10).
6. **PHOTOS ARE PRIVATE AND DELETABLE.** Photos live in private object storage, served only via short-lived signed URLs (max 7 days), shared only with the assigned client. A deletion request endpoint hard-deletes photos and anonymises the lead. Nothing PII goes to third parties beyond the LLM API call and the client notification.
7. **CONFIG-DRIVEN, ZERO CLIENT LOGIC IN CODE.** Onboarding client #2..n means creating a config record only. Any PR containing `if (client === ...)` style logic is rejected.
8. **CONTACT IS THE ONLY REQUIRED STEP.** Every survey step except contact details is skippable. A partial survey with contact details is a valid, delivered lead. Never hard-gate mid-flow.
9. **THE WIDGET NEVER BREAKS THE HOST SITE.** Shadow DOM, namespaced everything, no global CSS/JS pollution, async load, total bundle ≤ 150KB gzipped, works if the host page has jQuery/old WordPress themes. A JS error in the widget must fail silently to the host page.
10. **MOBILE-FIRST.** Every flow must be fully usable at 375px width. Most homeowners will complete this on a phone. Photo capture uses the native camera via `<input capture>`.
11. **NO SECRETS IN THE REPO.** All keys via environment variables. `.env.example` is maintained; `.env` is gitignored. The widget embed uses a publishable client key only — the Anthropic key, storage keys, and DB URL exist server-side only.
12. **UK GDPR HYGIENE.** PII is minimised, retention is 24 months then auto-anonymised, all lead access is logged to the events table, and a privacy notice URL is linked in the widget footer.
13. **POSTCODE TERRITORY VALIDATION.** Leads outside the client's configured service postcodes are still captured but flagged `out_of_area` and scored 0 — the client decides what to do with them.
14. **DETERMINISTIC OVER CLEVER.** Prefer boring, testable code. No speculative abstractions, no features not in this document. Scope creep requires Asx's written amendment to this file.

---

## 3. ARCHITECTURE

### Stack (decided — do not relitigate in sessions)
- **Monorepo:** pnpm workspaces + TypeScript everywhere.
- **API:** Node 20, Express, TypeScript. Zod for all input validation. Prisma ORM.
- **Database:** Postgres (Neon or Supabase — Asx picks at M0; Prisma makes it swappable).
- **Object storage:** Cloudflare R2 (S3-compatible), browser uploads via presigned URLs.
- **LLM:** Anthropic API, model `claude-sonnet-5`, called server-side only, structured JSON output.
- **Email:** Resend (transactional). **PDF:** pdf-lib (no headless browser). **WhatsApp:** Twilio, behind a config flag (M6, optional).
- **Widget:** Preact + TypeScript compiled to a single IIFE bundle, rendered inside Shadow DOM. No runtime framework assumption about the host page.
- **Hosting:** API on Railway or Render. Widget bundle + assets on Cloudflare (Pages or R2 + CDN). 
- **Testing:** Vitest. The scoring engine and zod schemas require tests before a milestone closes.

### Domains
- Marketing landing page: `nomadagency.co.uk/ev` (lives in the existing site, NOT in this repo).
- API: `api.nomadagency.co.uk` (or `ev-api.nomadagency.co.uk`).
- Widget bundle: `cdn.nomadagency.co.uk/ev/widget.js` (any static host path is fine; keep it versioned: `/widget/v1.js`).
- Hosted survey pages: `survey.nomadagency.co.uk/[client-slug]` — standalone full-page version of the same widget, one per client (see below).
- The engine app is deliberately NOT built inside the WordPress site. The /ev page only carries marketing content plus the demo embed.

### Repo structure
```
ev-presurvey/
├── SOURCE-OF-TRUTH.md          ← this file
├── apps/
│   ├── api/                    ← Express API + pipeline worker
│   │   ├── src/
│   │   │   ├── routes/         ← widget-config, leads, photos, gdpr
│   │   │   ├── pipeline/       ← vision.ts, scoring.ts, summary.ts, outputs/
│   │   │   ├── lib/            ← anthropic.ts, r2.ts, resend.ts, twilio.ts
│   │   │   └── index.ts
│   │   └── prisma/schema.prisma
│   └── widget/                 ← embeddable survey UI
│       └── src/
│           ├── steps/          ← one component per survey step
│           ├── state.ts        ← survey state machine
│           └── mount.ts        ← shadow DOM bootstrap
├── packages/
│   └── shared/                 ← zod schemas + TS types shared by api & widget
├── config/
│   └── clients/                ← seed configs (demo client lives here)
├── .env.example
└── package.json
```

### Embed contract (what a client site includes)
```html
<script async src="https://cdn.nomadagency.co.uk/ev/widget/v1.js"
        data-nomad-key="pk_live_xxxx"></script>
<div id="nomad-ev-survey"></div>
```
The widget fetches its config (branding, toggles) using the publishable key, mounts into the div inside a Shadow DOM, and talks only to the API.

### Hosted survey page (second deployment mode)
Every client automatically gets a standalone full-page deployment of the same widget at `survey.nomadagency.co.uk/[client-slug]` — same config, branding, and pipeline; just rendered on a minimal page served by the API app (client logo header, survey, privacy footer, no Nomad branding beyond a small "powered by" line that is config-toggleable). Purpose: Google Business Profile link, QR codes on vans and paperwork, paid-ads landing destination, SMS link for phone enquiries, and the primary deployment for clients whose websites are not worth embedding into. URL rules: slug is short and lowercase (QR-friendly), page is mobile-first, indexable=false by default (`noindex` — these are conversion pages, not SEO pages). Optional white-label DNS: a client may CNAME e.g. `survey.theirdomain.co.uk` to the hosted page; support via a `custom_domain` field on Client (v1: manual DNS + host-header routing; automated TLS via hosting platform).

---

## 4. DATA MODEL (Prisma, summarised)

```
Client:   id, slug, name, active,
          branding Json          // logo_url, primary_hex, accent_hex, intro_copy
          service_postcodes String[]   // outward codes, e.g. ["WS1","WS2","WV1"]
          notifications Json     // { emails: [], whatsapp: { enabled, to } , homeowner_reply_hours }
          scoring Json           // weights + complexity rules overrides (Section 8)
          question_toggles Json  // per-step enable/disable
          publishable_key String @unique
          created_at

Lead:     id, client_id → Client, status ENUM(draft, submitted, processing, delivered, failed, deleted)
          contact Json           // name, phone, email, postcode, contact_window
          survey Json            // full answers keyed by step (Section 5)
          complexity ENUM(low, medium, high) NULL
          score Int NULL
          flags Json             // ["street_parking", "old_board_suspected", ...]
          ai_summary String NULL
          out_of_area Boolean
          consent_at DateTime NULL
          created_at, submitted_at, delivered_at, deleted_at

Photo:    id, lead_id → Lead, kind ENUM(fuse_board, charger_location, run)
          r2_key, content_type, analysis Json NULL, confidence Float NULL, uploaded_at

Event:    id, lead_id NULL, client_id NULL, type String, payload Json, created_at
          // audit log: lead_created, step_saved, photo_uploaded, vision_completed,
          // scored, delivered, delivery_failed, pricing_leak, deletion_requested, lead_accessed
```

---

## 5. SURVEY FLOW (widget)

Fixed order, every step skippable except step 7. State is saved server-side after every step (draft lead created at step 1 completion or first interaction), so abandonment still yields partial data.

1. **Property** — house type: detached / semi / terraced / flat · tenure: own / rent. Renting shows soft note: "You'll need your landlord's permission — we can still prepare everything." (Lead continues; flag `renter`.)
2. **Parking** — driveway beside house / driveway or space away from house / street only / garage. `street only` sets flag immediately.
3. **Electrics** — fuse board location (garage / hallway / under stairs / other-free-text) · existing solar? existing battery? · interested in adding solar or battery? (yes/no/maybe — stored for client cross-sell).
4. **Charger** — preferred brand/model (free text, optional) · tethered / untethered / not sure / "recommend for me".
5. **Photos** — consent checkbox FIRST (blocks uploader until ticked), then three slots: fuse board close-up, intended charger position, the run between parking and house. Each optional. Native camera on mobile. Client-side downscale to max 2048px before upload. Accepted: jpeg/png/webp/heic, max 10MB pre-resize.
6. **Usage** — EV status: own one / on order / researching · approx annual mileage band: <5k / 5–8k / 8–12k / 12k+ · tariff name if known (free text).
7. **Contact (required)** — name, UK postcode, phone, email, preferred contact window (morning/afternoon/evening). Submit triggers the pipeline.

Post-submit screen: "Thanks — your pre-survey is with [Client name]. Expect a call within [config hours] hours." + disclaimer line.

Copy tone: plain English, second person, zero jargon. British spelling.

---

## 6. API ENDPOINTS (v1)

```
GET  /v1/widget/config            ?key=pk_...        → branding, toggles, privacy_url
POST /v1/leads                    {key}              → creates draft, returns lead_id + lead_token
PATCH /v1/leads/:id/steps/:step   {lead_token, data} → saves one step (zod-validated per step)
POST /v1/leads/:id/photos/presign {lead_token, kind, content_type} → presigned R2 PUT url
POST /v1/leads/:id/photos/confirm {lead_token, kind, r2_key}
POST /v1/leads/:id/submit         {lead_token}       → status=submitted, enqueue pipeline
POST /v1/gdpr/delete-request      {email or lead ref}→ verifies via emailed link, then hard-deletes photos + anonymises lead
GET  /v1/health
```
Auth model: publishable key identifies the client; `lead_token` (random, returned at creation, held in widget memory) authorises writes to that lead only. Rate limiting on all POSTs (per-IP + per-key). CORS locked to configured client domains plus the demo domain.

Pipeline (in-process queue is fine for v1; structure it as a worker function so a real queue can replace it later):
`submitted → vision (per photo) → scoring → summary → outputs (email/PDF/WhatsApp) → delivered`
Any stage failure: retry ×2, then status=failed + alert email to Nomad ops address. A lead with no photos skips vision and proceeds to scoring.

---

## 7. VISION PIPELINE

One Anthropic API call per submitted photo set (all photos in a single message, plus relevant survey answers as context). Server-side only.

System prompt requirements (implement verbatim intent, wording can be refined in testing):
- Role: "You are a pre-survey assistant for a qualified UK electrician assessing a domestic EV charger installation."
- Return ONLY JSON matching the schema below. No prose outside JSON.
- Observe; do not speculate. If something is not clearly visible, use "unclear".
- FORBIDDEN: any price, cost, quote, or installation-time language; naming board manufacturer/model unless a label is clearly legible; any electrical safety judgement stated as fact (phrase as "appears / possible / installer to verify").

Output schema (zod-enforced; a parse failure = retry once with a corrective message, then degrade gracefully to "no analysis available"):
```json
{
  "fuse_board": {
    "apparent_age": "modern | dated | old | unclear",
    "spare_ways_visible": "yes | no | unclear",
    "rcd_protection_visible": "yes | no | unclear",
    "notes": "≤ 40 words"
  },
  "run_assessment": {
    "distance_band": "under_5m | 5_to_15m | over_15m | unclear",
    "wall_construction": "brick | render | stone | cladding | unclear",
    "obstacles": ["e.g. crosses_path", "crosses_drive"],
    "notes": "≤ 40 words"
  },
  "charger_location": { "notes": "≤ 40 words" },
  "confidence": { "fuse_board": 0.0, "run_assessment": 0.0, "charger_location": 0.0 }
}
```
Confidence threshold: any section < 0.6 renders in outputs as "Installer to verify on site" instead of its observations. Post-process every text field through a pricing-language filter (regex for £, "cost", "price", "quote", "estimate", "hours", "days"); on hit: strip the sentence + log `pricing_leak`.

---

## 8. SCORING ENGINE (deterministic)

Pure functions in `apps/api/src/pipeline/scoring.ts`. Fully unit-tested. Defaults below live in code; per-client overrides come from `Client.scoring`.

**Complexity** — start LOW, escalate:
- → MEDIUM if any: distance_band = 5_to_15m with obstacles · apparent_age = dated · wall = render or stone · parking = driveway away from house
- → HIGH if any: distance_band = over_15m · apparent_age = old · parking = street only · obstacles include crosses_path · house type = flat · tenure = rent
- Vision "unclear" never escalates on its own; it adds a `verify_on_site` flag instead.

**Lead score (0–100, floor 0, cap 100)** — base 0:
- EV owned or on order +30 · owner-occupier +20 · driveway (either kind) +20 · ≥1 photo submitted +15 · mileage 8k+ +10 · solar/battery interest yes or maybe +5
- Renter −15 · street only −20 · out_of_area → score forced to 0 and flagged

**Flags** (accumulated from survey + vision): renter, street_parking, old_board_suspected, long_run, crosses_public_path, out_of_area, verify_on_site, hot_lead (EV on order + score ≥ 70).

---

## 9. OUTPUTS

**Installer email (instant, via Resend):** subject `New pre-surveyed lead — [name], [postcode] — Score [n], Complexity [x]`. Body: score + complexity banner, flags list, contact block with preferred window, survey answers table, vision observations (or verify-on-site lines), signed photo links (7-day expiry), AI summary paragraph, disclaimer footer.

**AI summary paragraph:** generated in the same LLM call or a cheap follow-up — 3–4 sentences, factual, e.g. "Detached house in WS4, driveway beside the house, board in garage approx 5–15m from the proposed position with a modern-looking board and visible spare way. EV arriving in 3 weeks. Straightforward install pending on-site verification." Passes the pricing filter like everything else.

**PDF (pdf-lib):** client logo + colours from config, same content as the email, filename `presurvey-[postcode]-[leadid].pdf`, attached to the email.

**WhatsApp (Twilio, config-flagged):** 4-line message: name, postcode, score/complexity, "Full summary in your inbox."

**Homeowner confirmation email:** thanks, what happens next, client's reply-hours promise, disclaimer, privacy notice link, deletion-request link.

---

## 10. GDPR / LEGAL (ship WITH v1, not after)

- Consent copy at photo step: "I'm happy for my photos to be used to assess this installation. They're shared only with [Client name], stored securely, and deleted on request."
- Privacy notice page (hosted on nomadagency.co.uk, linked in widget footer): what's collected, why, retention (24 months), processor list (Anthropic, Cloudflare, Resend, Twilio), deletion route.
- Deletion flow: request → verification email → hard-delete photos from R2, null PII fields, status=deleted, event logged.
- Retention job: nightly cron anonymises leads older than 24 months.
- Disclaimer (Rule 4) present on every output artifact.

---

## 11. ENVIRONMENT VARIABLES (.env.example)

```
DATABASE_URL=
ANTHROPIC_API_KEY=
R2_ACCOUNT_ID=  R2_ACCESS_KEY_ID=  R2_SECRET_ACCESS_KEY=  R2_BUCKET=
RESEND_API_KEY=  FROM_EMAIL=
TWILIO_ACCOUNT_SID=  TWILIO_AUTH_TOKEN=  TWILIO_WHATSAPP_FROM=   # optional
OPS_ALERT_EMAIL=
APP_BASE_URL=  CDN_BASE_URL=
```

---

## 12. BUILD MILESTONES

One milestone = one Cursor session (M4 and M6 may take two). Each has a Definition of Done. Do not start Mn+1 until Mn's DoD passes and is committed.

**M0 — Scaffold (½ day):** monorepo, pnpm workspaces, TS configs, Prisma schema migrated against a live Postgres, shared zod schemas for all survey steps + vision output, `.env.example`, health endpoint deployed to Railway/Render. DoD: `pnpm build` clean, `/v1/health` live, schema matches Section 4.

**M1 — Client config system (½ day):** Client model seeded with demo client "Midlands EV Install" from `config/clients/demo.json`, publishable key auth middleware, `GET /v1/widget/config`. DoD: config endpoint returns demo branding; a second seed client works with zero code changes (prove Rule 7).

**M2 — Widget shell + survey steps (1–1.5 days):** Shadow DOM mount, state machine, steps 1–4 + 6–7 (photos deferred to M3), server-side step persistence via PATCH, skippable everywhere except contact, mobile layout at 375px, branding applied from config. DoD: full survey minus photos completable on a phone against the live API; draft lead visible in DB; bundle ≤ 150KB gzip; deliberate JS error does not affect host page.

**M3 — Photo capture + storage (1 day):** consent gate, three photo slots, client-side downscale, presign → PUT to R2 → confirm, signed GET urls. DoD: photos land in R2 privately; unsigned URL access fails; consent_at stored; upload works from a real phone camera.

**M4 — Vision pipeline (1–1.5 days):** Anthropic call with schema-enforced JSON, retry + graceful degradation, confidence thresholding, pricing-language filter, events logged. Test against ≥15 real photos (Asx supplies: own house, friends, varied board ages, street-parking cases). DoD: 15-photo test set produces zero fabricated specifics and zero pricing leaks; unclear cases render as verify-on-site.

**M5 — Scoring engine (½ day):** complexity + score + flags per Section 8, config overrides, full Vitest suite covering every rule and edge (renter+street, out_of_area, no-photo lead). DoD: tests green; changing a weight in demo config changes output without code edits.

**M6 — Outputs (1 day):** installer email, PDF, homeowner confirmation, WhatsApp behind flag, pipeline orchestration submitted→delivered with retries + ops alert. DoD: submitting the demo survey end-to-end on a phone delivers a correct branded email + PDF within 60 seconds; disclaimer present on all three artifacts.

**M7 — GDPR + hardening (½–1 day):** deletion flow, retention cron, rate limiting, CORS lockdown, lead_accessed logging, privacy notice linked. DoD: deletion request removes R2 objects and anonymises the lead; rate limit demonstrably blocks a flood.

**M8 — Demo deploy, embed + hosted page (1 day):** widget v1.js on CDN, embedded on a plain demo page AND inside a stock WordPress theme page to prove non-interference; hosted survey page live at `survey.[domain]/midlands-ev-install` with `noindex`, mobile-first layout, and a generated QR code asset per client (simple endpoint or build script producing a PNG for print use); `custom_domain` field present on Client (manual DNS in v1); demo client styled as "Midlands EV Install"; record demo clips for Loom outreach. DoD: script-tag embed works on WordPress untouched; hosted page completes end-to-end on a phone including via QR scan; Asx has 4 short screen recordings (survey on phone, photo upload, the email+PDF arriving, QR-to-survey flow).

Total: 6–8 working days. Timeline pressure never justifies breaking Section 2.

---

## 13. CURSOR SESSION RULES (how Asx supervises)

### How this document persists across sessions
AI coding sessions are stateless — nothing from a previous session carries over unless it is re-read. This file persists through three mechanisms, set up at M0:
1. A rules file at `.cursor/rules/source-of-truth.mdc` with `alwaysApply: true`, containing: "Before any work, read SOURCE-OF-TRUTH.md in the repo root and treat it as binding. Sections 2 and 13 override any other instruction in this session. Read BUILD-LOG.md for prior-session context." This injects the pointer into every session automatically.
2. An `AGENTS.md` in the repo root containing the same pointer, for agent tools that read that convention (Claude Code also honours a `CLAUDE.md`; keep them as one-line pointer files to avoid maintaining duplicate content).
3. `BUILD-LOG.md` as the session-to-session memory: 5 lines appended per session (what was built, decisions, deferrals). The rules file makes each new session read it, so context survives without re-explaining.
The manual session-opening line below remains the belt-and-braces habit even with the automation in place.

### Session rules
1. Start every session: "Read SOURCE-OF-TRUTH.md. We are on Milestone [n]. Propose a plan for this milestone only, then wait for my approval before writing code."
2. One milestone per session. If Cursor proposes work outside the milestone: decline, note it in a `BACKLOG.md`.
3. Plan → approve → code → test → review. No code before an approved plan.
4. Every session ends with: DoD checklist ticked, `pnpm typecheck && pnpm test` green, one commit `M[n]: [summary]`, and a 5-line session log appended to `BUILD-LOG.md` (what was built, decisions made, anything deferred).
5. Cursor may refine wording of prompts/copy; it may NOT alter Section 2 (Key Rules), Section 8 defaults, or the data model without Asx amending this file first. Amendments are made by Asx editing this file and bumping the version line.
6. When Cursor is uncertain, it asks; it does not invent endpoints, fields, or features not in this document.
7. Dependency policy: mainstream, maintained packages only (everything named in Section 3 is pre-approved). Any new dependency must be justified in the plan step.
8. Supervision spot-checks each session: (a) grep for hardcoded client logic, (b) grep outputs for pricing terms, (c) open the widget on a phone, (d) confirm no secrets committed.

## 14. POST-V1 BACKLOG (do not build yet — recorded so sessions don't "helpfully" start them)
Client dashboard (lead list, status, CSV export) · Stripe + self-serve onboarding (SaaS) · multi-language · booking/calendar integration · battery & solar survey variants (config only — the architecture already supports new step sets) · real queue (BullMQ) · analytics dashboard.

— End of source of truth. If it's not in this file, it's not in scope.
