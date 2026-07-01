# Matrix

Specialized automated temporary-worker rota and communications backend.
Node.js + Express + TypeScript, Prisma ORM over PostgreSQL, Twilio for SMS.

## Phase 1 scope

- Express/TypeScript backend scaffold
- Prisma schema: Workers, Clients, Shifts, Allocations (bridge), BroadcastLogs
- Inbound Twilio SMS webhook (`POST /api/webhooks/twilio`) that processes worker
  accept (`1`) / decline (`2`) replies to shift proposals
- Mock integration harness to exercise the webhook against a database

## Phase 2 scope

- **Frontend PWA** (`frontend/`) — Next.js 16 + Tailwind v4 + lucide-react,
  installable (manifest + service worker). See [frontend/README](frontend/README.md).
- **Worker Portal** — frictionless SMS OTP login, weekly availability matrix,
  schedule tab with in-app accept/decline, holiday requests.
- **Admin Console** — live rota matrix (real-time via SSE), worker CRUD with
  instant session revocation, and a 3-step broadcast engine. Guarded by a shared
  admin access key (login screen).
- **New API surface** — `/api/auth/*` (incl. `POST /api/auth/admin/login`),
  `/api/worker/*`, `/api/admin/*`, plus an SSE stream at `/api/admin/events` for
  live dashboard updates.
- **Auth model** — workers authenticate via SMS OTP → opaque session token;
  all `/api/admin/*` routes require the `ADMIN_API_KEY` shared secret (sent as a
  `Bearer` header, or `?key=` on the SSE stream since EventSource can't set headers).
- **New tables** — Availability, HolidayRequest, OtpCode, Session (+ `slot` on Shift).

## Phase 3 scope — spreadsheet planning board

- **Admin Rota Board** (`frontend/components/admin/BoardGrid.tsx`) — high-density
  14-day grid (Monday-anchored), client dropdown filter (filters to that
  client's pool), sticky First/Last name columns, two-row date+day header,
  horizontal scroll. Color-coded statuses match the spec
  (AVAILABLE/UNAVAILABLE/SICK/REST/HOLIDAY/CANCELLED/NO_SHOW/SCHEDULED).
- **Cell editing** — click any cell to type a custom start time, apply a client
  **shift template**, set a status, copy/paste across days/workers, or **cancel**
  (confirmation modal → sets CANCELLED + sends a personalised Twilio SMS).
- **Worker self-service** — "My Rota" tab lets staff set AVAILABLE / UNAVAILABLE
  / SICK / REST / HOLIDAY for any of the 14 days; office-managed days are locked.
- **Schema** — new `RotaStatus` enum, `RotaCell` (one per worker/day, @db.Date),
  `ShiftTemplate` (per client), and `Client.pool`. Board dates are stored as UTC
  midnight to avoid timezone drift.
- **APIs** — `/api/admin/clients`, `/api/admin/board`, board cell set / bulk-set
  (paste) / clear / cancel, template CRUD; `/api/worker/board` + cell set.

### Running the full stack

```bash
docker compose up -d        # PostgreSQL
npx prisma db push          # apply schema
npm run seed                # demo clients/workers/shifts
npx ts-node src/index.ts    # backend on :3000  (or: npm run dev)

cd frontend
npm run dev -- -p 3001      # frontend on :3001
```

Open http://localhost:3001 and pick a view. The demo worker phone is
`+15550001000`; the login code is sent by SMS only (in local dev without Twilio
creds it's logged to the API server console — it is never returned to the
browser). The admin console asks for the access key — the dev value is
`dev-admin-key` (`ADMIN_API_KEY` in `.env`).

## Prerequisites

- Node.js 18+ (developed on v24)
- A PostgreSQL database

## Setup

```bash
npm install
cp .env.example .env          # then fill in real values
npx prisma generate           # generate the typed client
npx prisma migrate dev        # create tables (or: npx prisma db push)
```

Edit `.env`:

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | HTTP port (default 3000) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Twilio credentials |
| `TWILIO_FROM_NUMBER` | E.164 number outbound SMS are sent from |
| `PUBLIC_BASE_URL` | Public URL Twilio reaches, used for signature validation |
| `VALIDATE_TWILIO_SIGNATURE` | `false` to bypass signature checks locally |

## Run

```bash
npm run dev        # watch mode
npm run build      # compile to dist/
npm start          # run compiled output
npm run typecheck  # tsc --noEmit
```

## Twilio webhook

Point your Twilio number's inbound-SMS webhook at:

```
POST https://<PUBLIC_BASE_URL>/api/webhooks/twilio
```

Behaviour:

- Looks up the sender by `From`. Unknown / `INACTIVE` / `SUSPENDED` workers are
  silently ignored (safe no-op).
- Finds the worker's most recent `PROPOSED` allocation.
- `1` → if the shift still has open slots (CONFIRMED count < `slotsNeeded`),
  marks it `CONFIRMED` and replies with a success SMS; otherwise marks it
  `TIMEOUT` and replies that the slot was filled.
- `2` → marks it `DECLINED` and replies with a confirmation.
- Slot availability is re-checked inside a transaction so two simultaneous
  acceptances of the last slot cannot both confirm.

Requests are authenticated with Twilio's `X-Twilio-Signature` header via
`src/middleware/validateTwilioSignature.ts`.

## Mock integration test

With a database reachable and migrated, and `VALIDATE_TWILIO_SIGNATURE=false`:

```bash
npm run test:webhook
```

This boots the real Express app on an ephemeral port, seeds a client + shift +
workers + `PROPOSED` allocations, posts simulated Twilio payloads, and asserts
the resulting allocation state transitions (CONFIRMED / TIMEOUT / DECLINED /
ignored).

## Project layout

```
prisma/schema.prisma                       Database schema
src/index.ts                               Express app + bootstrap
src/lib/prisma.ts                          Shared PrismaClient
src/lib/twilio.ts                          Twilio client + sendSms helper
src/middleware/validateTwilioSignature.ts  Twilio request authentication
src/routes/webhooks.ts                     Inbound SMS webhook
tests/twilioWebhook.mock.ts                Mock integration harness
```
