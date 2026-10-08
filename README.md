# Local Social Automation

A single-user, local-only app that manages Meta (Instagram) connections and automates comment-triggered private replies. It runs a Next.js UI plus a custom Node HTTP server that owns the API, the SQLite database, the credential vault, and the scheduler. The UI copy is in Spanish.

Safety defaults: Dry Run is on, monitoring is off, and nothing is sent unless several explicit switches are turned on (see "Turning on real sends").

## Requirements

- Node.js >= 24.21.0 (uses the built-in `node:sqlite`).
- No external services. All data stays on this machine.

## Install and run

```bash
npm install
npm run dev        # development
npm run build      # production build
npm run start      # production server (NODE_ENV=production)
```

The server binds only to `127.0.0.1` and rejects any Host other than `127.0.0.1` or `localhost`. The default port is **3000** (`PORT` environment variable overrides it), so the default URL is http://localhost:3000. For another port, run for example `PORT=3310 npm run dev` and open http://localhost:3310. API writes require a same-origin request, a per-process CSRF token, and `application/json` bodies.

Other scripts: `npm test` (node:test with temporary databases) and `npm run typecheck`.

Only one instance can run per data directory; a second start is blocked by a lock file (`.application-owner.json`).

## Data directory and key file

- Default data directory: `./data` (relative to the working directory); override with `LOCAL_SOCIAL_DATA_DIR`. It is git-ignored.
- Database: `<data dir>/social-automation.sqlite` (WAL mode, `synchronous=FULL`, foreign keys on).
- Vault key: `<data dir>/vault.key`, a random 32-byte AES-256-GCM master key kept outside SQLite.
- Permissions: the data directory is set to `0700` and the key file to `0600` at startup.
- Access tokens are stored encrypted in SQLite with the key above. They are never returned to the browser, and API responses use allowlisted fields only.

### Backup and key loss

- Back up the whole data directory (database and `vault.key`) together, while the app is stopped. A database copy without its key cannot decrypt stored tokens, and the key alone is useless without the database. Keep backups private; anyone with both files can read your tokens.
- If `vault.key` is missing while encrypted credentials exist, or a stored credential cannot be authenticated with the existing key, the app fails closed at startup. It never creates a replacement key silently and never overwrites the database. Restore the matching key from backup, or, if it is lost, move the data directory aside and re-create connections with fresh tokens.
- A compromised local user account can read the key and database. This app does not protect against that.

## Connections

Create a connection from the Connections view with a name, provider mode, optional App ID, Graph API version, and an access token. The token is sent once and not shown again.

- **Instagram Login** (`graph.instagram.com`): discovery reads the token's own identity (`/me`, id/username/account type) and yields one account.
- **Facebook Login** (`graph.facebook.com`): discovery lists the Pages the token can access (`/me/accounts`) and the Instagram Business accounts linked to them.

Use "Probar y descubrir" to validate the token and list candidate accounts, then select the account. Changing the token, App ID, or Graph version invalidates validation and pauses that connection's monitoring until it is revalidated. Before every real send the current token must still own the selected account. Disconnect/delete keep history.

An optional explicit action imports a connection from the fixed parent-directory `.env`; no client-supplied path is accepted.

## Monitoring versus catch-up (backlog)

Scan progress: `GET /api/backlog/jobs/:id` now also returns `progress` `{ mediaDone, mediaTotal, pagesRead, commentsSeen, currentStartedAt? }`, aggregated across all accounts of the job and updated after every provider page (no secrets, nothing about what is read changes, no assumption about Meta ordering). The UI shows a determinate bar (`role="progressbar"`), elapsed time, a Cancel button and, when the job ends, a summary card built from the existing report fields. If you reload the page while a job runs, its id is kept in `sessionStorage` and polling resumes.

Pending review persistence: `GET /api/backlog/pending?accountId=<id>&limit=&offset=` (read-only, account REQUIRED and ownership-checked; default limit 50, max 200) returns `{ total, lastAnalyzedAt, items, limit, offset }`. Items are the stored `eligible` classifications from COMPLETE `backlog`/`catch_up` scans (the exact provenance rule `processEligible` enforces), excluding comments already in `queue_items`, comments past the 7-day private-reply window (server clock) and archived automations. Each item carries `username`, `commentText` (truncated to 280 chars), `matchedKeywords`, `analyzedAt` and a rendered `previewText`/`previewButtons` (no secrets, no raw provider payloads). The 'Revisión pendiente' screen loads it on open and after each analysis, so results survive reloads; the processing path is unchanged (`POST /api/backlog/process` with explicit IDs and `confirmed: true`) and the automation select auto-picks when the account has exactly one enabled automation. `GET /api/queue` items now also include `commentUsername` and a truncated `commentText`; the 'Ver' panel shows the message text and buttons, labelled `WOULD_SEND · No se envió (modo prueba)` for simulated items.

Publications show a type badge, a short caption, the date and a comments link. Media captions and `media_type` (`IMAGE`, `VIDEO`, `CAROUSEL_ALBUM`; anything else is ignored) are fetched with the media list, stored in two nullable columns (schema v9, additive) and refreshed whenever you press "Actualizar publicaciones"; rows saved before the upgrade show "Sin texto · id corto" until refreshed. With exactly one account, the account filter selects it automatically (an explicit choice, including "Todas las cuentas", is never overridden); with several, Publicaciones asks you to pick one inline.

- **Monitoring** is per account or for all accounts and is off by default (also after every restart). Enabling an automation records a monitoring cutoff of "now"; only comments after that cutoff are candidates. The scheduler polls every 60 seconds by default, checks the first comment page each tick, and continues a saved cursor over later ticks. Coverage is reported as partial until pagination ends.
- **Catch-up / backlog scan** (windows 2h, 24h, 3d, 7d, custom) only reads and classifies comments. It never sends and never enqueues anything.
- **Process eligible** is a separate, explicit, confirmed action. You select reviewed comment IDs and the server enqueues them only if each ID was classified `eligible` for that account and automation by a completed (not incomplete, not cancelled) backlog scan. If any ID fails that check, the whole request is rejected and nothing is enqueued. Switching Dry Run off never flushes old simulated items or backlog.
- A scan that hits a repeated cursor, a provider error, or a page limit ends as incomplete and its classifications cannot be processed.
- The comment author is read from Meta's top-level `username`, falling back to `from.username` (Meta often omits the former); with neither, the comment is `missing_author` and never eligible.
- Private replies are only eligible within 7 days of the comment. Own comments, replies in a thread, comments without author/timestamp, and comments matching several automations are not eligible.

## Automations

Each automation targets one media item of one account (or, if general, all publications of the account; see below), with one or more keywords (matching ignores case, accents, and extra spacing), a match mode (`contains` matches whole phrases; `exact` requires the whole comment to equal the keyword), a reply template, and up to two HTTPS buttons (title up to 20 characters). An invalid match mode is rejected with a 400; if omitted on create it defaults to `contains`.

### General (account-wide) automations

An automation has a **scope**. `media` (the default) targets one publication. `account` ("general", shown as "Todas las publicaciones (general)" in the form and with a "General" badge) targets every publication of that account, old and new, with the same keywords, match mode, template and 0–2 buttons. API: `POST /api/automations` with `scope: "account"` and `mediaId` omitted or `null` (a `mediaId` with `scope: "account"`, a missing/null `mediaId` without it, or an unknown scope is a 400). DTOs expose `scope`; a general automation has `mediaId: null`. Editing (`PUT`) keeps the stored scope: sending a different `scope`, or a `mediaId` for a general automation, is rejected with 409 so history is never reparented; create a new automation instead.

- **Precedence:** a publication with its own enabled, non-archived automation is handled only by that automation; the general automation applies only to publications without one (it yields). Paused, disabled or archived specific automations do not count, so the general one applies there. The same rule is used when scanning/classifying, in "Revisión pendiente", when enqueueing (`enqueueReviewed`) and in the pre-send recheck: a queued general item whose publication gained its own enabled automation becomes `SKIPPED` (reason `yielded_to_media_automation`) before any intent or POST. Two *enabled* automations that both claim the same comment (two specifics on one publication, or two generals) still make it ambiguous and require review.
- **Only new comments:** like any automation, monitoring uses the activation time as cutoff, so only comments created after "Activar" are candidates. The existing backlog of old publications is never auto-processed; review it explicitly in "Revisión pendiente" (analysis + "Procesar" with confirmation). The pending list shows the publication (date · type · short caption) next to the automation name.
- **Monitoring cadence and limits:** specific automations keep the 60-second cadence. For a general automation the scheduler refreshes the account's publication list from Meta at most once every 5 minutes (the same page-one media request as "Actualizar publicaciones", so new publications are picked up), scans each covered publication at most once every 2 minutes (page one plus the existing bounded continuation), never-scanned publications first, and performs at most 25 general publication scans per tick across all accounts. A provider error stops further general scans of that account for the tick. These timestamps are in memory: after a restart the first tick refreshes and scans again (monitoring is off after restart anyway). Dry Run, real authorization, legacy hold, 7-day expiry, owner-replied, reply-thread, missing-author, own-comment, send spacing and `UNKNOWN_OUTCOME` rules are unchanged.
- **Schema:** v10 rebuilds `automations` (SQLite cannot relax `NOT NULL` in place) to add `scope` and make `media_id` nullable, with `CHECK ((scope='media' AND media_id IS NOT NULL) OR (scope='account' AND media_id IS NULL))`. The rebuild runs in one transaction with foreign keys temporarily off (so `ON DELETE CASCADE` on keywords cannot fire), verifies `PRAGMA foreign_key_check` before committing, and restores foreign keys. Existing rows become `scope='media'` with all IDs unchanged; keywords, queue items, classifications and attempts keep their references. Back up `data/` before the first start of this version.

### Optional public reply (rotating variants)

An automation can also answer the commenter **publicly** under the comment, in addition to the private reply. Enable "Responder también públicamente al comentario" in the new-automation form or the edit dialog and enter one variant per line ("Variantes de la respuesta pública"); the form shows the variant count and two random rendered examples with a sample username. Cards show a "Respuesta pública · N variantes" badge. Repeating one text hundreds of times looks like spam, so a variant is picked per reply with rotation.

- **API:** `POST /api/automations` and `PUT /api/automations/:id` accept `publicReplyEnabled` (boolean) and `publicReplyVariants` (array of strings). Values are never coerced: a non-boolean flag, a non-array list, a non-string entry or an invalid variant is a 400; enabling requires at least one variant. On `PUT`, omitted fields keep the stored configuration (scope still cannot change). DTOs expose both fields.
- **Variant rules:** at most 50 variants, each 1–300 characters after trimming, distinct after normalization (case, accents, spacing), total at most 10,000 characters. Only `{{username}}` and `{{keyword}}` (first matched keyword) are allowed; a literal `@{{username}}` mention is allowed, but links (`http(s)://`, `www.`) and any other `@handle` are rejected.
- **Rotation:** for each account the last 3 used variants are avoided when the automation has more than 3 variants; otherwise only the immediately previous one is avoided (a single variant necessarily repeats). The exact rendered text is stored on the queue item, so history shows what was posted.
- **Ordering guarantee — private first, public after, never the reverse:** the public step is only scheduled when the private reply was **accepted** (queue item `SENT` with a message ID), the automation has the public reply enabled with ≥ 1 variant, and global Dry Run is off. It becomes `PENDING` in the **same SQLite transaction** that records the accepted private reply, so a crash can never leave one without the other. A private failure, ambiguous result or skip never schedules a public reply.
- **The private message is never repeated:** the public step has its own state (`public_reply_state`) and its own append-only attempt table (`public_reply_attempts`). No public outcome (failure, unknown, expiry, retry) changes the private item's `SENT` state or re-sends the private message.
- **Processing:** the scheduler calls `QueueService.processPublicReply()` after the private step on every tick: at most one public reply per tick, one in flight at a time, never concurrently with a private send of the same account, and at least **20 seconds** between public reply intents (tracked separately from the 10-second private spacing). A durable intent (`SENDING` + `intent_recorded` event) is committed before the POST. Right before posting it re-checks: Dry Run off, account/connection valid and monitoring on, no send hold (and the legacy interlock, if configured), private item `SENT`. Conservatively, if the automation was paused, archived, lost real authorization or had its public reply turned off since the private send, the public reply becomes `SKIPPED`. If more than 24 hours passed since the private send it becomes `EXPIRED` (no POST).
- **Failures and retries:** an ambiguous result (timeout, network/redirect error, 5xx, malformed body, accepted without reply ID, or a restart while `SENDING`) becomes `UNKNOWN_OUTCOME` and is **never** retried. A permission/OAuth rejection (Meta codes 3, 10, 102, 190, 200–299) is `FAILED` with code `public_reply_permission_denied` ("Falta el permiso para responder comentarios en esta conexión"). Rate limiting (HTTP 429 or Meta codes 4, 17, 32, 613) is provably unsent and is retried at most 3 attempts in total, never sooner than `Retry-After` (otherwise 30 s, 60 s, … capped at 15 minutes); a retry that would land after the 24 h window expires instead. Any other definitive rejection is `FAILED`.
- **Manual retry:** a `FAILED` public reply (always a definitive rejection, so provably unpublished) shows "Reintentar respuesta pública" in the Queue "Ver" panel (`POST /api/queue/:id/public-reply/retry` with `{accountId}`; ownership checked, only `FAILED`, only within 24 h of the private send). It only resets the public step to `PENDING` and records a `manual_retry` event.
- **Dry Run / simulated items:** the would-be public text is stored as an inert preview and shown as `WOULD_REPLY_PUBLIC · No se publicó (modo prueba)`; the provider is never called.
- **Queue DTO:** `GET /api/queue` items include `publicReply: { state, text, attempts, nextAt, safeErrorCode, replyId, preview }` (or `null`); `GET /api/queue/:id/attempts` also returns `publicEvents`. Public states in the UI: Pendiente, Enviando, Publicada, Falló, Resultado desconocido, Omitida, Expirada.
- **Meta API:** `POST /{ig-comment-id}/replies` with a JSON body `{ "message": "…" }` (never in the URL), response `{ "id": "<new comment id>" }`. Instagram Login uses `graph.instagram.com` with the Instagram user token and needs `instagram_business_basic` + `instagram_business_manage_comments`. Facebook Login uses `graph.facebook.com` with the account's Page token and needs `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement` (and `ads_management`/`ads_read` for Business Manager roles). Meta only allows replies to top-level comments, not to hidden comments or live-video comments. Source: https://developers.facebook.com/docs/instagram-platform/comment-moderation and https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies. **Whether your token has the comments permission is unknown until the first real attempt**; without it you will see `public_reply_permission_denied` and the private reply is unaffected.
- **Interaction with "already answered" detection:** our own public reply is authored by the account, so a later scan classifies that root as `owner_replied` for future classification. It cannot affect the item that produced it: the private reply was already sent (and its pre-send check passed) before the public reply existed, and queue uniqueness prevents re-queueing the comment. Comments the account had already answered before queueing are still excluded.
- **Schema v11 (additive):** `automations.public_reply_enabled`, `automations.public_reply_variants_json`; `queue_items.public_reply_state`, `public_reply_text`, `public_reply_attempts`, `public_reply_next_at`, `public_reply_variant`, `public_reply_selected_at`; append-only table `public_reply_attempts` with a unique index allowing at most one `accepted` event per queue item. Existing rows keep `public_reply_enabled=0` and no public state. Back up `data/` before the first start of this version. Startup recovery turns any public `SENDING` into `UNKNOWN_OUTCOME`.

Template variables: `{{username}}` (commenter), `{{comment}}`, `{{keyword}}` (the matched keyword), `{{account}}` (your account username), `{{media}}` (the post permalink, or the media ID if none is stored, truncated to 100 characters). A truncated caption (200 characters) is now stored for display only; templates do not use it. Any other variable is rejected when you save the automation. Rendered text is limited to 1000 characters.

## Dry Run and real sends

Dry Run is the default. In Dry Run (or for an automation not authorized for real sends) matched comments become `SIMULATED` queue items, which are inert.

Real sending requires all of the following:

1. Global Dry Run turned off, with explicit confirmation.
2. The automation enabled and separately authorized for real sends ("Autorizar real", confirmed).
3. Account, connection, and token still valid, and monitoring not paused.
4. For accounts with a legacy hold (the imported `@modoverbo` account starts held): the legacy account lock must not be present, and you must acknowledge the historical counter version in the UI ("Revisar estado y reconocer"). The acknowledgement is bound to the observed counter version; if it changes, you must acknowledge again. The app never modifies or deletes the legacy lock or counter files (read from `~/.local/share/gestor-instagram/accounts`), and it takes the lock only for the duration of its own send.
5. Items queued under an older automation template version are not sent after the automation is edited.

Before each POST the app commits an immutable send-attempt intent to the database, then re-fetches the comment and re-checks eligibility. Sends are serialized with a minimum 10 second spacing between attempts (default).

## Queue states

| State | Meaning |
| --- | --- |
| `SIMULATED` | Created in Dry Run or for a non-real automation. Never sent. |
| `QUEUED` | Waiting to be sent in real mode. |
| `SEND_INTENT_RECORDED` / `SENDING` | Intent committed; a POST is in flight or was interrupted. |
| `SENT` | Meta accepted the send and returned a message ID; a read-back is attempted and its result is recorded as an event. |
| `FAILED_RETRYABLE` | Provider rate limit (HTTP 429) or comment-refresh failure; retried with bounded backoff, never shorter than a provider `Retry-After`, local delay capped at 15 minutes. After 5 attempts it becomes `FAILED_PERMANENT`. |
| `FAILED_PERMANENT` | Definitive provider rejection or retries exhausted. |
| `UNKNOWN_OUTCOME` | The result is ambiguous (timeout, malformed or server failure after dispatch, accepted without message ID, or a restart after intent). Never retried automatically. |
| `SKIPPED` | Re-check before sending found it no longer allowed. |
| `EXPIRED` | The comment is at or past the 7-day private-reply window (conservative boundary). Assigned (a) just before a send, after the fresh comment read and before any send intent, so no POST occurs; (b) by a bounded, idempotent sweep (`QueueService.expireStale`) run at startup and on every scheduler tick over `QUEUED`, `FAILED_RETRYABLE` and `SIMULATED` items; and (c) when a retry would land after the window. It never touches `SENT`, `SENDING`, `SEND_INTENT_RECORDED`, `UNKNOWN_OUTCOME` or `FAILED_PERMANENT`. The reason code `private_reply_window_elapsed` is stored on the item; no attempt event is written because nothing was sent. Backlog scan reports count such comments separately as `expiredCount`. |

### Read-back of SENT messages

After Meta accepts a send, one read-back is attempted and recorded as a `readback` event. The sender is accepted when Meta reports either the account's provider id or its own username (compared with the same normalization used elsewhere), because Meta can report the Instagram account id instead of the app-scoped id from Instagram Login. The message id must still match and a recipient must be present. For button messages the real `attachments.data[].generic_template` shape (title and `cta` buttons) is compared with what was sent; the event records only `observedMatches` and a short `matchReason` (`match`, `text_mismatch`, `buttons_mismatch`, `content_unavailable`), never the raw payload, and a mismatch never triggers a resend or state change. When the read fails, the real safe code (for example `meta_readback_mismatch`, `http_5xx`, `timeout`) is stored; `readback_unavailable` is only the fallback.

In the Queue view, a `SENT` item has a "Verificar lectura" button (`POST /api/queue/:id/readback` with `{accountId}`, same CSRF/Origin guards). It reads the accepted message once, appends another `readback` event, and returns `{observed, safeErrorCode?, matches?}`. It never sends, never changes the item state, and is limited to one call per item every 30 seconds (HTTP 429 `readback_rate_limited`; the limit is in memory and resets on restart).

### Resolving UNKNOWN_OUTCOME

The app never re-sends these items and has no control to change their state. To resolve one: open its attempt history (Queue view) to see the recorded events, then check on the Instagram side (for example, the recipient's conversation) whether the message arrived. If it did not, treat the comment as handled manually or create a fresh trigger; do not expect the app to retry. Read-back of a message ID is not proof of how it rendered or whether buttons were clicked.

## Rate limiting

Defaults are conservative local settings, not a guarantee that Meta will accept the volume: polling every 60 seconds, 10 seconds minimum between send intents, one send at a time, bounded retries as above. Meta's actual limits depend on your app and account; the app records usage headers it sees but does not enforce Meta's quotas.

## Known limitations

- Single user, single machine, loopback only; no authentication beyond local access and the CSRF token.
- No TikTok, cloud deployment, queue infrastructure, or AI features.
- Captions are stored (display only, truncated to 200 characters), but `{{media}}` is still a permalink or ID.
- No in-app resolution of `UNKNOWN_OUTCOME` items.
- Only the first page of comments is checked each monitoring tick; deep history is covered gradually or by a backlog scan, and may remain partial.
- Already-answered roots: a root comment is excluded from private replies (reason `owner_replied`, shown as "Ya respondido por la cuenta", counted under review) when the locally stored comments contain a reply to it authored by the connected account's own username (case-insensitive, same account only). Detection relies on replies stored by earlier scans; a reply created after the last scan is unknown until the next scan, so run a fresh scan right before processing. There is no live send-time API check of replies. The queue pre-send recheck uses the same stored replies and moves such an item to `SKIPPED` (reason `owner_replied`) before any send intent or POST.
- Private reply behavior (permissions, 24h/7d rules, button rendering) depends on Meta and must be verified on a real controlled comment before any wider use.
- The legacy lock/counter adapter reads a fixed local path.
