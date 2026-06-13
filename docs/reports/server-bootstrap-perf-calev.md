---
project: "obsidian-web"
slice: "server-bootstrap-perf"
verifier: "calev"
date: "2026-06-13"
mode: "heavy"
verdict: "PARTIAL"
dod_items:
  - "server tests pass (25/25)"
  - "mobile unit tests pass (14/14)"
  - "cold bootstrap faster (UNVERIFIABLE — no root for drop_caches; warm shows no diff)"
  - "write does not wipe cache → next bootstrap HIT"
  - "update returns fresh content"
  - "delete precise on both paths (unlink + electron/trash)"
  - "incremental rebuild on external change (logs 'incremental (N dirs)')"
  - "clean HIT stays fast (fixture 1ms, rclone 4ms)"
spot_check: "ran full E2E on local fixture + rclone vault — write/update/unlink/trash/rename/rmdir/incremental all functional; two payload-contract deviations found"
findings:
  - id: 1
    severity: "minor"
    category: "spec-drift"
    summary: "rename leaves new file with no content and size=0/mtime=0 in cache (stat-only), diverging from full re-scan"
    source_brief: "DoD #7 (payload identical to full) + §4 Commit 1 rename spec (no content/size/mtime passed for new path)"
    source_code: "src/server/api/fs.js:499 + bootstrap-invalidate.js:52"
    cost_estimate: "20min"
  - id: 2
    severity: "minor"
    category: "spec-drift"
    summary: "after surgical/incremental file add, the changed dir's mtime is stale in its parent listing (dirs[parent]) and on Phase2 also in fs[parent] dir-stat, vs full re-scan"
    source_brief: "DoD #7 + §6 risk note 'payload must remain byte-for-byte identical to full'"
    source_code: "src/server/api/bootstrap.js:421-423 + bootstrap-invalidate.js (updateEntryFile/removeEntryPath do not touch fs[parent] nor dirs[grandparent])"
    cost_estimate: "30min"
  - id: 3
    severity: "minor"
    category: "unique"
    summary: "fallback vault (no vault= param, vaultId='') is never cached (pre-existing guard if(vaultId)) so every bootstrap rebuilds full — not a slice regression, but undercuts cold-perf claim if a client ever omits vault="
    source_brief: "out of slice scope (pre-existing)"
    source_code: "src/server/api/bootstrap.js:558"
    cost_estimate: "n/a (pre-existing, document only)"
---

# server-bootstrap-perf — Verification Report (Heavy)

> **תאריך:** 2026-06-13
> **Commit בסיס:** ef4d3a7 (Phase 3) — over f460b98 (Phase 2), 52b2a23 (Phase 1)
> **שיטה:** curl + server logs. Local fixture vault (`/tmp/verify/server-bootstrap-perf/testvault`) + real rclone vault (`<your-vault>`). No browser (server-only slice).
> **Evidence dir:** `/tmp/verify/server-bootstrap-perf/`

## TL;DR

| מדד | תוצאה |
|------|--------|
| DoD items עוברים | 7/8 (item 3 unverifiable in env) |
| Regressions | 0 |
| Bugs חדשים | 2 contract-deviations (minor) + 1 pre-existing (document) |
| Tests ש-אליעזר הכריז | אומת — 25/25 server, 14/14 mobile |

הליבה של הסליס עובדת היטב: write/update/unlink/trash/rmdir/rename/incremental כולם פונקציונליים, ה-cache לא נמחק בכל כתיבה (ה-bug המקורי שהסליס בא לתקן), ושני נתיבי-המחיקה (fs + electron/trash) שניהם surgical. נמצאו שני סטיות-contract קטנות מול full re-scan (rename ללא content; dir-mtime stale ב-parent listing) — לא שוברות שימוש (on-demand read עדיין מחזיר נכון) אבל מפֵרות את הדרישה "byte-for-byte identical to full" מ-§6/DoD#7.

## טבלת DoD items

| # | Item מה-brief | סטטוס | עדות |
|---|---------------|--------|------|
| 1 | כל server tests ירוקים | ✅ | `npm test` → 25/25 pass, 0 fail |
| 2 | mobile unit tests לא נשברו | ✅ | `node --test "src/client-mobile/test/*.test.js"` → 14/14 (חיים ב-main; ה-worktree נוצר מ-HEAD נקי לפני ה-WIP, כמתועד ב-brief §0) |
| 3 | Cold bootstrap מהיר יותר | ⓘ לא ניתן לאימות | אין root → אי-אפשר `drop_caches`; VFS חם. Warm: pool=4→1094ms, pool=64→1151ms (אין שיפור כשחם, כצפוי). אימתתי שה-knob מגיע ל-libuv (`UV_THREADPOOL_SIZE env = 64` אחרי require). טענת 37s→2s על VFS קר נשענת על מדידת אליעזר — לא שחזרתי. |
| 4 | שמירה לא מוחקת cache | ✅ | PUT write→ bootstrap הבא `cache HIT (0ms)`, לא MISS |
| 5 | עדכון מדויק | ✅ | write 'UPDATED CONTENT v2' → bootstrap מחזיר בדיוק את התוכן החדש, size=18 |
| 6 | מחיקה מדויקת — שני הנתיבים | ✅ | (א) DELETE /unlink → sub.md נעלם מ-fs+dirs[notes], HIT נשמר. (ב) POST /electron/trash → trashme.md נעלם, HIT נשמר. שאר ה-vault שלם בשניהם |
| 7 | Incremental מול full | ⚠️ | לוג: `cache MISS (1 dirs changed): notes` → `incremental rebuild (1 dirs)` (לא full) ✅; אבל ה-payload **לא** זהה ל-full re-scan — diff יחיד: dir-mtime של notes ב-dirs[""] (ראה NBug2) |
| 8 | HIT נקי נשאר מהיר | ✅ | fixture: 1-2ms; rclone (vault רשום): `cache HIT (4ms)`, ~37ms round-trip |

## Flows שעבדו מקצה לקצה

- ✅ **Write existing file** → PUT /api/fs/write → next bootstrap HIT + fresh content (DoD 4+5).
- ✅ **Unlink** → DELETE /api/fs/unlink → file gone from fs + dirs[parent], HIT preserved, rest intact (DoD 6a).
- ✅ **Electron trash** → POST /api/electron/trash → identical removal behavior, HIT preserved (DoD 6b — Avigail finding #1/#2 second write-path, correctly handled).
- ✅ **Recursive dir delete with children** → DELETE /api/fs/rmdir?recursive=1 on `subdir/` (containing `a.md` + `inner/b.md`) → entire subtree pruned from fs/dirs, removed from parent listing, rest intact.
- ✅ **External add (Phase 3)** → file written directly to disk (bypassing API) → `cache MISS (1 dirs changed)` → `incremental rebuild (1 dirs)`, new file present with content. NOT a full re-scan.
- ✅ **Rapid x12 concurrent writes** to same file → coalesce + surgical update converge; cached content == disk content (no race divergence).
- ✅ **Edge inputs** → unknown vault → 404 ENOVAULT (invalidateEntry no-ops cleanly, no crash); empty path → 404 EISDIR (graceful).

## Flows שנשברו

אין flow שנשבר פונקציונלית. שני flows מייצרים payload שסוטה מ-full re-scan (ראה Bugs חדשים) אך נשארים שמישים דרך on-demand read.

## Regressions

- אין regressions שזוהו. Partial build (full=0) מחזיר shape תקין (electron/fs/dirs, version 1.12.7). Status endpoint עובד. br+gzip encoding-bypass שניהם משרתים. ה-payload של full build (599 files) יציב בין pool=4 ל-pool=64.

## Bugs חדשים שלא ברשימה

- ❌ **NBug1 — rename מאבד content ומאפס stat** (minor, spec-drift)
  - **מניפסטציה:** `POST /api/fs/rename notes/note.md → notes/renamed.md`. אחרי כן `fs["notes/renamed.md"] = {mtime:0, size:0, isFile:true}` — **ללא content**, size=0, mtime=epoch. הדיסק: size=18, mtime אמיתי, content מלא. full re-scan היה כולל content+stat נכון.
  - **גורם:** `fs.js:498-499` קורא `invalidateEntry(newRel, {removed:false})` בלי content/size/mtime. `updateEntryFile` (bootstrap-invalidate.js:59-60) אז ברירת-מחדל ל-0 כי זו רשומה חדשה. ה-brief §4 Commit 1 ציין rename כ-"removed:false ל-new" אבל לא סיפק content/size/mtime — האקזקיוטר מימש מילולית.
  - **חומרה:** minor. on-demand `/api/fs/read` עדיין מחזיר את התוכן הנכון, אז הקובץ לא "שבור". אבל `stat()` מהcache מחזיר size=0/mtime=0 — Obsidian משתמש ב-file mtime/size ל-metadata index, עלול לחשוב שהקובץ ריק או לעורר re-read. הקובץ גם חסר מה-bootstrap payload (צריך round-trip).

- ❌ **NBug2 — dir-mtime stale ב-parent listing אחרי add** (minor, spec-drift)
  - **מניפסטציה:** הוספת קובץ ל-`notes/` (גם Phase2 surgical וגם Phase3 incremental) משאירה את ה-mtime של ה-entry `notes` בתוך `dirs[""]` ישן. ב-Phase2 גם `fs["notes"]` (ה-dir-stat הייעודי) נשאר ישן (size+mtime). full re-scan מעדכן את שניהם. diff מדויק: incremental `dirs[""].notes.mtime=1781370639154` מול full `=1781370708363`.
  - **גורם:** ב-Phase3 `bootstrap.js:421-423` מרענן `fs[relDir]` אך לא את ה-entry של relDir בתוך `dirs[parentOf(relDir)]`. ב-Phase2 `updateEntryFile`/`removeEntryPath` לא נוגעים כלל ב-`fs[parent]` ולא ב-`dirs[grandparent]`; `_refreshDirMtimes` מעדכן רק את snapshot ה-`dirMtimes` (לא את ה-payload), מה שדווקא **מסתיר** את ה-MISS שהיה מרענן את ה-parent listing.
  - **חומרה:** minor. Obsidian נשען על file mtimes, נדיר שעל directory mtimes. ה-listing עצמו נכון. אבל מפֵר את "byte-for-byte identical to full" (§6 risk note + DoD#7).

- ⓘ **NBug3 (pre-existing, לא slice) — fallback vault לא נשמר ל-cache**
  - **מניפסטציה:** בקשת `/api/bootstrap` בלי `vault=` (vaultId='') בונה full בכל פעם, ללא HIT/MISS log. גרם בתחילה לטעות-מדידה שלי (4004 בלי vault= → "1s rebuilds").
  - **גורם:** `bootstrap.js:558` `if (vaultId) serverCache.set(...)` — guard שקיים מהrelease הראשון (אומת ב-`git show 9c0bec8`). לא נגע בו הסליס.
  - **חומרה:** minor / document-only. הצרכן האמיתי תמיד שולח vault=, אז הנתיב הזה לא נפגע בפועל. מציין רק שאם client אי-פעם ישמיט vault=, טענת ה-cold-perf לא תחול.

## סיווג ל-patterns.md

| באג | קטגוריה | הערה |
|------|----------|------|
| NBug1 (rename ללא content) | קטגוריה 1 (TDD ירוק ≠ התנהגות נכונה) + spec-drift | `updateEntryFile` unit-tests ירוקים על ה-contract הפנימי; אף טסט לא מפעיל את rename דרך ה-flow המלא ומשווה ל-full re-scan. ה-brief עצמו לא ציין content ל-new path. |
| NBug2 (dir-mtime stale) | קטגוריה 1 + spec-drift | unit-tests של invalidate ירוקים; integration test של incremental משווה fs/dirs אבל לא תפס את ה-parent-listing dir-mtime. הדרישה "byte-for-byte identical" לא נאכפה בטסט. |
| NBug3 (fallback uncached) | unique (pre-existing) | מחוץ ל-scope; לתיעוד בלבד. |

## סיכום לסוכן הבא (אליעזר של ה-fix)

הסליס **פונקציונלי ובטוח למיזוג מבחינת התנהגות-משתמש** — אין flow שבור, אין regression, ה-bug המקורי (cache wipe בכל write) תוקן ושני נתיבי-המחיקה מטופלים. הפער היחיד מ-GO מלא הוא שתי סטיות-contract מ-full re-scan שמפֵרות את הדרישה המפורשת "byte-for-byte identical" אך לא שוברות שימוש בפועל.

עדיפות לתיקון:
1. **NBug1 (rename content)** — הכי משמעותי: stat שגוי (size=0/mtime=0) על קובץ אחרי rename יכול לבלבל את ה-metadata index של Obsidian. תיקון: ב-`/rename` להעביר content/size/mtime ל-new path (קריאת stat+read של newPath אחרי ה-rename), או ל-fall-back ל-`removeEntryPath(old)` + re-stat של new מהדיסק.
2. **NBug2 (dir-mtime)** — לעדכן את ה-entry של ה-dir שהשתנה בתוך `dirs[parent]` (וב-Phase2 גם את `fs[parent]`) בכל add/remove. נמוך-impact אך נדרש ל-"identical to full".
3. **NBug3** — לתעד או לתקן בנפרד; לא חוסם את הסליס.

**הערה על DoD#3:** טענת ה-cold-perf (37s→2s) לא ניתנת לאימות עצמאי בסביבה זו (אין root ל-drop_caches; VFS חם). אימתתי רק שה-knob מגיע ל-libuv ושאין regression במצב חם. אם הטענה קריטית למיזוג — מומלץ אימות חד-פעמי על VFS קר אמיתי (restart rclone / מכונה עם root).
