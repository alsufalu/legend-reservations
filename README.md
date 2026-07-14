# Legend Reservations

Host-stand and management console for reservations, waitlist, table/floor status, guest CRM, and KPI reporting. Built the same way as Shaker & Cellar: a single static site (no build step), Supabase for auth + database, hosted free on GitHub Pages. Works in any browser on iPad or desktop.

## Backend

A new Supabase project was created in your **Legend Bartending** organization (kept separate from the cocktail app's data):

- Project: `legend-reservations`
- URL: `https://bnjtoobxqfvosbvwnrie.supabase.co`
- Tables: `staff`, `dining_tables`, `guests`, `service_periods`, `reservations`, `waitlist`, `activity_log`
- View: `kpi_daily` (covers, no-shows, cancellations, walk-ins per day — powers the Dashboard tab)
- Row Level Security is on everywhere. Only approved, active staff (or you, the admin) can read/write data.
- 11 starter tables (Main/Bar/Patio) and Lunch/Dinner service periods are pre-seeded so the app isn't empty on first load.

## Access model

- Your email (`aerubio1@yahoo.com`) is hardcoded as admin — the first time you sign in with it, you're auto-approved as `admin`.
- Anyone else uses **Request Access** on the login screen. That creates their login but leaves them "pending" until you approve them in **Settings → Staff Access**, where you also set their role (host / server / manager / admin).
- Supabase sends a confirmation email on signup — staff need to click it before they can sign in.

## Features

- **Reservations** — daily list, create/edit, guest search-or-create, table assignment, status flow (pending → confirmed → seated → completed / no-show / cancelled).
- **Floor Plan** — tables grouped by section, tap to cycle status (available/reserved/seated/dirty/blocked).
- **Waitlist** — add walk-ins, quoted wait time, one-tap seat or remove.
- **Guests (CRM)** — search, VIP flag, tags, allergies/notes, auto-tracked visit count, no-show count, reservation history.
- **Dashboard** (management/desktop) — covers, reservations, completion rate, avg party size, no-show rate, cancellation rate, walk-ins, repeat-guest rate, reservations-by-hour chart. Filterable by today/7/30/90 days.
- **Settings** — manage tables, service periods, and (admin-only) staff approvals/roles.

## Files

- `index.html` — markup + login/pending screens + app shell
- `styles.css` — styling (same color system as Shaker & Cellar: blue `#0070f2` primary, card-based UI)
- `app.js` — all app logic, Supabase calls, rendering

## Publish to GitHub Pages

I wasn't able to reach GitHub directly from this session (no GitHub connector or working shell), so push it yourself — same as your other repos:

```bash
cd E:\DOWNLOAD\PM_RESERVATIONS
git init
git add .
git commit -m "Initial commit: Legend Reservations"
git branch -M main
git remote add origin https://github.com/alsufalu/legend-reservations.git   # create this repo on GitHub first (empty, no README)
git push -u origin main
```

Then in the repo's **Settings → Pages**, set source to `main` / `/ (root)`. It'll be live at:
`https://alsufalu.github.io/legend-reservations/`

## Notes / next steps

- This folder (`E:\DOWNLOAD\PM_RESERVATIONS`) is now the working directory for this project going forward.
- The anon key in `app.js` is safe to expose publicly — it only grants what your RLS policies allow.
- To add real tables/floor positions matching your actual dining room, edit them in **Settings** once live (or ask me to seed different starting tables).
- Nice follow-ups if you want them later: SMS/email reservation reminders (needs an edge function + Twilio/Resend), a visual drag-and-drop floor plan, combining tables for large parties, and a public booking widget that talks to the same backend for your existing restaurant website.
