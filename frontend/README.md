# Rota-Matrix — Frontend PWA

Next.js 16 (App Router) + Tailwind CSS v4 + lucide-react. Installable PWA that
talks to the Rota-Matrix Express backend.

## Run

```bash
npm install            # (already done during scaffold)
npm run dev -- -p 3001 # dev server on http://localhost:3001
npm run build          # production build (also typechecks)
```

The backend base URL is read from `NEXT_PUBLIC_API_URL` (see `.env.local`,
defaults to `http://localhost:3000`). Start the backend first.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Landing — toggle between Worker Portal and Admin Console |
| `/worker/login` | Frictionless SMS OTP login (2-step) |
| `/worker/dashboard` | Availability matrix · Schedule · Holidays |
| `/admin` | Live Rota Matrix · Worker CRUD · Broadcast Engine |

## PWA

- `public/manifest.json` — app name, icons, theme colors
- `public/sw.js` — app-shell service worker (registered by
  `components/ServiceWorkerRegister.tsx`)
- `public/icon.svg`, `icon-192.png`, `icon-512.png`

## Real-time

`/admin` subscribes to the backend SSE stream (`/api/admin/events`) via
`lib/useRotaEvents.ts`. SMS replies, in-app accept/decline, nudges, and
broadcasts flash onto the Live Rota Matrix without a refresh. The header shows a
Live/Offline indicator for the stream.

## Structure

```
app/                       Routes (App Router)
components/                StatusBadge, ServiceWorkerRegister
components/admin/          RotaMatrix, WorkersManager, BroadcastEngine
lib/api.ts                 Typed API client
lib/session.ts             localStorage session cache
lib/useRotaEvents.ts       SSE hook
lib/types.ts / ui.ts       Shared types + presentation helpers
```
