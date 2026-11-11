# A public sign-in page in front of the hosted console

Status: spec, approved 11 Nov 2026. Extends M10 §5 (one address) and M11.

## Decision (maintainer, 11 Nov 2026)

Until now `https://<public host>/` went straight to the console behind IAP, so a visitor landed on
Google's sign-in screen with no page of ours. The address now opens a sign-in page of our own:
a dark band with the team relay's three steps on the left, the sign-in on the right, and one
option only, Google's standard "Sign in with Google" button. After signing in, people land on
their Setup page (`/join`) until their setup is done, and on Ask (`/ask`) after that.

## 1. The page (relay)

- The relay serves it (`relay/relay/welcome.py`, files in `relay/relay/static/welcome/`), at
  `GET /` and `GET /login` (exact paths: `/login/`, `/LOGIN`, `/login.html` stay 404). Its
  stylesheet is `GET /v1/login/welcome.css`, its four fonts `GET /v1/login/fonts/<name>`, by
  exact name from a fixed list (never a path from the request). GET and HEAD only; anything else
  is `405` with `Allow: GET, HEAD`.
- It is static: rendered once at start, nothing from a request (query, headers, path) appears in
  it. It runs no script, has no form, sets no cookie and holds no data. Its one link is the
  button, `<a href="/start">`.
- Headers: `Content-Security-Policy: default-src 'none'; style-src 'self'; font-src 'self';
  img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-cache` with an `ETag`; `<meta name="robots" content="noindex, nofollow">`.
  Fonts: `font/woff2`, `Cache-Control: public, max-age=31536000, immutable`.
- Branding comes from `RELAY_BRAND_NAME` only (`BRAND_NAME` in `config/deploy.local.env`,
  passed by `scripts/deploy.sh`): 1 to 40 ASCII letters, digits, spaces and `& . , ' -`, not
  starting or ending with a space. Anything else refuses to start (the error never quotes the
  value); the name is HTML-escaped all the same. Unset, the page says "Team Relay", "Use your work
  Google account" and "For team members." The repository holds no logo or company name: the
  wordmark is the brand name as text.
- The fonts (Inter, Playfair Display, Google Sans Code; latin subset) are self-hosted under the
  SIL Open Font License; each family's licence sits beside the files in
  `relay/relay/static/welcome/fonts/`.
- Light and dark follow the system (`prefers-color-scheme`). At phone width the band collapses to
  a short header with the wordmark.

## 2. The load balancer (`scripts/deploy-lb.sh`)

The path matcher uses route rules (a matcher holds path rules or route rules, never both):

| Priority | Match | Backend |
|---|---|---|
| 1 | `fullPathMatch: /` | relay |
| 2 | `fullPathMatch: /login` | relay |
| 3 | `prefixMatch: /v1/` | relay |
| 4 | `fullPathMatch: /healthz` | relay |
| 5 | `fullPathMatch: /setup` | relay |
| default | everything else | console (IAP) |

The map carries tests, which Google checks on every import: `/`, `/login`, `/v1/health`,
`/setup` go to the relay; `/start`, `/join`, `/team`, `/login/` to the console. The script's
comparison of what is with what is wanted covers the tests too.

So the public paths are `/`, `/login`, the stylesheet and the four fonts, and, as before,
`/v1/*`, `/healthz` and `/setup`. Everything else stays behind IAP.

## 3. The console (`console/src/App.tsx`)

- The team view has its own path, `/team` (the Team tab pushes it). Any other path not named
  below is still the team view, so the local console opens on it at `/`.
- `/start` (the button's target, behind IAP) shows the loading state until the viewer's own
  setup is known (the data the Setup tab shows: `/api/me`, `/api/members-status`,
  `/api/acceptance`, `/api/boundaries`; nothing new is read), then replaces the address (no new history entry) with `/join` while the
  setup is not done, else `/ask`. A setup that cannot be read goes to `/join`, which says why. A
  viewer on no team sees the page for no team, at `/team`.
- `/join`, `/ask` and `/admin` are as before. The invite message and the plugin's messages still
  give `https://<public host>/`: that is the sign-in page now, which is where a new member starts.

## Rollout

After merge: `bash scripts/deploy.sh` (the relay, with `BRAND_NAME`), `bash
scripts/deploy-console.sh`, then `bash scripts/deploy-lb.sh` (until the map changes, `/` still
goes to the console). `bash scripts/smoke.sh` then expects `/` and `/login` to answer 200 and
`/start` and `/team` to send an anonymous visitor to Google's sign-in (302). Rollback: run
`scripts/deploy-lb.sh` from the previous commit.
