---
project: "obsidian-web"
slice: "livesync-requesturl"
verifier: "avigail"
date: "2026-06-13"
verdict: "READY"
findings:
  - id: 1
    severity: "minor"
    category: "dropped-branch"
    summary: "Content-Type guard only checks 'Content-Type'/'content-type' exact-case; mixed-case user header (e.g. 'Content-type') would be duplicated"
    source_brief: "§4 Commit 1 / impl line 161"
    source_code: "src/client-mobile/shims/capacitor-shim.js:560"
    cost_estimate: "0min (LiveSync passes contentType field, not header)"
  - id: 2
    severity: "minor"
    category: "wrong-line-number"
    summary: "contract doc offsets ~1084206/~1084715 point to menu defs not requestUrl; real code at byte 1089452 (caller+normalizer) — claim still verified there"
    source_brief: "docs/plans/livesync-implementation.md:57-58"
    source_code: "vendor/obsidian-mobile/app.js@1089452"
    cost_estimate: "0min"
---

# Plan Verification — livesync-requesturl

> **Brief**: docs/plans/livesync-requesturl.md
> **Base tip**: a5f5a4d (branch main) — matches brief
> **Verdict**: ✅ READY
> **אומדן זמן confusion אם לא תוקן**: ~0 דק' (שתי הערות minor בלבד)

This brief is unusually solid. All load-bearing claims verified against code in `main@a5f5a4d`,
and the core protocol contract was cross-checked against the actual vendor bundle. The two findings
below are cosmetic and do **not** block dispatch.

## בעיות שנמצאו

### 🔴 Blocker / Regression risk

None. (Filesystem base64 refactor verified functionally identical — see spot-check.)

### 🟡 Confusion / Type error / Outdated

None substantive.

### 🟢 Minor

| # | בעיה | מקור |
|---|------|------|
| 1 | Content-Type guard checks only exact `'Content-Type'`/`'content-type'`. A user header `'Content-type'` (mixed-case) would slip past and get a duplicate `Content-Type` added. Harmless for LiveSync (it uses the dedicated `contentType` field, not a raw header), so not a real-world break — but worth a 1-line note. | brief §4 Commit 1, impl line 161 / shim:560 |
| 2 | The **contract doc** (`livesync-implementation.md:57-58`) cites offsets `~1084206` (fb) and `~1084715` (caller). Both are stale — those bytes are Electron menu definitions. The real caller+normalizer is at byte **1089452**. The claim itself is still correct there, so no impact on the executor, but the offsets are misleading if someone goes looking. | livesync-implementation.md:57-58 |

## Spot-check שעבר (לא מצא בעיה)

**Check 1 — symbols/APIs:**
- ✅ `const App` at `capacitor-shim.js:548` — confirmed.
- ✅ stub `requestUrl: () => Promise.resolve({})` at line **560** — confirmed (object-literal property; brief's `async requestUrl(opts){}` method-shorthand replacement is valid syntax there).
- ✅ `pm('requestUrl')` at line **752** — confirmed.
- ✅ Filesystem inline base64: `readFile` btoa-chunked at 188-197, `writeFile` atob at 211-214 — confirmed.

**Check 2 — `pm()` returns promise (escalation trigger §7):**
- ✅ `pm()` at line 742 = `{ name, rtype: 'promise' }`. **All `pm()` are promise-typed**, so `pm('requestUrl')` already gives `rtype:'promise'`. The escalation trigger does **not** fire — bridge wraps async correctly. Brief's "do not change" guidance is right.
- ✅ Bridge path confirmed: `nativePromise` override (lines 713-719) does `Promise.resolve().then(() => method.call(...))`, so even a thrown/rejected fetch propagates — matches brief's "let rejection propagate" note (line 183).

**Check 3 — request/response contract vs vendor app.js:**
- ✅ Cross-checked `vendor/obsidian-mobile/app.js@1089452`:
  `e.body instanceof ArrayBuffer ? (t=$(e.body), n=!0) : t=e.body` then
  `Av.requestUrl({url,method,contentType,headers,body:t,binary:n})`.
  Request shape **exactly** matches brief §3 + impl destructuring (line 159).
- ✅ Response: `fb(e, i.status, i.headers, X(i.body))` — `X` = `atob`-based, applied **unconditionally**. Confirms body must ALWAYS be base64 (including text, including empty → `''`). Brief is correct.
- ✅ `binary=true` only when ArrayBuffer; else string passthrough — impl lines 165-167 match exactly.
- ✅ `res.headers.forEach((v,k)=>...)` (impl 176) matches vendor `u.headers.forEach((e,t)=>d[t]=e)` (value, key) ordering.

**Check 4 — demo vault id:**
- ✅ `5b68fb93d875ad63` present in `user-data/registry.json:7`. Self-test URL valid.

**Check 5 — Filesystem refactor safety (Commit 0):**
- ✅ `base64ToArrayBuffer` (brief) ≡ writeFile inline (211-214): atob → Uint8Array fill → `.buffer`. Identical.
- ✅ `arrayBufferToBase64` (brief, CHUNK=0x8000) vs readFile inline (CHUNK=8192): chunk size differs but output is byte-identical (chunk size only bounds the `String.fromCharCode.apply` arg count). No behavior change. Refactor is safe.

**Check 6 — atob/btoa in node --test:**
- ✅ Local node v24.16.0 exposes both as globals. `node --test` works without a shim (brief's fallback note at line 146 is belt-and-suspenders, fine).

**Check 7 — depends_on / worktree conflict:**
- ✅ `depends_on: []` consistent. No `state.json` in repo (front-matter is source of truth). Slice touches only `capacitor-shim.js`. Other live worktree is `server-bootstrap-perf` (server-side files only) — **zero overlap**.

**Check 8 — pitfall #6 (`_changes?feed=continuous`):**
- ✅ Documented in plan lines 446-454; correctly out-of-scope for this slice (one-shot self-test). Brief's escalation routing to Slice C is accurate.

**Misc:**
- ✅ `docs/walkthrough.md` exists (DoD #7).
- ✅ Pseudo-code branch coverage: `body==null`→undefined ✓, `binary`→base64ToArrayBuffer ✓, string passthrough ✓, empty body→`''` ✓, error propagation ✓.

## Verdict

✅ **READY** — Dispatch to אליעזר. The two minor findings are documentation/robustness notes, not
correctness or type issues. Optional: מרדכי may add a 1-line normalize for mixed-case Content-Type
and fix the stale byte offsets in the contract doc, but neither is required.
