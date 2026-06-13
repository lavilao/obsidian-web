# LiveSync integration — Implementation Plan

> Created: 2026-05-11
>
> Target audience: implementing agent (sub-agent). Read top to bottom,
> then execute. Acceptance criteria at the end define when you're done.

## Context

The previous two plans (now in `docs/plans/archive/`) gave us:
- A mobile runtime (`/mobile`) with CapacitorAdapter
- System plugin injection from `<repo>/plugins/`
- A working layout-switcher plugin

This plan adds **obsidian-livesync** as a second system plugin, so any
obsidian-web vault can sync with a CouchDB backend.

**The strategy was settled in `PLAN.md` → "Updated approach (2026-05-11):
direct fetch + CORS"** — do not deviate without re-reading that section
and discussing with the user.

**TL;DR strategy:**
- LiveSync calls Obsidian's `requestUrl()` API.
- We implement `App.requestUrl` in `client-mobile/shims/capacitor-shim.js`
  as a plain `fetch()` wrapper.
- Browser fetches CouchDB **directly**. No proxy.
- Users must configure CouchDB CORS (standard LiveSync requirement).

## What already exists (do not redo)

| Component | Status |
|---|---|
| Mobile runtime (`/mobile`) | ✅ done |
| `CapacitorAdapter` via shim | ✅ done |
| System plugin overlay | ✅ done (uses `<repo>/plugins/` directory) |
| Layout-switcher plugin (`obsidian-web-layout`) | ✅ done |
| `crypto.createHash` async path in `client-mobile/boot.js` | ✅ done — works for SHA-1/256/512 via `subtle.digest` |
| `App.requestUrl` in `capacitor-shim.js` | ❌ stubbed (`() => Promise.resolve({})`) — this is what we implement |
| LiveSync plugin in `<repo>/plugins/obsidian-livesync/` | ❌ not yet present |
| `SYSTEM_PLUGINS` env var | ❌ documented in PLAN.md but not implemented |

## Goal

When the user opens any vault on obsidian-web at `/mobile`:
1. LiveSync appears in the plugins list automatically (via system overlay).
2. They configure CouchDB URI + auth in the LiveSync settings tab.
3. Initial replication completes against their CouchDB.
4. Subsequent edits sync in both directions: web → desktop and desktop → web.
5. No server-side proxy is in the data path.

## The exact `App.requestUrl` contract — verified from `obsidian-mobile/app.js`

Obsidian's `requestUrl()` (the API LiveSync calls) routes to
`Capacitor.Plugins.App.requestUrl` when `isNativePlatform()` is true.
Confirmed locations in v1.12.7:

- **Caller** (offset ~1084715): converts the user's request before calling.
- **Response normalizer `fb`** (offset 1084206): wraps the response so
  the plugin sees `{status, headers, arrayBuffer, json, text}`.

### Request shape Obsidian sends us

```js
Av.requestUrl({
  url:         string,           // full URL
  method:      string?,          // 'GET' (default), 'POST', 'PUT', etc.
  contentType: string?,          // value for Content-Type header
  headers:     {[name]: string}?,// user-supplied headers
  body:        string OR base64, // see binary flag
  binary:      boolean,          // if true, body is base64-encoded
})
```

When the plugin passes an `ArrayBuffer` as body, Obsidian wraps it:

```js
// In obsidian-mobile/app.js (paraphrased):
n = false;
if (e.body instanceof ArrayBuffer) {
  t = $(e.body);    // ArrayBuffer → base64 string
  n = true;
} else {
  t = e.body;       // string passthrough
}
Av.requestUrl({ url: e.url, method: e.method, ..., body: t, binary: n });
```

### Response shape Obsidian expects from us

```js
{
  status:  number,
  headers: {[name]: string},
  body:    string,                // BASE64 of response body, ALWAYS
}
```

Then Obsidian does `X(i.body)` to decode base64 to ArrayBuffer, and `fb`
builds the final response object:

```js
function fb(e, status, headers, arrayBuffer) {
  if ((e.throw ?? true) && status >= 400) {
    throw new pb('Request failed, status ' + status, status, headers);
  }
  return {
    status, headers, arrayBuffer,
    get json() { return JSON.parse(new TextDecoder().decode(arrayBuffer)); },
    get text() { return new TextDecoder().decode(arrayBuffer); },
  };
}
```

### Helper functions in the bundle (for reference, do not import)

```js
// $: ArrayBuffer/Uint8Array → base64 string (uses btoa)
function $(e) { return Z(new Uint8Array(e)); }
function Z(e) {
  for (var t=[], n=e.byteLength, i=0; i<n; i++) t.push(String.fromCharCode(e[i]));
  return window.btoa(t.join(''));
}

// X: base64 string → ArrayBuffer
function X(e) {
  var t = window.atob(e), n = t.length, i = new Uint8Array(n);
  for (var r=0; r<n; r++) i[r] = t.charCodeAt(r);
  return i.buffer;
}
```

We re-implement these locally in our shim (don't try to reach into the
bundle).

## Implementation phases

### Phase 1 — Implement `App.requestUrl`

File: `client-mobile/shims/capacitor-shim.js`

Locate the existing `App` plugin definition (around line ~396). Replace
the `requestUrl: () => Promise.resolve({})` line with a real
implementation.

```js
// Helper: base64 string → ArrayBuffer.
function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

// Helper: ArrayBuffer → base64 string.
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  // btoa can't handle >65k arg lists; chunk it.
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// In const App = { ... }:
async requestUrl(opts) {
  const { url, method, contentType, headers, body, binary } = opts;

  // Build request init.
  const reqHeaders = Object.assign({}, headers || {});
  if (contentType && !reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
    reqHeaders['Content-Type'] = contentType;
  }

  let reqBody;
  if (body == null) {
    reqBody = undefined;
  } else if (binary) {
    // Obsidian sent us base64; convert back to ArrayBuffer for fetch.
    reqBody = base64ToArrayBuffer(body);
  } else {
    // String body passthrough.
    reqBody = body;
  }

  // Do the real network request.
  const res = await fetch(url, {
    method: method || 'GET',
    headers: reqHeaders,
    body: reqBody,
    credentials: 'include',   // pass cookies if the server allows
  });

  // Collect response.
  const respHeaders = {};
  res.headers.forEach((v, k) => { respHeaders[k] = v; });

  const respBuffer = await res.arrayBuffer();
  const respBase64 = arrayBufferToBase64(respBuffer);

  return {
    status:  res.status,
    headers: respHeaders,
    body:    respBase64,
  };
},
```

**Critical:** the response `body` field must ALWAYS be a base64-encoded
string. Obsidian unconditionally runs `atob` on it (via `X()`). Empty
body → return `''`.

**Network errors:** if `fetch()` throws (CORS, DNS, network down, etc.),
let the rejection propagate. The Capacitor bridge will surface it to the
plugin as a rejected Promise. LiveSync handles connection errors itself.

### Phase 2 — Self-test `App.requestUrl`

Restart the server, navigate the browser (gui-host port 9224, session
`obsmobile`) to `http://localhost:3000/mobile?vault=5b68fb93d875ad63`,
wait for workspace, then run:

```js
async () => {
  // Test 1: simple JSON GET
  const r1 = await window.app.requestUrl({
    url: 'https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest',
    method: 'GET',
  });
  const result1 = {
    status: r1.status,
    tagName: r1.json?.tag_name,
    headerKeys: Object.keys(r1.headers).slice(0, 5),
  };

  // Test 2: POST with JSON body (use httpbin)
  const r2 = await window.app.requestUrl({
    url: 'https://httpbin.org/post',
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify({ hello: 'world' }),
  });
  const result2 = {
    status: r2.status,
    echoedBody: r2.json?.json,
  };

  // Test 3: binary GET (small PNG)
  const r3 = await window.app.requestUrl({
    url: 'https://httpbin.org/image/png',
    method: 'GET',
  });
  const result3 = {
    status: r3.status,
    byteLength: r3.arrayBuffer.byteLength,
    looksLikePng: new Uint8Array(r3.arrayBuffer).slice(0, 4).join(',') === '137,80,78,71',
  };

  return JSON.stringify({ test1: result1, test2: result2, test3: result3 }, null, 2);
}
```

**Expected results:**
- `test1.status === 200`, `test1.tagName === 'v1.12.7'` (or whatever is current)
- `test2.status === 200`, `test2.echoedBody.hello === 'world'`
- `test3.status === 200`, `test3.byteLength > 0`, `test3.looksLikePng === true`

If any test fails, fix before continuing. The binary test specifically
exercises the base64 round-trip — if that breaks, LiveSync chunk transfer
will break too.

### Phase 3 — Add LiveSync to `<repo>/plugins/`

Create a script: `scripts/install-livesync.js`

This script:
1. Fetches the latest `obsidian-livesync` release metadata from GitHub
   (`https://api.github.com/repos/vrtmrz/obsidian-livesync/releases/latest`).
2. Downloads `main.js`, `manifest.json`, and `styles.css` (if present)
   from that release's assets.
3. Writes them into `<repo>/plugins/obsidian-livesync/`.

Pattern: model on `scripts/update-obsidian-mobile.js` (which downloads the APK).
Same error handling: validate the response, check file presence, fail
loud if assets aren't found.

Manifest tweaks (write this AFTER downloading, modify in place):
- Read the downloaded `manifest.json`.
- Add `data.json` next to it with these defaults:
  ```json
  {
    "version": "<copied from manifest>",
    "remote_type": "couchdb",
    "_obsidian_web_note": "Configure your CouchDB URI in the LiveSync settings tab."
  }
  ```
  (LiveSync reads `data.json` for its settings; an empty/minimal one is fine —
  the plugin shows the settings UI on first load anyway.)

CLI:
```bash
node scripts/install-livesync.js              # latest
node scripts/install-livesync.js --version 0.25.60
node scripts/install-livesync.js --force      # re-download even if cached
```

Verification:
```bash
ls plugins/obsidian-livesync/
# Should show: manifest.json, main.js, [styles.css], data.json
```

After running the script, the system-plugin overlay automatically picks
it up the next time you load a vault — no other config needed.

### Phase 4 — End-to-end test with real CouchDB

We need a real CouchDB to test against. Options (pick whichever is easiest):

**Option A: Local Docker** (recommended for testing):
```bash
docker run -d --name couchdb-test \
  -p 5984:5984 \
  -e COUCHDB_USER=admin \
  -e COUCHDB_PASSWORD=test123 \
  couchdb:3
```

Then configure CORS via the admin UI (`http://localhost:5984/_utils`) or
write `/opt/couchdb/etc/local.d/cors.ini` directly:

```ini
[chttpd]
enable_cors = true

[cors]
origins = http://localhost:3000
credentials = true
methods = GET,PUT,POST,HEAD,DELETE
headers = accept, authorization, content-type, origin, referer, x-csrf-token
```

Restart CouchDB: `docker restart couchdb-test`.

**Option B: Cloudant free tier** — convenient but adds network latency
to the test. CORS is configured in the dashboard.

**Option C: ask the user** if they already have a LiveSync CouchDB
running and would prefer to test against it. (Don't assume — long-running
tests against a user's production DB could trash their data. Ask first.)

#### Test procedure

1. With CouchDB running, open obsidian-web at `/mobile?vault=...`.
2. Wait for workspace. Open Settings → Community plugins → Self-hosted LiveSync.
3. **Configure remote database:**
   - URI: `http://localhost:5984` (or wherever)
   - Username: `admin`
   - Password: `test123`
   - Database name: `obsidian-livesync-test`
4. Click "Test database connection". Expected: green checkmark.
5. Click "Setup wizard" → choose "Setup as a new database" (or whatever the
   first-run flow says). Pick defaults.
6. Wait for initial replication. Status bar should show ⚡ then 💤.
7. Edit `Welcome.md` in obsidian-web. Type a unique string like
   `<test-marker-{timestamp}>`.
8. On a second device (or another browser tab pointed at desktop Obsidian
   connected to the same CouchDB), verify the marker appears.
9. Reverse: edit on desktop, verify it appears in obsidian-web.

If step 4 fails with CORS errors in the browser console, the CouchDB CORS
config is wrong. Don't try to work around it from our side — fix the
CouchDB config.

If step 7 or 9 doesn't propagate within ~10 seconds, check the LiveSync
status bar for errors. Common issues:
- `_changes` feed connection drops (browser killed long-poll, or CORS
  blocks streaming) — needs investigation.
- Conflicts (LiveSync handles automatically but logs to console).

### Phase 5 — Document and ship

**`docs/livesync.md`** (new file, top-level in `docs/`):

User-facing guide. Cover:
- Prerequisites (CouchDB instance with CORS, LiveSync setup elsewhere)
- The plugin appears automatically — no install step
- How to configure: settings tab walkthrough
- CORS config example for CouchDB
- Troubleshooting common errors

**`docs/walkthrough.md`** entry — new dated section at the top,
following the existing pattern. Include:
- What was done (this plan, in summary)
- Architecture decisions made along the way (any deviations from the plan)
- Verification results

**`PLAN.md`** updates:
- In the LiveSync section, remove the "Direct-fetch implementation
  checklist" (it's done — replaced by this plan).
- Mark the LiveSync integration as Phase 1 / done.

## Out of scope for this plan

- **`SYSTEM_PLUGINS` env var implementation** — already documented in
  PLAN.md as a future task. Not blocking LiveSync.
- **CF Workers demo gating of LiveSync** — when `SYSTEM_PLUGINS` is
  implemented (separately), the CF demo will set
  `SYSTEM_PLUGINS=obsidian-web-layout` to exclude LiveSync there.
- **WebRTC P2P sync support** in LiveSync — experimental upstream feature,
  not needed for v1.
- **Customisation Sync** (LiveSync's plugin/theme/config sync) — should
  work transparently if vault sync works, but specifically testing it is
  out of scope for v1.
- **`CapacitorHttp.request`** — Obsidian's `requestUrl` on mobile routes
  to `App.requestUrl`, not `CapacitorHttp`. If LiveSync directly calls
  `CapacitorHttp` (unlikely), we'll see it in browser console when the
  plugin loads. Add a stub then; do NOT implement it speculatively.

## Pitfalls (read before starting)

1. **Don't proxy.** The temptation when fetch fails (CORS) is to add a
   server-side proxy. This was explicitly rejected — see PLAN.md. Fix
   CORS on the CouchDB side.

2. **base64 round-trip is mandatory.** Even text responses must be
   base64-encoded in our reply. Obsidian unconditionally runs `atob` on
   `i.body`. Returning raw text or an empty object will break the plugin
   with a cryptic InvalidCharacterError.

3. **`credentials: 'include'`** sends cookies. CouchDB cookie auth
   requires this. The CouchDB CORS config must also set
   `credentials = true` — otherwise the browser silently drops the
   cookies even though our fetch sets `include`.

4. **`btoa` on large binary** — `String.fromCharCode.apply(null, hugeArray)`
   blows the JS arg-list stack at ~65k elements. The helper above chunks
   it; do NOT inline a one-shot version.

5. **`headers.forEach` ordering** — modern browsers return headers
   normalized to lowercase. Obsidian's plugin code is usually case-
   insensitive about response headers, but if anything breaks, double-check
   the Headers object iteration.

6. **`_changes?feed=continuous`** — LiveSync may use the continuous feed.
   That's a long-running streaming response. `fetch()` supports it via
   the `Response.body` ReadableStream — but plugins consuming `arrayBuffer`
   would block forever waiting for the stream to close. If LiveSync uses
   `longpoll` (one-shot), arrayBuffer works fine. If it uses `continuous`,
   we have a problem and need to inspect what feed mode LiveSync requests.
   **Action when it comes up:** check LiveSync source or its actual
   network requests in DevTools to confirm `feed=longpoll`. If
   `feed=continuous` is used, surface this in the report — separate
   plan needed.

7. **Don't put LiveSync in `test-vault/.obsidian/plugins/`.** Use the
   `<repo>/plugins/` system overlay. The vault stays clean.

8. **GitHub release asset naming** — at the time of writing, the
   obsidian-livesync release attaches `main.js`, `manifest.json`, and
   `styles.css` as plain files. If the upstream changes to a tarball or
   different naming, the install script needs to adapt. Fail loud on
   asset-not-found.

9. **`Cache-Control: no-cache` on plugin files** — the system-plugin
   overlay serves files with `Cache-Control: no-cache` by default. Don't
   change this for LiveSync — when we re-run `install-livesync.js` the
   new version should be picked up without a hard refresh.

10. **The user's existing data.json** — if a user already has LiveSync
    installed in their vault (`.obsidian/plugins/obsidian-livesync/data.json`),
    the system-plugin overlay's "vault > repo" precedence means their
    vault settings win. This is the desired behavior. The script's
    default `data.json` only matters for first-time setup.

## Acceptance criteria

The plan is complete when **all** of the following are true:

- [ ] `client-mobile/shims/capacitor-shim.js` has a real `App.requestUrl`
      implementation; the previous stub is gone.
- [ ] All three browser self-tests in Phase 2 pass (GET JSON, POST JSON
      echo, GET binary PNG).
- [ ] `scripts/install-livesync.js` exists, runs cleanly, and produces a
      complete `<repo>/plugins/obsidian-livesync/` directory with at
      least `main.js`, `manifest.json`, and `data.json`.
- [ ] After running the install script and reloading obsidian-web, the
      LiveSync settings tab is reachable from Settings → Community plugins.
- [ ] With a CouchDB instance + correct CORS config, initial replication
      completes (status bar shows 💤 after ⚡).
- [ ] Edit-on-web → appears-on-desktop within ~10 seconds.
- [ ] Edit-on-desktop → appears-on-web within ~10 seconds.
- [ ] `docs/livesync.md` user guide exists and walks a user through CORS
      setup + plugin config.
- [ ] `docs/walkthrough.md` has a new dated entry summarizing the work.
- [ ] `PLAN.md` LiveSync section updated to reflect completion.
- [ ] **No commits.** Leave that to the user.

## Reference: file locations + line numbers (Obsidian v1.12.7)

In `obsidian-mobile/app.js`:

| Item | Offset |
|---|---|
| `requestUrl()` plugin API caller | ~1084715 |
| `fb()` response normalizer | ~1084206 |
| `$()` ArrayBuffer → base64 | ~267137 |
| `X()` base64 → ArrayBuffer | ~267042 |

These offsets will drift between versions. Reference only — the regex
patterns are the source of truth, but for this plan we don't patch the
bundle (we implement entirely in the shim).

In `client-mobile/shims/capacitor-shim.js`:

| Item | Approx. line |
|---|---|
| `const App = { ... }` | ~396 |
| `requestUrl:` stub to replace | ~408 |
| `PluginHeaders` declaration | ~592 |

In `PluginHeaders`, `App.requestUrl` is already declared as
`rtype: 'promise'`. Do not change.

## Reference: how to run the gui-host browser

The previous agent's session is `obsmobile` on port 9224 with
`--user-data-dir=/tmp/pw-obsidian-mobile`. Don't touch ports 9222/9223
(other agents).

```bash
PW="export PATH=\"~/.local/share/fnm/node-versions/v25.9.0/installation/bin:\$PATH\" && cd ~/Documents/playwright-cli"
ssh gui-host "$PW && playwright-cli list"           # verify session
ssh gui-host "$PW && playwright-cli --s=obsmobile goto 'http://localhost:3000/mobile?vault=5b68fb93d875ad63'"
ssh gui-host "$PW && playwright-cli --s=obsmobile eval --raw '<js>'"
```

For screenshots: save to `~/<name>.png`, then `scp` to `/tmp/`
and Read.

If `obsmobile` session is gone:
```bash
ssh gui-host "$PW && playwright-cli --s=obsmobile attach --cdp http://localhost:9224"
```

If Chrome on 9224 is gone:
```bash
ssh gui-host "DISPLAY=:10 ~/Documents/scripts/pw-clean.sh \
  'http://localhost:3000/mobile?vault=5b68fb93d875ad63' \
  --port=9224 --user-data-dir=/tmp/pw-obsidian-mobile" &
sleep 6
```
