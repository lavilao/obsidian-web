# Future direction — pure client-only deployment (design exploration)

> Created: 2026-05-11
>
> Status: **design exploration, not a planned task.** This document captures
> an architectural option we considered and rejected for now. Kept so future
> contributors understand why the per-vault model (`local-vaults-implementation.md`)
> was chosen over a more radical pivot.

## The idea

Right now obsidian-web has a Node.js server that:
- Holds the vault on a real filesystem
- Serves `/api/fs/*` for read/write
- Runs chokidar to broadcast external changes via WebSocket
- Serves the static bundle (`obsidian-mobile/*`, `client-mobile/*`)
- Maintains a vault registry (`data/vaults.json`)

**What if we removed everything except the static-asset role?**

The mobile bundle is designed for a world where the vault lives locally
on the device, synced via LiveSync/iCloud/etc. We already "lie" to it via
`CapacitorAdapter` — instead of lying with HTTP-backed FS, we could lie
with browser-storage-backed FS (OPFS / IndexedDB).

Resulting topology:

```
Browser                              CouchDB (user-controlled)
├── obsidian-mobile bundle              ↑
├── client-mobile + capacitor shim      │
├── CapacitorAdapter ──► OPFS           │
└── LiveSync plugin ─────────────────────┘
              ↓
       (static hosting only:
        CF Pages / GitHub Pages / S3)
```

## Why this is appealing

- **Zero backend cost.** Static hosting is free or near-free.
- **Privacy by default.** No vault content ever touches our server.
- **Real PWA.** Installable, offline-first, no network dependency.
- **Trivial CF Workers demo.** No Durable Object lifecycle issues.

## Why we rejected it (for now)

1. **Migration of existing users would be invasive.** Anyone with a
   server-backed vault today would need a one-time export/import flow,
   plus a CouchDB setup, before they could even read their own notes.

2. **No graceful coexistence.** A "client-only" deployment by definition
   has no server FS. Users who *want* server-backed vaults (self-hosted,
   on a NAS, shared between desktop runtime and mobile runtime, etc.)
   would lose that option.

3. **Mandatory CouchDB.** Without LiveSync running, the vault has no
   way to leave the browser. We'd be forcing every user to set up
   CouchDB before they can do anything useful. Per-vault choice
   (`local-vaults-implementation.md`) keeps "fire up obsidian-web on a
   directory and start writing" as the path of least resistance.

4. **Single point of failure shifts to the user.** "Lost my CouchDB →
   lost my notes" is operationally heavier than "lost my server disk".

5. **Service worker complexity.** Caching a ~10MB bundle reliably across
   updates is non-trivial; getting it wrong means stale code in the wild.
   Worth doing eventually, not as a prerequisite to LiveSync.

## Why per-vault is better

The per-vault model (see `local-vaults-implementation.md`) gives us:

| | Per-vault model | Pure client-only |
|---|---|---|
| Existing server vaults | Keep working as-is | Need migration |
| User chooses model | Per-vault opt-in at create time | Forced |
| Server runtime needed | Yes (for server vaults) | No |
| CouchDB needed | Optional (for local vaults: yes) | Always |
| Migration risk | None | High |
| Implementation effort | ~1 week | ~2–3 weeks |
| Reversibility | Easy (delete the local vault) | Hard |

The per-vault model is **strictly more general**. A deployment that
configures `SYSTEM_PLUGINS=obsidian-web-layout,obsidian-livesync` and
restricts the vault registry to local-only effectively *becomes* the
client-only deployment — without taking that option away from anyone else.

## When this becomes worth revisiting

- If the server-backed mode accumulates enough operational cost
  (security patches, FS edge cases, multi-tenant auth) that maintaining
  it stops being worthwhile.
- If browser OPFS quotas, performance, or APIs improve to the point
  where local vaults are unambiguously preferable for nearly all users.
- If we want a true zero-cost free public demo and the CF Workers path
  (`cf/`) stops being viable.

Until then, keep both modes alive.
