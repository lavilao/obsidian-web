# Mobile bundle + Desktop layout — Implementation Plan

> Created: 2026-05-11
>
> Target audience: implementing agent (sub-agent). This document is
> self-contained — read top to bottom, then execute.

## Context

`obsidian-web` is a wrapper that runs Obsidian's renderer in a normal
browser by replacing Electron dependencies with HTTP shims. It currently
runs the **desktop bundle** (`obsidian/app.js`) with electron-style FS
shims.

We are adding a **second runtime** that uses the **mobile bundle**
(`obsidian-mobile/app.js`) so we get:

- `CapacitorAdapter` instead of `FileSystemAdapter` — cleaner async API,
  no sync XHR, no Node FS dependencies
- Plugin compatibility — `Platform.isMobile=true` means plugins use the
  mobile code paths and skip Node-only features

But we want the **desktop UI layout** (split panes, ribbon, persistent
sidebar) when the user is on a desktop viewport. The mobile bundle
unconditionally sets `bn.isMobile=true` and adds `is-mobile` to body,
which forces the mobile UI.

## What already exists (do not redo)

These were built in the conversation that produced this plan:

| File | Status |
|---|---|
| `scripts/update-obsidian-mobile.js` | Downloads APK and extracts `obsidian-mobile/`. Works. |
| `obsidian-mobile/` | Extracted mobile bundle (app.js, native-bridge.js, lib/, etc.) |
| `client-mobile/index.html` | Loads capacitor-shim → native-bridge → boot.js |
| `client-mobile/boot.js` | Vault selection, `window.require` for plugins, **post-init UI cleanup via MutationObserver** (the cleanup is what we are replacing in this plan) |
| `client-mobile/shims/capacitor-shim.js` | Implements Filesystem/App/Device/etc. plugins over HTTP. Includes `PluginHeaders` array so `registerPlugin` resolves methods correctly. |
| `server/index.js` route `/mobile` | Serves `client-mobile/index.html` |
| `server/index.js` route `/obsidian-mobile/*` | Serves extracted bundle |
| `server/index.js` route `/client-mobile/*` | Serves client files |

**Verified working in the previous conversation:**

- Mobile bundle loads end-to-end (all 14 scripts)
- `window.app` is created, `vault.adapter` is `CapacitorAdapter` (not `FileSystemAdapter`)
- Capacitor `getPlatform()` returns `'android'`, `isNativePlatform()` is `true`
- FS operations go through the HTTP API
- Body class on desktop viewport: `is-tablet` (correct), but layout is still mobile-styled because `is-floating-nav` and `auto-full-screen` get added based on `app.isMobile=true`

## Goal of this plan

Move the layout decision from **post-init runtime patches** (the current
`boot.js` MutationObserver hack) to **build-time bundle patches**
(applied by `update-obsidian-mobile.js` when it extracts the bundle).

This gives:

1. The correct Platform flags are set **before** any Obsidian code runs
2. No flicker, no race conditions, no observers
3. Centralized control via a global `window.__owPlatformOverrides` object
4. Plugins can override at runtime if needed

## The 3 build-time patches

Apply these to `obsidian-mobile/app.js` after extraction, before it is
written to disk.

### Patch 1 — Expose Platform object as a global

The Platform object is created at module-level with all flags false:

```js
var bn = {isDesktop:!1,isMobile:!1,isDesktopApp:!1,isMobileApp:!1,
          isIosApp:!1,isAndroidApp:!1,isPhone:!1,isTablet:!1, ... }
```

`bn` is a local var inside the bundle's IIFE — not reachable from outside.
We expose it as `window.__owPlatform` so plugins and our boot code can
read/write it.

**Regex (verified to match exactly once in v1.12.7):**

```js
const PATCH_1 = {
  name: 'expose-platform',
  find:    /var (\w{1,3})=\{isDesktop:!1,isMobile:!1,isDesktopApp:!1/,
  replace: 'var $1=window.__owPlatform={isDesktop:!1,isMobile:!1,isDesktopApp:!1',
  expectedMatches: 1,
};
```

After patch:
```js
var bn = window.__owPlatform = {isDesktop:!1,isMobile:!1, ... }
```

### Patch 2 — Make the IIFE platform-flag assignments respect overrides

The entry IIFE (at the bottom of app.js) unconditionally sets the flags:

```js
bn.isMobileApp=!0,bn.isMobile=!0,bn.isAndroidApp=Dv,bn.isIosApp=Tv,
```

We replace with `Object.assign` where `__owPlatformOverrides` is applied
**last** (so it wins).

**Regex (verified to match exactly once):**

```js
const PATCH_2 = {
  name: 'iife-overrides',
  find:    /(\w+)\.isMobileApp=!0,\1\.isMobile=!0,\1\.isAndroidApp=(\w+),\1\.isIosApp=(\w+),/,
  replace: 'Object.assign($1,{isMobileApp:!0,isMobile:!0,isAndroidApp:$2,isIosApp:$3},window.__owPlatformOverrides||{}),',
  expectedMatches: 1,
};
```

The `\1` backreference ensures the same minified variable name is used
for all four assignments (defensive against future minifier changes).

After patch:
```js
Object.assign(bn,{isMobileApp:!0,isMobile:!0,isAndroidApp:Dv,isIosApp:Tv},
              window.__owPlatformOverrides||{}),
```

If `__owPlatformOverrides.isMobile === false`, then `bn.isMobile` ends
up `false` despite the default.

### Patch 3 — Make `is-mobile` body class conditional

The IIFE unconditionally adds the class after the flag assignment:

```js
document.body.addClass("is-mobile"),
```

We gate it on the **post-override** value:

```js
const PATCH_3 = {
  name: 'is-mobile-class',
  find:    /document\.body\.addClass\("is-mobile"\),/,
  replace: 'window.__owPlatform.isMobile&&document.body.addClass("is-mobile"),',
  expectedMatches: 1,
};
```

If overrides set `isMobile=false`, the class never gets added → 170
mobile CSS rules don't apply → desktop styling wins.

## Implementation steps

### Step 1 — Create the patch module

Create a NEW file: `scripts/patch-obsidian-mobile.js`

This is a standalone module that owns the patch definitions and applies
them to a given `app.js` path. It is both:

- **Importable**: `const { applyPatches, PATCHES } = require('./patch-obsidian-mobile');`
- **CLI-runnable**: `node scripts/patch-obsidian-mobile.js <path-to-app.js>`

Why separate? So we can re-run patches without re-downloading the 15MB
APK, debug regexes against an extracted bundle, and isolate the patch
logic for testing.

**Full structure:**

```js
#!/usr/bin/env node
'use strict';

const fsp = require('fs/promises');
const path = require('path');

const PATCHES = [
  {
    name: 'expose-platform',
    find:    /var (\w{1,3})=\{isDesktop:!1,isMobile:!1,isDesktopApp:!1/,
    replace: 'var $1=window.__owPlatform={isDesktop:!1,isMobile:!1,isDesktopApp:!1',
    expectedMatches: 1,
  },
  {
    name: 'iife-overrides',
    find:    /(\w+)\.isMobileApp=!0,\1\.isMobile=!0,\1\.isAndroidApp=(\w+),\1\.isIosApp=(\w+),/,
    replace: 'Object.assign($1,{isMobileApp:!0,isMobile:!0,isAndroidApp:$2,isIosApp:$3},window.__owPlatformOverrides||{}),',
    expectedMatches: 1,
  },
  {
    name: 'is-mobile-class',
    find:    /document\.body\.addClass\("is-mobile"\),/,
    replace: 'window.__owPlatform.isMobile&&document.body.addClass("is-mobile"),',
    expectedMatches: 1,
  },
];

async function applyPatches(appJsPath) {
  let content = await fsp.readFile(appJsPath, 'utf8');

  for (const patch of PATCHES) {
    // Count matches using a global flag (cloned from the non-global regex).
    const globalRegex = new RegExp(patch.find.source, 'g');
    const matches = content.match(globalRegex) || [];

    if (matches.length !== patch.expectedMatches) {
      throw new Error(
        `Patch "${patch.name}" expected ${patch.expectedMatches} match(es), ` +
        `found ${matches.length}. The minifier may have changed the bundle ` +
        `layout. Update the regex in scripts/patch-obsidian-mobile.js.`
      );
    }

    content = content.replace(patch.find, patch.replace);
    console.log(`  patched: ${patch.name} (${matches.length}x)`);
  }

  await fsp.writeFile(appJsPath, content, 'utf8');
}

module.exports = { applyPatches, PATCHES };

// CLI mode
if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node scripts/patch-obsidian-mobile.js <path-to-app.js>');
    process.exit(1);
  }
  applyPatches(path.resolve(target))
    .then(() => console.log('Done.'))
    .catch(err => { console.error('Error:', err.message); process.exit(1); });
}
```

### Step 2 — Wire it into the update script

File: `scripts/update-obsidian-mobile.js`

Import the patch module and call it after `extractApk(...)` and before
`verifyRequired(...)`.

```js
const { applyPatches } = require('./patch-obsidian-mobile');

// ...inside main() after extractApk(...) and before verifyRequired(...):
console.log('Applying patches…');
await applyPatches(path.join(targetDir, 'app.js'));
```

**Output expectation when run:**

```
…
  i18n/                     (directory)
  lib/                      (directory)
Applying patches…
  patched: expose-platform (1x)
  patched: iife-overrides (1x)
  patched: is-mobile-class (1x)

Done. obsidian-mobile/ is ready (Obsidian 1.12.7).
```

### Step 3 — Inject platform overrides in boot.js

File: `client-mobile/boot.js`

**Location:** Add this **before** the script-injection block. It must
run before the dynamically-injected `obsidian-mobile/app.js` executes,
which means before the `fetch('/api/fs/stat?...')` resolves and starts
injecting `MOBILE_SCRIPTS`.

The simplest place: right after the early-return guards (after `if (!VAULT_ID && ...)`)
and before the `modules` declaration.

```js
// ── Platform overrides — applied BEFORE app.js loads ──────────────────
// The bundle has been patched (see scripts/update-obsidian-mobile.js,
// patches 1-3) so its IIFE merges this object into the Platform flags
// with Object.assign, AFTER its defaults. Whatever we set here wins.
//
// Layout mode persists in localStorage. Read by computeLayoutMode().
function computeLayoutMode() {
  const pref = localStorage.getItem('obsidian-web:layout-mode') || 'auto';
  if (pref === 'mobile')  return { isMobile: true,  reason: 'user-pref-mobile' };
  if (pref === 'desktop') return { isMobile: false, reason: 'user-pref-desktop' };
  // 'auto' — viewport-based decision
  const small = window.innerWidth < 900 || window.innerHeight < 600;
  return { isMobile: small, reason: 'auto-' + (small ? 'mobile' : 'desktop') };
}
const layout = computeLayoutMode();
window.__owPlatformOverrides = { isMobile: layout.isMobile };
console.log('[obsidian-web] platform overrides:', layout);
```

**Remove the now-obsolete MutationObserver cleanup block** in the same
file (the one that calls `app.mobileToolbar?.unload()` etc.). It is
replaced by the build-time patches.

### Step 4 — Verify in browser

Restart the server and load `/mobile?vault=<id>` in the gui-host browser
(use port 9224 with `--user-data-dir=/tmp/pw-obsidian-mobile`, do not
disturb other agent sessions on ports 9222/9223).

**Verification eval (run via playwright-cli `--s=default eval --raw`):**

```js
async () => {
  // wait for workspace
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 30; i++) {
    if (document.querySelector('.workspace')) break;
    await wait(1000);
  }

  return JSON.stringify({
    // patches active?
    platformGlobal: !!window.__owPlatform,
    overrides:      window.__owPlatformOverrides,

    // post-init platform state
    plat_isMobile:    window.__owPlatform?.isMobile,
    plat_isMobileApp: window.__owPlatform?.isMobileApp,  // must still be true!
    plat_isPhone:     window.__owPlatform?.isPhone,
    plat_isTablet:    window.__owPlatform?.isTablet,

    // app uses same value (App captures bn.isMobile at construction)
    app_isMobile: window.app?.isMobile,

    // UI state
    bodyHasIsMobile:    document.body.classList.contains('is-mobile'),
    bodyHasIsFloating:  document.body.classList.contains('is-floating-nav'),
    workspaceExists:    !!document.querySelector('.workspace'),

    // adapter must still be Capacitor (not FileSystemAdapter)
    adapterMethods: Object.getOwnPropertyNames(
      Object.getPrototypeOf(window.app?.vault?.adapter || {})
    ).filter(m => m === 'watchAndStatAll' || m === 'quickList'),
  }, null, 2);
}
```

**Expected results on desktop viewport (≥900px wide):**

| field | expected |
|---|---|
| `platformGlobal` | `true` |
| `overrides.isMobile` | `false` |
| `plat_isMobile` | `false` |
| `plat_isMobileApp` | `true` |
| `plat_isPhone` | `false` |
| `plat_isTablet` | `true` |
| `app_isMobile` | `false` |
| `bodyHasIsMobile` | `false` |
| `workspaceExists` | `true` |
| `adapterMethods` | `['watchAndStatAll', 'quickList']` (Capacitor adapter still active) |

**Take a screenshot** and confirm visually that the layout is desktop
(persistent left sidebar, ribbon visible, no mobile toolbar at the
bottom).

### Step 5 — Test the manual override path

In DevTools / via eval, simulate switching to mobile mode:

```js
localStorage.setItem('obsidian-web:layout-mode', 'mobile');
location.reload();
```

After reload, verify `plat_isMobile=true`, `bodyHasIsMobile=true`,
mobile toolbar visible.

Then switch to desktop explicitly:

```js
localStorage.setItem('obsidian-web:layout-mode', 'desktop');
location.reload();
```

Verify it stays desktop **even on a small viewport** (resize browser to
600px before reload to test).

### Step 6 — Document the changes

Update three docs:

1. **`docs/walkthrough.md`** — Add a new dated section:
   - Title: "Mobile bundle with desktop layout — build-time patches"
   - What was done (3 regex patches, override mechanism, removed runtime cleanup)
   - Verification results

2. **`docs/investigations.md`** — In the existing section
   "כיוון עתידי: obsidian-web-mobile — Capacitor approach", add a subsection:
   - "Build-time patch approach (implemented)"
   - List the 3 patches with their regex and what they achieve
   - Move "כיוון עתידי" → "כיוון מיושם" if appropriate

3. **`PLAN.md`** — Update the mobile section status.

## Out of scope for this plan

These are intentionally **not** in this plan and should not be done now:

- **The layout plugin** — separate plan. We have the global hook
  (`window.__owPlatform`) and the localStorage key
  (`obsidian-web:layout-mode`) ready for it.
- **Virtual plugin overlay** (loading plugins from `plugins/` in repo
  without putting them in the vault) — separate plan.
- **Mode switching without reload** — the override is read once at boot.
  Live mode switching can be added later via the plugin; for this plan,
  reload-based switching is fine.

## Common pitfalls (read before starting)

1. **Do not modify `isMobileApp`.** Keep the default `!0` (true). It
   selects the Capacitor adapter. Setting it false would silently switch
   to `FileSystemAdapter` (Node FS), defeating the whole point.

2. **The minified var name changes between builds.** Patch 1 captures
   it (`\w{1,3}`), patches 2-3 use the global `window.__owPlatform`
   reference (which is what Patch 1 creates). Patch 2 uses a backreference
   `\1` to ensure consistency within the IIFE assignment. Do **not**
   hard-code `bn`.

3. **Verify match counts.** If Obsidian updates the bundle and a regex
   no longer matches exactly once, `patchAppJs()` must throw. Silent
   failures here produce subtly broken bundles that are hard to debug.

4. **Patch order matters.** Patch 1 must run first (it creates
   `window.__owPlatform`). Patches 2 and 3 reference it.

5. **The `Object.assign` in Patch 2 puts overrides LAST.** This is
   intentional — they win over the defaults. If you swap the order,
   the overrides will be silently ignored.

6. **`is-mobile` is not the only mobile-related class.** Also check
   `is-android`, `is-ios`. They are already conditional on `Dv`/`Tv`
   in the original bundle, which are false when `isNativePlatform()`
   is web/false. Do not patch them.

7. **The MutationObserver cleanup in `client-mobile/boot.js` must be
   removed.** Leaving both the build-time patches AND the runtime
   cleanup is harmless but confusing — there is only one source of
   truth for the layout decision.

8. **Use port 9224 in gui-host** with `--user-data-dir=/tmp/pw-obsidian-mobile`.
   Ports 9222/9223 are used by other agents.

## Acceptance criteria

The plan is complete when **all** of the following are true:

- [ ] `scripts/update-obsidian-mobile.js` applies all 3 patches and
      throws on unexpected match counts
- [ ] Re-running the script produces an `obsidian-mobile/app.js` with
      `window.__owPlatform` exposed, `Object.assign` merging overrides,
      and conditional `is-mobile` class
- [ ] `client-mobile/boot.js` sets `window.__owPlatformOverrides` based
      on localStorage + viewport, and the post-init MutationObserver
      cleanup is removed
- [ ] Default load on a desktop viewport produces all the
      verification-eval expected results above
- [ ] `localStorage.setItem('obsidian-web:layout-mode', 'mobile')` +
      reload produces mobile UI even on a desktop viewport
- [ ] `localStorage.setItem('obsidian-web:layout-mode', 'desktop')` +
      reload produces desktop UI even on a small viewport
- [ ] CapacitorAdapter remains active in all three modes (verified via
      `adapterMethods` containing `watchAndStatAll`)
- [ ] The three docs above are updated

## Reference: known file/line locations

In `obsidian-mobile/app.js` (v1.12.7, 3,754,511 bytes):

| Item | Approx. offset |
|---|---|
| Platform object definition (`var bn = {...}`) | ~294,354 |
| `xv = window.Capacitor && "web" !== getPlatform()` | ~714,200 |
| Entry IIFE `Promise.all([fv, Av.getInfo, Nv.getInfo])` | ~3,727,441 |
| Unconditional flag assignment `bn.isMobileApp=!0,...` | ~3,728,028 |
| `document.body.addClass("is-mobile")` | within IIFE, just after flag assignment |

These offsets will drift between versions. The regex patterns are the
source of truth — do not rely on offsets.
