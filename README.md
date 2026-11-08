# Encore — concert tracker

A phone-first web app for following artists and tracking their upcoming concerts and ticket prices.
Install it on your iPhone from Safari. Everything stays on your phone: no account, no server, no tracking.

## Features

**Following & discovery**
- **Follow artists**: search Ticketmaster, add them by name, or **import** them from Spotify (artists you follow plus your top artists), Apple Music (through a Shortcut) or a pasted list.
- **Discover tab**: follow **venues** or a whole **area** (a city plus a radius) to see every concert coming up there.
- **Suggested artists**: acts sharing a bill with artists you follow, plus artists playing near you in your genres. Follow or dismiss them with one tap.

**Shows & prices**
- **Upcoming shows feed**, grouped by month, with filters for *Near me*, *My shows*, *New*, *Price drops*, *On sale soon* and *Hidden*, plus search.
- **Face-value prices** from Ticketmaster and, optionally, **live resale prices** from SeatGeek (lowest, average, and number of listings).
- **Price chart**: face value and resale as two lines, the prices you logged as markers, and your target as a dashed line. Choose a 1W, 1M, 3M or All range, and tap or drag to read values. Short notes describe the trend (lowest seen, week-over-week change).
- **Target price alerts**, plus detection of new shows, price drops, cancellations, postponements, reschedules and shows that disappear from listings.
- On-sale and presale dates, resale search links, and manual shows.

**Going to shows**
- **My plans**: mark a show *Interested*, *Going* or *Got tickets*, and record quantity, price paid, seats, doors time and notes.
- **Ticket wallet**: attach screenshots, PDFs or Apple Wallet passes to a show. They're stored on the device, open full screen, and can be shared.
- **Show-day view**: a *Tonight* banner opens a screen with doors and show times, a live countdown, the weather forecast at showtime, directions, your tickets and a before-you-go checklist.
- **Calendar** month view, and export to Apple Calendar (.ics).

**Your history**
- **Stats**: shows seen, shows per year, money spent, cities, farthest trip, and your most-seen artists and venues.
- **Year in review**: a shareable image of your year.

**Sync & background alerts (optional)**
- Keeps a private copy of your data in a **secret GitHub Gist**, so you can restore it on a new phone or use two devices.
- A **scheduled GitHub Action** checks every 2 hours and sends **push notifications to your phone even when Encore is closed**. It covers new shows, price drops, price targets, status changes, presales starting soon and show-day reminders.

Also: works offline, light and dark themes, pull-to-refresh, a count badge on the app icon, and backup and restore (including ticket files).

## Install on iPhone

1. Open the GitHub Pages URL (e.g. `https://<your-user>.github.io/concert-tracker/`) in **Safari**.
2. Tap **Share** → **Add to Home Screen**.
3. Open Encore from the Home Screen → **Settings** → paste your Ticketmaster key.

## Getting a Ticketmaster API key (free)

Automatic show lookup uses the [Ticketmaster Discovery API](https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/):

1. Sign up at <https://developer-acct.ticketmaster.com/user/register>.
2. Open **My Apps**. A default app is already created.
3. Copy its **Consumer Key** into Encore → Settings → Ticketmaster.

The key is stored only in your phone's browser storage and is sent only to Ticketmaster.
The free tier allows 5,000 calls a day. A refresh uses about one call per artist.
Without a key, Encore still works as a manual tracker.

Optional: a Bandsintown `app_id` adds tour dates that aren't sold through Ticketmaster. These dates have no prices.

## Optional integrations

| What | Where to set it up | What you get |
|---|---|---|
| Ticketmaster key | Settings → Ticketmaster | Shows, face-value prices, on-sale dates, venues, suggestions |
| SeatGeek client ID | Settings → SeatGeek ([get one](https://seatgeek.com/account/develop)) | Resale prices tracked over time |
| Spotify Client ID | Artists → Import → Spotify | Import followed and top artists |
| Bandsintown app ID | Settings → Bandsintown | Extra tour dates |
| GitHub token (gist scope) | Settings → Sync & background alerts | Sync + background push alerts |

### Background alerts setup

1. In Encore, go to **Settings → Sync & background alerts**. [Create a token](https://github.com/settings/tokens/new?scopes=gist&description=Encore%20sync) with only the **gist** scope, paste it, and tap **Connect**. Encore creates a secret gist.
2. In this repo, open **Settings → Secrets and variables → Actions** and add two secrets:
   - `ENCORE_GIST_ID`: the gist ID shown in Encore (it has a Copy button)
   - `ENCORE_GIST_TOKEN`: the same token
3. Open Encore **from your Home Screen** (push needs iOS 16.4 or later and an installed app) and turn on **Alerts on this device**.
4. Optional: run the **Background alerts** workflow once from the Actions tab to test it. After that it runs every 2 hours.

The gist holds `encore.json` (your data and API keys), `encore-push.json` (push subscriptions and the VAPID key pair, generated on your phone) and `encore-server.json` (what the job already notified you about). GitHub pauses scheduled workflows after 60 days with no repository activity. If alerts stop, re-enable the workflow in the Actions tab. Encore also warns you in Settings.

To test the job offline: `npm ci --prefix server && node server/selftest.mjs`.

## Deploying to GitHub Pages

This repo has a workflow (`.github/workflows/pages.yml`) that publishes the site whenever `main` changes.

1. Set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**.
2. The workflow runs on every push to `main`, or you can start it by hand from the **Actions** tab.

There is no build step: plain HTML, CSS and ES modules. Every path is relative, so the app works from a `/concert-tracker/` subpath.

## Running locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Project layout

```
index.html              App shell and tab bar
manifest.webmanifest    PWA manifest
sw.js                   Offline cache + push handler (bump VERSION when you change files)
css/styles.css          Styles (light/dark, iOS safe areas)
js/app.js               Routing, global actions, refresh orchestration, pull-to-refresh, sync hooks
js/views.js             Shows, Calendar, Artists, Artist, Event, Settings
js/views-more.js        Discover, Place, Import, Stats, Show day, Ticket wallet, Sync settings
js/ui.js                Cards, sheets, toasts, .ics export
js/chart.js             Price history chart and trend notes
js/refresh.js           Merge fetched data; detect new shows, price & status changes, alerts
js/api.js               Ticketmaster, SeatGeek, Bandsintown, geocoding (also used by the server job)
js/sync.js              Gist sync, merge, Web Push subscription
js/spotify.js           Spotify import (PKCE, no server)
js/files.js             Ticket files in IndexedDB
js/store.js             localStorage persistence, backup/restore
js/util.js              Formatting and helpers
server/check.mjs        Background-alert job (run by .github/workflows/alerts.yml)
server/selftest.mjs     Offline test for the job
icons/                  App icons
```

## Limits

- Without background alerts, Encore checks for updates only when you open it, because iOS doesn't let web apps run in the background.
- Ticketmaster price ranges are face value and may not include fees. Resale prices need a SeatGeek client ID; you can also log prices by hand.
- Spotify developer apps start in development mode. That's fine for your own account.
