# PTO Volunteer Sign-Up

A SignUpGenius-style volunteer sign-up app running on **Google Apps Script**.
Every event is its own **Google Sheet** in the PTO's shared **Events** folder.

## How it works

| Piece | Where |
|---|---|
| Sign-up page (HTML/CSS/JS) | `src/Index.html`, `src/Styles.html`, `src/Client.html` |
| Server entry points | `src/Code.js` (`doGet`, `getPageData`, `submitSignup`) |
| Sign-up rules (pure, fully tested) | `src/Signup.js` |
| Event spreadsheets + Events-folder check | `src/Repo.js` |
| Emails | `src/Mail.js` |
| Short links (TinyURL) | `src/ShortLink.js` (`getShortLink`) |
| QR code library (qrcode-generator, MIT, minified) | `src/QrCode.html` (browser), `src/QrCodeLib.js` (server) |
| One-time setup | `src/Setup.js` (`setup()`) |

### Events

Each event is a spreadsheet with three tabs:

- **Event**: rows of `field | value`: `title`, `description`, `location`,
  `organizerEmail` (optional; gets an email per sign-up), and optionally
  `confirmationSubject` / `confirmationMessage` to customize the volunteer's
  email and `organizerSubject` / `organizerMessage` for the organizer's (below). A `status` row from older spreadsheets is ignored. The app adds `shortLink` and `qrCode` rows
  when someone makes a short link (see below).
- **Slots**: `slotId`, `label`, `start`, `end`, `capacity`. Leave `slotId` blank
  and the app fills it in. Never change a `slotId` after people have signed up.
- **Signups**: written by the app. Organizers only change `status`
  (`confirmed`, `waitlisted`, `cancelled`). Each custom question adds a column
  (named after the question) the first time someone answers it.
- **Questions** (optional): custom questions for the sign-up form, one row
  each: `question`, `type` (`text`, `paragraph`, `choice`, `checkbox`),
  `options` (for `choice`, comma-separated), `required` (`yes`/`no`). Up to 10.
  Answers are checked on the server, saved in Signups and included in the
  organizer's email; never shown publicly. A question named like a built-in
  column (e.g. `note`) is saved as `note (answer)`. Renaming a question after
  people answer starts a new column. Spreadsheets made before this can add a
  tab named `Questions` with those headers.

**The folder an event is in decides whether it takes sign-ups:**

| Where the spreadsheet is | What the sign-up page does |
|---|---|
| Directly in **Events** | Open: takes sign-ups |
| Directly in **Past events** | Shows the slots and who signed up; no new sign-ups |
| Anywhere else, including subfolders of Events | "We couldn't find that sign-up" |

*Event Template* is never shown, even in the Events folder. Moving an event to
Past events stops sign-ups immediately (each sign-up asks Drive), and the page
shows it as closed within about a minute. Moving it anywhere else unpublishes
it within 5 minutes.

The event's URL is `…/exec?event=<spreadsheet id>`. The bare `…/exec` URL (and
the static site's home page) **lists the open events** that still have spots
(directly in Events, at least one spot left; soonest first, with dates,
location and spots left, never volunteer names), loaded after the page shows.
The 1-minute timer keeps that list cached (`getOpenEvents`, `?api=events`), so
it changes within about a minute of a sign-up, edit or move. Below the list,
the page shows organizers step-by-step
instructions (with lightweight HTML mock-ups of the folder and tabs rather
than screenshots, to keep every page small) and the tool where they paste
their spreadsheet's link to get its sign-up link. The Events folder link and
admin@bishopschoolpto.com are written into `src/Index.html`.

**Speed:** `doGet` builds each event's slot data into the page, so the browser
makes no second call. Each event's public view is cached for 15 minutes and
kept fresh by a **1-minute timer** (`refreshEventCaches`, installed by
`setup()`): each run lists the Events and Past events folders with Drive and only
reopens spreadsheets whose last-modified time changed. So first visits are
usually served from the cache, a sign-up updates the cache immediately, and
**edits typed directly into a spreadsheet (new slots, new times) appear
within about a minute.** Sign-ups always re-check the sheet under a lock, so
the cache can never cause overbooking. To see what the timer is doing: Apps Script editor → Executions.

**Short links and QR codes:** after the link tool finds an event, *Make short
link & QR code* gets a TinyURL for it and draws a QR code in the browser (with
a PNG download). TinyURL only answers browsers on its own site, so Apps Script
asks for the link (`UrlFetchApp`). Set the `TINYURL_API_TOKEN` script property
to use TinyURL's current API (`POST https://api.tinyurl.com/create`); without it
the app falls back to TinyURL's deprecated keyless `api-create.php`. It only
does this for open and past events. Short links point to the static site
(`SITE_URL`), or to the Apps Script page when made there.

The app remembers nothing about short links: **every click makes a new
TinyURL** and overwrites the event's Event tab (`shortLink` row, with a QR code
image over the `qrCode` row below it), and the page confirms it was saved
there. Organizers can type the text after `tinyurl.com/` (TinyURL's "alias":
5–30 letters, numbers, `-` or `_`); the field is prefilled from the event: the
org name's first word, the title, and the event's year, e.g.
`bishop-fall-book-fair-2026` (`suggestAlias` in `src/Client.html`). TinyURL
won't make the same text twice, so if the text is taken the app follows
`tinyurl.com/<text>`: if it already leads to this event, that link is reused;
otherwise the organizer is asked for other text. Because anyone can use the
link tool, each event may make at most 10 new links per 6 hours (a counter in
the script cache, `shortLinkCount:<event id>`, that expires by itself). Apps
Script draws the spreadsheet's QR code itself (`src/QrCodeLib.js`, a private
copy of the same library) instead of taking the browser's image.

**Waitlist:** when every slot of an open event is full, each slot offers
*Join waitlist*. Entries go in the Signups tab with status `waitlisted`; they
never count toward capacity, and only the count ("2 on the waitlist") is shown
publicly. The volunteer is told they're #N on the waitlist and not confirmed
yet (the organizer's custom subject and message are left out of that email);
the organizer is notified. **Promotion is automatic when a confirmed volunteer
cancels with their email link** (see Cancel link). Status changes organizers
make by hand don't promote anyone: they change the next person to `confirmed`
themselves and contact them. While
any spot is open, the waitlist is closed and sign-ups go to the open spots.
Full open events stay in the home page list, marked "Full · join the waitlist".

**Cancel link:** every confirmation (and waitlist) email ends with "Can't make
it?" and a link to `<page>?event=<id>&cancel=<cancelToken>`, on the page the
volunteer used (Apps Script or `SITE_URL`). The token is a random UUID kept in
the Signups tab's `cancelToken` column and that email, so no account is needed
and nobody else can cancel. Opening the link only shows the sign-up
(`getCancellation`, `?api=cancellation`); cancelling takes a click
(`cancelSignup`, POST `{"api":"cancel"}`), so email link scanners can't cancel
anything. Cancelling sets the status to `cancelled` under the lock, updates the
cached page, and emails the volunteer and the organizer. **If a confirmed
volunteer cancels and the slot has a waitlist, the earliest waitlisted person
(by row order) is confirmed in the same locked step**, so the spot is never
open for someone else to take, and they get a "A spot opened up – you're in"
email with the organizer's message and their own cancel link (which points to
`SITE_URL`). The organizer's email names who moved up. Waitlisted volunteers
use the same link to leave the waitlist (nobody moves up then). It works for
events in Past events too.

**Confirmation emails:** `confirmationSubject` replaces the subject;
`confirmationMessage` is added below the sign-up details (line breaks kept,
links clickable). Both can use `{firstName}` `{name}` `{email}` `{phone}`
`{event}` `{slot}` `{when}` `{location}`, `{eventLink}` (the event's sign-up
page) and `{cancelLink}` (the volunteer's
personal cancel link). The greeting, details, organizer contact line and cancel
link stay, unless `confirmationMessageOnly` is `yes`: then the email is only
the organizer's `confirmationMessage` (and subject), so they should include
`{cancelLink}` themselves. A blank message falls back to the standard email,
and waitlist and "a spot opened up" emails always keep their standard text.

**Cancellation emails:** `cancellationSubject`, `cancellationMessage` and
`cancellationMessageOnly` customize the email volunteers get when they cancel
or leave the waitlist, the same way (same placeholders, except `{cancelLink}`).
The organizer's cancellation notice keeps its standard text.

**Links and pictures in messages** (`confirmationMessage`, `cancellationMessage`, `organizerMessage`;
`renderMessage_` in `src/Mail.js`): `[words](https://…)` makes a link,
`![description](https://…)` an image scaled to the email's width, and bare
`https://` addresses are clickable. Plain-text versions read "words (address)"
and "[description]". Only `http(s)` addresses work (anything else stays as
typed), all other text is escaped, and the Markdown is read before placeholders
are filled, so volunteers' details can't become links or images; `{cancelLink}`,
`{eventLink}` and `{spreadsheetLink}` (the app's own addresses)
are the only placeholders allowed in an address. Images must be publicly
reachable (not a private Drive file). Older spreadsheets can add the rows at the bottom of the Event tab.

**Event page links:** every email links to the event's sign-up page, on the
site the person used (`pageBaseUrl_`): "View the event page" in confirmations
(also waitlist and "a spot opened up"), "sign up again on the event page" in
cancellations, and "Open the event page" next to "Open the event spreadsheet"
in organizer emails. Message-only emails add nothing; `{eventLink}` works in
every custom field.

**Organizer emails:** `organizerSubject` replaces the subject of the email
`organizerEmail` gets for each new sign-up (waitlist entries keep a
`Waitlist: ` prefix), and `organizerMessage` adds a note below the volunteer's
details. Both can use the same placeholders, plus `{spreadsheetLink}` (the
event spreadsheet's address, also usable as `[words]({spreadsheetLink})`).
Every organizer email (new sign-up and cancellation) also ends with an "Open the
event spreadsheet" link. Volunteers' emails never include the spreadsheet link.
The volunteer's details and the reply-to address always stay; volunteers never
see these. Cancellation notices keep their standard subject.

**To create an event:** open *Event Template* in the Events folder, use
*File → Make a copy* (keep it in Events), fill in the Event and Slots tabs,
then paste the copy's link into the link tool to get the sign-up link. The copy
takes sign-ups as soon as it is in Events, but nobody can find it until you
share its link. **When sign-ups should stop, move the spreadsheet to Past
events.**

## Static site (signups.bishopschoolpto.com)

`site/index.html` is the same sign-up page as a single self-contained static
file. It skips Google's page frame and calls Apps Script only for data:

| Request | Apps Script |
|---|---|
| `GET …/exec?api=page&event=<id>` | event data (JSON) |
| `GET …/exec?api=events` | open events with spots left (JSON) |
| `POST …/exec` body `{"api":"signup","input":{…}}` as `text/plain` | sign-up (JSON) |
| `POST …/exec` body `{"api":"shortLink","input":{"eventId":…}}` as `text/plain` | TinyURL for the event (JSON) |

The home page (no `?event=`) appears without waiting for any API call, then
fetches the open events list: the org name is built into the page (`orgName` in `site.config.json`, default "Bishop School PTO";
keep it the same as the `ORG_NAME` script property).

`text/plain` keeps the POST a "simple" cross-origin request, since Apps Script
can't answer CORS preflights. Its responses allow any origin.

```sh
npm run build:site   # writes site/index.html using apiUrl from site.config.json
```

Update `site.config.json` if the Apps Script deployment URL ever changes.
Event links are `https://signups.bishopschoolpto.com/?event=<id>`; the link
tool on the home page builds them. Links to the Apps Script URL keep working
too.

### Hosting on GitHub Pages

`.github/workflows/pages.yml` publishes the site on every push to `main`: it
runs the unit tests, builds `site/index.html` from `src/` with the `apiUrl` in
`site.config.json`, and deploys it with GitHub Pages. `site/` is built, not
committed (it's in `.gitignore`).

One-time setup:

1. Create the GitHub repository and push `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. The workflow runs (Actions tab); the site appears at
   `https://<owner>.github.io/<repo>/`.
4. **Settings → Pages → Custom domain:** `signups.bishopschoolpto.com`. At the
   DNS provider for bishopschoolpto.com, add a `CNAME` record from `signups`
   to `<owner>.github.io`. When the DNS check passes, tick **Enforce HTTPS**.
   (With GitHub Actions deployments no `CNAME` file is needed in the repo.)
   Optionally verify the domain for your account or organization (Settings →
   Pages → Verified domains) so nobody else can claim it.

GitHub Pages caches pages for up to 10 minutes, so a change can take that
long to show up. Free GitHub Pages needs a **public** repository: everything
committed is public (no secrets live in the repo; the TinyURL token and other
settings are Script Properties).

> **Security rule:** Apps Script lets any visitor call any global function
> whose name doesn't end in `_`. Every internal helper ends in `_`, and
> `test/unit/security.test.js` fails if a new public function appears.

## Local development (no Google account needed)

```sh
npm test          # unit tests: logic, sheet access, locking, email, security
npm run test:ui   # headless-browser tests of the real page
npm run dev       # local preview (in-memory fake Drive and Sheets), incl. the static site at /static
```

`npm run dev` runs the real server code against fakes of the Google services
(`test/helpers/gas.js`). `/__mail` shows the emails that would have been sent
and `/__data` shows the spreadsheets' contents.

**What local tests can't cover:** real permissions and the OAuth consent
screen, actual email delivery and quotas, real `LockService` contention, how
the page behaves inside Google's iframe and inside a Google Site, and
Google's `Utilities.formatDate` output.

## First deployment

1. Turn on the Apps Script API: <https://script.google.com/home/usersettings>
2. Log in (prints a URL; sign in as the PTO account, paste the code back):
   `npx clasp login --no-localhost`
3. Create the project: `npx clasp create --type standalone --title "PTO Volunteer Sign-Up" --rootDir src`
   (this overwrites `src/appsscript.json`; restore the repo's version afterwards)
4. `npx clasp push --force` (clasp silently skips the push without `--force`
   whenever the manifest changed)
5. In the Apps Script editor (`npx clasp open-script`), run **setup** and approve
   the permissions. It creates *Event Template* and a sample event in My Drive
   (or brings an existing template up to date), installs the refresh timer, and
   logs a checklist (`OK:` / `NOTE:` / `TODO:`) of what's left: moving the
   template into Events, trying the sample, setting `TINYURL_API_TOKEN`, etc.
   It can't move files itself (the app only reads Drive metadata).
6. In **Project Settings → Script Properties**, set `MAIL_REDIRECT_TO` to your
   own email while testing, so no parent gets a test email.
7. Deploy: `npx clasp deploy --description "test"` and open the web app URL.

### Script properties

| Property | Purpose |
|---|---|
| `EVENTS_FOLDER_ID` | Events folder (default: the PTO's shared Events folder) |
| `PAST_EVENTS_FOLDER_ID` | Past events folder (default: the PTO's shared Past events folder) |
| `TEMPLATE_ID`, `SAMPLE_EVENT_ID` | Set by `setup()` so it doesn't create them twice (deleting the file makes the next run recreate it) |
| `ADMIN_EMAIL` | Who organizers contact, shown in the spreadsheets' Start here tab (default admin@bishopschoolpto.com) |
| `ORG_NAME` | Display name (default "Bishop School PTO") |
| `MAIL_REDIRECT_TO` | Send **all** emails here instead. Remove it for production |
| `TINYURL_API_TOKEN` | API token from a TinyURL account (developer page: https://tinyurl.com/app/dev). Without it, the deprecated keyless API is used |
| `SITE_URL` | Where short links point (default `https://signups.bishopschoolpto.com/`) |

**`setup()` is safe to run any time**, and worth re-running after an update:
it only creates what's missing. Every spreadsheet it makes, and the existing
Event Template each time it runs, gets the current layout: a **Start here** tab
(how to run a sign-up), the Event/Slots/Signups/Questions tabs with every field
and column, hover notes on headers, dropdowns for Signups `status` and
Questions `type`/`required`, a date-time format for slot times, and a
whole-number check on capacity. It never changes values organizers typed; it
only removes the template's retired `status` row. The sample event shows off a
custom confirmation email and questions. It also installs the 1-minute
`refreshEventCaches` timer (Apps Script editor → Triggers) if it's missing.

After any change to `oauthScopes` in `src/appsscript.json`, the owner must run
any function in the editor once to approve the new permissions, **before**
redeploying; otherwise the web app fails for everyone.
