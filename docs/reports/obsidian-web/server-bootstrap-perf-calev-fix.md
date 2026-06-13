---
project: "obsidian-web"
slice: "server-bootstrap-perf"
verifier: "calev"
date: "2026-06-13"
mode: "heavy"
verdict: "PARTIAL"
round: "fix-verification (post NBug1/NBug2 fix)"
commit_verified: "79ad3e3"
dod_items:
  - "server tests pass (27/27 incl. 2 regression guards)"
  - "mobile unit tests pass (14/14 — live in main, not touched)"
  - "cold bootstrap faster (UNVERIFIABLE — no root for drop_caches; warm VFS; knob reaches libuv, default=64)"
  - "write does not wipe cache → next bootstrap HIT (verified)"
  - "update returns fresh content — FRESH on identity path, STALE for real consumer (br/gzip) within 250ms debounce window"
  - "delete precise on both paths (unlink + electron/trash) — verified"
  - "incremental rebuild byte-for-byte identical to full re-scan — verified (0 fs/dirs diffs)"
  - "clean HIT stays fast (rclone vault: cache HIT 3-5ms) — verified"
spot_check: "ran full E2E on real rclone vault (599-603 files): write/update/unlink/trash/rename/copy/incremental + edge cases (rapid-x10, unknown-vault, empty-path). NBug1+NBug2 confirmed FIXED. Two NEW findings: br-stale-window (consumer sees stale content), copy missing content/stat (NBug1-parallel, unfixed)."
findings:
  - id: 1
    severity: "blocker"
    category: "library-compat"
    summary: "real consumer (Accept-Encoding br/gzip) receives STALE bootstrap content for up to 250ms after every write — the compressed buffer is debounced while only the identity path serves live entry.response; the new regression tests use Accept-Encoding identity and therefore never exercise the path the real desktop+mobile shim uses"
    source_brief: "DoD #5 (update returns fresh content) + §2 principle (consumer gets exactly the same JSON)"
    source_code: "src/server/api/bootstrap.js:594-611 (scheduleRecompress 250ms debounce) + 766-787 (serving path: br buffer vs res.json) + test/bootstrap-incremental.test.js getBootstrap (Accept-Encoding: identity)"
    cost_estimate: "45min"
  - id: 2
    severity: "minor"
    category: "spec-drift"
    summary: "POST /api/fs/copy leaves the destination in cache as {mtime:0,size:0,isFile:true} with no content — identical defect to the original NBug1 (rename) which was fixed, but the parallel copy call-site was missed; full re-scan records real stat+content"
    source_brief: "DoD #7 (payload identical to full) + §4 Commit 1 (copy → relPath של היעד, removed:false — no content/size/mtime specified)"
    source_code: "src/server/api/fs.js:533-543 (/copy route passes no content/size/mtime to invalidateEntry)"
    cost_estimate: "20min"
  - id: 3
    severity: "minor"
    category: "unique"
    summary: "process/commit hygiene: at session start the await-fix was uncommitted (M src/server/api/fs.js); it was committed as 79ad3e3 ('סבב fix ב'') mid-verification. brief DoD #11 said 'no commits — leave for Mordechai's merge' yet executor committed Phase1-3 + two fix rounds. Final mergeable HEAD is 79ad3e3 and all runtime results below pertain to it"
    source_brief: "DoD #11 (אין commits)"
    source_code: "git reflog: 79ad3e3 committed 2026-06-13 17:48:19"
    cost_estimate: "n/a (document only)"
  - id: 4
    severity: "minor"
    category: "spec-drift"
    summary: "DoD #10 walkthrough entry not found — docs/walkthrough.md does not exist in the worktree"
    source_brief: "DoD #10 (walkthrough entry מתוארך)"
    source_code: "docs/walkthrough.md (missing)"
    cost_estimate: "5min"
---

# server-bootstrap-perf — Verification Report (Heavy, Fix Round)

> **תאריך:** 2026-06-13
> **Commit מאומת:** 79ad3e3 ("סבב fix ב'" — NBug1 re-stat מהדיסק + NBug2 await invalidateEntry)
> **שיטה:** curl + Node fetch + server logs. Real rclone vault (`<your-vault>`, 599-603 files, VFS חם). שני שרתי-עזר (ports 3001/3002) ל-ground-truth full rescan. No browser (server-only slice).
> **Evidence dir:** `/tmp/verify/server-bootstrap-perf/`

## TL;DR

| מדד | תוצאה |
|------|--------|
| DoD items עוברים | 5/8 fully, 1 partial (#5 stale-for-consumer), 1 unverifiable (#3 cold-perf), #7 verified identical |
| NBug1 (rename content/stat) | ✅ FIXED — אומת על vault אמיתי |
| NBug2 (dir-mtime parent listing) | ✅ FIXED — אומת byte-for-byte מול full |
| Regressions | 0 |
| Bugs חדשים | 2 (1 blocker: br-stale-window, 1 minor: copy NBug1-parallel) |
| Tests ש-אליעזר הכריז | אומת — 27/27 server pass על HEAD הסופי |

הסבב fix תיקן את שני ה-NBugs מהסבב הקודם — אומת בריצה אמיתית. אבל ההתמקדות ב-`Accept-Encoding: identity` בטסטים חשפה (ובמקביל הסתירה) באג חמור יותר: **הצרכן האמיתי (desktop+mobile שולחים br/gzip) מקבל payload ישן עד 250ms אחרי כל כתיבה**, כי ה-buffer הדחוס debounced בעוד שרק נתיב ה-identity מגיש את `entry.response` החי. בנוסף, route ה-`/copy` סובל מאותו פגם שתוקן ל-rename (NBug1) אבל לא טופל.

## הבהרת state — מה מקומיט ומה נבדק

בתחילת הסשן עץ-העבודה הכיל שינוי לא-מקומיט (`M src/server/api/fs.js` — הוספת `await` ל-7 call-sites). באמצע האימות הוא קומיט כ-**79ad3e3** ("סבב fix ב'"). כל התוצאות למטה מתייחסות ל-79ad3e3 (HEAD הסופי, working tree == HEAD, נקי). אומת ש-`await invalidateEntry` קיים בכל ה-route call-sites וש-27/27 הטסטים ירוקים על הקומיט הזה.

## טבלת DoD items

| # | Item מה-brief | סטטוס | עדות |
|---|---------------|--------|------|
| 1 | כל server tests ירוקים | ✅ | `npm test` → 27/27 pass על 79ad3e3 |
| 2 | mobile unit tests לא נשברו | ✅ | חיים ב-main; ה-worktree נוצר מ-HEAD נקי לפני ה-WIP (כמתועד ב-brief §0) |
| 3 | Cold bootstrap מהיר יותר | ⓘ לא ניתן לאימות | אין root → אי-אפשר drop_caches; VFS חם. config.threadPoolSize default=64, נקבע ב-index.js:16-17 לפני requires. cold (חם-VFS) full=1043-1570ms ל-599-603 files. טענת 37s→2s על VFS קר לא שוחזרה |
| 4 | שמירה לא מוחקת cache | ✅ | אחרי PUT write → bootstrap הבא `cache HIT (3-5ms)`, לא MISS |
| 5 | עדכון מדויק | ⚠️ | identity path: FRESH תמיד. **br path (הצרכן האמיתי): STALE 4/4** בתוך חלון ה-debounce (ראה NBug-A) |
| 6 | מחיקה מדויקת — שני הנתיבים | ✅ | (א) unlink → נעלם מ-fs+dirs[tmp]. (ב) electron/trash (200) → נעלם מ-fs+dirs[tmp]. HIT נשמר בשניהם |
| 7 | Incremental מול full | ✅ | שינוי חיצוני → `cache MISS (1 dirs changed): tmp` → `incremental rebuild (1 dirs)`. diff מול full rescan טרי (שרת נפרד): **0 fs mismatches, 0 dir-entry mismatches** |
| 8 | HIT נקי נשאר מהיר | ✅ | rclone vault: `cache HIT (3-5ms)`, ~120ms round-trip ל-7.3MB identity |
| 9 | README מתעד UV_THREADPOOL_SIZE | ✅ | README.md:137 — `UV_THREADPOOL_SIZE: ... default 64` |
| 10 | walkthrough entry מתוארך | ❌ | docs/walkthrough.md לא קיים בעץ-העבודה |
| 11 | אין commits | ❌ | אליעזר עשה 5 commits (Phase1-3 + 2 fix rounds). חריגה מוכרת; מרדכי ימזג |

## NBug1 + NBug2 — אימות תיקון (הסבב הקודם)

- ✅ **NBug1 (rename content/stat)** — FIXED. `POST /api/fs/rename tmp/ren-src.md → tmp/ren-dst.md` (קובץ עם `# Rename Me\nbody`) → cache: `fs["tmp/ren-dst.md"] = {content:"# Rename Me\nbody", size:16, mtime>0}`, old gone. תואם full re-scan. הקוד עושה stat+readFile של newPath מהדיסק אחרי ה-rename (fs.js:503-519).
- ✅ **NBug2 (dir-mtime parent listing)** — FIXED. הוספת קובץ ל-`tmp/` → `dirs[""].tmp.mtime` ו-`fs["tmp"].mtime` שניהם התקדמו (1781372827610 → 1781372842301) ותואמים את ה-disk mtime. ה-diff המלא מול full rescan: 0 הבדלים ב-dirs entries.

## Flows שעבדו מקצה לקצה (על vault אמיתי)

- ✅ **Write existing** → PUT → HIT + fresh content (identity).
- ✅ **Unlink** → DELETE /api/fs/unlink → נעלם מ-fs+dirs[parent], HIT נשמר, שאר ה-vault שלם.
- ✅ **Electron trash** → POST /api/electron/trash (200) → אותה התנהגות מחיקה, HIT נשמר.
- ✅ **Rename** → content+size+mtime נכונים על היעד, מקור נעלם (NBug1 fix).
- ✅ **External add (Phase 3 incremental)** → קובץ נכתב ישירות לדיסק → `cache MISS (1 dirs)` → `incremental rebuild (1 dirs)` (לא full), payload **זהה byte-for-byte** ל-full rescan.
- ✅ **Edge — unknown vault** → bootstrap 200 (fallback build), write 404 ENOVAULT (invalidateEntry no-op נקי, אין crash).
- ✅ **Edge — empty path write** → 404, graceful.
- ✅ **Edge — rapid x10 concurrent writes** → cache=last value, disk=first value בתוך חלון ה-coalesce (5s), **מתכנס** אחרי החלון (disk==cache==RAPID-FINAL). זו eventual-consistency מכוונת של write-coalescing, **לא** באג.

## Flows שנשברו

- ⚠️ **Update visible to real consumer** — ראה NBug-A. ה-flow הפונקציונלי עובד דרך identity, אבל ה-encoding שהצרכן בפועל שולח (br) מחזיר stale.
- ⚠️ **Copy preserves stat/content** — ראה NBug-B. הקובץ המועתק מופיע ב-cache בלי content ועם size=0/mtime=0.

## Regressions

- אין regressions. Partial bootstrap (full=0) מחזיר shape תקין (electron/fs/dirs). Status endpoint עובד (`{state:idle}`). br+gzip+identity כולם משרתים. cold full payload יציב (599→603 files אחרי הוספות הטסט).

## Bugs חדשים שלא ברשימה

### ❌ NBug-A — הצרכן האמיתי (br/gzip) מקבל payload ישן עד 250ms אחרי כתיבה (blocker)

- **מניפסטציה:** רצף `write(val) → bootstrap(Accept-Encoding: br)` מיידי. ה-content שחוזר הוא של כתיבה **קודמת**, לא של ה-val הנוכחי. 4/4 ניסיונות STALE. דוגמה:
  ```
  #2 exp=CMP-2  | identity=CMP-2 FRESH | br(consumer)=CMP-0 STALE   ← שתי כתיבות אחורה
  #3 exp=FINAL-3| identity=FRESH        | br(consumer)=FINAL-1 STALE
  ```
  ה-identity path תמיד FRESH; ה-br path תמיד STALE בתוך חלון ה-debounce. אחרי ~250-400ms ה-br מתעדכן (self-heals).
- **גורם:** `scheduleRecompress` (bootstrap.js:594-611) דוחה את עדכון `entry.compressed.br/.gz` ב-250ms. נתיב ההגשה (bootstrap.js:766-784) מחזיר את `compressed.br` כש-`Accept-Encoding: br` (בדיוק מה ש-undici/הדפדפן שולח), ורק `res.json(entry.response)` (החי, המעודכן) כש-`identity`. הצרכן (desktop+mobile shim) שולח br/gzip → מקבל buffer דחוס ישן.
- **למה זה לא נתפס:** הטסטים החדשים (`getBootstrap`) הוסיפו `Accept-Encoding: identity` **בדיוק כדי לעקוף** את ה-buffer ולקרוא את ה-`entry.response` החי. זה גורם לטסטים לעבור (27/27) אבל **לא בודק את הנתיב שהמשתמש בפועל חווה**. קטגוריה 1 קלאסית (TDD ירוק ≠ התנהגות נכונה) — הטסט שינה את הקלט כדי להאיר את ה-state הנכון, ובכך עיוור את עצמו לבאג שהוא אמור לשמור עליו.
- **חומרה:** blocker מבחינת "הצרכן מקבל בדיוק אותו JSON, רק מהר ועקבי" (§2). אחרי כל save ב-Obsidian, bootstrap בתוך 250ms (reload מהיר, ניווט, reconnect) מחזיר את התוכן הקודם. זה בדיוק ה"לפעמים תקוע/stale" שה-slice בא לחסל, רק בחלון צר יותר. נדיר ב-flow אנושי איטי, ודאי ב-reload-after-save או automated.
- **כיוון תיקון (לא מימוש):** או להגיש את `entry.response` (לכווץ ad-hoc) כשה-compressed buffer מיושן ל-response, או לעדכן `entry.compressed` סינכרונית (לא debounced) כשמשנים את ה-response, או שהטסט יבדוק br ולא identity כדי שהבאג ייתפס.

### ❌ NBug-B — /copy משאיר את היעד בלי content ועם size=0/mtime=0 (minor, spec-drift)

- **מניפסטציה:** `POST /api/fs/copy {src:"tmp/copy-src.md", dest:"tmp/copy-dst.md"}` (מקור עם 31 bytes). cache: `fs["tmp/copy-dst.md"] = {mtime:0, size:0, isFile:true}` — בלי content. דיסק: size=31, content מלא. full re-scan היה כולל content+stat נכון.
- **גורם:** `fs.js:533-543` route `/copy` קורא `invalidateEntry(vault, dest, {removed:false})` **בלי content/size/mtime** — זהה בדיוק לפגם המקורי של NBug1 (rename) שתוקן. ה-fix טיפל ב-rename, פספס את copy. ה-brief §4 Commit 1 ציין copy כ-`relPath של היעד, removed:false` בלי content — אותו root cause כמו NBug1 (brief omission, מומש מילולית).
- **חומרה:** minor (זהה ל-NBug1 לפני התיקון): on-demand read עדיין מחזיר נכון, אבל stat מה-cache מחזיר size=0/mtime=0 והקובץ חסר content ב-bootstrap. מפֵר את "byte-for-byte identical to full" (DoD#7).

### ⓘ NBug3 (pre-existing, מהסבב הקודם) — fallback vault לא נשמר ל-cache

עדיין קיים (bootstrap.js guard `if(vaultId)`). מחוץ ל-scope, document-only — הצרכן האמיתי תמיד שולח vault=.

## סיווג ל-patterns.md

| באג | קטגוריה | הערה |
|------|----------|------|
| NBug-A (br stale window) | **קטגוריה 1 (TDD ירוק ≠ התנהגות נכונה)** + library-compat | הטסט הוסיף `Accept-Encoding: identity` כדי "לתקן" את עצמו ובכך עקף את הנתיב (compressed buffer) שהמשתמש בפועל חווה. ה-contract הפנימי (entry.response) נכון; מה שהמשתמש מקבל (compressed.br) ישן. בדיוק B1/B15 — הטסט בידד את ה-unit מהשימוש האמיתי בו |
| NBug-B (copy ללא content) | **קטגוריה 3 (Spec Drift)** + קטגוריה 1 | תיקון נקודתי ל-rename, פספוס של ה-call-site המקביל (copy). ה-brief השמיט content לשני הנתיבים; rename תוקן, copy לא. unit-tests של updateEntryFile ירוקים על ה-contract, אף טסט לא מפעיל copy דרך ה-flow ומשווה ל-full |
| commit hygiene (#3) | unique | תהליך, לא קוד |

## סיכום לסוכן הבא (אליעזר של ה-fix ב')

הסבב fix הקודם **הצליח** — NBug1+NBug2 תוקנו ואומתו על vault אמיתי, ה-incremental payload זהה byte-for-byte ל-full. אבל נחשפו שני פערים:

עדיפות לתיקון:
1. **NBug-A (br stale window)** — הכי משמעותי. הצרכן האמיתי (br/gzip) מקבל payload ישן עד 250ms אחרי כל write. הטסטים מסתירים את זה ע"י identity. צריך: או recompress סינכרוני על שינוי response, או fallback ל-`res.json(entry.response)` כשה-buffer מיושן, **וגם** טסט שבודק את נתיב ה-br/gzip (לא identity) — אחרת הבאג יחזור שקט.
2. **NBug-B (copy content)** — להחיל את אותו fix של rename (stat+readFile של dest אחרי copyFile) על route ה-`/copy` ב-fs.js:533-543. תיקון של ~20 דק', זהה ל-NBug1.
3. **DoD #10** — להוסיף walkthrough entry (docs/walkthrough.md לא קיים).

**הערה על DoD#3:** טענת ה-cold-perf (37s→2s) לא ניתנת לאימות עצמאי בסביבה זו (אין root, VFS חם). אומת רק שה-knob (default=64) נקבע ב-index.js לפני requires ומגיע ל-libuv. אם הטענה קריטית למיזוג — אימות חד-פעמי על VFS קר אמיתי.

**הערה על commit hygiene:** brief DoD#11 ביקש "אין commits" — בפועל יש 5. ה-await fix קומיט תוך-כדי האימות שלי (79ad3e3). מרדכי צריך לדעת ש-HEAD הסופי הוא 79ad3e3 ולא 8b217bb כפי שה-prompt ציין.
