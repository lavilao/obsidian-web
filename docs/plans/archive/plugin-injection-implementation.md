# System Plugin Injection — Implementation Plan

> Created: 2026-05-11
>
> Target audience: implementing agent (sub-agent). Read top to bottom,
> then execute.

## Context

The previous plan (`mobile-layout-implementation.md`) gave us a mobile
bundle whose Platform flags are controlled by `window.__owPlatformOverrides`,
which reads `localStorage['obsidian-web:layout-mode']`. Switching modes
currently requires the user to manually edit localStorage and reload.

**This plan adds a built-in Obsidian plugin** that gives users a ribbon
icon + commands to switch between `auto / mobile / desktop` modes.

**The plugin is injected by the server** rather than living in the user's
vault. The user never has to install or copy anything — it just appears
when they open any vault on obsidian-web.

## What already exists (do not redo)

| File | Status |
|---|---|
| `obsidian-mobile/app.js` (patched) | Mobile bundle with `window.__owPlatform` + `__owPlatformOverrides` hooks |
| `client-mobile/boot.js` | Sets `__owPlatformOverrides` from localStorage + viewport |
| `server/api/fs.js` | HTTP API for FS ops (`GET /api/fs/read`, `stat`, `readdir`; `PUT /api/fs/write`; etc.) |
| `server/api/bootstrap.js` | Bootstrap cache (NOT used by mobile bundle — Capacitor bypasses it for FS reads) |

The mobile bundle uses `CapacitorAdapter`, which routes every FS call
through our HTTP API:

```
plugin file read
  → app.vault.adapter.read("Welcome.md")
  → Capacitor.Plugins.Filesystem.readFile(...)
  → our capacitor-shim → fetch /api/fs/read?path=…
  → server/api/fs.js
```

Our overlay needs to plug in at the **`server/api/fs.js`** layer.
Anything we inject there is automatically seen by both desktop and
mobile bundles.

## Goal

When Obsidian loads `.obsidian/plugins/obsidian-web-layout/main.js`, the
server returns content from `<repo>/plugins/obsidian-web-layout/main.js`
even though the file doesn't exist in the vault. Same for `manifest.json`.

When Obsidian reads `.obsidian/community-plugins.json`, the server
returns a JSON array that includes `"obsidian-web-layout"` even if the
file in the vault doesn't have it. When Obsidian writes that file back,
the server strips our plugin id before saving so we don't pollute the
vault.

## High-level architecture

```
repo/plugins/                             ← source of truth (read-only)
└── obsidian-web-layout/
    ├── manifest.json
    └── main.js

server/system-plugins.js                  ← NEW module
  exports:
    - SYSTEM_PLUGINS         (Set<string> of plugin ids)
    - tryGetSystemPath(rel)  → absolute repo path or null
    - mergeCommunityList(arr) → arr with system ids added
    - stripCommunityList(arr) → arr with system ids removed
    - systemPluginEntry(id)  → directory entry for readdir

server/api/fs.js                          ← MODIFIED
  - GET /read:    if vault doesn't have it AND it's a system plugin file → serve from repo
  - GET /stat:    same fallback
  - GET /readdir: if listing .obsidian/plugins, merge system plugins into result
  - GET /read on community-plugins.json: merge in system ids
  - PUT /write on community-plugins.json: strip system ids
```

**Important precedence:** for `read`/`stat`, the vault is checked FIRST.
The repo is a **fallback**. This means a user can override our plugin by
placing files at `.obsidian/plugins/obsidian-web-layout/main.js` in their
vault (e.g. for testing). Default: they get the repo version.

## The 3 components

### Component A — the plugin source

Files in the repo (you create them):

**`plugins/obsidian-web-layout/manifest.json`**

```json
{
  "id": "obsidian-web-layout",
  "name": "Obsidian Web — Layout Switcher",
  "version": "0.1.0",
  "minAppVersion": "1.0.0",
  "description": "Switch between desktop, mobile, and auto-detect layouts. Only visible on obsidian-web (the web wrapper).",
  "author": "obsidian-web",
  "isDesktopOnly": false
}
```

**`plugins/obsidian-web-layout/main.js`**

A vanilla CommonJS Obsidian plugin (no TypeScript build, no bundler).
The Obsidian plugin runtime resolves `require('obsidian')` itself when
it loads the plugin — we don't need to handle that.

Behavior:

- On load: register a ribbon icon (Lucide name `monitor-smartphone`) and
  three commands (`set-layout-auto/mobile/desktop`).
- Clicking the ribbon icon: open a menu showing the three modes, with a
  checkmark next to the current one.
- Selecting a mode: write `localStorage['obsidian-web:layout-mode']`,
  show a full-screen overlay ("Switching to <mode> mode…"), and call
  `location.reload()` after a short delay (~150ms) so the overlay
  paints.
- The plugin only does anything on obsidian-web — if `window.__owPlatform`
  doesn't exist (i.e. running in real desktop Obsidian), the ribbon icon
  is **not** registered and commands are **not** registered. The plugin
  loads cleanly but is a no-op.

Sketch (complete this; the agent should not deviate from this structure
without good reason):

```js
'use strict';
const obsidian = require('obsidian');

const LAYOUT_KEY = 'obsidian-web:layout-mode';
const MODES = ['auto', 'mobile', 'desktop'];

function getMode() {
  return localStorage.getItem(LAYOUT_KEY) || 'auto';
}

function setMode(mode) {
  if (!MODES.includes(mode)) return;
  localStorage.setItem(LAYOUT_KEY, mode);
  showReloadOverlay(mode);
  setTimeout(() => location.reload(), 150);
}

function showReloadOverlay(mode) {
  const div = document.createElement('div');
  div.style.cssText = [
    'position:fixed', 'inset:0',
    'background:var(--background-primary)',
    'color:var(--text-normal)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'font:14px var(--font-interface, sans-serif)',
    'z-index:99999',
  ].join(';');
  div.textContent = 'Switching to ' + mode + ' mode…';
  document.body.appendChild(div);
}

function modeLabel(mode) {
  return mode === 'auto'    ? 'Auto (by viewport)'
       : mode === 'mobile'  ? 'Mobile layout'
       : mode === 'desktop' ? 'Desktop layout'
       : mode;
}

module.exports = class ObsidianWebLayoutPlugin extends obsidian.Plugin {
  async onload() {
    // Only activate on obsidian-web (where __owPlatform exists).
    // In real Obsidian desktop/mobile, this plugin is a no-op.
    if (typeof window.__owPlatform === 'undefined') {
      console.log('[obsidian-web-layout] not on obsidian-web — plugin idle');
      return;
    }

    this.addRibbonIcon('monitor-smartphone', 'Layout mode', (evt) => this.showMenu(evt));

    for (const mode of MODES) {
      this.addCommand({
        id: 'set-layout-' + mode,
        name: 'Set layout: ' + modeLabel(mode),
        callback: () => setMode(mode),
      });
    }
  }

  showMenu(evt) {
    const current = getMode();
    const menu = new obsidian.Menu();
    for (const mode of MODES) {
      menu.addItem((item) =>
        item
          .setTitle(modeLabel(mode))
          .setChecked(mode === current)
          .onClick(() => setMode(mode))
      );
    }
    menu.showAtMouseEvent(evt);
  }
};
```

### Component B — server module `system-plugins.js`

Create `server/system-plugins.js`. Pure module — no Express, no routing.
Just utility functions consumed by `fs.js`.

**Constants/state:**

```js
const SYSTEM_PLUGINS_DIR = path.resolve(__dirname, '..', 'plugins');
const SYSTEM_PLUGIN_IDS  = new Set();  // populated on init
```

**Functions to export:**

```js
init()                            // scan SYSTEM_PLUGINS_DIR, populate SYSTEM_PLUGIN_IDS
getSystemPluginIds() → string[]   // sorted copy
isSystemPluginPath(relPath) → boolean
                                  // true if relPath is exactly
                                  // .obsidian/plugins/<id> or
                                  // .obsidian/plugins/<id>/... for a known id

tryGetSystemFilePath(relPath) → absolute_path | null
                                  // resolve relPath against SYSTEM_PLUGINS_DIR
                                  // if it points to a real file there

mergeCommunityList(arr) → string[]
                                  // arr is parsed JSON array of plugin ids
                                  // returns arr with all SYSTEM_PLUGIN_IDS appended (dedup)

stripCommunityList(arr) → string[]
                                  // arr with SYSTEM_PLUGIN_IDS removed (for writes)
```

**`init()` behavior:**

- Read `SYSTEM_PLUGINS_DIR` (create if missing — log warning, no error).
- Each subdirectory that contains a `manifest.json` is a system plugin.
- The directory name must equal the `id` field in manifest.json. If not, log warning and skip.
- Populate `SYSTEM_PLUGIN_IDS`.
- Log "Loaded N system plugins: id1, id2, …" on startup.

**Path resolution for `tryGetSystemFilePath`:**

Input is a vault-relative path like `.obsidian/plugins/obsidian-web-layout/main.js`.

1. Must start with `.obsidian/plugins/`.
2. The segment after that is the plugin id. Must be in `SYSTEM_PLUGIN_IDS`.
3. Resolve to `path.join(SYSTEM_PLUGINS_DIR, <id>, <rest>)`.
4. **Security:** ensure the resolved path stays inside `SYSTEM_PLUGINS_DIR` (path traversal protection — `..` should not escape).
5. Return only if the file actually exists (use `fs.statSync` or async equivalent). Caller will handle "doesn't exist" cases.

### Component C — wiring into `server/api/fs.js`

Three logical changes. Place them as additions, do not rewrite the file.

**C1 — Read handler (lines 206-230 in current file):**

After computing `target = resolveSafe(req, relPath)` and BEFORE attempting `fsp.readFile`:

```js
// System plugin overlay: if the file is a known system plugin path
// AND not present in the vault, serve from repo plugins/.
const relPath = req.query.path || '';
const systemPath = tryGetSystemFilePath(relPath);
if (systemPath) {
  const vaultHas = await fileExists(target);  // small helper, see below
  if (!vaultHas) {
    // Serve from repo
    if (encoding) {
      const data = await fsp.readFile(systemPath, encoding);
      return res.type('text/plain; charset=utf-8').send(data);
    }
    const data = await fsp.readFile(systemPath);
    return res.type('application/octet-stream').send(data);
  }
}

// Special case: community-plugins.json — merge system ids into the list.
if (relPath === '.obsidian/community-plugins.json') {
  let list = [];
  try {
    const txt = await fsp.readFile(target, 'utf8');
    const parsed = JSON.parse(txt);
    if (Array.isArray(parsed)) list = parsed;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  list = mergeCommunityList(list);
  return res.type('application/json').send(JSON.stringify(list));
}
```

Helper:

```js
async function fileExists(absPath) {
  try { await fsp.access(absPath); return true; } catch { return false; }
}
```

**C2 — Stat handler (lines 156-170 in current file):**

After computing `target`:

```js
const relPath = req.query.path || '';
const systemPath = tryGetSystemFilePath(relPath);
if (systemPath) {
  const vaultHas = await fileExists(target);
  if (!vaultHas) {
    const stats = await fsp.stat(systemPath);
    return res.json(serializeStats(stats));
  }
}
```

Place this before the existing `fsp.stat(target)` call.

**C3 — Readdir handler (lines 173-203):**

After the existing readdir succeeds and you have `result`:

```js
// If listing the plugins directory, include system plugin dir entries.
const relPath = req.query.path || '';
if (relPath === '.obsidian/plugins' || relPath === '.obsidian/plugins/') {
  for (const id of getSystemPluginIds()) {
    if (!result.find(e => e.name === id)) {
      result.push({
        name: id,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        stats: null,  // optional; the client will stat individually if needed
      });
    }
  }
}
```

Also handle the case where the plugins dir doesn't exist in the vault
at all (Obsidian creates it lazily). In that case, `fsp.readdir(target)`
throws ENOENT. Before letting it bubble through `handleError`, check if
the path is `.obsidian/plugins` and we have system plugins — if so,
return a synthetic listing:

```js
} catch (err) {
  if ((err.code === 'ENOENT' || err.code === 'ENOTDIR')
      && (relPath === '.obsidian/plugins' || relPath === '.obsidian/plugins/')
      && getSystemPluginIds().length > 0) {
    return res.json(getSystemPluginIds().map(id => ({
      name: id,
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
      stats: null,
    })));
  }
  handleError(res, err);
}
```

Apply the same readdir-from-repo when listing inside a system plugin dir:

```js
// Inside a system plugin dir? List from the repo.
const ssp = relPath.match(/^\.obsidian\/plugins\/([^/]+)\/?$/);
if (ssp && getSystemPluginIds().includes(ssp[1])) {
  // If vault has its own files there, they take precedence (merge).
  // For simplicity v1: if vault dir exists, list it; otherwise list repo.
  const vaultEntries = await safeReaddir(target);  // returns [] on ENOENT
  if (vaultEntries.length > 0) {
    // Use vault listing as primary; supplement with repo files not overridden.
    // ... (or just use vault listing; user opted in to override entire dir)
  } else {
    const repoDir = path.join(SYSTEM_PLUGINS_DIR, ssp[1]);
    const entries = await fsp.readdir(repoDir, { withFileTypes: true });
    const result = await Promise.all(entries.map(async (entry) => {
      const child = path.join(repoDir, entry.name);
      const s = await fsp.stat(child);
      return {
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymbolicLink: entry.isSymbolicLink(),
        stats: serializeStats(s),
      };
    }));
    return res.json(result);
  }
}
```

**C4 — Write handler (lines 234-258):**

For `community-plugins.json`, strip system ids before writing:

```js
if (relPath === '.obsidian/community-plugins.json' && encoding) {
  try {
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      const cleaned = stripCommunityList(parsed);
      data = JSON.stringify(cleaned, null, 2);
    }
  } catch (_) { /* malformed JSON: pass through as-is */ }
}
```

Place after `data = encoding ? req.body.toString(encoding) : req.body;` and before the `mkdir + writeFile`.

**C5 — Initialize on server startup:**

In `server/index.js` (the `startServer` function), call `require('./system-plugins').init()` BEFORE the server starts listening. Log output is informative.

## Implementation steps

### Step 1 — Create the plugin files

```
mkdir -p plugins/obsidian-web-layout
# Write manifest.json (see Component A)
# Write main.js (see Component A)
```

Verify: `node -e "JSON.parse(require('fs').readFileSync('plugins/obsidian-web-layout/manifest.json', 'utf8'))"` succeeds.

### Step 2 — Create `server/system-plugins.js`

Implement the module exactly as specified in Component B. Include a
short JSDoc-style header explaining what it does and its relationship
to `server/api/fs.js`.

### Step 3 — Wire into `server/api/fs.js`

Add changes C1, C2, C3, C4 from Component C. Be careful:

- Do **not** rewrite the file; insert minimal changes.
- The `fileExists()` helper goes at the top of the file (module scope).
- The `tryGetSystemFilePath`, `getSystemPluginIds`, `mergeCommunityList`, `stripCommunityList` are imported once at the top: `const { tryGetSystemFilePath, getSystemPluginIds, mergeCommunityList, stripCommunityList } = require('../system-plugins');`

### Step 4 — Initialize on server startup

In `server/index.js`, add a single `require('./system-plugins').init()` call inside `startServer()` (before the `server.listen()` call).

### Step 5 — Test the overlay

Restart the server. Then:

```bash
# Should return the manifest from repo, even though it's not in the vault:
curl -s "http://localhost:3000/api/fs/read?vault=5b68fb93d875ad63&path=.obsidian/plugins/obsidian-web-layout/manifest.json&encoding=utf8" | jq .

# Should return main.js (large output, just check status):
curl -sI "http://localhost:3000/api/fs/read?vault=5b68fb93d875ad63&path=.obsidian/plugins/obsidian-web-layout/main.js&encoding=utf8" | head -1
# → HTTP/1.1 200 OK

# stat should succeed:
curl -s "http://localhost:3000/api/fs/stat?vault=5b68fb93d875ad63&path=.obsidian/plugins/obsidian-web-layout" | jq .
# → { isFile: false, isDirectory: true, ... }

# readdir of .obsidian/plugins should include obsidian-web-layout:
curl -s "http://localhost:3000/api/fs/readdir?vault=5b68fb93d875ad63&path=.obsidian/plugins" | jq '.[] | .name'

# community-plugins.json should have our id (even if the file didn't exist):
curl -s "http://localhost:3000/api/fs/read?vault=5b68fb93d875ad63&path=.obsidian/community-plugins.json&encoding=utf8" | jq .
# → [..., "obsidian-web-layout"]
```

All five should pass. If any fail, fix before continuing.

### Step 6 — Test in the browser

Use the gui-host browser. **Port 9224 with `--user-data-dir=/tmp/pw-obsidian-mobile`**
is shared between you and any previous agent — that's fine, but other
agents are on 9222 and 9223 — do not touch those.

Use session name `obsmobile` (the previous agent established it). If
session is gone, attach a new one targeting port 9224:

```bash
PW="export PATH=\"~/.local/share/fnm/node-versions/v25.9.0/installation/bin:\$PATH\" && cd ~/Documents/playwright-cli"
ssh gui-host "$PW && playwright-cli list"
# verify obsmobile is on http://localhost:9224. If not, attach it:
ssh gui-host "$PW && playwright-cli --s=obsmobile attach --cdp http://localhost:9224"
```

(If Chrome is closed entirely, restart with `pw-clean.sh --port=9224 --user-data-dir=/tmp/pw-obsidian-mobile`.)

Then:

```bash
ssh gui-host "$PW && playwright-cli --s=obsmobile goto 'http://localhost:3000/mobile?vault=5b68fb93d875ad63'"
```

Wait for workspace, then check the plugin loaded:

```js
async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 30; i++) {
    if (document.querySelector('.workspace')) break;
    await wait(1000);
  }
  await wait(2000);  // give the plugin time to load
  return JSON.stringify({
    workspaceReady: !!document.querySelector('.workspace'),
    pluginsList: Object.keys(window.app?.plugins?.plugins || {}),
    ourPluginLoaded: !!window.app?.plugins?.plugins?.['obsidian-web-layout'],
    ribbonIcon: !!document.querySelector('.side-dock-ribbon [aria-label*="Layout"]'),
    // What's the current layout mode?
    layoutMode: localStorage.getItem('obsidian-web:layout-mode') || 'auto',
    platOverride: window.__owPlatformOverrides,
  }, null, 2);
}
```

Expected:
- `workspaceReady: true`
- `ourPluginLoaded: true`
- `pluginsList` includes `"obsidian-web-layout"`
- `ribbonIcon: true`

If the plugin doesn't load, check `window.app.plugins.manifests` to see
if Obsidian discovered the manifest at all. If not, the readdir/read
overlay isn't working. If yes but `plugins[id]` is missing, the plugin
errored on load — check console.

Take a screenshot showing the ribbon icon.

### Step 7 — Test mode switching from the plugin

```bash
# Click the ribbon icon via the menu, then "Mobile layout":
ssh gui-host "$PW && playwright-cli --s=obsmobile eval --raw 'async () => {
  // Get the plugin instance and call setMode directly
  // (clicking via DOM is fragile; this is the equivalent end-effect test)
  const plugin = window.app.plugins.plugins[\"obsidian-web-layout\"];
  if (!plugin) return \"plugin not loaded\";

  // Don't actually call setMode (it reloads). Just verify the API works.
  return JSON.stringify({
    pluginExists: true,
    getMode: localStorage.getItem(\"obsidian-web:layout-mode\") || \"auto\",
    commands: Object.keys(window.app.commands.commands)
      .filter(c => c.startsWith(\"obsidian-web-layout:\")),
  }, null, 2);
}'"
```

Expected: `commands` array contains three entries
(`obsidian-web-layout:set-layout-auto`, `…:set-layout-mobile`,
`…:set-layout-desktop`).

Then test that an actual mode change works:

```bash
# Set to mobile via localStorage (simulates clicking "Mobile layout"):
ssh gui-host "$PW && playwright-cli --s=obsmobile eval --raw '() => {
  localStorage.setItem(\"obsidian-web:layout-mode\", \"mobile\");
  return \"set\";
}'"
ssh gui-host "$PW && playwright-cli --s=obsmobile goto 'http://localhost:3000/mobile?vault=5b68fb93d875ad63'"
# Wait for workspace and check is-mobile is on body:
ssh gui-host "$PW && playwright-cli --s=obsmobile eval --raw 'async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 20; i++) { if (document.querySelector(\".workspace\")) break; await wait(1000); }
  return JSON.stringify({
    bodyHasIsMobile: document.body.classList.contains(\"is-mobile\"),
    platIsMobile: window.__owPlatform?.isMobile,
  });
}'"
# Expected: bodyHasIsMobile=true, platIsMobile=true

# Reset to auto:
ssh gui-host "$PW && playwright-cli --s=obsmobile eval --raw '() => { localStorage.removeItem(\"obsidian-web:layout-mode\"); return \"reset\"; }'"
```

### Step 8 — Test write isolation

Verify that `community-plugins.json` doesn't get polluted with our
plugin id when Obsidian writes it back:

```bash
# First trigger a write (e.g. enable a different plugin in Obsidian UI,
# or just simulate by sending a write request):
curl -X PUT -H "Content-Type: text/plain; charset=UTF-8" \
  --data-raw '["dataview","obsidian-web-layout"]' \
  "http://localhost:3000/api/fs/write?vault=5b68fb93d875ad63&path=.obsidian/community-plugins.json&encoding=utf8"

# Now check what's actually on disk:
cat ~/projects/obsidian-web/test-vault/.obsidian/community-plugins.json
# Expected: ["dataview"] — our id stripped

# And reading via API gets it back:
curl -s "http://localhost:3000/api/fs/read?vault=5b68fb93d875ad63&path=.obsidian/community-plugins.json&encoding=utf8"
# Expected: includes obsidian-web-layout

# Cleanup:
rm ~/projects/obsidian-web/test-vault/.obsidian/community-plugins.json 2>/dev/null
```

### Step 9 — Document the changes

Update three docs (concise — 1-2 paragraphs each):

1. **`docs/walkthrough.md`** — new dated entry: "System plugin injection + Layout Switcher plugin"
2. **`docs/investigations.md`** — add brief section under existing
   "Obsidian internals" about `community-plugins.json` mechanism and
   how our overlay works
3. **`PLAN.md`** — note that the layout plugin exists and is auto-injected

## Out of scope

- Live mode switching without reload (explicit non-goal — see prior conversation)
- Settings tab in the plugin (the ribbon menu is enough for v1)
- Multiple system plugins (the infrastructure supports it via the Set, but only one plugin is delivered now)
- Bootstrap cache integration (mobile bundle doesn't use it for FS reads; desktop bundle does but the overlay at FS-level is enough — adding to bootstrap is a future perf optimization)
- Plugin "disabling" — if user disables our plugin in Obsidian UI, the disable does NOT persist (we re-inject on next reload). v2 can track this via server-side state if requested.

## Pitfalls

1. **Path traversal in `tryGetSystemFilePath`.** A malicious path like
   `.obsidian/plugins/obsidian-web-layout/../../../etc/passwd` must not
   escape `SYSTEM_PLUGINS_DIR`. Use `path.resolve` + `startsWith`
   verification (same pattern as `resolveSafe` in fs.js).

2. **`fileExists` is async.** Don't forget `await`.

3. **The `relPath` variable name** is declared twice if you're not
   careful in `fs.js`. Read the file carefully; in `/read` handler the
   existing code uses `req.query.path` directly without naming it. Add
   `const relPath = req.query.path || '';` once at the top of each
   handler.

4. **`isSystemPluginPath` vs `tryGetSystemFilePath`.** The former
   returns boolean, the latter returns absolute path or null. Use the
   latter in the FS handlers — it does the resolution and security
   check.

5. **`community-plugins.json` encoding.** Obsidian writes it as UTF-8
   text. Our write handler receives it as `req.body.toString('utf8')`.
   The strip/merge logic operates on parsed JSON. If parsing fails,
   pass through untouched (don't break the vault on malformed data).

6. **The plugin's `require('obsidian')`** is resolved by Obsidian's
   plugin runtime, NOT by `window.require`. Do not add `obsidian` to
   the modules table in `client-mobile/boot.js`.

7. **Capacitor FS calls strip the vault-ID prefix.** Look at
   `client-mobile/shims/capacitor-shim.js`'s `fullPath()` —
   `<vaultId>/<rel>` becomes just `<rel>` before the HTTP call. So when
   the plugin asks for `.obsidian/plugins/obsidian-web-layout/main.js`,
   the server actually sees that exact path in `req.query.path`. Good
   — but verify in network tab if anything looks weird.

8. **Do not place files inside the vault.** No `test-vault/.obsidian/plugins/obsidian-web-layout/`. The whole point is that the plugin is injected by the server.

9. **The plugin in `plugins/` is NOT gitignored.** It IS part of the repo. Verify `.gitignore` doesn't accidentally exclude it (currently it shouldn't — `.gitignore` excludes `obsidian/`, `obsidian-mobile/`, `node_modules/`, etc. but not `plugins/`).

## Acceptance criteria

The plan is complete when **all** of the following are true:

- [ ] `plugins/obsidian-web-layout/{manifest.json,main.js}` exist and parse correctly
- [ ] `server/system-plugins.js` exists with the documented API
- [ ] `server/api/fs.js` is modified for overlay (read, stat, readdir, write); existing behavior unchanged when path is not a system plugin
- [ ] `server/index.js` calls `init()` on startup; log shows "Loaded 1 system plugins: obsidian-web-layout"
- [ ] All five curl tests in Step 5 pass
- [ ] Browser test in Step 6 returns `ourPluginLoaded: true` and `ribbonIcon: true`
- [ ] Commands test in Step 7 shows three commands registered
- [ ] Mode switch test in Step 7 shows `bodyHasIsMobile=true` after switching to mobile
- [ ] Step 8 write isolation test shows `obsidian-web-layout` NOT in the vault file
- [ ] Screenshot of the ribbon icon exists and is verified visually
- [ ] Three docs updated
- [ ] No commits made (leave for user)

## Reference: existing code locations

- `server/api/fs.js` lines 156-170 — `/stat` handler
- `server/api/fs.js` lines 173-203 — `/readdir` handler
- `server/api/fs.js` lines 206-230 — `/read` handler
- `server/api/fs.js` lines 234-258 — `/write` handler
- `server/index.js` — look for `function startServer` (around line 125 in the version I last saw)
- `client-mobile/shims/capacitor-shim.js` `fullPath()` — strips vault ID prefix from paths

## Test vault details

- Vault id: `5b68fb93d875ad63`
- Vault path: `~/projects/obsidian-web/test-vault`
- Server: `http://localhost:3000` (already running in a background process; restart after server-code changes)
- Mobile entry point: `/mobile?vault=5b68fb93d875ad63`
