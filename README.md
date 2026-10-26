# PastePort

Copy on one computer, paste on the other. PastePort is a small web app (nothing to
install) that links two computers through a **room**. Whatever you paste, type or
drop on one computer shows up on the other, already on the clipboard, ready to
paste. No more emailing things to yourself.

**Live site:** https://pasteport.vercel.app (Vercel project `pasteport`). The old address,
https://clipshare-two.vercel.app, redirects there.

```
 Computer A (host)                  Supabase                  Computer B (joiner)
 browser / installed app  ──HTTPS + WebSocket──▶  relay  ◀──HTTPS + WebSocket──  browser / installed app
                                   (stores only encrypted data)
```

Both computers only make outgoing HTTPS/WebSocket connections, so it works across
different networks, VPNs and firewalls. No LAN, port forwarding or admin rights needed.

## Using it

1. On computer A open the site and click **Create room**. You get a code like `7KQ2M-9XD4P`
   and a QR code.
2. On computer B open the same site, type the code and click **Join**.
   On a phone, scan the QR code with the camera app instead; the link opens the room
   directly. The code, the QR code and the invite link are also under **Invite** in the
   top bar.
3. Send something from either side:
   - press **Ctrl+V** anywhere on the page: text, formatted text, screenshots, and files
     copied in File Explorer (Chrome/Edge)
   - type in the box and press **Enter** (Shift+Enter for a new line)
   - drop files on the page or click the paperclip (up to 50 MB per file; zip folders first)
   - click **Send clipboard**
4. On the other computer text and images are put on the clipboard automatically, so
   just press Ctrl+V in any program. Files are downloaded automatically. Everything also
   stays in the room's feed with Copy / Download / Delete buttons.

**Browser limitation:** a web page may only write to the clipboard while its window is
focused. If PastePort is in the background when something arrives, the title and a banner
tell you, and the item is copied as soon as you switch to the PastePort window (Alt+Tab).

Tips:

- Install it as an app (the **Install as app** button on the start page, or the browser
  menu) so it has its own window and taskbar icon. Keep it open on both computers.
- The room is remembered: reopening the app goes straight back into it.
- Phones work too, and more than two devices can be in the same room. Phone browsers are stricter
  about the clipboard, especially on iPhone: if something received isn't on the
  clipboard, tap its **Copy** button.
- Settings (gear icon):
  - device name
  - auto-copy received text/images (on)
  - auto-download received files (on)
  - **send my clipboard automatically when I switch to this window** (off). With this on,
    the flow is: copy in any program, Alt+Tab to PastePort, done.
  - desktop notifications
  - delete everything in the room
- Status in the top bar:
  - **Live**: changes arrive instantly.
  - **Connected (polling)**: WebSockets are blocked on this network, so the app checks
    every few seconds instead. Everything still works, just with a short delay.

## One-time setup

You need a free [Supabase](https://supabase.com) project (the relay and database) and a
static host for the `web` folder. [Vercel](https://vercel.com) is configured here.

### 1. Supabase

1. Create a project (choose the region closest to you).
2. Open **SQL Editor > New query**, paste the whole of [`supabase/setup.sql`](supabase/setup.sql)
   and click **Run**. It is safe to run again, for example after changing the limits.
3. Get two values. The **Connect** button at the top of the dashboard, or **Project Settings**,
   shows both:
   - **Project URL**: `https://<project-ref>.supabase.co`
   - **Publishable key** (`sb_publishable_...`) from **Project Settings > API Keys**.
     The legacy `anon` key also works.
4. Put them in [`web/config.js`](web/config.js):

   ```js
   window.CLIPSHARE_CONFIG = window.CLIPSHARE_CONFIG || {
     supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
     supabaseKey: 'sb_publishable_...',
   };
   ```

   The publishable key is meant to be public. **Never** put a secret / `service_role` key
   in this file.

Instant updates use Supabase Realtime (broadcast and presence on public channels). If
the status stays on "Connected (polling)" on every network, check that public channels
are allowed in the project's Realtime settings. That is the default.

### 2. Deploy the website (Vercel)

[`vercel.json`](vercel.json) publishes only the `web` folder (there is no build step)
and adds security headers, including a strict Content-Security-Policy.

Option A, with the CLI from the project folder:

```powershell
# Only needed behind a TLS-inspecting proxy, so Node trusts the corporate root CA:
$env:NODE_OPTIONS = '--use-system-ca'
npx vercel deploy --prod
```

The first deploy links the folder to a Vercel project (saved in `.vercel/`). Vercel
project names must be lowercase, so if it complains about the name (for example when the
folder is called `PastePort`), run `npx vercel deploy --prod --project pasteport` once.

Option B: push the repository to GitHub, then **Add New > Project** on vercel.com
and import it. Keep the framework preset at *Other* and leave the root directory as the
repository root.

Open the resulting `https://<name>.vercel.app` on both computers. Any other static
host that serves `web/` over HTTPS also works. HTTPS is required for the clipboard API
and for installing as an app. Other hosts won't apply the `vercel.json` headers, though.

If you use a custom Supabase domain, add it to `connect-src` in `vercel.json`.

## Security and privacy

- **End-to-end encrypted.** The room code never leaves your computers. Each browser derives
  the keys from the code:
  - PBKDF2-SHA256, 200,000 iterations, gives a master key.
  - From that: a room id, an AES-256 key and an HMAC-SHA256 key.
  - Every item and file chunk is encrypted (AES-256-CBC + HMAC-SHA256, encrypt-then-MAC)
    before upload.
  - Supabase only ever sees the room id (a hash) and ciphertext.
- **The code is the password.** Anyone with the code or invite link can read and post in
  the room. Codes are 10 random characters (about 50 bits). To rotate, leave the room
  and create a new one.
- **The database is locked down.** Tables live in a private schema that the API cannot
  read. Browsers can only call the `clip_*` functions, which validate sizes and room ids.
- **Data expires.** Items are deleted after 72 hours. **Delete** removes an item for
  both computers right away, and **Delete everything in this room** clears it.
- **Check your organisation's policy** before sending work data through third-party
  cloud services, even encrypted ones.

## Limits

Defaults, set in `clipshare.limits()` in `setup.sql` (edit and re-run to change):

| Limit | Default |
|---|---|
| Retention | 72 hours |
| Text item | 2 MB (encrypted size) |
| File | 50 MB |
| Storage per room | 250 MB |
| Storage for all rooms | 380 MB (the free database is 500 MB) |

When a quota is full, the oldest finished items are removed to make room. Unfinished
uploads are cleaned up after 2 hours. Removed and expired data disappears from the app
at once; the database frees its space bit by bit as the app is used.

Free Supabase projects are paused after a period of inactivity. Restore the project from
the dashboard if the app suddenly can't connect.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Backend not configured" | Fill in `web/config.js` and redeploy. |
| "Invalid API key" / 401 errors | Use the project URL and the *publishable* (or anon) key of the same project. |
| Errors about missing `clip_*` functions | Run `supabase/setup.sql` in the SQL Editor. |
| "Could not send: canceling statement due to statement timeout" | Run the latest `supabase/setup.sql` in the SQL Editor. Older versions freed expired files all at once, which could take longer than Supabase allows. |
| Always "Connected (polling)" | WebSockets are blocked by a proxy/firewall, or public Realtime channels are disabled. It still works, with a few seconds of delay. |
| Received text isn't on the clipboard | Switch to the PastePort window. Browsers only allow clipboard writes in a focused window. |
| "Send clipboard" / auto-send does nothing | Allow the browser's clipboard permission for the site (lock icon in the address bar). |

## Project layout

```
web/                 the app: static HTML/CSS/JS, installable (PWA)
  config.js          your Supabase URL + publishable key
  js/crypto.js       room-code key derivation and encryption
  js/backend.js      Supabase RPC + Realtime client, sync, chunked file transfer
  js/app.js          UI, clipboard, paste/drop, settings
  js/qr.js           QR code generator for the invite link
supabase/setup.sql   database schema, functions, limits, permissions
vercel.json          publishing + security headers
tests/               automated tests and a local mock backend
```

The app was first called ClipShare. Internal names (the `clipshare` database schema,
`CLIPSHARE_CONFIG`, the encryption salt, Realtime topics and browser storage keys) keep
that name so existing rooms and setups keep working.

## Development and tests

Needs Node.js 20+ (tested with Node 24) and Google Chrome (or Edge). The tests use the
installed browser, so nothing large is downloaded.

```powershell
cd tests
npm install
npm test            # all of the below
npm run test:crypto # crypto test vectors
npm run test:qr     # QR encoder vs. the qrcode package, every symbol decoded with jsQR
npm run test:sql    # setup.sql on real PostgreSQL (PGlite, in-process)
npm run e2e         # two browser "computers" and a phone against the in-memory mock backend
npm run e2e:pg      # the same, against the real setup.sql running in PGlite
```

The e2e test runs under the CSP from `vercel.json`. Set `HEADED=1` to watch it, or
`PW_CHANNEL=msedge` to use Edge.

To check a deployment against its real Supabase project:

```powershell
npm run live -- https://pasteport.vercel.app
```

It reads the Supabase URL and key from the site's `config.js`, checks that `setup.sql` is
installed and that Realtime works, then two browser "computers" exchange text and a 2.5 MB
file in a new random room and an emulated phone joins it by its QR code. The room is
cleared at the end. Behind a TLS-inspecting proxy, set
`$env:NODE_OPTIONS = '--use-system-ca'` first.

To try the app locally without a Supabase project:

```powershell
cd tests
npm run mock        # http://127.0.0.1:8787, in-memory backend
npm run mock:pg     # same, backed by the real setup.sql in PGlite
```

Open it in two windows (for example a normal and a private window) to play both computers.

## License

[MIT](LICENSE)
