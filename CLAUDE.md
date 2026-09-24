# BasePlate

A personal tool for a LEGO reseller/investor. It answers three questions about any
LEGO set: **what's it worth, should I buy it at this price, and what should I do
with it** (flip sealed / part out / reconstruct). Built for one user, run locally.

## KEEP THIS FILE CURRENT
This file is the contract for every agent that touches BasePlate. It goes stale fast —
the roadmap moves, APIs unlock, sacred rules get refined.

**Whenever you change something this file describes, update this file in the same
change.** That includes:
- A new/changed data source, its auth, its quota, or its status (e.g. BrickLink
  flipping from PENDING → LIVE, part-out going from MOCK → real).
- A change to core logic: verdict rules, fee %s, thresholds, strategy gating,
  forecast tiers, retirement-date precedence, condition handling.
- Anything shipped from the Roadmap → move it into **Built**, and re-rank what's left.
- New architectural rules, new deps, new frozen/"do not touch" files, new commands.
- Anything that would surprise the next agent if it only read this file.

If you finish a milestone and this file still describes the old world, the milestone
isn't done. If you're unsure whether a change is worth recording: record it — a stale
line here causes worse damage than a redundant one.

## What this is (and isn't)
- A private, local decision tool — NOT a public site, marketplace, or catalog mirror.
- The end goal is a personal "hub" for selling + investing: valuation, part-out,
  investment suggestions, a P&L dashboard, and eventually retailer deal data — with
  an AI layer that recommends the best move per set.
- It is NOT a data-scraping or competing product; API use stays within each
  provider's terms.

## THE SACRED RULE: honesty over completeness
This tool informs real money decisions. It must NEVER show a fabricated, estimated,
or stale number as if it were real. A blank labeled "unavailable" is always better
than a confident guess.
- Missing data → "insufficient data" / "not valued yet", never $0.00, never a guess.
- Estimated/derived values → visibly flagged as estimated.
- Stale/quota-exhausted data → shown WITH a stale banner, every render, never silently.
- Mock data (e.g. part-out before BrickLink) → loudly labeled MOCK, never presented
  as a real quote.
- When the honest answer is "we can't show that," find the true thing that's more
  useful (e.g. show a max-buy ceiling instead of a fake BUY chip) — don't fake it.
- **A resale figure is MARKET VALUE, labeled as such** — the observed band price. BasePlate
  computes no asking price, so no surface may call it a "suggested resale" or "suggested
  list price". Naming the band it came from ("used market value, no box") is the fix.
- **Never deduct an invented cost.** Effort/time costs are shown as a TAG beside a net,
  never subtracted from it — a made-up dollar sitting in a column of measured ones is
  exactly the failure this rule exists to prevent.

## THE OTHER SACRED RULE: quota discipline
BrickEconomy is capped at 100 requests/DAY. This shapes the whole architecture.
- **Rendering/browsing/sorting/filtering NEVER spends a request** — reads come from
  the local cache only. Only an explicit user action ("Value this set" / "Refresh")
  spends exactly one request, per set, per click.
- No auto-fetch on render, ever. A grid of many cards reads cache; uncached cards
  wait for their explicit button. A broad search spends zero.
- All outbound API calls are logged (ApiRequest) and shown in a quota meter.

## Architecture
- **Ports & adapters.** The valuation engine (`src/lib/`) is PURE — no I/O, no Prisma,
  no adapter imports. It only touches injected interfaces. All I/O (value providers,
  catalog, cache, persistence) lives behind ports implemented in `src/db/`.
- **Never modify** `src/lib/valuation.ts`, the engine's purity, or an adapter's
  behavior without explicit approval. Additive logging (e.g. recordRequest) is the
  only sanctioned touch of a frozen file, and must be flagged.
- **`src/lib/platforms.ts` is the single source of truth for every net in the app.** A
  hand-edited config (like `src/trending.ts`, but inside `src/lib` so the engine imports a
  sibling): one row per venue with its fee formula, which plays it can host, its reach, and
  its effort. `ANCHOR_PLATFORM` names the venue each play's verdict is anchored to — it
  replaced a hardcoded `'ebay'` and a bare `0.92` BrickLink multiplier. `src/lib/fees.ts` is
  now a thin id-keyed adapter over it, kept precisely so `fees.test.ts` keeps pinning the
  published rates to hand-computed values. **Adding a platform is a config edit, not a code
  change.**
- **Next.js (App Router) + TypeScript + Tailwind + Prisma + SQLite.** Same package,
  `app/` at root, two tsconfigs (Next-facing + Node-facing engine/CLI/tests).
- **Server-side secrets only** — no API key ever reaches the client bundle. All
  provider calls run in Server Actions / server components.
- **Cache-first + daily freshness.** Values cached per set/day; "fresh today" is free
  to show, older is stale (shown with banner, refreshable for 1 request). Cache
  persists across restarts. Quota resets 00:00 UTC.
- **DB-enforced constraints** over convention; prefer zero new deps; one fixed
  timezone (America/New_York) for day boundaries.
- **Set-number equivalence:** `75192` and `75192-1` are the same set — all reads use
  `equivalentKeys`, never exact-match.
- **Minifig numbers have NO equivalence rule.** `sw0011a` is Chewbacca and `sw0011` is a different
  figure, so a variant letter is part of the identity: nothing is normalised beyond trim +
  lowercase, and the fig client performs **no `-1` retry** (a fig number has no variant-suffix
  concept). Copying `equivalentKeys` here would file one figure's price under another's name.
- **Valuation reads are condition-BLIND.** A `Valuation` row carries every price band, so
  `condition` is only part of the cache key `@@unique([setNumber, condition, fetchedOn])`
  and a stored label. No read may filter on it — doing so reported "not valued yet" for
  sets whose numbers were already on disk, and offered to spend a request re-fetching
  them. Writes are filed under one canonical condition (`sealed`); reads accept any.
  When several rows match, `pickValuationRow` (`src/lib/valuationRows.ts`) decides:
  newest `fetchedOn` → exact spelling → sealed-first → `fetchedAt` → `id`. Freshness
  beats spelling, deliberately: the reverse showed a stale banner on a set valued today.

### Routes
| Route | Kind | Notes |
|---|---|---|
| `/` Lookup | RSC + client `LookupBoard` | `?q=`/`?sort=` mirrored via `replaceState`. `?set=` is the old deep link and 307-redirects to `/set/…`, so bookmarks live. |
| `/watchlist`, `/trending` | pure RSC | No client state at all. Trending's ranking is a server-side sort by 12m growth. |
| `/retiring` | RSC + client `RetiringBoard` | Whole view (sort/theme/price/flags/query/months) lives in the URL. |
| `/set/[setNumber]` | RSC + client `SetDetailView` | The detail/decision view, openable from every board. Also renders the minifig panel. |
| `/minifig/[minifigNumber]` | RSC + client `MinifigDetailView` | One figure: value, max-buy ceiling, exclusivity, observed price events. Cache-only on arrival. |

- **Detail is a ROUTE, not a dialog. There is no `<dialog>` anywhere in this app** — do
  not reintroduce one for this. It was a full-screen native dialog living on Lookup, and
  that had three bugs at once: the browser top layer painted it OVER the app header, it
  read Lookup's client state so no other page could open it, and closing always dumped
  the user on Lookup. As a route the header renders above it for free, and "close" is a
  back link. Opening it reads `readSetPreviews` — **cache only, zero API requests.**
- **The origin travels in `?from=` and is NEVER trusted.** `parseOrigin`
  (`src/lib/origin.ts`, pure + unit-tested) rejects anything not starting with a single
  `/`, anything containing `\` (browsers normalise it, so `/\evil.com` ≡ `//evil.com`),
  control characters, over 512 chars, and any unknown pathname — including `/set/…`,
  which is what stops `?from=` nesting. Everything rejected falls back WHOLLY to Lookup,
  href included, so the back button is never dead and its label always comes from
  `ORIGIN_LABELS` rather than from the URL. Boards pass `from`; Retiring and Lookup
  compute theirs from live state via `useMemo`, never by reading `window.location`.
- **Set → Fig → back-to-Set travels in FOUR SCALARS, not a nested `?from=`.** `src/lib/origin.ts`
  is **unmodified** and still refuses `/set/…` and `/minifig/…` as origins — rewriting the one file
  whose job is refusing hostile input, to carry a breadcrumb, is the wrong risk. (It is also
  load-bearing that every `Origin` has a `label`: `origin.test.ts` reads
  `parseOrigin(value).label` on every rejected value, so a label-less variant is a compile error.)
  Instead `src/lib/figOrigin.ts` carries `?inSet=` (a set NUMBER validated by
  `isAddressableSetNumber`, **never used as an href** — it is handed to `detailHref`, which BUILDS
  the path, so a non-set-number can never become a redirect), `?cond=` (narrowed by `isCondition`),
  `?buy=` (bounded and **re-serialised from the parsed number**, so no exponent form reaches a URL)
  and `?from=` (the board, parsed by the untouched `parseOrigin`). Nesting is bounded **by type**:
  a fig's origin is a set number, a set's origin is a board, a board has no origin — depth two,
  with nowhere to put a third level.
- **The set NAME on a fig's back link comes from the DATABASE, never the URL.**
  `resolveBackLink` (`src/db/originLabel.ts`) looks it up via `readSetPreviews` — a cache read,
  zero requests — falling back to `Set 10236-1`. The URL can supply a number; it can never supply
  a word. `figHref` also carries `?from=` only when `parseOrigin` would actually ACCEPT it, so a
  URL never carries a value its destination is guaranteed to throw away.
- **Cards use the stretched-link pattern:** `article.group.relative.isolate` + a `<Link>`
  inside the `<h3>` carrying `after:absolute after:inset-0 after:z-10`, with every
  interactive child at `relative z-20`. Never nest a button or form inside a link.
  `isolate` is load-bearing — `relative` with `z-index: auto` creates no stacking
  context, so without it a card's `z-20` competes with the sticky header.
- **The app header is sticky at `z-30`.** Anything overlaying content stays below it or
  becomes a real route. Note this is also why `html:has(dialog[open]) { overflow: hidden }`
  had to go: a sticky element inside an `overflow: hidden` ancestor does not stick.
- **Card links set `prefetch={false}`.** NOT a quota rule — the detail route cannot reach
  the network, so prefetching it is provably request-free — but sixty cards prefetching is
  sixty pointless renders and six queries each.
- **A URL never runs a search.** Lookup mirrors `q`/`sort` into the URL, but the `touched`
  ref still gates the search effect. Returning from detail restores results from the
  module-scope `sessionCache` **in a mount effect** — reading it during render would make
  the client's first paint disagree with the server's empty grid and hydration would tear.
  A cold `?q=` URL fills the box and waits for an explicit "Run this search" click.

## Commands
| Command | What it does |
|---|---|
| `pnpm dev` | Next dev server |
| `pnpm build` / `pnpm start` | Production build / serve |
| `pnpm valuate` | Valuation engine CLI |
| `pnpm test` | Node test runner over `src/**/*.test.ts` |
| `pnpm typecheck` | Both tsconfigs (Next-facing + Node-facing) |
| `pnpm db:push` | Push `prisma/schema.prisma` to SQLite |

**Env tunables** (all via the `xFromEnv(env = process.env)` convention — a pure function taking a
plain record, so tests pass a literal; see `factorsFromEnv`):

| Var | Default | What it does |
|---|---|---|
| `MINIFIG_SHARE_THRESHOLD` | `0.50` | The minifig-rich bar. Ignored outside (0, 1]. |
| `MINIFIG_BATCH_MAX` | `4` | Most figs one batch click may value. A BUDGET guard, not a rate one. |
| `BRICKECONOMY_MIN_GAP_MS` | `1100` | Gap between fig requests. Politeness, not a measured limit. |
| `USED_NOBOX_FACTOR` | `0.80` | Only when an observed with-box value lacks a low band. |
| `RETIRING_WINDOW_MONTHS` | `6` | Default retiring-board window. |

## Data sources
| Source | Role | Auth | Status |
|---|---|---|---|
| **BrickEconomy** | Set + minifig values, 12m trend, 2y forecast | `x-apikey` header | LIVE. 100 req/DAY, shared by `/set/` and `/minifig/`. `{data:{...}}`. One set request returns ALL condition bands **and the set's minifig id list**. |
| **Brickset** | Market-wide catalog: retirement (exitDate), availability, MSRP, images | `apiKey` param | LIVE. Only `getSets` counts vs quota; `getKeyUsageStats` reports usage (no published limit). Read-only, getSets + getKeyUsageStats only. |
| **Rebrickable** | Set search (name→number), images | `Authorization: key <KEY>` | LIVE. ~1 req/sec, BANS on abuse. Read-only, `/lego/` GETs only. **NOT used for minifigs at all** — see below. |

**BrickEconomy minifig facts (MEASURED 2026-07-30, 7 live requests).** The official
`/api-reference` is Cloudflare-403 to any fetcher, so this was established by observation:
- `GET /api/v1/minifig/{n}` — same key, same envelope, same 100/day allowance. Id space is
  **BrickLink's** (`sw0509`, `sw0011a`, `cas559`), never Rebrickable's.
- The payload is exactly TWELVE fields: `minifig_number, name, description, set_count, sets[],
  theme, subtheme, year, released_date, current_value_new, price_events_new[], currency`.
  There is **no used band, no forecast, and no growth field** — so a minifig has no trend and no
  forecast tier, and neither is invented. `price_events_new` is 12 observed `{date, value}` pairs,
  shown as observations with no delta computed from them.
- `set_count` + `sets[]` ship with every fig value, so **exclusivity needs no BrickLink**.
- **The widely-repeated "4 requests/minute" limit is NOT real** — 7 requests in 9.2s drew no 429.
  The binding constraint is the published 100/DAY. `BRICKECONOMY_MIN_GAP_MS` defaults to 1100
  (the Rebrickable convention) as politeness, not as a measured requirement.
- A part-shaped id (`90398pb015`) answers **HTTP 400 with the bare body `Bad Request`** — not JSON,
  so status decides. That is the one error that writes a permanent `MinifigAbsence`.

**Why Rebrickable is off the minifig path entirely.** It identifies figs as `fig-001549` and
exposes `external_ids` for parts but **not** minifigs — confirmed by a Rebrickable moderator
("Indeed it is an omission"), by `minifigs.csv` having exactly four columns and no BrickLink one,
and by staff closing the bulk-mapping request permanently. There is no published mapping from
`fig-001549` to `sw0509`, so a Rebrickable-first fig pipeline could never have valued anything.
Do not add one; do not scrape their HTML (the charter forbids it and the data is not theirs to
redistribute); do not match the two lists by position — ordering across two id spaces is not an
observation.
| **BrickLink** | Part-out SOLD value, subsets (inventory), supersets (minifig exclusivity) | OAuth 1.0 HMAC-SHA1, 4 creds | PENDING seller verification (~2wk). IP-pinned (static IP / fixed egress needed to deploy). `{meta:{code},data}`, prices are fixed-point strings. Read-only, Catalog Item GETs only. |
| **BrickOwl** | (was: reconstruct cost) | — | DECLINED for this use case. Revisit only if a BrickOwl store is opened. |
| **LEGO Pick-a-Brick** | Cheap common-part sourcing (CSV upload by ElementID) | none (no API) | Future, for reconstruct optimizer. BrickLink item_mapping gives part→ElementID. |
| **Retailer deals** | Live retail prices / "where to buy" | — | NOT YET SOURCED. Needed for the deals layer. |

## Core logic
- **Conditions:** FIVE — sealed / **open box (bags sealed)** / used-with-box / used-no-box
  / incomplete. A set HAS values for all of them at once. Condition is NOT a filter on
  display — cards show all. Condition is chosen only for the buy/pass verdict, in the
  detail view. One "Value this set" click fills every condition, because one BrickEconomy
  request returns every band.
- **Open box has NO price band and none is invented.** BrickEconomy publishes new /
  used-with-box / used-no-box and nothing between, so an opened box with sealed inner bags
  is priced as `part_out` only — at the FULL figure, because the bags were never opened
  and the parts are genuinely new. `flip_sealed` is ruled out (the box is open, and
  scoring it would quote `valuation.sealed` for a box that isn't sealed); `resell_used` is
  ruled out with "no open-box market data". Pricing it off the used-with-box band was
  considered and rejected — that is deriving a number, not observing one. Consequence to
  live with: `part_out` is MOCK until BrickLink lands, so an open-box verdict today shows
  the loud MOCK notice and no actionable figure. That is the honest answer.
- **Which band prices a resale is a total `Record<Condition, …>`** (`RESELL_BAND` in
  `verdict.ts`). It replaced `condition === 'used_nobox' ? usedNoBox : usedWithBox`, whose
  switch was exhaustive over `Strategy` and not `Condition` — so every condition added
  after it silently priced off `usedWithBox`. A new condition is now a compile error there.
- **Card headline:** `bestCall(callsByCondition(v))` — the best play across all
  conditions. NEVER render it without naming the condition it assumes; an unlabelled
  "BUY UNDER $X" quotes a ceiling for a play the user may not be able to make.
- **Lookup sort** (`src/lib/lookupView.ts`) is pure client-side reordering of cards
  already loaded: zero requests, and it can never hide or blank a card. Keys: relevance,
  sealed high→low, sealed low→high, used high→low, name, year — both sealed options are
  labelled with their direction so neither is ambiguous. Unknown figures sink to the
  bottom **in BOTH directions**: negating the descending comparator would float unvalued
  cards to the top of a "lowest price first" sort as if they were the cheapest thing on
  the page, which is a filter wearing a sort's clothes. Stale cards rank with fresh ones
  (their prices are real, just older, and the banner says so). Ties fall back to
  Rebrickable relevance order. `LOOKUP_SORT_OPTIONS` is built from a total
  `Record<LookupSortKey, …>`, so a key with no menu entry is a compile error rather than
  a sort that exists in the type system and nowhere a user can reach.
- **Verdict:** given a set + buy price + condition, pick the best eligible play
  (flip_sealed / part_out / resell_used), compute net after fees, return BUY if margin
  clears the threshold (default >25%, strictly). Rates all live in `src/lib/platforms.ts`:
  eBay 13.6% + $0.40 (**$0.30 at or below $10**), Mercari 10%, FB local 0,
  FB shipped **max(5%, $0.40)**, BrickLink 8% on a part-out. The verdict is **anchored to
  one venue per play** (`ANCHOR_PLATFORM`: eBay for the marketplace plays, BrickLink for
  part-out) so BUY/PASS stays a single call — a fee-free cash channel must never silently
  flip a PASS to a BUY. The other venues are compared beside it, not folded into it.
- **"Should I buy" is condition-specific; "Ways to act" is condition-INDEPENDENT.** The
  selector prices one purchase; the opportunity map (`src/lib/waysToAct.ts`) shows every
  priced play regardless of it. They were coupled, and picking a condition silently hid
  avenues from the map that is supposed to be complete. `actMatrix()` takes a `Valuation`
  and no condition — keep it that way. It is DERIVED from `CONDITIONS` × `ELIGIBILITY` ×
  `bandFor`, so the 5×3 grid collapses to its four distinct priced cells today and a new
  condition or band joins with no edit.
- **Absent plays are blank, not "unavailable".** In the map a play is either shown with a
  real net or cleanly absent — never a row reading "off the table". Absence is disclosed
  ONCE, together, with the engine's own reason (`AbsentNote`). A band that is null OR
  non-positive is absent: a $0.00 band is a gap in the data, and pricing it would render
  "market value $0.00, net -$0.30" as if it were a real, terrible deal.
- **A local cash sale is never crowned on net alone.** `reach: 'local'` rows (FB local) rank
  by net like everything else but can never be `best` — they out-net the marketplaces only
  by giving up shipping reach and buyer protection, so they surface as `topLocal`, a trade
  rather than a better price. Channel availability is config data too: `plays` keeps
  fb_local away from part-out entirely (you are not handing over 3,000 loose bricks in a car
  park), rather than filtering it at the render site.
- **Strategy gating by condition:** sealed → flip_sealed + part_out; **open_box →
  part_out only**; used_box → resell_used(usedWithBox) + part_out; used_nobox →
  resell_used(usedNoBox) + part_out; incomplete → part_out only. Ineligible plays return
  N/A with a reason. Every condition must keep at least one eligible play — `verdict()`
  throws outright on an empty list, and a test asserts it for every member of `CONDITIONS`.
- **No used data (in-production sets):** resell_used → "insufficient data", never
  derive used from sealed. (`USED_NOBOX_FACTOR` 0.80 applies ONLY to an observed
  with-box value lacking a low band — never to invent used from sealed.)
- **Part-out:** subsets → per-lot BrickLink sold price × qty, discounted for low
  `unit_quantity` liquidity. MOCK until BrickLink lands. Keep minifigs whole. Note the
  BrickLink row in `platforms.ts` carries a REAL 8% seller rate — the part-out **value** is
  what's still mock. Adding that row un-mocked nothing.
- **Forecast tiers (badge):** by % growth — Negative <-15%, Flat [-15%,+15%),
  Positive [+15%,+40%), Strong >=40%. One threshold constant per edge. Trend-based /
  lagging — confirms what's already climbing, misses sleepers (that's the precedent
  engine's job). **NEVER rendered for a minifig**: BrickEconomy publishes no growth for one, and
  `MinifigFacts` has no such field — so it is a compile error rather than a badge computed off a
  defaulted 0 that would read "Flat" and mean "we never asked".

### Minifigs + the 50% rule
- **Identity is FREE and retroactive.** A set's fig list arrives inside its own BrickEconomy
  payload (`minifigs: string[]`), which `SetSnapshot.payload` has stored verbatim since the adapter
  was written — `BrickEconomySet` just never modelled the field. `readSetRoster`
  (`src/db/brickeconomy/minifigRefs.ts`) re-parses it through `equivalentKeys`. Zero requests, for
  every set ever valued. **`BrickEconomySet` deliberately does NOT gain `minifigs`**: it already
  omits `upc`, `ean` and four `retail_price_*` fields, so it is a partial view by design, and both
  readers do an unchecked `JSON.parse(payload) as BrickEconomySet` — a declaration would buy no
  runtime safety while spending an approval on a frozen file. Validation lives at the read site.
- **Three id kinds** (`MINIFIG_ID_RULES`, a total Record): `brickeconomy` (askable + batchable);
  `unclassified` — measured, 20 of this DB's 178 ids are BrickLink PART numbers like `90398pb015` —
  askable **individually only**, never batched; `rebrickable` (`fig-001549`) — **no button at all**,
  because no mapping exists to ask through.
- **Six fig states, and collapsing any two prints a guess:** `unvalued` (never asked) / `valued` /
  **`no_price`** (BrickEconomy knows it and publishes no value — NOT "not valued yet", never $0.00,
  no Value button) / `absent` (confirmed 400/404) / `unaddressable` / `unreadable`. Folding
  `no_price` into `valued` is what makes "3 of 5 valued — $340" print over a sum of two.
- **`MinifigAbsence` is a PERMANENT negative cache**, keyed by number alone with **no day column** —
  permanence is a shape, not a read policy someone can forget. Written from exactly one place: the
  `BrickEconomyUnknownMinifigError` branch of the fig source. **Never** on a 429, a timeout, or from
  the batch loop — a quota error is not evidence of absence. Overridable only by an explicit
  "Ask again", which bumps `attempts`.
- **The share is over DISTINCT figures and is never quantity-weighted.** `minifigs_count` exceeds
  `minifigs.length` on 6 of this DB's sets (10236-1: 17 vs 15), because the array names distinct
  figs while the count includes duplicates — and BrickEconomy publishes no per-fig quantity, while
  Rebrickable's is in the unjoinable id space. The gap is disclosed in words, never smoothed over.
- **A percentage cannot leave `minifigShare.ts` without its coverage sentence.** The unrenderable
  variants (`no_denominator`, `no_numerator`) carry **no `ratio` property at all**, and
  `shareLines()` is the only renderer — it returns headline + coverage + dates together or not at
  all. `AsOf` marks a ratio whose inputs were never true on the same day. Percentages round DOWN so
  the printed number and the flag can never disagree at the bar.
- **The rich flag is THREE-valued**, not boolean. `rich` iff `ratio >= threshold` — sound for a
  floor too, because every source of error understates, so a clearing floor is a **proof**.
  `not_rich` requires complete coverage. Otherwise `not_assessable`: a floor *under* the bar proves
  nothing, and rendering it as "not minifig-rich" is the lie the third value exists to prevent.
- **Denominator is the set's SEALED market value** (`valuation.sealed`), not MSRP. An unvalued set
  yields `no_denominator` — the dollar total still shows, the percentage cannot.
- **Valuing figs is always deliberate.** Per-fig buttons, plus a batch capped at
  `MINIFIG_BATCH_MAX` (default 4) whose cost is computed SERVER-side from the current cache so a
  stale client cannot inflate it. There is **no multi-request Server Action**: the client calls the
  single-fig action once per fig, sequentially, with a Stop button — so nothing sleeps for minutes,
  every fig is written the moment it resolves, and a second click resumes rather than restarts.
- **A fig's ceiling reuses the set machinery**: `maxBuyPrice(netForPlatform(value, bricklink))`.
  No new pricing logic, and no condition/strategy machinery — those are set-shaped concepts.
- **Exclusivity is REAL DATA, not an empty slot.** `set_count` + `sets[]` come with the fig value.
  `exclusiveTo` is asserted ONLY when the list NAMES exactly this set — a reported count of 1 with
  no list supports "appears in 1 set" and not "exclusive to this set"; a count is not an identity.
- **No fig name search exists, in any usable id space**, so Lookup offers exact-number lookup (free)
  plus a labelled search over figures already valued. Fig results render in their own section —
  `lookupView.ts` is untouched, because every sort key is set-shaped.
- **Retirement dates:** Brickset exitDates are mostly year/month BUCKETS, not real
  days — label honestly ("end of 2026 — a year, not a date"). Precedence: future
  LEGO.com dateLastAvailable > cached BrickEconomy retired_date > Brickset bucket. A
  PAST LEGO.com date = "direct sales ended" (a channel event, not retirement) → used
  only as a bucket tiebreak, never as the headline date.

## Built (as of this writing)
- Valuation engine + CLI (`pnpm valuate`)
- Web UI: Lookup, Watchlist, Trending; dark/light; BasePlate branding
- Set search by name (Rebrickable) + smarter local-cache/synonym search
- Retiring board: market-wide (Brickset), sort/filter/in-board search, honest date
  bucketing, forecast badges
- Forecast tiers (graded, symmetric)
- Lookup redesign: browse→preview→value grid, max-buy ceiling, all-conditions cards,
  sort-only control (incl. sealed price both directions)
- Detail/decision view as its own route `/set/[setNumber]`, with written BUY/PASS
  reasoning — openable from EVERY board, returning to its origin via a validated `?from=`
  back link under the app header
- Shell polish: sticky header, whole-card click targets with a pointer cursor, no inline
  expand on grid cards
- Open-box condition (part-out only; no band invented)
- Hand-edited platform config (`src/lib/platforms.ts`) — fee formulas, per-play channel
  availability, reach and effort; single source of truth for every net, add a venue by
  editing one file
- Detail view "Ways to act": the condition-INDEPENDENT opportunity matrix (every priced
  play at once, honest blanks, one absence disclosure, no "off the table" phrasing)
- Detail view "Should I buy": multi-platform net strip — net, Δ vs the eBay anchor, margin
  and which venues clear the bar, with the best avenue named and its non-fee cost stated

- **Minifig valuation + the 50% rule** — fig identity free from the set payload (zero requests,
  retroactive); per-fig BrickEconomy values with a permanent negative cache; three-valued
  minifig-rich flag whose percentage cannot render without its coverage sentence;
  `/minifig/[minifigNumber]` route with a Set→Fig→Set breadcrumb in scalar params; exclusivity
  from `set_count`/`sets[]`; deliberate per-fig and capped-batch spending. Caveats, all disclosed
  in the UI: no fig artwork, no per-fig quantity, no fig trend/forecast/used band, and no fig name
  search (exact-number lookup + cached-name search only)

## Roadmap (priority order)
1. **Dashboard / inventory** — P&L (made/invested), owned-sets table, order tracking,
   retirement calendar. Unlocks "you own this / parted out" flags and repricing.
2. **Deals / "where to buy" layer** — retailer prices + affiliate links. BLOCKED on a
   retail-price data source (its own project).
3. **Part-out (real)** — BLOCKED on BrickLink unlock. Then the part-out OPTIMIZER:
   hidden-expensive-piece color substitution, sticker-sheet external sourcing, minifig
   whole-vs-parts decomposition.
4. **Precedent engine** — the real forecasting brain. Combines measurable signals:
   minifig novelty (first-of-kind), exclusivity (fig in one retiring set), the 50%
   rule, variant-lineage history (e.g. distinctive Vader variants appreciate),
   retirement timing, theme performance. MUST surface the historical comparables it
   reasons from — never a black-box BUY. **Partly unblocked already**: fig values, the 50% rule
   and exclusivity (`set_count`/`sets[]`) all ship today with no BrickLink access, so this can
   start on real signals. Variant lineage and sold-history still need BrickLink.
5. **Sourcing/reconstruct optimizer** — cheapest way to buy all a set's parts across
   BrickLink + LEGO Pick-a-Brick, shipping- and lead-time-aware. Needs BrickLink.
6. **Later inputs:** social/hype signal (needs social data), live LEGO.com dates.

## Known issues (raised, not fixed — need approval to touch a frozen file)
- **`prisma/schema.prisma`'s platform comment is drifted.** `Listing.platform` reads
  `// one of Platform: ebay | mercari | fb_shipped | fb_local`, but the platform vocabulary
  now lives in `src/lib/platforms.ts` (as `PlatformId`, derived from the config) and
  includes `bricklink`. The `Listing` model is neither read nor written by anything, so
  nothing breaks — but the comment is wrong, and fixing it means editing a frozen file.
- **"Spends 1 request" is not always true.** `src/db/brickeconomy/source.ts`'s `inFlight`
  memo is retained for the process lifetime on success, so a SECOND Refresh of the same
  set in the same server process makes zero network calls. The buttons now say "spends
  up to 1 request" rather than overstating it. Fixing the memo means editing a frozen
  adapter — ask first.
- ~~`Valuation.condition`'s comment omits `open_box`~~ — **FIXED**, riding along with the approved
  minifig schema touch, as this entry asked. No migration was ever needed.
- **Set-valuing and fig-valuing do not share a throttle.** The fig source paces its own requests
  (`BRICKECONOMY_MIN_GAP_MS`); `src/db/brickeconomy/client.ts` paces nothing. Valuing a set in the
  middle of a fig batch can therefore burst. Harmless against the measured behaviour (no
  per-minute limit was observed), but fixing it properly means putting a throttle inside the
  frozen set client — **ask first**.
- **The ~4 requests/minute figure is third-party and was NOT reproduced.** 7 requests in 9.2s drew
  no 429. `BRICKECONOMY_MIN_GAP_MS` exists so a wrong assumption costs a config edit, not a deploy.
- **Lookup's transient per-card state does not survive opening a set.** `errors` and
  `busy` are lost on navigation to the detail route — the search results, the URL's
  `q`/`sort`, and anything valued mid-session all come back, but an error message does
  not. Accepted when detail became a route; re-raise if it ever bites.
- **Valuing from the Retiring board still drops the board's filters.**
  `valueRetiringSetAction` redirects to `retiringPath(months)`, keeping only `months` —
  pre-existing, and untouched by the detail-view work, which routes around it via `?from=`.

## Working agreement for agents
- Stop at the milestone; leave clean seams, don't build ahead.
- Propose before non-obvious architecture or new deps.
- Parallel agents must not touch the same files; only ONE agent touches
  schema.prisma / composition.ts at a time (the "trunk"). Last-writer-appends on
  shared UI files (layout.tsx, QuotaMeter.tsx).
- Small, typed, testable functions. Enforce the quota invariant in tests (stub fetch
  to throw). The engine stays pure and untested-against-a-DB.
- **Update this CLAUDE.md as part of the work** — see [KEEP THIS FILE CURRENT](#keep-this-file-current)
  above. Ending a task with a stale CLAUDE.md is an unfinished task.
