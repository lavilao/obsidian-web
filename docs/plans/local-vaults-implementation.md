# Local vaults (OPFS + LiveSync) — Implementation Plan

> Created: 2026-05-11
>
> Target audience: implementing agent (sub-agent). Read top to bottom,
> then execute. Acceptance criteria at the end define when you're done.

## Context

Today every obsidian-web vault is backed by the server's filesystem
(`/api/fs/*`). This plan adds a **second vault type** — "local vaults"
— that live entirely in the browser's OPFS (Origin Private File System)
and sync to other devices exclusively through obsidian-livesync ↔ CouchDB.

The two types coexist. The user picks which kind to create on the
starter screen.

| Vault type | Storage | Sync between devices | Sync between tabs |
|---|---|---|---|
| **Server** (current) | Server filesystem, `/api/fs/*` | Each device opens obsidian-web; all share the server vault | chokidar → WebSocket |
| **Local** (this plan) | Browser OPFS, per-origin per-browser | LiveSync ↔ CouchDB (mandatory for cross-device) | BroadcastChannel + leader election |

**Why per-vault, not a full deployment-mode pivot?** See
`docs/plans/future-direction-client-only.md` for the rejected pure-client
approach and the rationale.

**Why now, after LiveSync?** Local vaults are useless without sync —
they live in one browser only. LiveSync is the sync. This plan therefore
**depends on `livesync-implementation.md` being complete** (`App.requestUrl`
implemented, install script ready, plugin works end-to-end on a server vault).

## Dependencies — confirm before starting

| Pre-requisite | Where it lives | What "done" means |
|---|---|---|
| `App.requestUrl` real implementation | `client-mobile/shims/capacitor-shim.js:439` | Replaced the stub `() => Promise.resolve({})` with a real fetch wrapper that round-trips base64. All 3 Phase 2 self-tests of `livesync-implementation.md` pass. |
| LiveSync system plugin | `<repo>/plugins/obsidian-livesync/` | `scripts/install-livesync.js` ran successfully. Plugin loads from system overlay. |
| End-to-end sync on a server vault | manual E2E (Phase 4 of livesync plan) | Edit-on-web propagates to a second device through a real CouchDB within ~10s, and vice versa. |
| `crypto.createHash` async path | `client-mobile/boot.js:128` | Already done — works for SHA-1/256/512 via `subtle.digest`. |

If any of these are still red, **stop and finish them first.** Local
vaults without working LiveSync = a vault you can't escape.

## Scope boundaries

**In scope for v1:**
- OPFS-backed adapter that fully replaces the HTTP FS plugin for local vaults
- Per-vault routing: same `CapacitorAdapter` surface, different backend per vault
- Browser-side local vault registry (`localStorage`)
- Starter page UI: "Create local vault" button + section showing local vaults
- Setup wizard shown on first open of an empty local vault (offers
  "Configure LiveSync" or "Just start writing")
- Documentation (`docs/local-vaults.md`)

**Out of scope for v1 (separate follow-up plans if needed):**
- Export/import vault as `.zip` (mention in pitfalls; recommend adding next)
- Service worker / installable PWA (recommend adding next)
- Multi-tab leader election with BroadcastChannel (single-tab assumption
  documented; second tab shows a clear error)
- Local vaults on the **desktop runtime** (`/`). Out of scope — desktop
  uses `FileSystemAdapter` over `original-fs`, which doesn't have a clean
  OPFS mapping. Local vaults are mobile-runtime-only.
- `SYSTEM_PLUGINS` env var (already documented in `PLAN.md` as separate
  future work; LiveSync as a system plugin is enough to make local vaults
  useful).

## What already exists (do not redo)

| Component | Status |
|---|---|
| Mobile runtime (`/mobile`) | ✅ done |
| `CapacitorAdapter` via shim | ✅ done (`client-mobile/shims/capacitor-shim.js`) |
| System plugin overlay | ✅ done — applies to local vaults too via the same `/api/fs` fallback for `.obsidian/plugins/*` reads (system plugins are NOT stored in OPFS; they're loaded from the server-static `<repo>/plugins/`) |
| Layout-switcher plugin | ✅ done |
| LiveSync system plugin | ✅ done (Phase 3 of `livesync-implementation.md`) |
| `App.requestUrl` | ✅ done (Phase 1 of `livesync-implementation.md`) |
| Vault selection from `?vault=<id>` | ✅ done (`client-mobile/boot.js:40-41`) |

## High-level architecture

```
                         vault id (URL/localStorage)
                                   │
                    ┌──────────────┴──────────────┐
                    │  boot.js: resolveVaultType  │   (new step)
                    │   ┌─────────────────────┐   │
                    │   │ in local-registry?  │   │
                    │   │  → 'local'          │   │
                    │   │  else → 'server'    │   │
                    │   └─────────────────────┘   │
                    └──────────────┬──────────────┘
                                   │
                       window.__owVaultType = 'local'|'server'
                                   │
              ┌────────────────────┴────────────────────┐
              │     capacitor-shim.js: Filesystem        │
              │                                          │
              │  if (__owVaultType === 'local')          │
              │      → OpfsStore                         │
              │  else                                    │
              │      → HTTP /api/fs/*  (current code)    │
              └──────────────────────────────────────────┘
```

**Key insight:** the `CapacitorAdapter` (what Obsidian sees) doesn't
change. The `Filesystem` plugin inside our shim is the only thing that
branches. Same plugin surface (`readFile`, `writeFile`, `stat`,
`readdir`, …), two different backends.

## Implementation phases

### Phase 1 — `OpfsStore` module

New file: `client-mobile/storage/opfs-store.js`

A standalone module that implements the same surface the current
`Filesystem` plugin uses, but on OPFS. It exports an object with the
same async methods (`readFile`, `writeFile`, `stat`, `readdir`, `mkdir`,
`rmdir`, `rename`, `copy`, `deleteFile`, `appendFile`, `getUri`,
`watchAndStatAll`, `startWatch`, `stopWatch`, `addListener`).

#### Storage layout in OPFS

Per browser origin, OPFS root contains:

```
/vaults/
  <vault-id>/
    Welcome.md
    Notes/
      …
    .obsidian/
      …
```

Each local vault is rooted at `/vaults/<vault-id>/`. The vault id is the
same 16-char hex string the server registry generates (just produced in
the browser instead).

#### Required methods

Match the existing Filesystem plugin signatures in
`client-mobile/shims/capacitor-shim.js:122-394`. The shapes Obsidian
expects are documented inline there — preserve them exactly.

Skeleton (full implementation to be written):

```js
// client-mobile/storage/opfs-store.js
(function () {
  'use strict';

  // ── Internals ─────────────────────────────────────────────────────────
  async function rootDir() {
    return await navigator.storage.getDirectory();
  }

  async function vaultDir(vaultId, { create = false } = {}) {
    const root = await rootDir();
    const vaults = await root.getDirectoryHandle('vaults', { create });
    return await vaults.getDirectoryHandle(vaultId, { create });
  }

  /**
   * Walk to a sub-handle under the vault root.
   * @param {string} relPath - path relative to vault root, e.g. "Notes/foo.md"
   * @param {{ create?: boolean, isFile?: boolean }} opts
   */
  async function resolve(vaultId, relPath, opts = {}) {
    const dir = await vaultDir(vaultId, { create: !!opts.create });
    if (!relPath || relPath === '/' || relPath === '.') return dir;
    const parts = relPath.split('/').filter(Boolean);
    const last = parts.pop();
    let cur = dir;
    for (const part of parts) {
      cur = await cur.getDirectoryHandle(part, { create: !!opts.create });
    }
    if (opts.isFile === undefined) {
      // Try file first, then directory. Caller should specify when possible.
      try { return await cur.getFileHandle(last); }
      catch (_) { return await cur.getDirectoryHandle(last); }
    }
    return opts.isFile
      ? await cur.getFileHandle(last, { create: !!opts.create })
      : await cur.getDirectoryHandle(last, { create: !!opts.create });
  }

  // ── Public API ────────────────────────────────────────────────────────
  function makeStore(vaultId) {
    return {
      async readFile(opts) { /* … */ },
      async writeFile(opts) { /* … */ },
      async appendFile(opts) { /* … */ },
      async deleteFile(opts) { /* … */ },
      async mkdir(opts) { /* … */ },
      async rmdir(opts) { /* … */ },
      async readdir(opts) { /* … */ },
      async stat(opts) { /* … */ },
      async rename(opts) { /* … */ },
      async copy(opts) { /* … */ },
      async trash(opts) { /* delegate to deleteFile */ },
      async getUri(opts) {
        // OPFS files have no stable HTTP URL. Return a blob URL.
        const fh = await resolve(vaultId, opts.path, { isFile: true });
        const file = await fh.getFile();
        return { uri: URL.createObjectURL(file) };
      },
      async startWatch(opts) { /* no-op — OPFS has no external changes */ },
      async stopWatch(opts) { /* no-op */ },
      async addListener(eventName, callback) {
        return Promise.resolve({ remove: () => {} });
      },
      async watchAndStatAll(opts) {
        // Walk the entire vault tree and return Capacitor's expected shape.
        // CRITICAL: must be a FLAT list — see method-by-method notes below.
        // No watcher needed because all writes come through this same store.
        return { children: await walkTree(vaultId) };
      },
      // identity stubs — match existing Filesystem behavior
      async setTimes()           { return {}; },
      async verifyIcloud()       { return {}; },
      async open()               { return {}; },
      async checkPerms()         { return { publicStorage: 'granted' }; },
      async requestPermissions() { return { publicStorage: 'granted' }; },
      async requestPerms()       { return { publicStorage: 'granted' }; },
      async choose()             { return null; },
    };
  }

  window.__owOpfsStore = { makeStore };
})();
```

#### Method-by-method contract notes

**`readFile`** — same as existing (line 124). When `opts.encoding === 'utf8'`,
read the file via `FileHandle.getFile()` then `file.text()` and return
`{ data: text }`. When binary, return `{ data: base64(arrayBuffer) }`.
Use the same chunked btoa pattern as the existing shim (line 142-147)
to avoid `String.fromCharCode.apply` blowing the stack on large files.

**`writeFile`** — same as existing (line 151). For utf8, `writable.write(string)`.
For binary, decode base64 to ArrayBuffer and `writable.write(buffer)`.
**Always `close()` the writable** — otherwise the write may not flush.

**`stat`** — return `{ type: 'file'|'directory', size, mtime, ctime, uri: '' }`.
For files: `(await handle.getFile()).lastModified` gives mtime; `.size` gives size.
For directories: `size: 0`, `mtime: 0` (OPFS doesn't expose directory mtime).
Match the existing shape on line 252-258.

**`readdir`** — iterate `dir.values()`, push entries shaped like
`toCapacitorDirEntry` (line 109-118). Each file: `getFile()` for size+mtime.

**`mkdir`** — `getDirectoryHandle(name, { create: true })`. If
`opts.recursive` is set, walk parts creating each.

**`rename`** — OPFS has no `rename`. Implement as **copy + delete**.
For files: read source, write dest, delete source. For directories:
recursively. **Track this as a known limitation** — it's not atomic.
Make sure not to delete the source if the dest write fails.

**`copy`** — for files: read+write. For directories: recursive walk.

**`rmdir`** — `parent.removeEntry(name, { recursive: !!opts.recursive })`.

**`deleteFile`** — `parent.removeEntry(name)`.

**`watchAndStatAll`** — recursive walk of the vault tree, return
`{ children: [ { name, type, size, mtime, ctime, uri }, … ] }` as a
**FLAT list**. Each entry's `name` is its **full relative path from the
vault root** (e.g. `"Notes/2026/foo.md"`), NOT just the leaf name.

**Critical pitfall (learned 2026-05-12 the hard way):** Obsidian's
`CapacitorAdapter` consumes the result with:
```js
for (const i of e.children) this.quickList("", i);
```
`quickList` does NOT recurse into `entry.children`. A nested tree with
`children: [...]` arrays will result in **only the top level being
indexed** — directories will appear in the file explorer but their
contents won't. This was the bug behind "vault שלי הראה תיקיות ריקות"
on 2026-05-12; do not regress.

The current `capacitor-shim.js:345-383` already does this correctly
(walks the entire `dirs` map from `/api/bootstrap` and pushes one
flat entry per file/dir with its full relative path). The OPFS
implementation must match.

Reference skeleton:
```js
async function walkTree(vaultId) {
  const children = [];
  async function walk(dirHandle, prefix) {
    for await (const [name, handle] of dirHandle.entries()) {
      const relPath = prefix ? prefix + '/' + name : name;
      if (handle.kind === 'directory') {
        children.push({
          name: relPath, type: 'directory',
          size: 0, mtime: 0, ctime: 0, uri: '',
        });
        await walk(handle, relPath);
      } else {
        const file = await handle.getFile();
        children.push({
          name: relPath, type: 'file',
          size: file.size, mtime: file.lastModified,
          ctime: file.lastModified, uri: '',
        });
      }
    }
  }
  const root = await vaultDir(vaultId);
  await walk(root, '');
  return children;
}
```

**Watch APIs (`startWatch`, `stopWatch`, `addListener`)** — for local
vaults these can be no-ops. Reason: every write goes through us, and
Obsidian's internal event bus already fires `vault.on('modify')` when
the adapter writes. There are no "external" changes.

  Exception: when LiveSync pulls a change from CouchDB, it calls
  `vault.adapter.write()` directly. Obsidian's modify event still fires.
  So no separate watcher is needed.

#### Acceptance for Phase 1

Run from DevTools console (after manually setting `window.__owVaultType='local'`):

```js
const s = window.__owOpfsStore.makeStore('test-local');
await s.mkdir({ path: 'Notes', recursive: false });
await s.writeFile({ path: 'Notes/hello.md', data: 'Hi', encoding: 'utf8' });
const r = await s.readFile({ path: 'Notes/hello.md', encoding: 'utf8' });
console.assert(r.data === 'Hi');
const list = await s.readdir({ path: 'Notes' });
console.assert(list.files.length === 1 && list.files[0].name === 'hello.md');
// Binary round-trip:
const bin = btoa('hello\x00world');
await s.writeFile({ path: 'bin.dat', data: bin });
const back = await s.readFile({ path: 'bin.dat' });
console.assert(back.data === bin);

// watchAndStatAll — MUST return FLAT list with full relative paths.
// This guards against regressing the 2026-05-12 nested-tree bug.
await s.mkdir({ path: 'A/B/C', recursive: true });
await s.writeFile({ path: 'A/B/C/deep.md', data: 'x', encoding: 'utf8' });
const tree = await s.watchAndStatAll({});
const names = tree.children.map((e) => e.name).sort();
console.assert(names.includes('Notes'),         'top-level dir present');
console.assert(names.includes('Notes/hello.md'),'nested file present with full path');
console.assert(names.includes('A/B/C/deep.md'), 'deeply nested file present with full path');
console.assert(tree.children.every((e) => e.children === undefined),
  'entries must NOT have a children property — flat list only');

// Cleanup:
const root = await navigator.storage.getDirectory();
await root.removeEntry('vaults', { recursive: true });
```

All assertions must pass without errors. The `watchAndStatAll` assertions
are the most important — they catch the nested-tree bug that broke
production on 2026-05-12.

### Phase 2 — Local vault registry + vault-type routing

#### 2a. Browser-side registry module

New file: `client/local-vault-registry.js`

(Lives in `client/` because the starter page — which is in the desktop
runtime — uses it, AND `client-mobile/` uses it. Loaded via `<script>`
tag in both `client-mobile/index.html` and the starter wrapper.)

```js
// client/local-vault-registry.js
(function () {
  'use strict';

  const KEY = 'obsidian-web:local-vaults';

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); }
    catch (_) { return {}; }
  }
  function save(map) {
    localStorage.setItem(KEY, JSON.stringify(map));
  }
  function uuid() {
    const arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  window.__owLocalVaults = {
    list() {
      const map = load();
      return Object.entries(map)
        .map(([id, v]) => ({ id, name: v.name, createdAt: v.createdAt }))
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    get(id) {
      const map = load();
      return map[id] || null;
    },
    has(id) {
      return !!this.get(id);
    },
    create(name) {
      const map = load();
      const id = uuid();
      map[id] = { name: name || 'Untitled', createdAt: Date.now() };
      save(map);
      return { id, name: map[id].name };
    },
    rename(id, name) {
      const map = load();
      if (!map[id]) return false;
      map[id].name = name;
      save(map);
      return true;
    },
    remove(id) {
      const map = load();
      if (!map[id]) return false;
      delete map[id];
      save(map);
      // Note: caller is responsible for deleting OPFS content too.
      return true;
    },
  };
})();
```

#### 2b. Boot-time vault type resolution

Edit `client-mobile/boot.js`:

After line 41 (`var VAULT_ID = params.get('vault') || …`), add:

```js
// Vault type: 'local' (OPFS) or 'server' (HTTP /api/fs). Determined by
// whether the id is present in the browser-side local vault registry.
// Loaded synchronously via <script> before boot.js.
var VAULT_TYPE = (window.__owLocalVaults && window.__owLocalVaults.has(VAULT_ID))
  ? 'local'
  : 'server';
window.__owVaultType = VAULT_TYPE;
window.__owVaultId   = VAULT_ID;
console.log('[obsidian-web] vault type:', VAULT_TYPE, 'id:', VAULT_ID);
```

Then change the **vault verification block** (currently lines 215-265).
The current code calls `fetch('/api/fs/stat?vault=…&path=')`. For local
vaults this would 404. Branch:

```js
setStatus('Verifying vault...');

var verifyPromise;
if (VAULT_TYPE === 'local') {
  // Ensure the OPFS directory exists. Creating it is idempotent.
  verifyPromise = (async function () {
    if (!window.__owOpfsStore) throw new Error('OPFS store not loaded');
    const root = await navigator.storage.getDirectory();
    const vaults = await root.getDirectoryHandle('vaults', { create: true });
    await vaults.getDirectoryHandle(VAULT_ID, { create: true });
    return { isDirectory: true };
  })();
} else {
  verifyPromise = fetch('/api/fs/stat?vault=' + encodeURIComponent(VAULT_ID) + '&path=')
    .then(function (res) {
      if (!res.ok) throw new Error('Vault not found (HTTP ' + res.status + ')');
      return res.json();
    });
}

verifyPromise
  .then(function (stat) {
    if (!stat || (!stat.isDirectory && stat.type !== 'directory')) {
      throw new Error('Vault path is not a directory');
    }
    // … existing script-injection logic continues unchanged …
  })
  .catch(/* … existing error handler unchanged … */);
```

Also update `client-mobile/index.html` to load the registry + OPFS store
**before** `boot.js`:

```html
<!-- 0. Local vault registry + OPFS store (loaded before boot.js).         -->
<script src="/client/local-vault-registry.js?v=1"></script>
<script src="/client-mobile/storage/opfs-store.js?v=1"></script>

<!-- 1. Capacitor shim — חייב לפני native-bridge.js כדי שandroidBridge יהיה -->
<script src="/client-mobile/shims/capacitor-shim.js?v=2"></script>
<!-- (bump v=2 — the shim now branches on vault type) -->
```

Server change required to serve `/client/local-vault-registry.js` —
`server/index.js` already serves `/client/*` as static; verify and add
the route if missing.

#### 2c. Branch the Filesystem plugin

Edit `client-mobile/shims/capacitor-shim.js`:

Replace `const Filesystem = { … }` (lines 120-394) with a dispatcher
that delegates to either the existing HTTP impl or the new OPFS impl,
based on `window.__owVaultType`.

Pattern:

```js
// Rename the current Filesystem object to HttpFilesystem.
const HttpFilesystem = { /* current implementation, unchanged */ };

// At call time, choose backend per call (in case vault type changes
// mid-session, which it currently can't, but cheap defensive code).
function fsBackend() {
  if (window.__owVaultType === 'local') {
    if (!window.__owLocalFs) {
      window.__owLocalFs = window.__owOpfsStore.makeStore(window.__owVaultId);
    }
    return window.__owLocalFs;
  }
  return HttpFilesystem;
}

const Filesystem = new Proxy({}, {
  get(_target, prop) {
    const backend = fsBackend();
    return backend[prop];
  },
});
```

**Pitfall:** Methods that aren't on the OPFS store (e.g. `setTimes`,
`open`, `verifyIcloud`) need to be present as no-ops on both backends.
The skeleton in Phase 1 has them; double-check parity by diffing the
two objects.

#### Acceptance for Phase 2

1. Open `/mobile?vault=nonexistent-local-id` — should redirect to `/starter`
   with no error (the id isn't in local registry, so it's treated as
   server, and the existing server-fs verification fails cleanly).
2. From DevTools on the starter page: `__owLocalVaults.create('Test')`.
   Note the id. Navigate to `/mobile?vault=<id>`.
3. Status bar shows "Verifying vault...". OPFS directory is created.
4. Workspace renders. Vault is empty. Console shows
   `vault type: local id: <id>`.
5. Open any existing server vault (e.g. test-vault from the registry).
   Confirm it still works exactly as before — no regression. Check
   `__owVaultType === 'server'` in console.

### Phase 3 — Starter UI: list + create local vaults

The starter page (`client/starter.html`) wraps Obsidian's official
starter (`obsidian/starter.js`). The current vault list is rendered by
Obsidian's starter code, fed by `electron.js` IPC stubs that read
`data/vaults.json`.

We need to surface local vaults next to server vaults. Two options:

**Option A — extend the existing IPC list (recommended).**
Modify the IPC handler that returns the vault list to merge in local
vaults from `__owLocalVaults`. The handler is in either
`client/shims/electron.js` or `server/api/electron.js` — find the
`obsidian:vaults:get-vaults` (or equivalent) handler. Inject local
vault entries with a marker field like `_local: true` and a synthetic
path like `(local)/<id>`.

This makes them appear in Obsidian's own list UI, with all the
goodness (recents, click-to-open, etc.). The downside: when the user
clicks "open", we have to intercept it and redirect to
`/mobile?vault=<id>` instead of doing the normal server-vault flow.

**Option B — separate panel above the existing list.**
Inject HTML into `starter.html` (in our wrapper, not Obsidian's code)
that shows "Local vaults" as a separate section. Simpler but uglier.

Pick **Option A**. The reason: it's the same UX as server vaults, and
users shouldn't have to think about which kind they have. We're
adding **two** new affordances:

1. **A "Create local vault" button** alongside the existing "Open folder" /
   "Create new vault" buttons.
2. **Visual indicator** (small badge or color) on local-vault entries
   so users can tell which is which.

#### Required source spelunking

Before writing code, find these in the current codebase:

```bash
# How does the starter currently fetch the vault list?
grep -rn 'getVaults\|vault.*list\|recent.*vault' client/ obsidian/starter.js obsidian/app.js | head -30
# How is "Open folder" implemented?
grep -rn 'showOpenDialog\|open.*folder\|chooseDirectory' client/shims/ server/api/electron.js | head -20
```

Record the findings in a comment at the top of the modified file.

#### Implementation sketch

1. **Find the IPC channel that returns the vault list.** Likely
   `obsidian:vaults:get-recent-vaults` or similar. Edit the handler
   in `server/api/electron.js` (since it's a `sendSync` channel) or
   in `client/shims/electron.js` (if it's resolved client-side):

   ```js
   // After the existing logic that returns server vaults:
   const localVaults = (typeof window !== 'undefined' && window.__owLocalVaults)
     ? window.__owLocalVaults.list().map((v) => ({
         id:     v.id,
         path:   '(local)/' + v.id,
         name:   v.name,
         ts:     v.createdAt,
         _local: true,
       }))
     : [];
   const merged = [...localVaults, ...serverVaults];
   ```

2. **Intercept "open vault" clicks.** Find the click handler in the
   starter that navigates to `/mobile?vault=<id>` or `/?vault=<id>`.
   If the vault is `_local`, force `/mobile?vault=<id>` (local vaults
   are mobile-runtime-only — see Scope boundaries).

3. **Add "Create local vault" button.** Inject in `client/starter.html`
   after Obsidian's starter scripts load. Wire it to:
   ```js
   const name = prompt('Name your local vault:');
   if (!name) return;
   const { id } = window.__owLocalVaults.create(name);
   location.href = '/mobile?vault=' + encodeURIComponent(id);
   ```
   Plain `prompt()` is fine for v1 — match the existing UX of the
   server-vault "Open folder" prompt picker.

4. **Visual indicator.** Add a CSS class to entries with `_local: true`.
   The wrapper code in `client/starter.html` can apply it after Obsidian
   renders the list, via a MutationObserver or post-render hook.

#### Acceptance for Phase 3

1. Open `/starter`. See existing server vaults + a "Create local vault"
   button.
2. Click it. Type "My Notes". Page navigates to `/mobile?vault=<id>`.
3. Vault opens. Empty.
4. Return to `/starter` (open in new tab). See "My Notes" in the list,
   visually distinguished from server vaults.
5. Click "My Notes" → opens at `/mobile?vault=<id>`. (Verify URL goes to
   `/mobile`, not `/`, even if the user previously used `/`.)
6. Server vaults still work as before — no regression.

### Phase 4 — Empty-vault setup wizard

A brand-new local vault is **empty**. A user who created one without
knowing about LiveSync will see a blank screen with no files, no help,
and assume it's broken.

Add a one-time onboarding overlay:

#### What to show

When `Filesystem.readdir({ path: '' })` returns zero entries on a local
vault **and** `localStorage` doesn't have `obsidian-web:local-vault-onboarded:<id>`:

```
┌──────────────────────────────────────────────────────────┐
│  Welcome to your local vault                             │
│                                                          │
│  This vault is stored only in this browser. To sync it   │
│  to other devices or back it up, you'll need to set up   │
│  LiveSync with a CouchDB server.                         │
│                                                          │
│  [ Set up LiveSync now ]   [ I'll do it later ]          │
│                                                          │
│  Learn more about CouchDB setup →  docs/local-vaults.md  │
└──────────────────────────────────────────────────────────┘
```

- "Set up LiveSync now" — opens the LiveSync settings tab
  (`app.setting.open(); app.setting.openTabById('obsidian-livesync')`).
- "I'll do it later" — closes the overlay, writes the onboarded flag.
  Creates a default `Welcome.md` so the editor has something to show.

#### Where to put it

Two options:

**Option A:** A built-in obsidian-web feature, injected by
`client-mobile/boot.js` after the workspace is ready. Simple, no plugin
needed.

**Option B:** A feature of the `obsidian-web-layout` plugin (which is
already a system plugin). Cleaner separation but requires modifying that
plugin.

Pick **Option A** for v1 — it's the simpler path and the boot already
has a `MutationObserver` waiting for `.workspace` to appear (line 251).
Hook into that observer to also fire the wizard check.

#### Acceptance for Phase 4

1. Create a new local vault. On first open, the wizard appears.
2. Click "I'll do it later". Wizard closes. `Welcome.md` is created. The
   onboarded flag is set in localStorage.
3. Reload. Wizard does NOT reappear.
4. Create another local vault. Wizard appears for that one only (the
   flag is per-id).
5. Click "Set up LiveSync now" on a fresh vault. LiveSync settings tab
   opens. (The user manually configures and the wizard does not
   re-appear thanks to the flag being set when the button is clicked.)

### Phase 5 — Documentation

**`docs/local-vaults.md`** (new file). User-facing guide covering:

- What a local vault is, in 2 paragraphs
- The trade-off vs server vaults
- How to create one
- How to set up LiveSync against a CouchDB instance (link to
  `docs/livesync.md` which already exists from `livesync-implementation.md`)
- Backup strategies (since OPFS = single-browser exposure):
  - Run LiveSync (primary backup is CouchDB)
  - Note: a "browser-clear" event wipes OPFS. Mitigation is LiveSync.
- Multi-tab limitation (out-of-scope for v1) — document explicitly
- Known limitations: no `.zip` export yet, no service worker yet

**`docs/walkthrough.md`** — new dated entry at top following the existing
pattern:
- What was done (this plan, summary)
- Architecture decisions (any deviations from the plan)
- Verification results

**`PLAN.md`** — update the "Phase 2 (future): per-vault storage type"
section to mark this complete. Move both `livesync-implementation.md`
and `local-vaults-implementation.md` to `docs/plans/archive/` (per the
existing convention — see `docs/plans/archive/` for prior examples).

## Pitfalls (read before starting)

1. **OPFS rename is NOT atomic.** OPFS has no native rename; you must
   copy then delete. If the system loses power mid-operation, you can
   end up with two copies. Document this; do **not** try to invent
   atomicity (it would require a journaling layer that's overkill).

2. **OPFS quotas are per-origin, not per-vault.** A user with multiple
   large local vaults shares one quota. `navigator.storage.estimate()`
   gives the usage. Surface this in the wizard or settings later;
   don't block on it for v1.

3. **`navigator.storage.getDirectory()` returns the SAME OPFS root
   across all tabs of the same origin.** Two tabs writing to the same
   file simultaneously can corrupt it. v1 ships a single-tab assumption.
   Detect a second tab via `BroadcastChannel` if you want to add a
   warning, but multi-tab leader election is out-of-scope.

4. **OPFS is wiped by "Clear browsing data" in Chrome/Edge/Firefox.**
   This is the user's "site data" and they can delete it any time.
   **Document this loud and clear** in `docs/local-vaults.md`. LiveSync
   to CouchDB is the only durable backup.

5. **No standard DevTools UI for OPFS (as of mid-2026 in Chrome).**
   When debugging, walk OPFS programmatically via
   `await (await navigator.storage.getDirectory()).values()`. Plan to
   add an "Export vault as .zip" feature soon as a recovery affordance.

6. **System plugins still load from the server**, not from OPFS. The
   system plugin overlay in `server/system-plugins.js` is unchanged.
   Local vaults pick up `obsidian-web-layout` and `obsidian-livesync`
   via the same overlay because the system-plugin reads are served by
   `/api/fs/*` for `.obsidian/plugins/<system-id>/*` paths. Verify by
   checking that loading a fresh local vault produces a network request
   to `/api/fs/read?path=.obsidian/plugins/obsidian-livesync/main.js`
   in DevTools.

   **Subtle:** for a local vault, the OPFS store handles `.obsidian/`
   paths (config, workspace.json, etc.). But `.obsidian/plugins/<system-id>/*`
   should fall through to the server's system-plugin overlay. **The
   simplest correct behavior is: OPFS store handles all `.obsidian/`
   reads/writes, EXCEPT it returns ENOENT for missing system plugin
   files, and the caller (Obsidian) is supposed to skip them. BUT —**
   Obsidian doesn't know about our overlay; it just calls
   `vault.adapter.read`. For server vaults this works because the HTTP
   API does the overlay server-side.

   **Decision: for a local vault, the OpfsStore's `readFile`/`stat`
   must check if the requested path matches a system plugin id, and if
   so, fall back to fetching from the static server overlay
   (`fetch('/api/fs/read?vault=__system__&path=…')`).**

   That requires a small change to `server/api/fs.js`: accept a
   special `vault=__system__` value that only returns files via the
   system-plugin overlay (no real vault lookup). Add this guarded
   endpoint and have `OpfsStore.readFile` use it for any path matching
   `^\.obsidian/plugins/<system-id>/`.

   Alternative considered and rejected: bundle the system plugins into
   the OPFS at vault creation time. Rejected because it would make
   plugin updates invisible to existing local vaults.

7. **`getUri` returns blob URLs for OPFS.** Blob URLs are
   browser-session-scoped and revoke on tab close. For most Obsidian
   needs (image previews, audio playback) they work fine. Plugins that
   try to do `fetch(uri)` and pass it to another window will break.
   Document and move on.

8. **Local vault IDs are generated client-side** and live only in
   `localStorage`. A user who clears site data **loses the registry
   mapping**, even if OPFS happens to survive (which it usually doesn't —
   "Clear site data" wipes both). Don't rely on the id surviving.

9. **The desktop runtime (`/`) does NOT support local vaults in v1.**
   If a user manually navigates to `/?vault=<local-id>`, behavior is
   undefined. **Add a guard** in `client/boot.js`: if the requested
   vault id is in `__owLocalVaults`, redirect to `/mobile?vault=<id>`.

10. **Service worker is NOT installed in v1.** Without it, the user
    cannot use the app offline (the first load needs the network, even
    if OPFS has all the data). Document this. Add a clear note that
    a future plan will add SW + installable PWA.

11. **`watchAndStatAll` MUST return a flat list, not a tree.** This
    is the #1 most likely bug. `CapacitorAdapter`'s consumer iterates
    `e.children` exactly once (non-recursively) and calls `quickList("",
    entry)` on each — `quickList` uses `entry.name` as the **full
    relative path**. A nested-tree result will populate only the root
    level; subdirectories will appear empty in the file explorer.
    See the `watchAndStatAll` section in Phase 1 for the correct
    flat-list shape and the existing `capacitor-shim.js:345-383`
    implementation that already does it right.

## Acceptance criteria

The plan is complete when **all** of the following are true:

- [ ] `client-mobile/storage/opfs-store.js` exists with all FS methods
      implemented and the Phase 1 self-test passes — **including the
      `watchAndStatAll` flat-list assertions on nested subdirectories**.
- [ ] `client/local-vault-registry.js` exists; `__owLocalVaults` API
      works as documented.
- [ ] `client-mobile/index.html` loads the registry + OPFS store before
      `boot.js` and the capacitor shim.
- [ ] `client-mobile/boot.js` resolves vault type and stores it in
      `window.__owVaultType`.
- [ ] `client-mobile/shims/capacitor-shim.js` `Filesystem` is a
      dispatcher routing to OPFS or HTTP based on vault type.
- [ ] Starter page shows local vaults alongside server vaults with a
      visual indicator.
- [ ] "Create local vault" button works end-to-end.
- [ ] Clicking a local vault on the starter opens it at
      `/mobile?vault=<id>`.
- [ ] First open of an empty local vault shows the setup wizard exactly
      once.
- [ ] System plugins (`obsidian-web-layout`, `obsidian-livesync`) load
      correctly in a local vault (verify in DevTools Network tab that
      `main.js` requests for system plugin ids reach the server overlay,
      and the plugin UIs render).
- [ ] **LiveSync end-to-end test on a local vault:** configure CouchDB
      in LiveSync settings, do a pull, see files appear in OPFS, edit
      a file, see it propagate to a second device. **The pulled vault
      must have at least one subdirectory** — this exercises the flat-list
      contract of `watchAndStatAll`.
- [ ] Existing server vaults continue to work without regression.
      Spot-check: open `test-vault`, edit `Welcome.md`, confirm the
      change is persisted to the server disk.
- [ ] `docs/local-vaults.md` exists with all the topics from Phase 5.
- [ ] `docs/walkthrough.md` has a new dated entry.
- [ ] `PLAN.md` updated to reflect completion.
- [ ] **No commits.** Leave that to the user.

## Reference: file locations

In `client-mobile/shims/capacitor-shim.js` (current line numbers as of
the writing of this plan; may drift):

| Item | Approx. line |
|---|---|
| `getVaultId()` helper | 55 |
| `fullPath()` helper | 86 |
| `const Filesystem = { … }` start | 122 |
| `Filesystem.readFile` | 124 |
| `Filesystem.writeFile` | 151 |
| `Filesystem.watchAndStatAll` | 345 |
| `Filesystem.addListener` | 374 |
| `Filesystem` close brace | 394 |
| `const App = { … }` | 427 |
| `App.requestUrl` | 439 |
| `const plugins = { … }` | 503 |

In `client-mobile/boot.js`:

| Item | Approx. line |
|---|---|
| `VAULT_ID` resolution | 41 |
| `setStatus('Verifying vault...')` | 215 |
| `fetch('/api/fs/stat?vault=…')` (verification call) | 218 |
| Script injection loop | 230 |
| Workspace MutationObserver | 251 |

In `client-mobile/index.html`:

| Item | Approx. line |
|---|---|
| `<script src=".../capacitor-shim.js">` | 36 |
| `<script src=".../boot.js">` | 52 |

In `server/system-plugins.js`:

| Item | Function |
|---|---|
| `tryGetSystemFilePath(relPath)` | Resolves a `.obsidian/plugins/<id>/<file>` path to its repo location. Reuse in the new `vault=__system__` endpoint. |

## Reference: testing via gui-host browser

Same setup as `livesync-implementation.md`:

- Session: `obsmobile` on port 9224
- User-data-dir: `/tmp/pw-obsidian-mobile`

OPFS inspection from console:

```js
await (async () => {
  const root = await navigator.storage.getDirectory();
  async function walk(dir, prefix='') {
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      const path = prefix + '/' + name;
      if (handle.kind === 'directory') {
        out.push(path + '/');
        out.push(...await walk(handle, path));
      } else {
        const f = await handle.getFile();
        out.push(path + ' (' + f.size + 'b)');
      }
    }
    return out;
  }
  return await walk(root);
})();
```

Clearing OPFS for a fresh test run:

```js
await (async () => {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('vaults', { recursive: true }); } catch (_) {}
})();
localStorage.removeItem('obsidian-web:local-vaults');
```
