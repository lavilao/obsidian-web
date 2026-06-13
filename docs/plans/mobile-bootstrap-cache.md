# Mobile bootstrap cache — Implementation Plan

> Created: 2026-05-12
>
> Target audience: implementing agent (sub-agent). Read top to bottom,
> then execute. Acceptance criteria at the end define when you're done.

## Context

The desktop runtime (`/`) loads `/api/bootstrap?full=1` at boot, populates
`window.__owBootstrapCache`, and `client/shims/original-fs.js` answers
`statSync` / `readFileSync` from that cache **synchronously** — saving
50–100+ sync XHR round-trips at startup. With cache HIT, cold boot of a
medium vault is 1–2 seconds; without it, it would be 10+ seconds.

The mobile runtime (`/mobile`) does **not** use the bootstrap for FS reads.
It calls `/api/bootstrap?full=1` **once** in `Filesystem.watchAndStatAll`
(`src/client-mobile/shims/capacitor-shim.js:358`), but only consumes the
`dirs` portion to return a flat file list. The `fs` (content) and `electron`
portions are thrown away. Every subsequent `Filesystem.readFile`/`stat`/
`readdir` makes a separate HTTP round-trip — same data is fetched twice,
once during bootstrap and again per-call.

**Result:** mobile cold boot on a 394-file vault takes ~5–8 seconds
because Obsidian fires ~150 sequential `stat`/`readFile` calls on
`.obsidian/*.json` and recent notes, each costing ~20ms round-trip.

**Goal:** make mobile use the bootstrap cache the same way desktop does,
saving the round-trips. Add server-side knobs for the deployer to:
- Disable bootstrap entirely (some deployments may want to skip the
  large precompute)
- Cap the per-file size (skip individual large files from the response)
- Cap the total response size (safety net — no 200MB payloads)

## Dependencies

None. This is purely an additive performance improvement. Both LiveSync
plan (`livesync-implementation.md`) and Local-Vaults plan
(`local-vaults-implementation.md`) are independent.

If LiveSync ships first, the bootstrap cache helps it too — LiveSync's
initial vault scan goes through the same `Filesystem` plugin.

## What already exists (do not redo)

| Component | Status |
|---|---|
| `/api/bootstrap?full=1` endpoint | ✅ done (`src/server/api/bootstrap.js`) |
| Server-side mtime cache + brotli/gzip pre-compression | ✅ done |
| Per-file `MAX_CONTENT_BYTES = 500KB` cap | ✅ done (hardcoded) — will become env-var |
| `watchAndStatAll` fetches bootstrap | ✅ done — will be repurposed to populate the cache |
| Desktop bootstrap consumption pattern | ✅ done (`src/client/shims/original-fs.js`, `src/client/shims/electron.js`) — reference for mobile |

## High-level architecture

```
              src/client-mobile/boot.js
                       │
                       ├── (parallel) fetch /api/bootstrap?full=1
                       │              ↓
                       │              window.__owBootstrapCache = { fs, dirs, electron, capped?, disabled? }
                       │
                       └── inject scripts (existing flow)
                                ↓
                            obsidian-mobile/app.js runs
                                ↓
                            Filesystem.readFile(p)
                                ↓
                          ┌─────────────────────────┐
                          │ if __owBootstrapCache && │
                          │    cache.fs[p].content   │
                          │    → return immediately  │
                          │ else                     │
                          │    → fetch /api/fs/read  │
                          └─────────────────────────┘
                                ↓
                       writeFile → invalidate cache entry
                       watch event → invalidate cache entry
```

## Configuration knobs

Add to `src/server/config.js`:

```js
module.exports = {
  // ... existing
  bootstrap: {
    // Master switch. When false, /api/bootstrap returns { disabled: true }
    // immediately without scanning the vault. Use case: minimal deployment,
    // single-user setup where the round-trip-saving isn't worth the precompute.
    enabled: process.env.BOOTSTRAP_DISABLED !== 'true',

    // Per-file size cap (KB). Files larger than this get stat-only in the
    // response — content is fetched on demand. Default 500 (matches current
    // hardcoded MAX_CONTENT_BYTES).
    maxFileKB: parseInt(process.env.BOOTSTRAP_MAX_FILE_KB || '500', 10),

    // Total response size cap (MB) on the UNCOMPRESSED JSON. When the
    // accumulated file content would exceed this, the server stops adding
    // content but still returns dirs+electron. Marks response with
    // { capped: true }. Default 50 MB. Compressed response is ~85% smaller,
    // so 50MB raw ≈ 7.5MB on the wire.
    maxTotalMB: parseInt(process.env.BOOTSTRAP_MAX_TOTAL_MB || '50', 10),
  },
};
```

**Deployer experience:**

```bash
# Disable bootstrap entirely:
BOOTSTRAP_DISABLED=true node src/server/index.js

# Lower per-file cap to 100KB (skip larger notes from cache):
BOOTSTRAP_MAX_FILE_KB=100 node src/server/index.js

# Cap total response at 20MB raw (helpful on tight bandwidth):
BOOTSTRAP_MAX_TOTAL_MB=20 node src/server/index.js
```

Document these in `README.md` under Configuration.

## Implementation phases

### TDD strategy (read before any Phase)

Most of this work is amenable to test-driven development. The codebase
already has `node:test`-based integration tests under
`src/server/test/`. We extend that pattern and add a small unit-test
file for client-side pure-function helpers.

**Vertical slices.** For each behavior listed below, the cycle is:
RED (write one failing test) → GREEN (minimal code to pass) → next.
**Do NOT write all tests for a phase before writing any implementation.**

| Phase | What to TDD | What stays manual |
|---|---|---|
| Phase 1 (server) | All 5 behaviors (disable, file-cap, total-cap, electron extract, warmup bail-out) via `bootstrap-cache.test.js` extensions. | None — fully testable. |
| Phase 2 (client cache lookup) | A new pure helper `src/client-mobile/bootstrap-lookup.js` with `lookupFromBootstrap(cache, path, encoding)`. TDD this directly. | Wiring the helper into `Filesystem.readFile/stat/readdir` (3 small splices) + boot.js fetch + Playwright smoke. |
| Phase 3 (invalidation) | Pure helpers `invalidateCacheEntry(cache, p)` and `invalidateCacheSubtree(cache, prefix)` in new `src/client-mobile/cache-invalidation.js`. TDD directly. | Wiring into mutation methods + WS message handler. |
| Phase 4 (docs + acceptance) | N/A | All manual + Playwright. |

**Refactor before Phase 2:** Extract the cache-lookup logic into a
standalone module so we can unit-test it without a browser. Same for
the invalidation helpers. The original plan had them inline in
`capacitor-shim.js`; TDD favors small testable modules.

**Helper modules to be created (in this plan):**
- `src/client-mobile/bootstrap-lookup.js` — pure, no browser deps
- `src/client-mobile/cache-invalidation.js` — pure, no browser deps
- `src/client-mobile/test/bootstrap-lookup.test.js` — uses `node:test`
- `src/client-mobile/test/cache-invalidation.test.js` — uses `node:test`

Both helper modules export plain functions. They will be loaded into
the browser via plain `<script>` tags (they attach to `window.__owCache*`
or similar) — same pattern as the existing shims.

### Test infrastructure setup

**Server tests** (`src/server/test/*.test.js`) already work via the
existing `src/server/package.json`:
```bash
cd src/server && npm test       # runs node --test
```
Phase 1 extends `src/server/test/bootstrap-cache.test.js` — no new
infrastructure needed.

**Client-mobile tests** are new. We will add a tiny `package.json` to
`src/client-mobile/`:

```json
{
  "name": "obsidian-web-client-mobile",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "test": "node --test test/"
  }
}
```

Then:
```bash
cd src/client-mobile && npm test
```

The helper modules under test (`bootstrap-lookup.js`,
`cache-invalidation.js`) use a Node-friendly module pattern (CommonJS
export when `module` exists, browser global otherwise — see the helper
code skeletons below). This lets `require()` work in tests and
`<script>` work in the browser, with no bundler.

### Config override for tests

**This is the trickiest piece — read carefully.**

The current `config.js` reads env vars at module load. Tests that vary
`BOOTSTRAP_DISABLED` per-test would need timing-sensitive
`process.env` manipulation. We avoid that by following the existing
override pattern: `createApp(appConfig)` already takes a custom config
object (see `src/server/test/bootstrap-cache.test.js:73` for an example
overriding `clientPath`, `obsidianPath`, etc.).

**Convention:** in `src/server/api/bootstrap.js`, access bootstrap config
via the `appConfig` parameter passed to `createBootstrapRouter`, NOT via
`require('../config')`. The current code reads `config.appVersion`
directly via require — we'll keep that for version (it's a constant)
but switch bootstrap-specific lookups to come from appConfig.

Concretely: `createBootstrapRouter` already receives `vaultRegistry` and
`fallbackVaultRoot`. Add a third parameter `bootstrapConfig`:

```js
function createBootstrapRouter(vaultRegistry, fallbackVaultRoot, bootstrapConfig) {
  // bootstrapConfig = { enabled, maxFileKB, maxTotalMB }
  if (!bootstrapConfig.enabled) {
    console.log('[bootstrap] DISABLED via config (BOOTSTRAP_DISABLED env or override)');
    serverCache.clear();
    buildProgress.clear();
  }
  // ... router setup ...
}
```

And in `src/server/index.js`, change the call:
```js
app.use('/api/bootstrap', createBootstrapRouter(
  vaultRegistry,
  appConfig.vaultPath,
  appConfig.bootstrap,
));
```

`appConfig.bootstrap` comes from `config.js` by default, and tests can
override it.

For the cap thresholds (`maxFileKB`, `maxTotalMB`), pass them similarly
to `buildCacheEntry` / `_buildCacheEntry` as part of an options object,
OR (simpler) put them in a module-level `currentLimits` variable that
`createBootstrapRouter` sets at construction. Tests that need different
limits create a new router via a new `createApp` call.

**Test helper extension:** the existing `startTestServer(config)` already
passes `config` to `createApp`. Tests can now add:
```js
const server = await startTestServer({
  // ... existing overrides ...
  bootstrap: { enabled: false, maxFileKB: 500, maxTotalMB: 50 },
});
```

Now to the phases themselves.

### Phase 1 — Server: config knobs + limits in bootstrap.js

#### 1a. Add config block

File: `src/server/config.js` — add to the exports object:

```js
bootstrap: {
  // Master switch. When false, /api/bootstrap returns { disabled: true }
  // immediately without scanning the vault.
  enabled: process.env.BOOTSTRAP_DISABLED !== 'true',

  // Per-file size cap (KB). Files larger than this get stat-only in the
  // response — content is fetched on demand.
  maxFileKB: parseInt(process.env.BOOTSTRAP_MAX_FILE_KB || '500', 10),

  // Total response size cap (MB) on the UNCOMPRESSED JSON.
  maxTotalMB: parseInt(process.env.BOOTSTRAP_MAX_TOTAL_MB || '50', 10),
},
```

#### 1b. Extract `buildElectronValues` helper

File: `src/server/api/bootstrap.js`

The electron values today are built inline inside `_buildCacheEntry`
(currently lines 246-261). **Extract them into a standalone helper at
module-level** so the disable path can call it without doing any FS walk:

```js
// Insert near the top of the file (after the const declarations, before
// walkDir). Used by both _buildCacheEntry (now) and the disable path
// (new in step 1d below).
function buildElectronValues(vaultId, vaultRegistry) {
  const vault = vaultId ? vaultRegistry.get(vaultId) : null;
  return {
    'vault':          vault ? { id: vaultId, path: VAULT_BASE } : {},
    'vault-list':     vaultRegistry.list(),
    'is-dev':         false,
    'version':        APP_VERSION,
    'frame':          'hidden',
    'resources':      '',
    'file-url':       '',
    'disable-update': true,
    'update':         '',
    'check-update':   false,
    'insider-build':  false,
    'cli':            false,
    'disable-gpu':    false,
    'is-quitting':    false,
  };
}
```

Then in `_buildCacheEntry`, replace lines 246-261 with:
```js
const electronValues = buildElectronValues(vaultId, vaultRegistry);
```

#### 1c. Per-file cap from env

Replace the hardcoded `MAX_CONTENT_BYTES = 500 * 1024` (line ~115) with:
```js
const config = require('../config');
const MAX_CONTENT_BYTES = config.bootstrap.maxFileKB * 1024;
```

`isTextFile()` already checks size — no signature changes needed.

#### 1d. Disable path in the HTTP handler

File: `src/server/api/bootstrap.js`, function `createBootstrapRouter`,
the GET `/` handler (line 421).

Inject AT THE TOP of the handler (before any cache lookups, before
`buildCacheEntry`):

```js
router.get('/', async (req, res) => {
  const vaultId = req.query.vault || '';
  const full = req.query.full === '1';

  // ── Disable path ────────────────────────────────────────────────────
  // When BOOTSTRAP_DISABLED=true, return a minimal payload immediately.
  // No FS walk, no serverCache lookup, no pre-compression.
  if (!config.bootstrap.enabled) {
    return res.json({
      disabled: true,
      electron: buildElectronValues(vaultId, vaultRegistry),
      fs: {},
      dirs: {},
    });
  }

  // ── Existing logic continues unchanged from here ───────────────────
  const vault = vaultId ? vaultRegistry.get(vaultId) : null;
  const vaultRoot = vault ? vault.path : fallbackVaultRoot;
  // ... rest of existing handler ...
});
```

**Important:** the disable path must also clear `serverCache` and
`buildProgress` if they have entries from a previous (non-disabled)
session. Otherwise stale cache data leaks. Add at the top of
`createBootstrapRouter`, once at construction time:

```js
function createBootstrapRouter(vaultRegistry, fallbackVaultRoot) {
  if (!config.bootstrap.enabled) {
    console.log('[bootstrap] DISABLED via BOOTSTRAP_DISABLED env var');
    serverCache.clear();
    buildProgress.clear();
  }
  const router = express.Router();
  // ...
}
```

#### 1e. Warm-up bail-out

`warmUpBootstrapCache` (currently line 472) is called from
`src/server/index.js:startServer()`. When disabled, it should be a no-op.
Add at the top:

```js
async function warmUpBootstrapCache(vaultRegistry, fallbackVaultRoot) {
  if (!config.bootstrap.enabled) {
    // Bootstrap disabled — skip the precompute entirely.
    return;
  }
  // ... existing logic ...
}
```

#### 1f. Total response cap — explicit `walkDir` signature change

The current signature:
```js
async function walkDir(dir, root, fsCache, dirsCache, walkHidden = false, progress = null)
```

Change to:
```js
async function walkDir(dir, root, fsCache, dirsCache, walkHidden = false, progress = null, budget = null)
```

`budget` is a shared mutable object: `{ remaining: <bytes>, capped: false }`.
Threading it through is the trickiest part — there are TWO call sites of
`walkDir` in `_buildCacheEntry`:
- Line 313: `walkDir(obsidianDir, vaultRoot, fsCache, dirsCache, true, progress)` — for `.obsidian/`
- Line 354: `walkDir(vaultRoot, vaultRoot, fsCache, dirsCache, false, progress)` — for full vault walk

PLUS the recursive call **inside** walkDir:
- Line 187: `await walkDir(abs, root, fsCache, dirsCache, walkHidden, progress)` — recursive descent

**ALL three must pass the same budget object** (or `null`). Concretely:

```js
// In _buildCacheEntry, BEFORE the .obsidian walk:
const budget = full ? {
  remaining: config.bootstrap.maxTotalMB * 1024 * 1024,
  capped: false,
} : null;

await walkDir(obsidianDir, vaultRoot, fsCache, dirsCache, true, progress, budget);
// ...
if (full) {
  await walkDir(vaultRoot, vaultRoot, fsCache, dirsCache, false, progress, budget);
}
```

And inside `walkDir`, the recursive call (line 187):
```js
await walkDir(abs, root, fsCache, dirsCache, walkHidden, progress, budget);
```

Inside the readFile batch (current line 200-205):
```js
await Promise.all(batch.map(async ({ abs, rel }) => {
  try {
    const content = await fsp.readFile(abs, 'utf8');
    // NEW: budget enforcement
    if (budget) {
      if (budget.remaining < content.length) {
        budget.capped = true;
        return;  // skip — stat already in fsCache from line 190
      }
      budget.remaining -= content.length;
    }
    fsCache[rel] = { ...fsCache[rel], content };
  } catch (_) {}
}));
```

Note: I read the file first then check budget against actual content length
(not the stat size, which can differ for symlinks etc.). The disk read is
already paid for; only the in-memory accounting is gated.

**An alternative is to check the stat size BEFORE reading**: if `e.size`
already exceeds `budget.remaining`, skip the read entirely. This is more
optimal for disk I/O but slightly under-counts budget on edge cases.
Either approach works; pick stat-based check for efficiency:

```js
// Inside the entries loop, BEFORE pushing to textFiles (line 188-191):
} else if (isTextFile(e.name, e.size)) {
  fsCache[rel] = { mtime: e.mtime, size: e.size, isFile: true };
  if (budget && budget.remaining < e.size) {
    budget.capped = true;  // don't queue for read
  } else {
    if (budget) budget.remaining -= e.size;
    textFiles.push({ abs, rel });
  }
}
```

After the build (in `_buildCacheEntry`, after walkDir but before
`response = { ... }`):

```js
const response = { electron: electronValues, fs: fsCache, dirs: dirsCache };
if (budget && budget.capped) {
  response.capped = true;
  response.cappedReason = `total size limit reached (${config.bootstrap.maxTotalMB} MB)`;
}
```

#### 1g. Logging

Update the existing log line (currently line 397-401) to include capped/disabled:

```js
const cappedFlag = budget && budget.capped ? ' CAPPED' : '';
console.log(
  `[bootstrap] vault=${vaultId.slice(0, 8)}… full=${full}${cappedFlag} ` +
  `files=${fileCount}(content:${withContent}) dirs=${dirCount} ` +
  `size=${(byteCount / 1024).toFixed(0)}KB time=${ms}ms`,
);
```

For the disable path, the one-time `[bootstrap] DISABLED via …` log in
`createBootstrapRouter` (step 1d) is sufficient — no per-request log noise.

#### TDD tracer bullet — Phase 1

**Start with this exact test (the first RED).** Add to
`src/server/test/bootstrap-cache.test.js`:

```js
test('BOOTSTRAP_DISABLED=true returns {disabled:true} without scanning', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-bootstrap-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const vaultPath = await makeVaultFixture(tmp);

  const server = await startTestServer({
    clientPath: path.join(tmp, 'client'),
    obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'vaults.json'),
    vaultPath,
    bootstrap: { enabled: false, maxFileKB: 500, maxTotalMB: 50 },
  });
  t.after(server.close);

  const openRes = await fetch(server.baseUrl + '/api/vaults/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: vaultPath, create: false }),
  });
  const { id: vaultId } = await openRes.json();

  const t0 = Date.now();
  const res = await fetch(`${server.baseUrl}/api/bootstrap?vault=${vaultId}&full=1`);
  const elapsed = Date.now() - t0;
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.disabled, true, 'should mark response as disabled');
  assert.ok(body.electron, 'electron values still present');
  assert.deepEqual(body.fs, {}, 'fs should be empty');
  assert.deepEqual(body.dirs, {}, 'dirs should be empty');
  assert.ok(elapsed < 200, `should respond in <200ms, got ${elapsed}ms`);
});
```

This test fails initially because the disable path doesn't exist yet
AND because `createApp` doesn't honor `bootstrap` from override config
(it still reads `require('../config').bootstrap`). The minimal code to
get to GREEN:
1. Thread `appConfig.bootstrap` through `createApp` → `createBootstrapRouter`.
2. Add the early-return at the top of `router.get('/')` for `!bootstrap.enabled`.
3. Make sure `buildElectronValues` is reachable from the disable path
   (extract first, or duplicate logic temporarily).

Once this test passes, proceed to the NEXT behavior (`maxFileKB`), and
so on. **Do NOT write all 5 tests upfront.** The next test will reveal
that your "minimal" disable-path code needs adjustment for shared logic
— that's the cycle.

#### Acceptance for Phase 1

All tests pass via `cd src/server && npm test`. Specifically:

- Existing tests (`bootstrap cache HIT…`, `bootstrap cache is invalidated…`) still pass.
- New tests for: `BOOTSTRAP_DISABLED=true returns…`, `maxFileKB caps individual files`, `maxTotalMB caps total response`, `buildElectronValues extracted produces same output`, `warm-up is no-op when disabled`.

Manual smoke (after tests pass):

- `BOOTSTRAP_DISABLED=true node src/server/index.js` then `curl /api/bootstrap?vault=…&full=1` returns `{ disabled: true, electron: {…}, fs: {}, dirs: {} }` in <50ms.
- `BOOTSTRAP_MAX_FILE_KB=10 node src/server/index.js` and a vault with a >10KB markdown file: response excludes that file's content but includes its stat in `dirs`.
- `BOOTSTRAP_MAX_TOTAL_MB=1 node src/server/index.js` on the large vault (009428c4…, ~7MB content): response has `capped: true`, fs cache has content for files until ~1MB then stat-only for the rest.
- Default behavior unchanged: no env vars → same response shape as before, same size as before.

### Phase 2 — Client: populate cache + use in readFile/stat/readdir

File: `src/client-mobile/boot.js`

1. **Fetch bootstrap in parallel with vault verification.** Currently boot
   verifies the vault, then injects scripts. Add the bootstrap fetch as a
   parallel async task:

   ```js
   // After VAULT_ID resolved, before script injection:
   var bootstrapPromise = fetch('/api/bootstrap?vault=' + encodeURIComponent(VAULT_ID) + '&full=1', {
     headers: { 'Accept-Encoding': 'br, gzip' },
   })
     .then(function (r) { return r.ok ? r.json() : null; })
     .then(function (data) {
       if (!data) return null;
       if (data.disabled) {
         console.log('[obsidian-web] bootstrap disabled by server, all FS reads will round-trip');
         window.__owBootstrapCache = null;
         return null;
       }
       window.__owBootstrapCache = data;
       var fileCount = data.fs ? Object.keys(data.fs).length : 0;
       var capped = data.capped ? ' (CAPPED: ' + data.cappedReason + ')' : '';
       console.log('[obsidian-web] bootstrap loaded: ' + fileCount + ' files cached' + capped);
       return data;
     })
     .catch(function (err) {
       console.warn('[obsidian-web] bootstrap failed:', err.message);
       window.__owBootstrapCache = null;
     });

   // Expose the promise so capacitor-shim can await it in watchAndStatAll.
   window.__owBootstrapPromise = bootstrapPromise;
   ```

2. **Place this BEFORE** the script-injection loop, so the fetch starts
   in parallel with the script downloads. The cache should be ready
   well before Obsidian starts reading files (scripts take 1-2s to load,
   bootstrap typically arrives in <500ms on a small vault).

File: `src/client-mobile/bootstrap-lookup.js` (NEW — extracted helper, TDD'd)

```js
/**
 * Pure lookup helpers over a bootstrap cache object.
 * No browser/DOM deps — testable with node:test.
 *
 * Cache shape (from /api/bootstrap):
 *   {
 *     fs:   { [relPath]: { content?, size, mtime, isFile, isDirectory } },
 *     dirs: { [relPath]: [{ name, size, mtime, isFile, isDirectory }] },
 *     electron: { ... }, disabled?, capped?, cappedReason?
 *   }
 */
(function () {
  'use strict';

  // Returns the cached file content (string) or null. ONLY hits for
  // text reads (encoding truthy) with a stat-and-content entry.
  function lookupContent(cache, p, encoding) {
    if (!encoding) return null;             // binary read — cache stores only utf8
    if (!cache || !cache.fs) return null;
    const entry = cache.fs[p];
    if (!entry || typeof entry.content !== 'string') return null;
    return entry.content;
  }

  // Returns { type, size, mtime, ctime, uri } or null.
  function lookupStat(cache, p) {
    if (!cache || !cache.fs) return null;
    const entry = cache.fs[p];
    if (!entry) return null;
    return {
      type:  entry.isDirectory ? 'directory' : 'file',
      size:  entry.size || 0,
      mtime: entry.mtime || 0,
      ctime: entry.mtime || 0,
      uri:   '',
    };
  }

  // Returns array of dir entries (Capacitor shape) or null.
  function lookupDir(cache, p) {
    if (!cache || !cache.dirs) return null;
    const entries = cache.dirs[p];
    if (!entries) return null;
    return entries.map(function (e) {
      return {
        name:  e.name,
        type:  e.isDirectory ? 'directory' : 'file',
        size:  e.size || 0,
        mtime: e.mtime || 0,
        uri:   '',
        ctime: e.mtime || 0,
      };
    });
  }

  // Node export (for tests) + browser global.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { lookupContent, lookupStat, lookupDir };
  } else {
    window.__owBootstrapLookup = { lookupContent, lookupStat, lookupDir };
  }
})();
```

File: `src/client-mobile/shims/capacitor-shim.js` — splice the helper in.

3. **Filesystem.readFile** (around line 124) — add cache check at the top:

   ```js
   async readFile(opts) {
     const p = fullPath(opts);
     const encoding = opts.encoding;

     // Bootstrap cache hit: only for text reads with content cached.
     // Returns null on stat-only entry (oversized/capped) — fall through.
     const hit = window.__owBootstrapLookup &&
       window.__owBootstrapLookup.lookupContent(window.__owBootstrapCache, p, encoding);
     if (hit !== null && hit !== undefined) {
       return { data: hit };
     }

     // Existing HTTP fallback unchanged.
     const url = '/api/fs/read?' + vaultQuery() + 'path=' + encodePath(p) + ...
     // ...
   }
   ```

4. **Filesystem.stat** (around line 244):

   ```js
   async stat(opts) {
     const p = fullPath(opts);

     const hit = window.__owBootstrapLookup &&
       window.__owBootstrapLookup.lookupStat(window.__owBootstrapCache, p);
     if (hit) return hit;

     // Existing HTTP fallback unchanged.
     // ...
   }
   ```

5. **Filesystem.readdir** (around line 233):

   ```js
   async readdir(opts) {
     const p = fullPath(opts);

     const hit = window.__owBootstrapLookup &&
       window.__owBootstrapLookup.lookupDir(window.__owBootstrapCache, p);
     if (hit) return { files: hit };

     // Existing HTTP fallback unchanged.
     // ...
   }
   ```

6. **Filesystem.watchAndStatAll**: await the bootstrap promise instead of
   doing its own fetch. Around line 345:

   ```js
   async watchAndStatAll(opts) {
     await Filesystem.startWatch(opts);

     // Wait for boot.js's bootstrap fetch to land (it started in parallel
     // with script injection, so likely already done by now).
     if (window.__owBootstrapPromise) {
       await window.__owBootstrapPromise.catch(() => null);
     }

     const cache = window.__owBootstrapCache;
     const dirs = cache && cache.dirs;

     // If bootstrap failed or is disabled, fall back to fetching directly.
     if (!dirs) {
       const vaultId = getVaultId();
       const res = await fetch('/api/bootstrap?vault=' + encodeURIComponent(vaultId) + '&full=1', ...);
       // ... existing logic ...
     }

     // Flat-list build (unchanged from current — see comment in existing code)
     const children = [];
     for (const dirPath of Object.keys(dirs)) {
       for (const e of dirs[dirPath]) {
         const relPath = dirPath ? dirPath + '/' + e.name : e.name;
         children.push({
           name: relPath,
           type: e.isDirectory ? 'directory' : 'file',
           size: e.size || 0,
           mtime: e.mtime || 0,
           uri: '',
           ctime: e.mtime || 0,
         });
       }
     }
     return { children };
   }
   ```

#### TDD tracer bullet — Phase 2 (helper module only)

**Start with this exact test (the first RED).** Create
`src/client-mobile/test/bootstrap-lookup.test.js`:

```js
'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const { lookupContent } = require('../bootstrap-lookup');

test('lookupContent returns the cached text for a hit', () => {
  const cache = {
    fs: {
      'Welcome.md': { content: '# hello\n', size: 8, mtime: 1, isFile: true },
    },
  };
  const result = lookupContent(cache, 'Welcome.md', 'utf8');
  assert.equal(result, '# hello\n');
});
```

This fails because `bootstrap-lookup.js` doesn't exist. Minimal GREEN:
create the module with just `lookupContent` returning entry content
when present. Next RED:

```js
test('lookupContent returns null for stat-only entry (oversized/capped file)', () => {
  const cache = {
    fs: {
      'big.md': { size: 1_000_000, mtime: 1, isFile: true /* no content */ },
    },
  };
  assert.equal(lookupContent(cache, 'big.md', 'utf8'), null);
});
```

Then null for missing entry, then null for binary reads (no encoding),
then `lookupStat` cycles, then `lookupDir` cycles. **One at a time.**

#### Acceptance for Phase 2

All helper tests pass via `cd src/client-mobile && npm test`.
Behaviors covered:

- [ ] `lookupContent` returns text on hit
- [ ] `lookupContent` returns null on stat-only entry
- [ ] `lookupContent` returns null on missing entry
- [ ] `lookupContent` returns null on binary read (no encoding)
- [ ] `lookupContent` returns null on null/undefined cache
- [ ] `lookupStat` returns shape `{type, size, mtime, ctime, uri}` on hit
- [ ] `lookupStat` distinguishes file from directory
- [ ] `lookupStat` returns null on missing entry
- [ ] `lookupDir` returns array of Capacitor entries
- [ ] `lookupDir` returns null on missing dir

Manual integration verification (after wiring helper into capacitor-shim
and adding boot.js fetch):

- Open `/mobile?vault=…` and check DevTools Network tab:
  - One request to `/api/bootstrap?full=1` (the new boot.js fetch)
  - NO duplicate bootstrap request from watchAndStatAll
  - Significantly fewer `/api/fs/read` and `/api/fs/stat` requests
    (only for files NOT in the cache — binary files, large text files
    above the cap, or post-cache writes)
- Console: `[obsidian-web] bootstrap loaded: N files cached`
- Open the large vault (009428c4) and feel the speedup. Should be
  comparable to the desktop runtime now.
- `BOOTSTRAP_DISABLED=true`: confirm console shows
  `[obsidian-web] bootstrap disabled by server, all FS reads will round-trip`
  and the vault still loads correctly (just slower — all reads HTTP).

### Phase 3 — Cache invalidation on writes + watch events

The cache stays valid only if we keep it in sync with mutations.

File: `src/client-mobile/cache-invalidation.js` (NEW — pure, TDD'd)

```js
/**
 * Pure invalidation helpers. Mutate the cache object in place.
 * No browser/DOM deps — testable with node:test.
 */
(function () {
  'use strict';

  // Drop a single path's stat+content, and drop its parent dir listing.
  function invalidateCacheEntry(cache, p) {
    if (!cache) return;
    if (cache.fs) delete cache.fs[p];
    if (cache.dirs) {
      const parent = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '';
      delete cache.dirs[parent];
    }
  }

  // Drop a whole subtree (path + everything under it). For rmdir
  // recursive and rename of a directory.
  function invalidateCacheSubtree(cache, prefix) {
    if (!cache) return;
    const prefixSlash = prefix + '/';
    if (cache.fs) {
      for (const key of Object.keys(cache.fs)) {
        if (key === prefix || key.startsWith(prefixSlash)) {
          delete cache.fs[key];
        }
      }
    }
    if (cache.dirs) {
      for (const key of Object.keys(cache.dirs)) {
        if (key === prefix || key.startsWith(prefixSlash)) {
          delete cache.dirs[key];
        }
      }
      const parent = prefix.includes('/') ? prefix.substring(0, prefix.lastIndexOf('/')) : '';
      delete cache.dirs[parent];
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { invalidateCacheEntry, invalidateCacheSubtree };
  } else {
    window.__owCacheInvalidation = { invalidateCacheEntry, invalidateCacheSubtree };
  }
})();
```

In `capacitor-shim.js`, the mutation methods call the helpers via the
global:

```js
function invalidateCacheEntry(p) {
  window.__owCacheInvalidation &&
    window.__owCacheInvalidation.invalidateCacheEntry(window.__owBootstrapCache, p);
}
function invalidateCacheSubtree(prefix) {
  window.__owCacheInvalidation &&
    window.__owCacheInvalidation.invalidateCacheSubtree(window.__owBootstrapCache, prefix);
}
```

Wire them into the mutation methods (line ranges refer to current code):

| Method | Line | Invalidation |
|---|---|---|
| `writeFile` | 151 | `invalidateCacheEntry(p)` after successful response |
| `appendFile` | 176 | `invalidateCacheEntry(p)` after successful response |
| `deleteFile` | 195 | `invalidateCacheEntry(p)` after successful response |
| `mkdir` | 205 | `invalidateCacheEntry(p)` (clears parent dir listing) |
| `rmdir` | 219 | **`invalidateCacheSubtree(p)`** if `opts.recursive`, else `invalidateCacheEntry(p)` |
| `rename` | 261 | `invalidateCacheSubtree(from)` + `invalidateCacheSubtree(to)` — `from` may have been a dir |
| `copy` | 276 | `invalidateCacheSubtree(to)` — `to` may be a dir |

Example wiring for `writeFile`:
```js
async writeFile(opts) {
  // ... existing HTTP write up to "if (!res.ok) ..." ...
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw capError(json.code || 'EIO', json.error || 'writeFile failed: ' + p);
  }
  invalidateCacheEntry(p);   // NEW
  return { uri: '' };
}
```

Example for `rmdir`:
```js
async rmdir(opts) {
  // ... existing HTTP code up to error handling ...
  if (opts.recursive) {
    invalidateCacheSubtree(p);
  } else {
    invalidateCacheEntry(p);
  }
  return {};
}
```

**For watch events.** The existing WebSocket handler at line 320 receives
`{ type: 'change' | 'add' | 'unlink', path }` from chokidar. Add:

```js
ws.onmessage = (ev) => {
  try {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'change' || msg.type === 'add' || msg.type === 'unlink') {
      // Invalidate cache so subsequent reads pick up the change.
      invalidateCacheEntry(msg.path);
      // ... existing listener notification logic unchanged ...
    }
  } catch (_) {}
};
```

#### TDD tracer bullet — Phase 3

**Start with this exact test (the first RED).** Create
`src/client-mobile/test/cache-invalidation.test.js`:

```js
'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const { invalidateCacheEntry } = require('../cache-invalidation');

test('invalidateCacheEntry drops the file entry and its parent dir listing', () => {
  const cache = {
    fs: {
      'Notes/foo.md': { content: 'a', size: 1, mtime: 1, isFile: true },
      'Notes/bar.md': { content: 'b', size: 1, mtime: 1, isFile: true },
      'other.md':     { content: 'c', size: 1, mtime: 1, isFile: true },
    },
    dirs: {
      '':      [{ name: 'Notes', isDirectory: true }, { name: 'other.md', isFile: true }],
      'Notes': [{ name: 'foo.md', isFile: true }, { name: 'bar.md', isFile: true }],
    },
  };

  invalidateCacheEntry(cache, 'Notes/foo.md');

  // The target file is gone.
  assert.equal(cache.fs['Notes/foo.md'], undefined);
  // Siblings untouched.
  assert.ok(cache.fs['Notes/bar.md']);
  assert.ok(cache.fs['other.md']);
  // Parent dir listing dropped (will be re-fetched on next readdir).
  assert.equal(cache.dirs['Notes'], undefined);
  // Other dirs untouched.
  assert.ok(cache.dirs['']);
});
```

This fails because `cache-invalidation.js` doesn't exist yet (the
require throws). The minimal GREEN is creating the module with just
`invalidateCacheEntry` as defined in the helper skeleton above.

Then the NEXT test for the same module:
```js
test('invalidateCacheEntry on a root-level file drops dirs[""]', () => { ... });
```
Then `invalidateCacheSubtree`, then edge cases. **One at a time.**

#### Acceptance for Phase 3

All pure-helper tests pass via `cd src/client-mobile && npm test`.
Behaviors covered:

- [ ] `invalidateCacheEntry` drops target file + parent dir
- [ ] `invalidateCacheEntry` no-ops when cache is null/undefined
- [ ] `invalidateCacheEntry` handles root-level files (parent = `""`)
- [ ] `invalidateCacheSubtree` drops all fs/dirs entries under prefix
- [ ] `invalidateCacheSubtree` does NOT drop siblings of the prefix
- [ ] `invalidateCacheSubtree` drops the prefix's parent dir too

Manual integration verification (after wiring helpers into capacitor-shim):

- Open vault, note a file's content via `await window.app.vault.adapter.read('Welcome.md')` — fast (cache hit).
- Edit the file via the UI (or programmatically). Read again — gets the
  new content, not the cached stale one.
- From a SECOND device editing the same vault via LiveSync (or any
  external write that triggers chokidar): subsequent reads in the first
  device pick up the new content within ~100ms (watch event invalidates,
  next read goes HTTP).
- `rename` a file: old path returns ENOENT, new path works, parent dir
  listing reflects the rename.

### Phase 4 — Documentation

**`README.md`** — add to Configuration section:

```markdown
### Bootstrap configuration

The `/api/bootstrap` endpoint preloads vault content into memory for fast
boot. Defaults work for most vaults. To customize:

- `BOOTSTRAP_DISABLED=true` — skip bootstrap entirely. Each file read
  goes individually over HTTP. Useful for minimal deployments.
- `BOOTSTRAP_MAX_FILE_KB=500` — skip individual files larger than this
  from the cache (default: 500 KB). Their stat is still cached; content
  is fetched on demand.
- `BOOTSTRAP_MAX_TOTAL_MB=50` — cap total response size (default: 50 MB).
  When reached, server stops adding content but still returns dirs+stat.
  Sends a `capped: true` marker.
```

**`docs/walkthrough.md`** — new dated entry summarizing the work.

**`PLAN.md`** — update the "fast bootstrap" mentions to clarify both
runtimes use it now.

## Pitfalls (read before starting)

1. **Bootstrap race with boot.** The fetch starts in parallel with script
   injection. Scripts might load faster than the bootstrap response (rare
   but possible on a fast local network with a slow vault). Early reads
   from Obsidian will miss the cache and fall back to HTTP — that's
   correct behavior, but means the speedup is partial on first boot.
   Don't try to "wait for bootstrap before injecting scripts" — that
   would re-introduce the boot-time blocking we're trying to avoid.

2. **`encoding` matters in readFile cache check.** Cache stores `content`
   as a UTF-8 string. Binary reads (no `encoding` set) want base64 of
   an ArrayBuffer. **Don't return cached `content` for binary reads** —
   the format is wrong. Always check `if (encoding)` before consulting
   the cache.

3. **`fsEntry.isDirectory` semantics.** The bootstrap entries for
   directories have `{ mtime, size, isFile: false, isDirectory: true }`.
   Files have `{ mtime, size, isFile: true, content? }`. Cap detection:
   files that were `isFile: true` but have no `content` field were
   skipped (binary or oversized). Return their stat from cache, but
   ALWAYS fall back to HTTP for their content.

4. **Parent dir invalidation on writes is conservative.** After a write
   we drop the parent dir listing entirely so next readdir re-fetches.
   Alternative: update the entry in place (size+mtime). The conservative
   approach is simpler and the cost is one HTTP roundtrip per dir whose
   contents changed — acceptable.

5. **Watch event firehose.** Chokidar can emit many events when a folder
   is bulk-modified (e.g. LiveSync pull). The invalidate helper is cheap
   (just deletes object keys), but if a thousand events fire in a second,
   we drop a lot of cache entries — exactly what we want, but means
   subsequent reads hammer the server. Consider debouncing the **dirs**
   invalidation (keep file-level fast). Out of scope for v1; document.

6. **`watchAndStatAll` runs early in Obsidian boot.** It's the first
   call from `app.js` that requires the bootstrap data. If the fetch
   hasn't landed yet, the `await __owBootstrapPromise` will block the
   FS adapter's init. This is correct — Obsidian is waiting for FS
   anyway. But monitor: if the bootstrap takes too long, Obsidian's
   boot UX is degraded. Mitigation: server-side cache HIT path is
   <20ms, so this isn't usually an issue.

7. **Server's existing per-file cap (`MAX_CONTENT_BYTES = 500KB`) was
   silent.** The current code skips files >500KB without telling the
   client. After this plan, we still skip them but the client should
   know. Two options:
   - Mark such entries `{ truncated: true }` so the client knows to
     fetch on demand.
   - Don't add them to fs cache at all; client falls through to HTTP
     because `fs[p]` is undefined.
   Choose option 2 — simpler. The dirs cache still has their stat.

8. **`BOOTSTRAP_DISABLED` server-side, but client still fetches.**
   When disabled, the server returns `{ disabled: true, ... }` in <50ms.
   The client fetch happens regardless but is cheap. Don't add a
   client-side disable knob — keeps the config story simple
   (one knob, server-side).

9. **CF Workers deployment uses a different bootstrap** in
   `src/deployments/cloudflare/api/bootstrap.js`. This plan covers only
   the Node.js server. The CF Worker bootstrap may want similar limits
   in the future but is out of scope here.

10. **Don't precompute the cache for the disabled case.** The current
    server has a warm-up call at startup. If `BOOTSTRAP_DISABLED=true`,
    skip the warm-up entirely. Saves cold-boot time.

11. **`serverCache` and `pendingBuilds` are module-level state in
    `bootstrap.js`** (lines 62, 69). They persist across `createApp()`
    calls within a single Node process. Tests in the same file run
    sequentially under `node:test` by default, but use **distinct
    vault IDs per test** (the existing pattern — `vaults/open` returns
    a new id each time when the path differs). When a test deliberately
    re-uses a vault id to test cache hit/miss, it must explicitly
    `serverCache.clear()` and `pendingBuilds.clear()` in `t.beforeEach`
    or accept the persisted state. The shared state is also why we
    `serverCache.clear()` in the disable path at router construction.

12. **TDD anti-pattern to avoid.** Do NOT write all tests for a phase
    upfront — that's "horizontal slicing" and produces tests that
    verify imagined behavior instead of actual behavior. For each
    phase, work in vertical slices: one RED test → minimal GREEN code
    → next RED. Standard TDD philosophy explicitly warns against this.
    Each tracer bullet above shows
    THE FIRST cycle only — the next cycles emerge from what you learn.

## Acceptance criteria

The plan is complete when **all** of the following are true:

**Tests (run via `npm test` in each package):**

- [ ] `cd src/server && npm test` — all existing tests still pass, plus new tests for `BOOTSTRAP_DISABLED`, `maxFileKB`, `maxTotalMB`, `buildElectronValues` regression, warm-up bail-out.
- [ ] `cd src/client-mobile && npm test` — all `bootstrap-lookup` tests pass (lookupContent / lookupStat / lookupDir + edge cases).
- [ ] `cd src/client-mobile && npm test` — all `cache-invalidation` tests pass (invalidateCacheEntry + invalidateCacheSubtree + edge cases).
- [ ] New `src/client-mobile/package.json` exists with `"test": "node --test test/"`.

**Implementation:**

- [ ] `src/server/config.js` exposes `bootstrap.{enabled, maxFileKB, maxTotalMB}` driven by env vars.
- [ ] `src/server/api/bootstrap.js` returns `{ disabled: true, ... }` in
      <50ms when `BOOTSTRAP_DISABLED=true`.
- [ ] Per-file cap is configurable via `BOOTSTRAP_MAX_FILE_KB`; files
      larger than the cap are not in `fs` cache but ARE in `dirs`.
- [ ] Total cap via `BOOTSTRAP_MAX_TOTAL_MB`: server stops adding content
      after the limit, response has `{ capped: true, cappedReason: ... }`.
- [ ] `src/client-mobile/boot.js` fetches bootstrap in parallel with
      script injection and populates `window.__owBootstrapCache`.
- [ ] `Filesystem.{readFile, stat, readdir}` check the cache before HTTP.
- [ ] `Filesystem.watchAndStatAll` uses `window.__owBootstrapPromise`
      instead of re-fetching.
- [ ] Mutations (`writeFile`, `mkdir`, `rmdir`, `rename`, `deleteFile`,
      `copy`, `appendFile`) invalidate the affected cache entries.
- [ ] Watch events from chokidar invalidate the affected cache entries.
- [ ] **Measurable speedup on the large vault** (009428c4, 394 files,
      68 nested folders):
      - **Baseline (before this plan):** time from `goto /mobile?vault=…`
        until `document.querySelector('.workspace')` resolves AND
        `window.app.metadataCache.inProgressTaskCount === 0` ≈ 5-8s
        (mostly network round-trips).
      - **Target after this plan:** ≤ 2s on the same network.
      - **How to measure:** in DevTools console after navigation:
        ```js
        performance.timing.loadEventEnd - performance.timing.navigationStart
        ```
        And visually: time from URL bar enter to "Indexing complete" status.
      - **Acceptance:** at least 60% reduction vs baseline.
- [ ] **`BOOTSTRAP_DISABLED=true` smoke test**: vault still loads
      correctly. Console shows `[obsidian-web] bootstrap disabled by
      server, all FS reads will round-trip`. Time-to-workspace returns
      to ~5-8s (no regression from disabled state vs original).
- [ ] **`BOOTSTRAP_MAX_TOTAL_MB=1` capping test**: response has
      `capped: true`. Some text file content is in `cache.fs`, the rest
      stat-only. Vault still loads (those files fetch on demand). Console
      shows `[bootstrap] vault=… full=true CAPPED files=… size=…`.
- [ ] **Network panel verification** after a successful boot of the large
      vault: `/api/fs/read` and `/api/fs/stat` requests are ≤ 30 total
      (was 100+ before the plan). This confirms the cache is actually
      being consulted.
- [ ] `README.md` documents the three env vars.
- [ ] `docs/walkthrough.md` has a new dated entry.
- [ ] **No commits.** Leave that to the user.

## Reference: file locations + line numbers

Lines are accurate as of 2026-05-12 (commit `9c0bec8`). They will drift
with future edits — the regex/anchor points named below are the actual
contracts.

In `src/client-mobile/boot.js`:

| Item | Line |
|---|---|
| `VAULT_ID` resolution | 41 |
| Vault verification `fetch('/api/fs/stat?…')` | 218 |
| Script injection loop | 230 |
| Workspace MutationObserver | 251 |
| **Insertion point for bootstrap fetch** | between line ~228 (after `setStatus('Loading Obsidian mobile...')`) and line 230 (before the injection loop). Parallel with the script downloads. |

In `src/client-mobile/shims/capacitor-shim.js`:

| Item | Line |
|---|---|
| `getVaultId()` / `fullPath()` helpers (good place to add `invalidateCacheEntry` next to them) | 55, 86 |
| `Filesystem.readFile` | 124 |
| `Filesystem.writeFile` | 151 |
| `Filesystem.appendFile` | 176 |
| `Filesystem.deleteFile` | 195 |
| `Filesystem.mkdir` | 205 |
| `Filesystem.rmdir` | 219 |
| `Filesystem.readdir` | 233 |
| `Filesystem.stat` | 244 |
| `Filesystem.rename` | 261 |
| `Filesystem.copy` | 276 |
| `Filesystem.startWatch` (WS handler at `ws.onmessage`) | 315, message handler at ~321 |
| `Filesystem.watchAndStatAll` | 345 |

In `src/server/api/bootstrap.js`:

| Item | Line |
|---|---|
| `MAX_CONTENT_BYTES` constant | 115 |
| `isTextFile()` helper | 117 |
| `walkDir()` signature + body | 133 |
| `walkDir()` recursive call inside | 187 |
| `walkDir()` text-file content read loop | 198-210 |
| `_buildCacheEntry()` start | 241 |
| **Electron values inline block (to extract)** | 246-261 |
| First `walkDir` call (`.obsidian/`) | 313 |
| Second `walkDir` call (full vault) | 354 |
| `response = { electron, fs, dirs }` construction | 365 |
| Pre-compression call | 388 |
| Log line (final) | 397-401 |
| Router `GET /` handler entry | **421** |
| `warmUpBootstrapCache()` function | 472 |

In `src/server/config.js`:

| Item | Line |
|---|---|
| `module.exports = {` | 62 |
| (insert `bootstrap: { ... }` block here, anywhere in the object) | end of exports |

## Effort estimate (with TDD)

- **Phase 1 (server, fully TDD)**: ~3 hours
  - Config override threading + 5 tracer-bullet cycles (RED→GREEN×5)
- **Phase 2 (client, TDD helper + manual wiring)**: ~4 hours
  - `src/client-mobile/package.json` setup + `bootstrap-lookup.js` TDD (~10 cycles)
  - Manual splice into capacitor-shim (3 methods) + boot.js fetch
- **Phase 3 (TDD pure helpers)**: ~1.5 hours
  - `cache-invalidation.js` TDD (~6 cycles)
  - Manual wiring into 7 mutation methods + WS handler
- **Phase 4 (docs)**: ~45 min
- **Integration + Playwright smoke**: ~1-2 hours

**Total: ~1.5 days for a TDD-disciplined agent.** Faster if the agent
skips writing tests (~half a day), but the user explicitly chose TDD.

## What this does NOT do

- **CF Workers bootstrap** — separate codebase, separate plan if needed.
- **Local-vaults (OPFS)** — doesn't use the server bootstrap; the OPFS
  walk does the same job faster anyway.
- **Service Worker / offline support** — orthogonal. Bootstrap caches
  in-memory only; refreshes on reload.
- **Replace `/api/bootstrap` with WebSocket streaming** — different
  approach; consider only if bootstrap response sizes routinely exceed
  what HTTP buffering can handle.
