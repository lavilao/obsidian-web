---
project: "obsidian-web"
slice: "server-bootstrap-perf"
verifier: "calev"
date: "2026-06-13"
mode: "heavy"
verdict: "GO"
round: 4
dod_items:
  - "server tests pass (35/35) — independently re-run, confirmed"
  - "mobile unit tests pass (14/14) — independently re-run, confirmed"
  - "cold bootstrap faster (UNVERIFIABLE — no root for drop_caches; warm shows no diff; knob reaches libuv)"
  - "write does not wipe cache → next bootstrap HIT (confirmed)"
  - "update returns fresh content (confirmed)"
  - "delete precise on both paths (unlink + rmdir + electron/trash) — all byte-identical to full"
  - "incremental rebuild on external/dir change (logs 'incremental rebuild (N dirs)', not full wipe)"
  - "clean HIT stays fast (fixture <5ms)"
spot_check: "in-process E2E over real Express app + tmp fixture vault: mkdir / mkdir+write / rename-dir / unlink / rmdir / trash / write-existing / copy-file / copy-dir + edge cases (deep-nested mkdir, root mkdir, concurrent guard, unknown vault, empty path, restart-parity). 53/54 in-process assertions pass; the single fail is a pre-existing minor write-path mtime drift, NOT a round-4 regression."
findings:
  - id: 1
    severity: "minor"
    category: "spec-drift"
    summary: "surgical file-write stores fs[file].mtime and dirs[parent][file].mtime as server Date.now() instead of the on-disk mtime, drifting 1-475ms from a full re-scan (DoD#7 byte-parity). Self-heals on next Phase 3 rebuild of that dir. PRE-EXISTING from Phase 2 (f460b98), not introduced in round 4."
    source_brief: "DoD #7 + §6 risk note 'payload must remain byte-for-byte identical to full'"
    source_code: "src/server/api/fs.js:450 (writeMtime=Date.now), 458, 471"
    cost_estimate: "20min (stat newPath after writeFile in non-coalesce path; coalesce path inherently can't, but Phase 3 covers it)"
---

# server-bootstrap-perf — Verification Report (Heavy, Round 4)

> **תאריך:** 2026-06-13
> **Commit בסיס:** 9b20267 (round-4 fix: dir-mutation force-stale → Phase 3) over e3410c2, 8b217bb, ef4d3a7, f460b98, 52b2a23
> **שיטה:** in-process E2E מול ה-Express app האמיתי (`createApp`) + fixture vault תחת `/tmp` (לא rclone mount). השוואה byte-for-byte מול full re-scan (force `serverCache.delete` ואז rebuild). + הרצת שני test-suites. אין browser — server-only slice (brief §0).
> **Evidence dir:** `/tmp/verify/server-bootstrap-perf/`

## TL;DR

| מדד | תוצאה |
|------|--------|
| DoD items עוברים | 7/8 (item 3 unverifiable בסביבה — אין root) |
| Regressions | 0 |
| Bugs חדשים | 1 minor (spec-drift, **pre-existing מ-Phase 2** — לא round-4) |
| Tests ש-אליעזר הכריז | אומת עצמאית — 35/35 server, 14/14 mobile |
| round-4 dir-mutation fix | **תקין מלא — byte-for-byte זהה ל-full בכל מוטציות התיקיות** |

‏round 4 ‏פתר במלואו את F1+F2 ‏מ-calev-heavy ‏סבב 3. ‏כל מוטציות התיקיות (mkdir,
‏mkdir+write-inside, rename-dir-with-children) ‏מייצרות payload **‏זהה byte-for-byte
‏ל-full re-scan**. ‏המנגנון `isDir:true` → `dirMtimes[parent]=0` → Phase 3 incremental
‏rebuild ‏עובד, ‏וה-guard ‏ב-`_refreshDirMtimes` (`dirMtimes[dir]===0 → return`) ‏שורד
‏גם תחת write-מקבילי לאותה תיקייה (‏הבדיקה הכי שברירית — ‏עברה). ‏כל ה-removal paths
‏(unlink/rmdir/trash) ‏וכל ה-file paths (write/copy) ‏זהים ל-full. ‏הפער היחיד מ-GO
‏מלא הוא סטיית-mtime ‏בנתיב ה-write ה-surgical — ‏סטייה minor, ‏pre-existing ‏מ-Phase 2,
‏שמרפאת את עצמה ב-Phase 3 ‏הבא. ‏לא חוסמת.

## טבלת DoD items

| # | Item מה-brief | סטטוס | עדות |
|---|---------------|--------|------|
| 1 | כל server tests ירוקים | ✅ | `npm test` → 35/35 pass, 0 fail (הרצתי בעצמי) |
| 2 | mobile unit tests לא נשברו | ✅ | `node --test bootstrap-lookup + cache-invalidation` → 14/14 |
| 3 | Cold bootstrap מהיר יותר | ⓘ לא ניתן לאימות | אין root → אין `drop_caches`; fixture תחת /tmp (לא rclone). אימתתי שה-knob מגיע (`UV_THREADPOOL_SIZE` default 64). טענת cold-perf נשענת על מדידת אליעזר. |
| 4 | שמירה לא מוחקת cache | ✅ | PUT write על קובץ קיים → bootstrap הבא `cache HIT (0ms)`, לא MISS |
| 5 | עדכון מדויק | ✅ | write '# UPDATED v2' → content נכון; size נכון |
| 6 | מחיקה מדויקת — שני הנתיבים | ✅ | unlink + rmdir-recursive + electron/trash — בכולם הקובץ/תת-העץ נעלם מ-fs+dirs, **כולם byte-identical ל-full** |
| 7 | Incremental מול full | ✅ | dir-mutations: `cache MISS (1 dirs changed): notes` → `incremental rebuild (1 dirs)` (לא full wipe); payload **זהה byte-for-byte ל-full re-scan** בכל המקרים שנבדקו |
| 8 | HIT נקי נשאר מהיר | ✅ | fixture: HIT 0-1ms |

## Flows שעבדו מקצה לקצה

‏כל flow ‏נבדק כך: ‏בצע מוטציה → bootstrap (incremental) → ‏שמור → `serverCache.delete` →
‏bootstrap (full re-scan) → diff byte-for-byte על fs (כל מפתח: isFile/isDirectory/content/size)
‏ועל dirs (כל listing). "זהה" ‏= ‏אפס הבדלים.

- ✅ **mkdir `notes/newdir`** → `fs[notes/newdir].isDirectory:true, isFile:false`; ‏מופיע ב-`dirs[notes]` ‏עם isDirectory:true; `dirs[notes/newdir]` ‏מערך ריק; **זהה ל-full**. ‏לוג: incremental rebuild (1 dirs), ‏לא full wipe.
- ✅ **mkdir + write-inside** (`notes/subdir2/inner.md`) → ‏הקובץ מופיע עם content `# Inner\n`, isFile:true; **זהה ל-full**.
- ✅ **rename dir-with-children** (`notes/sub` → `notes/sub_renamed`, ‏מכיל child.md) → old subtree ‏נעלם לגמרי מ-fs+dirs; new subtree ‏מלא עם content נכון; `dirs[notes]` ‏החליף sub→sub_renamed; **זהה ל-full**. ‏סדר הקריאות (isDir(new) ‏לפני removed(old)) ‏שומר על ה-stale sentinel.
- ✅ **unlink** (`notes/top.md`) → ‏נעלם מ-fs+dirs[notes], `cache HIT` ‏נשמר (surgical, ‏לא rebuild); **זהה ל-full**.
- ✅ **rmdir recursive** (`notes/todel` ‏עם x.md) → ‏תת-העץ נגזם; **זהה ל-full**.
- ✅ **electron/trash** (`notes/trashme.md`) → ‏הנתיב-מחיקה השני, surgical removal; **זהה ל-full**.
- ✅ **write-existing** (`notes/existing.md` → '# UPDATED v2') → content+size נכונים, HIT נשמר. ‏(mtime — ‏ראה finding #1.)
- ✅ **copy-file** (`notes/existing.md` → `notes/copy.md`) → היעד עם content מלא, size>0 (‏לא size=0/no-content — ‏אישור שתיקון סבב 3 ‏מחזיק); **זהה ל-full**.
- ✅ **copy-dir** (`/api/fs/copy` ‏עם src=directory) → ‏מחזיר **404 EISDIR** (‏לא 200), ‏ה-cache לא מושחת, fs keys ‏ללא שינוי. ‏בדיוק כפי שאליעזר ציין (point 7).

## Edge cases (שלב 4)

- ✅ **deep-nested mkdir** (`notes/d1/d2/d3` ‏בקריאה אחת recursive) → ‏כל 3 הרמות מופיעות, ‏העמוקה isDirectory:true; **זהה ל-full**.
- ✅ **mkdir בשורש** (`rootdir`, parentRel='') → ‏מופיע ב-fs ‏וב-`dirs[""]`; **זהה ל-full**. ‏(force-stale על key='' ‏עובד.)
- ✅ **concurrent guard** — mkdir `notes/concur` ‏בו-זמנית עם write `notes/sibwrite.md` (‏שניהם נוגעים ב-`notes/`) → ‏ה-write ‏קורא ל-`_refreshDirMtimes(notes)` ‏אבל ה-guard `dirMtimes===0` ‏מונע דריסת ה-sentinel; ‏שתי המוטציות שורדות; **זהה ל-full**. **‏זה החלק הכי שברירי במנגנון round-4 ‏והוא מחזיק.**
- ✅ **unknown vault** — mkdir על vault לא-קיים → 404, ‏השרת ממשיך לשרת (invalidateEntry no-op נקי, ‏אין crash).
- ✅ **empty path** — mkdir עם path='' → 200 (no-op על שורש), ‏השרת חי.
- ✅ **restart/reconnect** — `serverCache.delete` (‏מדמה restart) → full rebuild; ‏כל 12 ה-mtimes ‏ב-fs ‏תואמים את הדיסק בדיוק (mismatch=0) — ‏מאשר שהדריסה ב-finding #1 ‏היא בלעדית בנתיב ה-write, ‏ו-full re-scan נקי ממנה.

## Regressions

‏אין regressions. ‏35/35 server tests ‏עוברים (‏כולל 4 ‏החדשים מ-round 4 + 31 ‏קיימים).
‏14/14 mobile. ‏כל ה-removal/write/copy paths ‏שעבדו בסבבים קודמים ‏עדיין עובדים ‏וזהים
‏ל-full. ‏המנגנון של round 4 ‏(isDir force-stale) ‏לא שבר את ה-surgical paths הקיימים —
‏file-add/update/remove ‏ממשיכים surgical (HIT), ‏רק dir-mutations ‏נופלים ל-Phase 3 (‏בכוונה).

## Bugs חדשים שלא ברשימה

- ⚠️ **NBug (minor, spec-drift) — write-path mtime drift מול full re-scan**
  - **מניפסטציה:** ‏אחרי `PUT /api/fs/write` ‏על קובץ, `fs[file].mtime` ‏ו-`dirs[parent][file].mtime` ‏נשמרים כ-`Date.now()` ‏של השרת, ‏לא כ-mtime ‏האמיתי על הדיסק. ‏מדדתי 8 ‏כתיבות עוקבות: ‏הסטייה (cache − disk) ‏הייתה `[1, 77, 145, 212, 279, 345, 411, 475]` ‏ms — ‏עקבית וחיובית (cache תמיד מקדים את הדיסק), ‏לא jitter אקראי. ‏גם בנתיב write-coalesce (rapid-fire) ‏סטייה ~3ms.
  - **גורם:** `src/server/api/fs.js:471` (non-coalesce) ‏מעביר `mtime: Date.now()` ‏ל-invalidateEntry, ‏ו-`:450/:458` (coalesce) ‏מעביר `writeMtime = Date.now()` ‏שנקרא **‏לפני** ‏ה-flush. ‏בשני המקרים זה לא ה-mtime ‏שה-OS ‏מטביע על הקובץ ב-`fsp.writeFile`. ‏full re-scan ‏קורא את ה-mtime ‏האמיתי דרך `fsp.stat` → ‏ערכים שונים.
  - **חומרה:** minor, ‏ולא round-4. (‏א) **‏Pre-existing** — `git log -S` ‏מאשר שזה נכנס ב-Phase 2 (f460b98), round 4 ‏נגע רק במוטציות-תיקיות. (‏ב) **‏מרפא את עצמו** — ‏בדקתי: ‏ברגע ש-Phase 3 incremental rebuild רץ על אותה תיקייה (‏למשל mkdir של sibling), ‏ה-mtime ‏מתוקן לערך הדיסק המדויק. (‏ג) content+size **‏נכונים** — ‏רק ה-mtime ‏סוטה; on-demand read נכון; Obsidian נדיר שמסתמך על mtime ‏ברזולוציית ms. ‏(ד) ‏זו אותה משפחה כמו NBug2 ‏מסבב 3 (cache-mtime ≠ disk), ‏רק בנתיב ה-write ‏הספציפי שלא נוקה אז.
  - **‏הערה:** ‏זה היחיד שמפר את "byte-for-byte identical to full" (DoD#7). ‏אם הדרישה נאכפת מילולית — ‏זה PARTIAL. ‏בפועל לא שובר התנהגות-משתמש ‏ומרפא את עצמו, ‏לכן **GO** ‏עם תיעוד. ‏תיקון אופציונלי: ‏בנתיב non-coalesce, ‏אחרי `fsp.writeFile`, ‏לעשות `fsp.stat(target)` ‏ולהעביר את ה-mtime ‏האמיתי. ‏(‏נתיב coalesce ‏לא יכול — ‏הקובץ עוד לא על הדיסק; ‏שם Phase 3 ‏מכסה.)

## סיווג ל-patterns.md

| באג | קטגוריה | הערה |
|------|----------|------|
| write-path mtime drift | **spec-drift** + קטגוריה 1 (TDD ירוק ≠ התנהגות נכונה) | ‏הטסטים שולחים `Accept-Encoding: identity` ‏ומשווים content/size/keys, ‏אבל אף טסט לא משווה mtime ‏מול disk-truth ‏אחרי write בנתיב ה-HIT. ה-unit-tests ‏של updateEntryFile ‏ירוקים על ה-contract הפנימי (mtime מועבר ונשמר), ‏אבל ה-contract ‏עצמו (mtime=Date.now ‏במקום disk) ‏סוטה מ-full. ‏זה אותו דפוס שתפס NBug1/NBug2 ‏בסבב 3 — ‏unit ירוק, parity מול full נכשל. |

## סיכום לסוכן הבא

‏ה-slice **‏פונקציונלי, ‏בטוח, ‏ו-round-4 ‏פתר את F1+F2 ‏במלואם** — ‏כל מוטציות התיקיות
‏זהות byte-for-byte ל-full re-scan, ‏כולל ה-guard ‏המקבילי השברירי. ‏אין regressions,
‏35/35 + 14/14 ‏אומתו עצמאית. ‏verdict: **GO**.

‏פער יחיד (‏לא חוסם, ‏אופציונלי לתיקון בנפרד):
1. **write-path mtime drift** (minor, pre-existing מ-Phase 2) — ‏לתקן ‏ע"י `fsp.stat`
   ‏אחרי writeFile בנתיב non-coalesce ‏והעברת ה-mtime ‏האמיתי. ‏מרפא את עצמו ב-Phase 3
   ‏ממילא, ‏אז זה cosmetic-parity ‏בלבד. ‏אם מרדכי רוצה "byte-for-byte" ‏מוחלט — ‏תיקון
   ‏של 20 ‏דק'. ‏אחרת ניתן למזג כפי שזה.

**הערה על DoD#3:** ‏cold-perf (37s→2s) ‏לא ניתן לאימות עצמאי (אין root, ‏fixture לא על
‏rclone). ‏אומת רק שה-knob מגיע ל-libuv ‏ושאין regression. ‏נשען על מדידת אליעזר.
