# Encore — concert tracker

A phone-first web app for following artists and tracking their upcoming concerts and ticket prices.
Install it on your iPhone from Safari. Everything stays on your phone: no account, no server, no tracking.

## Features

- **Follow artists**: search Ticketmaster or add them by name. You can also paste a whole list at once.
- **Upcoming shows feed**, grouped by month, with filters for *Near me*, *My shows*, *New*, *Price drops*, *On sale soon* and *Hidden*, plus search.
- **Price tracking**: Encore records Ticketmaster's face-value price range on every refresh and draws a price history chart. You can log prices you see elsewhere (StubHub, SeatGeek, box office), set a **target price**, and get flagged when the lowest price falls to it.
- **Change detection**: new shows, price drops and rises, and status changes (cancelled, postponed, rescheduled) are all flagged. Shows that vanish from listings are marked *No longer listed*.
- **On-sale and presale dates**, with *On sale Fri* badges.
- **My plans**: mark a show *Interested*, *Going* or *Got tickets*, and record quantity, price paid, seats and notes. Past shows you went to stay on as your concert history.
- **Calendar** month view. Export one show or all your shows to Apple Calendar (.ics).
- **Distances** from your home city, a *Near me* radius, and quick links to Apple Maps.
- **Resale links** (StubHub, SeatGeek, Vivid Seats) pre-filled for each show.
- **Manual shows** for artists or venues that aren't on Ticketmaster.
- Pull-to-refresh, automatic refresh when the app is opened (interval is configurable), optional notifications, and an app-icon badge.
- Works offline (service worker). Light and dark themes. Backup to and restore from a JSON file.

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

## Deploying to GitHub Pages

This repo has a workflow (`.github/workflows/pages.yml`) that publishes the site whenever `main` changes.

1. Merge this branch into `main`.
2. In GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The workflow runs on the next push to `main`, or you can start it by hand from the **Actions** tab.

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
sw.js                   Offline cache (bump VERSION when you change files)
css/styles.css          Styles (light/dark, iOS safe areas)
js/app.js               Routing, global actions, refresh orchestration, pull-to-refresh
js/views.js             Screens: Shows, Calendar, Artists, Artist, Event, Settings
js/ui.js                Cards, sheets, toasts, price chart, .ics export
js/refresh.js           Merge fetched data, detect new shows / price & status changes, alerts
js/api.js               Ticketmaster, Bandsintown, Open-Meteo geocoding
js/store.js             localStorage persistence, backup/restore
js/util.js              Formatting and helpers
icons/                  App icons
```

## Limits

- iOS doesn't let web apps run on a schedule in the background, so Encore checks for updates when you open it. Notifications fire at that point.
- Ticketmaster price ranges are face value and may not include fees. Resale prices aren't available through a free public API, so log them by hand.
