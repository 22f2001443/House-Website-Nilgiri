# Council History Endpoint — Design

| | |
|---|---|
| **Status** | Proposed |
| **Endpoint** | `GET /api/council/history` |
| **Affects** | `council_members` table, Vercel API (`api/`), Express backend (`backend/`), council pages, admin council page |
| **Hard deadline** | Backfill 2025-26 before **2027-01-19** (archived photo links expire then — see [§8](#8-backfilling-2025-26)) |

## 1. Summary

Add a public, read-only endpoint that returns every House Council Nilgiri has had, grouped by academic year and team. The data comes from the existing `council_members` table, using its `tenure_year` column as the axis of history: a member's row is never deleted when their term ends, it simply stops being the current year. The 2025-26 council, which today exists only as a static YAML file, is backfilled into the table so the history is complete and editable from the admin panel.

## 2. Background: how council data works today

### 2.1 Current council

- `GET /api/council` (`api/_handlers/council/index.ts`, `backend/routes/council.js`) returns **every row** in `council_members`, sorted by leadership priority. It has no notion of year.
- `src/components/Council.jsx` calls `/council?limit=20` (`limit` is ignored by both backends) and maps raw `team` values to the UI categories.
- If the API returns nothing, it falls back to `council-data.yml` in the `public-data` Storage bucket, written by `POST /api/council/sync-yaml`.
- Live data today: 6 rows, all `team = 'RC'`, all `tenure_year = 2026` (the 2026-27 council, partially entered).

### 2.2 Archive (`/council/archive`)

- `CouncilArchivePage` renders `<Council archive />`.
- Years are hard-coded in `COUNCIL_ARCHIVE_YEARS` (`Council.jsx:8`): `2025-26 → public/council-2025-26.yml`, `2026-27 → public/council-2026-27.yml`.
- The browser fetches the YAML file and flattens it with `flattenYamlCouncilData`.
- `council-2025-26.yml` holds 24 members (UHC 3, operations 7, RCs 5, mentors 3, community admins 6) with only `name`, `position`, `region`, `image`.
- `council-2026-27.yml` is an empty placeholder.

### 2.3 Admin

- `src/pages/admin/AdminCouncil.jsx` lists all rows from `/council` and creates/edits members with `name, position, region, team, email, linkedin, profile_photo_url, tenure_year`.
- `tenure_year` defaults to the current calendar year and is a free-text input.

### 2.4 Problems this design must fix

| # | Problem | Evidence | Consequence |
|---|---|---|---|
| P1 | Archived photos expire | Every `image` in `council-2025-26.yml` is a **signed** URL from a different Supabase project (`pnatddmdgxtyjaglenxk`); the token's `exp` is `1800343242` = **2027-01-19 07:20 UTC** | The 2025-26 archive loses all 24 photos in ~3 months |
| P2 | History is not data | Past years live in YAML files committed to `public/`; adding a year needs a code change to `COUNCIL_ARCHIVE_YEARS` and a deploy | Admins can't maintain history; each year's handover needs a developer |
| P3 | `/api/council` has no year filter | `handleGet` selects `*` with only `team`/`region` filters | As soon as past members are stored in the table, they appear on the **current** council page |
| P4 | Team values are inconsistent | Migration `002` CHECK allows `UHC, Multimedia, WebOps, RC`; admin form offers `UHC, RC, Operations, Community Admins, Mentor`; `sync-yaml` maps `Mentor`/`Mentors`, `Community Admin`/`Community Admins`; `Council.jsx` even handles the typo `Commnunity Admin` | Grouping by team is unreliable; inserts with `Operations` fail if the 002 CHECK is live |
| P5 | Dirty text | Live `position` values include trailing spaces (`"Regional Coordinator "`) | Sorting/grouping quirks |
| P6 | `sync-yaml` dumps every row | Both implementations select `*` with no filter | After backfill, the "current council" fallback YAML would contain past councils |
| P7 | Route shadowing | Vercel router (`api/index.ts`) sends any `/api/council/<x>` to the `[id]` handler; Express registers `GET /:id` before other GETs | A naive `/api/council/history` is treated as a member ID and returns 404/500 |

## 3. Goals and non-goals

### Goals

1. One endpoint that returns the full council history, newest year first, grouped into the same teams the UI shows.
2. Filter by year and team, and a lightweight summary mode for the year picker.
3. History is maintained from the admin panel: ending a term needs no data copying, just entering the next council with the next `tenure_year`.
4. Backfill 2025-26 with permanent photo URLs before 2027-01-19.
5. Same behaviour on both backends (Vercel `api/` and Express `backend/`), matching how every other endpoint is maintained today.
6. No personal contact details (email) in the public history.

### Non-goals

- A per-person timeline ("everyone who has ever been Secretary", "this person's terms across years"). The data model leaves room for it ([§12](#12-future-work)), but no person identity is introduced now.
- Councils of other houses.
- Editing history through this endpoint; it is read-only. Writes stay on the existing admin `POST/PUT/DELETE /api/council`.
- Pagination. At ~25–35 members a year the full history stays well under a few hundred rows for the foreseeable future ([§10](#10-performance)).

## 4. Design overview

**`council_members` + `tenure_year` is the history.** Each row is one person's term in one academic year. `tenure_year` is the first calendar year of the academic year (`2025` = 2025-26; this matches how `sync-yaml` already formats `tenure`). The current council is the latest `tenure_year` present.

```
                    ┌────────────────────────────────────────────┐
  admin panel ─────▶│ council_members                            │
  (POST/PUT/DELETE) │ id │ name │ position │ team │ tenure_year │…│
                    └───────────────┬────────────────────────────┘
                                    │ SELECT … ORDER BY tenure_year DESC
          ┌─────────────────────────┼──────────────────────────────┐
          ▼                         ▼                              ▼
 GET /api/council?          GET /api/council/history       POST /api/council/sync-yaml
   tenure_year=current        (all years, grouped)           (current year only)
          │                         │
   /council page              /council/archive page
```

Why this over alternatives is covered in [§13](#13-alternatives-considered). In short: the admin panel, API and table already carry `tenure_year`; the only missing pieces are a year filter on the current-council query, a grouped read endpoint, clean team values, and the backfill.

## 5. Data model changes

New migration `supabase/migrations/008_council_history.sql`.

> The live schema has drifted from the migration files (see the database review: `002` creates a `team` CHECK the app no longer honours). Run the **pre-checks** against production first and resolve anything they return before applying the migration.

### 5.1 Pre-checks (must return 0 rows)

```sql
-- Rows with no year: decide their tenure_year by hand before migrating
SELECT id, name, position, team FROM council_members WHERE tenure_year IS NULL;

-- Team values the migration does not know how to map
SELECT DISTINCT team FROM council_members
WHERE lower(btrim(coalesce(team, ''))) NOT IN (
  'uhc', 'rc', 'operations', 'multimedia', 'webops', 'multimedia/pr/webops',
  'community admin', 'community admins', 'commnunity admin', 'mentor', 'mentors'
);

-- Name of the existing team CHECK, if any (expected: council_members_team_check)
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'council_members'::regclass AND contype = 'c';
```

### 5.2 Migration

```sql
-- 008_council_history.sql
-- Makes council_members the source of truth for every council year.
BEGIN;

-- Clean text so grouping and sorting are stable
UPDATE council_members
SET name = btrim(name),
    position = btrim(position),
    region = NULLIF(btrim(region), '');

-- Canonical team values
UPDATE council_members SET team = CASE
  WHEN lower(btrim(team)) = 'uhc' THEN 'UHC'
  WHEN lower(btrim(team)) = 'rc' THEN 'RC'
  WHEN lower(btrim(team)) IN ('operations', 'multimedia', 'webops', 'multimedia/pr/webops') THEN 'Operations'
  WHEN lower(btrim(team)) IN ('community admin', 'community admins', 'commnunity admin') THEN 'Community Admins'
  WHEN lower(btrim(team)) IN ('mentor', 'mentors') THEN 'Mentors'
  ELSE team
END;

ALTER TABLE council_members DROP CONSTRAINT IF EXISTS council_members_team_check;
ALTER TABLE council_members ADD CONSTRAINT council_members_team_check
  CHECK (team IN ('UHC', 'Operations', 'RC', 'Community Admins', 'Mentors'));
ALTER TABLE council_members ALTER COLUMN team SET NOT NULL;

-- Every row belongs to a year
ALTER TABLE council_members ALTER COLUMN tenure_year SET NOT NULL;
ALTER TABLE council_members DROP CONSTRAINT IF EXISTS council_members_tenure_year_check;
ALTER TABLE council_members ADD CONSTRAINT council_members_tenure_year_check
  CHECK (tenure_year BETWEEN 2020 AND 2100);

-- One row per person per role per year; also makes the backfill idempotent
ALTER TABLE council_members DROP CONSTRAINT IF EXISTS council_members_unique_term;
ALTER TABLE council_members ADD CONSTRAINT council_members_unique_term
  UNIQUE (tenure_year, team, name, position);

CREATE INDEX IF NOT EXISTS idx_council_members_tenure_team
  ON council_members (tenure_year DESC, team);

COMMENT ON COLUMN council_members.tenure_year IS
  'First calendar year of the academic-year term: 2025 = 2025-26';
COMMENT ON COLUMN council_members.team IS
  'UHC, Operations (Multimedia/PR/WebOps), RC, Community Admins or Mentors';

COMMIT;
```

### 5.3 Canonical teams

| Stored `team` | UI label | Accepted legacy inputs (case-insensitive, trimmed) | YAML section |
|---|---|---|---|
| `UHC` | UHC | `UHC` | `niligiri_uhc` |
| `Operations` | Multimedia/PR/WebOps | `Operations`, `Multimedia`, `WebOps`, `Multimedia/PR/WebOps` | `operations` |
| `RC` | RC | `RC` | `regional_coordinators` |
| `Community Admins` | Community Admins | `Community Admin`, `Community Admins`, `Commnunity Admin` | `community_admins` |
| `Mentors` | Mentors | `Mentor`, `Mentors` | `mentors` |

Display order everywhere: UHC → Operations → RC → Community Admins → Mentors (the order of the category bar in `Council.jsx`).

`Operations` members get a derived `sub_team` from their `position`, replacing the client-side logic in `Council.jsx` with a slightly stricter version:

1. matches `webops`, `web-ops`, `web admin` or `web-admin` → `WebOps`
2. matches the word `pr` (`/\bpr\b/i`, so "Production" doesn't count) → `PR`
3. otherwise → `Multimedia`

Sub-team order: Multimedia → PR → WebOps (as today).

## 6. API: `GET /api/council/history`

Public, no authentication, read-only.

### 6.1 Query parameters

| Param | Type | Example | Behaviour |
|---|---|---|---|
| `year` | `YYYY` or `YYYY-YY` | `2025`, `2025-26` | Return only that tenure. `YYYY-YY` must be consecutive years (`2025-27` → 400). Unknown year → 404. |
| `team` | canonical team or legacy alias | `UHC`, `mentor` | Only that team inside each tenure. Unknown team → 400. Tenures with no members in that team are omitted. |
| `summary` | `true` | `true` | Omit `teams`/members; return counts only. Used to build the year picker cheaply. |

Unknown parameters are ignored.

### 6.2 Response `200`

```json
{
  "current_tenure_year": 2026,
  "tenures": [
    {
      "tenure_year": 2026,
      "label": "2026-27",
      "is_current": true,
      "member_count": 6,
      "teams": [
        {
          "key": "RC",
          "label": "RC",
          "members": [
            {
              "id": "6f1c…",
              "name": "Member Name",
              "position": "Regional Coordinator",
              "region": "Kolkata",
              "sub_team": null,
              "profile_photo_url": "https://<project>.supabase.co/storage/v1/object/public/nilgiri_media/…",
              "linkedin": "https://www.linkedin.com/in/…"
            }
          ]
        }
      ]
    },
    {
      "tenure_year": 2025,
      "label": "2025-26",
      "is_current": false,
      "member_count": 24,
      "teams": [ { "key": "UHC", "label": "UHC", "members": [ … ] }, … ]
    }
  ]
}
```

- `tenures` is ordered newest first. It **includes the current tenure**, flagged `is_current`, so one endpoint serves both "archive" and "all-time" views; the client decides whether to hide it.
- `teams` is an ordered array (not an object) so the display order travels with the data. Empty teams are omitted.
- `summary=true` returns the same shape without `teams`.
- `current_tenure_year` is `null` and `tenures` is `[]` when the table is empty.
- `label` is `` `${y}-${String((y + 1) % 100).padStart(2, '0')}` ``.

### 6.3 Member fields

Explicit column list. Never `select('*')`.

| Field | Source | Notes |
|---|---|---|
| `id` | `id` | Stable key for React lists and future deep links |
| `name` | `name` | |
| `position` | `position` | Trimmed |
| `region` | `region` | `null` if empty |
| `sub_team` | derived | `Multimedia` / `PR` / `WebOps` for `Operations`, else `null` |
| `profile_photo_url` | `profile_photo_url` | `null` if empty |
| `linkedin` | `linkedin` | `null` if empty |

**Excluded on purpose:** `email` (contact details of former students should not be published indefinitely), `created_at`, `updated_at`.

### 6.4 Sorting inside a team

1. Leadership priority (`getLeadershipPriority`: Secretary → Deputy Secretary → Web Admin → everyone else), reusing `councilPriority` in each backend.
2. For `Operations`: sub-team order Multimedia → PR → WebOps.
3. `position`, then `name`, alphabetically (`localeCompare`, so the result is deterministic).

### 6.5 Errors

All errors are JSON `{ "error": "<message>" }`. Database error details are logged, never returned.

| Status | When | Body |
|---|---|---|
| 400 | Malformed `year` | `Invalid year. Use YYYY or YYYY-YY, e.g. 2025 or 2025-26` |
| 400 | Unknown `team` | `Invalid team. Use one of: UHC, Operations, RC, Community Admins, Mentors` |
| 404 | `year` given but no members that year | `No council found for 2019-20` |
| 405 | Method other than `GET`/`OPTIONS` | `Method not allowed` |
| 500 | Supabase error / not configured | `Failed to load council history` |

### 6.6 Caching

History changes a few times a year, so let Vercel's CDN absorb the traffic:

```
Cache-Control: public, max-age=300, s-maxage=600, stale-while-revalidate=86400
```

An admin edit can take up to ~10 minutes to show on the archive. That's acceptable for history; the **current** council page keeps using the uncached `/api/council`. This is the first endpoint in the repo to set `Cache-Control`. If it works well, the other public GETs can follow.

### 6.7 Query

One round trip, grouped in application code:

```js
supabase
  .from('council_members')
  .select('id, name, position, region, team, tenure_year, profile_photo_url, linkedin')
  .order('tenure_year', { ascending: false })
  // + .eq('tenure_year', year) when ?year is given
  // + .in('team', [canonicalTeam]) when ?team is given
```

`current_tenure_year` comes from the same result when unfiltered. When `year` or `team` is set, a second tiny query `select('tenure_year').order('tenure_year', { ascending: false }).limit(1)` provides it.

## 7. Changes to existing endpoints

| Endpoint | Change | Why |
|---|---|---|
| `GET /api/council` | New optional `tenure_year` param: `current` (latest year), a year (`2025`/`2025-26`), or absent (all rows: **unchanged default**, so the admin list and dashboard keep working) | P3 |
| `POST/PUT /api/council` | Validate `tenure_year` (integer, 2020–2100, required on POST) and normalise `team` to the canonical value; reject unknown teams with 400 | P4, keeps data clean after the CHECK constraint lands |
| `POST /api/council/sync-yaml` | Only dump the current tenure | P6 |
| Both backends | Register `/history` **before** the `/:id` route | P7 |

## 8. Backfilling 2025-26

### 8.1 Why a script, not the admin form

Twenty-four members could be typed in by hand, but each photo also has to be downloaded from the expiring signed URL and re-uploaded. A script does both reliably and can be re-run safely.

### 8.2 `backend/scripts/backfill-council-history.js`

It lives in `backend/` because that package already depends on `js-yaml` and `@supabase/supabase-js`.

```
node scripts/backfill-council-history.js --file ../public/council-2025-26.yml --year 2025 [--dry-run]
```

Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` of the **current** project.

For each member in each YAML section:

1. Map the section to a canonical team ([§5.3](#53-canonical-teams)).
2. Trim `name`, `position`, `region`.
3. Download `image`. Upload it to the public bucket `nilgiri_media` at `Nilgiri Website/Council 25-26/<slug(name)>.<ext>` with `upsert: true`. Store the **public** URL (`/storage/v1/object/public/…`), which never expires, unlike the signed URL.
4. Upsert the row on `(tenure_year, team, name, position)` (the unique constraint from [§5.2](#52-migration)) so re-runs update rather than duplicate.
5. If a photo download fails, insert the row with `profile_photo_url = null` and list it at the end, so nothing silently disappears.

`--dry-run` prints the planned rows and uploads without writing anything. The script prints `inserted / updated / photo failures` at the end.

### 8.3 Older councils

Nothing earlier than 2025-26 exists in the repository. Once the endpoint is live, earlier councils need nothing extra: an admin adds the members with the right `tenure_year` and they appear in the history automatically. If someone has older rosters as YAML in the same format, the same script handles them (`--year 2024`, …).

### 8.4 Deadline

The signed URLs stop working on **2027-01-19**. The backfill (step 4 of [§14](#14-rollout-plan)) must run before then, and ideally well before so failures can be fixed by hand.

## 9. Implementation

### 9.1 Shared helpers

Mirror the existing `councilPriority` split (`api/_handlers/utils/councilPriority.ts` + `backend/utils/councilPriority.js`) with a new pair:

- `api/_handlers/utils/councilTeams.ts`
- `backend/utils/councilTeams.js`

```js
export const COUNCIL_TEAMS = [
  { key: 'UHC', label: 'UHC', aliases: ['uhc'] },
  { key: 'Operations', label: 'Multimedia/PR/WebOps', aliases: ['operations', 'multimedia', 'webops', 'multimedia/pr/webops'] },
  { key: 'RC', label: 'RC', aliases: ['rc'] },
  { key: 'Community Admins', label: 'Community Admins', aliases: ['community admin', 'community admins', 'commnunity admin'] },
  { key: 'Mentors', label: 'Mentors', aliases: ['mentor', 'mentors'] },
];

export function normalizeCouncilTeam(team) { /* alias → key, or null */ }
export function getOperationsSubTeam(position) { /* WebOps | PR | Multimedia */ }
export function parseTenureYear(value) { /* '2025' | '2025-26' → 2025, else null */ }
export function formatTenureLabel(year) { /* 2025 → '2025-26' */ }
export function groupCouncilHistory(rows, { summary }) { /* rows → tenures[] per §6.2 */ }
```

`groupCouncilHistory` is a pure function holding all the grouping and sorting, so both handlers stay thin and it can be unit-tested without a database.

### 9.2 Vercel (`api/`)

- New `api/_handlers/council/history.ts`. Structure it like `council/index.ts`: CORS headers via `ALLOWED_ORIGIN`, an `OPTIONS` early return, `GET` only, `checkSupabaseConfig()`.
- `api/index.ts`: add the route **above** the `/^\/api\/council\/[^/]+$/` match:

  ```ts
  if (path === '/api/council/history') {
    const { default: councilHistoryHandler } = await import('./_handlers/council/history');
    return councilHistoryHandler(req, res);
  }
  ```

- It stays inside the single `api/index.ts` function, so it doesn't add to the Vercel function count.

### 9.3 Express (`backend/`)

- `backend/routes/council.js`: add `router.get('/history', …)` **before** `router.get('/:id', …)`.
- Rate limiting comes from the `/api` limiter added in PR #1, if merged.

## 10. Performance

- **Volume:** ~25–35 rows per year. Ten years of history is ~350 rows, about 100 KB of JSON before gzip. One indexed query, grouping in memory, no pagination needed.
- **Load:** with `s-maxage=600`, the database sees at most a handful of queries per 10 minutes per edge region.
- **Revisit** if the table passes ~2,000 rows, or if the archive page needs a per-year fetch (`?year=` already supports that).

## 11. Security and privacy

- **Read-only and public:** no auth, no writes. Inputs are an allowlisted `team` and a regex-validated `year`, passed through the Supabase query builder (parameterised, so no injection surface).
- **Column allowlist:** `email` is never selected. The current `/api/council` returns emails publicly; this design does not change that endpoint's output, but it is worth a separate decision.
- **Consent:** the history publishes names, photos and LinkedIn profiles of former students indefinitely. The council should agree that this is fine. Removal is a normal admin delete (or clearing `linkedin`/`profile_photo_url`), and it reaches the archive within the cache window.
- **Errors:** generic messages; Supabase details stay in server logs.
- **Abuse:** CDN caching on Vercel; `express-rate-limit` on Express.

## 12. Future work

- **Person timeline:** add a nullable `person_id` (or a stable slug) to link one person's rows across years, enabling "terms served" and role-holder lists (every Secretary since 2025).
- **Tenure metadata:** a small `council_tenures (tenure_year PK, starts_on, ends_on, notes)` table, if handover dates or year notes are wanted. It would also replace "latest year = current" with an explicit flag.
- **`sub_team` column:** if the position-text heuristic for Operations proves fragile, store it explicitly.
- **Retire YAML fallbacks:** once `/api/council?tenure_year=current` has been reliable for a term, remove the `public-data/council-data.yml` fallback and `sync-yaml`.

## 13. Alternatives considered

| Option | Why not |
|---|---|
| **Keep YAML files, serve them through an endpoint** | Doesn't fix P1 (expiring photos) or P2 (code change + deploy per year); history stays uneditable from the admin panel |
| **Separate `council_history` table, copy rows at year end** | Duplicates data and needs a manual "archive the council" step that will be forgotten; edits to a past year would have to touch two tables |
| **Snapshot JSON per year in Storage** (like `sync-yaml`) | Same drawbacks as YAML; snapshots drift from the table |
| **Normalised `people` + `terms` tables now** | Right long-term shape for person timelines, but a bigger migration and admin rewrite for a feature nobody has asked for yet. `person_id` can be added later without breaking this API ([§12](#12-future-work)) |

## 14. Rollout plan

The order matters: past members must not reach the table before the current council page filters by year (P3).

1. **Pre-checks** ([§5.1](#51-pre-checks-must-return-0-rows)) on production; fix any rows they return.
2. **Migration `008`** in the Supabase SQL editor.
3. **Deploy backend + frontend together:**
   - `/api/council/history`
   - `tenure_year` filter on `/api/council`
   - write validation on `POST/PUT /api/council`
   - current-tenure-only `sync-yaml`
   - `Council.jsx` changes ([§15](#15-frontend-changes))
4. **Backfill 2025-26:** `--dry-run`, review, then run for real. **Before 2027-01-19.**
5. **Verify:**
   - `/council/archive` shows 2025-26 with photos loading from the current project's public URLs.
   - `/council` still shows only 2026-27.
6. **Clean up** in a follow-up PR: delete `public/council-2025-26.yml` and `public/council-2026-27.yml` (they stay in git history) and the archive-mode YAML code path.

**Rollback:** the endpoint is additive, so reverting the deploy is safe. The migration's data changes (trimming, team renames) are not reversed. The old frontend (`normalizeTeam`) and the Vercel `sync-yaml` handle the canonical values (`Operations`, `Mentors`, `Community Admins`). The old **Express** `sync-yaml` only recognises `Mentor`, so after a rollback it would leave `Mentors` out of its YAML. Backfilled rows can be removed with `DELETE FROM council_members WHERE tenure_year = 2025`.

## 15. Frontend changes

- **`src/components/Council.jsx`, archive mode:**
  - Replace `COUNCIL_ARCHIVE_YEARS` and the YAML fetch with one `GET /council/history`.
  - Build the year selector from `tenures`, defaulting to the most recent **past** tenure, with the current one labelled "(current)".
  - Use each member's `team`/`sub_team` from the response instead of `flattenYamlCouncilData`.
- **`Council.jsx`, current mode:** call `/council` with `params: { tenure_year: 'current' }`. Drop the ignored `limit=20`.
- **`src/pages/admin/AdminCouncil.jsx`:**
  - Team select uses the canonical list.
  - Tenure year becomes a number input (or a select of recent years) showing the `2025-26` label.
  - Add a year filter to the member list so past councils don't crowd the current one.
- **`src/pages/admin/Dashboard.jsx`:** count the current tenure only.

## 16. Testing plan

The repo has no test runner. Keep it lightweight:

- **Unit tests (Node's built-in `node:test`, no new dependency):** `backend/utils/councilTeams.test.js`, run with `node --test backend/utils`, covering:
  - `normalizeCouncilTeam`: every alias in [§5.3](#53-canonical-teams), unknown values, `null`, whitespace and case.
  - `parseTenureYear`: `2025`, `2025-26`, `2025-27` (invalid), `25-26`, `abc`, `2019`.
  - `getOperationsSubTeam`: `Webops Team`, `PR Coordinator`, `MultiMedia & PR team` (→ PR), `Production Lead` (→ Multimedia), `Multimedia Team`.
  - `groupCouncilHistory`: year ordering, team ordering, leadership-first sorting, empty teams omitted, `summary` mode, empty input.
- **Route-order regression:** `GET /api/council/history` returns history, not "Council member not found", on both backends.
- **Manual checks** against a preview deployment:

  ```bash
  curl -s $BASE/api/council/history | jq '.tenures[] | {label, is_current, member_count}'
  curl -s "$BASE/api/council/history?year=2025-26&team=uhc" | jq '.tenures[0].teams[0].members[].position'
  curl -s "$BASE/api/council/history?summary=true" | jq
  curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/council/history?year=2025-27"   # 400
  curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/council/history?year=2019"      # 404
  curl -sI "$BASE/api/council/history" | grep -i cache-control
  curl -s $BASE/api/council/history | jq '[.. | objects | select(has("email"))] | length'   # 0
  ```

- **Backfill:** run with `--dry-run` first; afterwards check that `SELECT team, count(*) FROM council_members WHERE tenure_year = 2025 GROUP BY team` gives UHC 3, Operations 7, RC 5, Mentors 3, Community Admins 6, and that every `profile_photo_url` is a `/object/public/` URL.

## 17. Open questions

1. **Which year is "current"?** This design uses the latest `tenure_year` present. If next year's council is entered before handover, it becomes current immediately. Is that acceptable, or should "current" be an explicit setting (env var, or the `council_tenures` table in [§12](#12-future-work))?
2. **Earlier councils:** were there councils before 2025-26, and does anyone have the rosters and photos?
3. **Consent:** is the council comfortable publishing former members' names, photos and LinkedIn links indefinitely?
4. **Archive scope:** should `/council/archive` list the current year too (as today), or past years only?
5. **Email on `/api/council`:** should the existing endpoint stop returning member emails publicly? It's out of scope here, but the same concern applies.

## 18. File checklist

| File | Change |
|---|---|
| `supabase/migrations/008_council_history.sql` | New ([§5](#5-data-model-changes)) |
| `api/_handlers/utils/councilTeams.ts` | New helpers |
| `backend/utils/councilTeams.js` | New helpers (mirror) |
| `backend/utils/councilTeams.test.js` | New unit tests |
| `api/_handlers/council/history.ts` | New handler |
| `api/index.ts` | Route `/api/council/history` above the `[id]` match |
| `api/_handlers/council/index.ts` | `tenure_year` filter; POST validation |
| `api/_handlers/council/[id].ts` | PUT validation |
| `api/_handlers/council/sync-yaml.ts` | Current tenure only |
| `backend/routes/council.js` | `GET /history` before `/:id`; `tenure_year` filter; POST/PUT validation; `sync-yaml` filter |
| `backend/scripts/backfill-council-history.js` | New one-off backfill ([§8](#8-backfilling-2025-26)) |
| `src/components/Council.jsx` | Archive via history endpoint; current via `tenure_year=current` |
| `src/pages/admin/AdminCouncil.jsx` | Canonical teams, numeric year, year filter |
| `src/pages/admin/Dashboard.jsx` | Count current tenure |
| `public/council-2025-26.yml`, `public/council-2026-27.yml` | Delete after backfill is verified (follow-up) |
