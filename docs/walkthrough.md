# obsidian-web - יומן פיתוח

> פרויקט שמריץ את Obsidian (Electron) בדפדפן רגיל, על-ידי החלפת תלויות Electron ב-shims שמדברים HTTP עם שרת Node.js.

---

## 2026-06-13 — server-bootstrap-perf: סבב Fix רביעי (מוטציות תיקיות — F1+F2)

**Branch**: `server-bootstrap-perf` | **Commits**: e3410c2..HEAD (סבב fix רביעי)

### מה בוצע

תיקון F1+F2 שנמצאו ב-calev-heavy סבב 3 (PARTIAL): מוטציות תיקיות (mkdir, rename-dir) לא ייצרו payload תקין ב-bootstrap הבא.

**F1 — `updateEntryFile` מתייג תיקייה כ-isFile:true (bootstrap.js, fs.js)**:
- `/mkdir` קרא ל-`invalidateEntry({removed:false})` → `updateEntryFile` → `isFile:true` על ה-entry. עם `isText=false`, ה-entry לא נכנס לfs בכלל (חסר).
- `/rename` עם יעד תיקייה: סטאט newPath → `isDirectory=true`, אבל קרא ל-`updateEntryFile` שלא יודע לטפל בתיקיות.

**F2 — `_refreshDirMtimes` מסתיר את ה-MISS (bootstrap.js)**:
- `_refreshDirMtimes` (fire-and-forget) מרענן `dirMtimes[parent]` ל-mtime הנכון → Phase 3 לא מגלה changedDir → תיקייה חדשה/ששונתה לא נבנית.

**הפתרון — `isDir: true` flag ב-`invalidateEntry`**:
- כש-`isDir=true`: לא קורא `updateEntryFile` (F1). כופה `entry.dirMtimes[parent] = 0` (stale sentinel) — Phase 3 מוצא changedDir ובונה את הסאבטרי נכון (F2).
- Guard ב-`_refreshDirMtimes`: אם `dirMtimes[dir] === 0`, לא דורס (שומר את ה-stale).
- **סדר קריאות ב-rename-dir חיוני**: `invalidateEntry(newRel, {isDir:true})` תחילה (מכפה `=0`), ואחר כך `invalidateEntry(oldRel, {removed:true})` (fire-and-forget של `_refreshDirMtimes` יבדוק guard ויוותר).

**call-sites שעודכנו**:
- `/mkdir` (fs.js): `{removed:false}` → `{isDir:true}`.
- `/rename` (fs.js): אם `renamedIsDirectory` → `invalidateEntry(newRel,{isDir:true})` ואז `invalidateEntry(oldRel,{removed:true})`; אחרת — התנהגות הקובץ הקיימת.
- `/rmdir`, `/unlink`, `/copy` (קבצים), electron `/trash` — **לא השתנו** (removal קיים עובד, copy רק קבצים).

### טסטים חדשים (TDD — 4 חדשים)

`test/bootstrap-dir-mutations.test.js`:
- `mkdir → isDirectory:true` + זהה ל-full re-scan.
- `mkdir + write-inside → file עם content`.
- `rename-dir-with-children → old gone, new subtree, identical to full`.
- `copy-dir → /api/fs/copy מחזיר שגיאה (copyFile files-only), cache לא מושחת`.

### תוצאות

`npm test` מ-`src/server/` — **35/35 ירוקים** (4 חדשים + 31 קיימים). Mobile: 14/14.

### חריגות / הכרעות מודעות

- **מוטציות תיקיות → Phase 3 (force-stale parent), לא surgical** — הכרעה מודעת. Phase 3 incremental rebuild בונה את הסאבטרי נכון byte-for-byte. תועד ב-§סטיות ב-brief.
- **סדר קריאות ב-rename-dir**: `isDir(new)` לפני `removed(old)` — נדרש בגלל timing של `_refreshDirMtimes` (fire-and-forget async יכול לסיים לפני הקריאה השנייה אם הסדר הפוך).
- `/copy` של תיקייה לא נתמך על-ידי `fsp.copyFile` → 404/500 מהשרת, cache תקין.

---

## 2026-06-13 — server-bootstrap-perf: סבב Fix שלישי (br-stale + copy-no-content + binary-in-fs)

**Branch**: `server-bootstrap-perf` | **Commits**: 79ad3e3..HEAD (סבב fix שלישי)

### מה בוצע

3 תיקוני correctness שנמצאו ב-calev-heavy סבב 2 ועל-ידי סוכן חקירה עצמאי:

**תיקון 1 — ביטול async מ-invalidateEntry (bootstrap.js:692)**:
- הפיכת `invalidateEntry` ל-`async` (סבב fix קודם, תיקון NBug2) גרמה latency על כל כתיבה על rclone mount.
- Phase 3 (incremental rebuild) כבר מכסה dir-mtime parity בחינם — ביטלנו את ה-await.
- `invalidateEntry` חזרה לsync. `_refreshDirMtimes` נשאר fire-and-forget (best-effort).
- הוסר `await` מ-7 call-sites ב-`fs.js` ומ-`electron.js`. ה-wrappers הפכו sync.

**תיקון 2 — gate isText ב-updateEntryFile + תיקון /copy (bootstrap-invalidate.js, fs.js)**:
- `updateEntryFile` לא בדק isText — בינארי/oversized נכנס ל-`fs` בניגוד ל-walkDir.
- הוספנו flag `isText` (מועבר מה-call-site): `isText=true` → עדכון fs עם content; `isText=false/undefined` → עדכון dirs בלבד.
- `/copy` (fs.js) פוספס בתיקון NBug1: עכשיו עושה stat+readFile של dest כמו rename.
- `/rename` נוקה: במקום שכפול הlist ב-rename handler, שימוש ב-`isTextInLimit()` helper.
- `isTextInLimit()` helper חדש ב-fs.js (mirrors TEXT_EXTENSIONS+MAX_CONTENT_BYTES מbootstrap.js).

**תיקון 3 — חלון ה-br/gzip (bootstrap.js)**:
- לקוח עם `Accept-Encoding: br` בתוך ה-250ms debounce קיבל buffer ישן.
- הוספנו `entry.compressedStale = true` ב-`scheduleRecompress` (מיידי), נמחק ל-`false` אחרי build buffer.
- ב-HIT path: אם `compressedStale` → מדלגים על buffer הדחוס, `res.json(entry.response)` (compression middleware מכווץ on-the-fly).

### טסטים חדשים (4 חדשים, כולל regression guards)

- `bootstrap-cache.test.js`: br HIT אחרי write מחזיר תוכן טרי; copy text file עם content/size/mtime; copy binary לא ב-fs רק ב-dirs.
- `bootstrap-invalidate.test.js`: binary file → NOT in fs, only in dirs listing.

### תוצאות

`npm test` מ-`src/server/` — **31/31 ירוקים** (4 חדשים + 27 קיימים). Mobile: 14/14.

### חריגות / הכרעות מודעות

- **dir-mtime parity**: Phase 3 (incremental rebuild) מכסה, לא invalidate — זו ההכרעה המודעת. תועד ב-§סטיות ב-brief.
- **HIT בחלון 250ms אחרי write**: משלם כיווץ ad-hoc חד-פעמי (compression middleware). HIT נקי (הרוב) לא נפגע.
- **isText flag מcall-site**: לא שכפלנו isTextFile לbootstrap-invalidate.js — העברנו flag כדי לשמור על טהרת המודול.

---

## 2026-06-13 — server-bootstrap-perf: תיקון NBug1+NBug2 (סבב Fix אחרי calev-heavy PARTIAL)

**Branch**: `server-bootstrap-perf` | **Commits**: ef4d3a7..HEAD (סבב fix)

### מה בוצע

שני תיקוני correctness שמצא calev-heavy (PARTIAL verdict) — הפרת "payload זהה ל-full re-scan" (DoD#7):

**NBug1 — rename מאבד content ומאפס stat (fs.js `/rename`)**:
- ה-WIP ניסה לקחת content/size/mtime מה-entry הישן ב-cache — אבל הסדר היה שגוי (מחיקת הentry לפני הקריאה), ובנוסף זה כשל אם הקובץ לא היה ב-cache (oversized/binary).
- הפתרון: re-stat+readFile של `newPath` מהדיסק אחרי ה-rename (כמפורט ב-brief §4 Commit 1). TEXT_LIMIT guard זהה ל-bootstrap.js.

**NBug2 — dir-mtime stale ב-dirs[parent] אחרי add (bootstrap.js + fs.js + electron.js)**:
- `_refreshDirMtimes` עדכן payload אבל היה fire-and-forget — bootstrap HIT שהגיע לפני שה-stat הסתיים קיבל mtime ישן.
- הפתרון: `invalidateEntry` הפך async ומ-await ל-`_refreshDirMtimes`. כך route handlers מחכים לסיום הrefresh לפני שמחזירים 200.
- `_refreshDirMtimes` גם קורא `scheduleRecompress` אחרי עדכון.
- כל call sites ב-`fs.js` ו-`electron.js` עודכנו ל-`await invalidateEntry(...)` (חוץ מ-write-coalesce path).

**2 regression guard tests** (`test/bootstrap-incremental.test.js`):
- `surgical rename: new path has content/size/mtime (NBug1 regression guard)`
- `surgical add: parent dirs listing has updated dir mtime (NBug2 regression guard)`

### תוצאות

`node --test 'test/*.test.js'` מ-`src/server/` — **27/27 ירוקים** (2 חדשים + 25 קיימים). Mobile tests: 14/14.

### חריגות

- write-coalesce path (ראשון write בחלון 5s): dir mtime לא מתעדכן עד flush (250ms). לאחר flush, bootstrap יהיה MISS → Phase3 incremental rebuild. מחוץ ל-scope (full re-scan גם לא היה רואה שינוי לפני flush).
- הכרעת NBug1: re-stat מהדיסק (לא מה-cache) — מתועד ב-§סטיות מהתכנון בbrief.

---

## 2026-06-13 — server-bootstrap-perf: Phase 3 (Commit 2) — Incremental rebuild

**Branch**: `server-bootstrap-perf` | **Commits**: 52b2a23..HEAD

### מה בוצע

ה-Phase הסופי של ה-slice. הוסיף ענף **incremental rebuild** ב-`_buildCacheEntry`:
- כש-`cached && changedDirs.length > 0 && cached.isFull === full` — בונה רק את התיקיות שהשתנו במקום full re-scan.
- לכל `relDir` ב-`changedDirs`: readdir → diff → prune למחיקות, `walkDir` לתת-תיקיות חדשות, `readFile` לקבצים חדשים/שונים, עדכון `dirs[relDir]` + `dirMtimes[relDir]` + `fsCache[relDir].size/mtime`.
- `entry.vaultRoot = vaultRoot` נשמר ב-entry לשימוש `_refreshDirMtimes`.
- `_refreshDirMtimes` פונקציה חדשה: מרעננת `dirMtimes` לאחר surgical invalidation (fire-and-forget).
- ניקוי dead code ב-`invalidateEntry` (WIP שנשאר אחרי reboot).

**Integration tests חדשים** (`test/bootstrap-incremental.test.js`, 5 טסטים):
- add file / delete file / rename file → correctness vs full re-scan.
- spy על readdir → מאמת שרק changedDirs נסרקו.
- HIT אחרי incremental rebuild.

### תוצאות

`npm test` מ-`src/server/` — **25/25 ירוקים** (5 חדשים + 20 קיימים).

### חריגות

- `incFsCache[relDir].size/mtime` עדכון — נוסף מעבר למפרט (נדרש ל-correctness).
- Phase 3 לא מטפל בשינוי תוכן של קובץ קיים (dir mtime לא משתנה) — מגבלה ידועה, גם בקוד המקורי.

---

**Live URL (pico tuns.sh, דטרמיניסטי):** https://<your-tunnel>.tuns.sh

**מסמכים נוספים:**
- [`PLAN.md`](../PLAN.md) - תכנון בן 5 פאזות.
- [`docs/investigations.md`](./investigations.md) - חקירות עומק לבעיות. **קרא לפני שחוקרים בעיה ידועה.**

---

## 2026-05-12 19:55

### Mobile bootstrap cache — האצה משמעותית של cold boot ב-mobile runtime

ה-mobile runtime (`/mobile`) לא ניצל את `/api/bootstrap` לקריאות FS עוקבות, רק לזיהוי הקבצים ב-`watchAndStatAll`. כל `Filesystem.readFile/stat/readdir` הפך ל-round-trip HTTP נפרד — מה שגרר ~100-300 בקשות עוקבות ב-cold boot של vault גדול. ה-desktop runtime כבר עשה את זה דרך `src/client/shims/original-fs.js`. עכשיו גם mobile.

ביצועים נמדדים על vault `009428c4` (394 קבצים, 68 תיקיות מקוננות, נתיב על rclone-mount של Google Drive):

| תרחיש | זמן ל-`workspace.layoutReady && metadataCache.inProgressTaskCount === 0` |
|---|---|
| Cold + `BOOTSTRAP_DISABLED=true` | 22.6s, 22.7s (mean 22.65s) |
| Cold + bootstrap enabled       | 6.9s, 2.7s (mean 4.8s) |
| Warm + bootstrap enabled       | 1.9s, 2.1s |

**הפחתה של 79%** לעומת disabled cold (יעד התוכנית: ≥60%). ב-warm server ל-2s בדיוק.

#### מה בוצע

**Phase 1 — שרת (`src/server/`):**

- `config.js`: בלוק חדש `bootstrap: { enabled, maxFileKB, maxTotalMB }` עם env vars `BOOTSTRAP_DISABLED`, `BOOTSTRAP_MAX_FILE_KB` (default 500), `BOOTSTRAP_MAX_TOTAL_MB` (default 50).
- `api/bootstrap.js`:
  - חילוץ `buildElectronValues(vaultId, vaultRegistry)` כפונקציה מודולרית — נדרש כדי שמסלול ה-disable יוכל לבנות electron values ללא FS walk.
  - `createBootstrapRouter(vaultRegistry, fallbackVaultRoot, bootstrapConfig)` — פרמטר שלישי חדש. אם `enabled === false`: מנקה `serverCache`, `buildProgress`, `pendingBuilds`, ולכל בקשה מחזיר `{ disabled: true, electron, fs: {}, dirs: {} }` בפחות מ-50ms.
  - State משותף `currentLimits = { maxContentBytes, maxTotalBytes }` שמתעדכן ב-`applyLimits(bootCfg)` בכל פעם ש-router נבנה (או `warmUpBootstrapCache` נקרא).
  - `walkDir(...)` קיבל פרמטר נוסף `budget = { remaining, capped }` — שימוש בו לגלישת תקציב גלובלי. כשגודל קובץ עולה מעל ה-remaining, מסמן `budget.capped = true` ומדלג. ה-stat עדיין נכנס ל-`dirs`.
  - בתגובה כשמתרחש cap: `response.capped = true; response.cappedReason = "total size limit reached (N MB)"`.
  - `warmUpBootstrapCache(vaultRegistry, fallbackVaultRoot, bootstrapConfig)` — מתפזר מיד אם `enabled === false`. גם מפעיל `applyLimits` כדי שה-warm-up יכבד את ה-caps.
- `index.js`:
  - `createApp(appConfig = {})` עכשיו ממזג עם `config` הגלובלי — מתקן באג קודם שגרם לכל הטסטים להיכשל אחרי ה-reorg של 2026-05-12 (test config לא סיפק `clientMobilePath` ו-`express.static` קרס על `undefined`).
  - מעביר `appConfig.bootstrap` ל-`createBootstrapRouter` ול-`warmUpBootstrapCache`.

**Phase 2 — Client helpers + שילוב ב-shim:**

- `src/client-mobile/package.json` חדש: `"test": "node --test test/*.test.js"`.
- `src/client-mobile/bootstrap-lookup.js` — מודול קטן ועצמאי עם `lookupContent / lookupStat / lookupDir`. ב-Node מייצא דרך `module.exports` (לטסטים), בדפדפן מצמיד ל-`window.__owBootstrapLookup`.
- `src/client-mobile/boot.js`: לאחר אימות ה-vault מוסיף `fetch('/api/bootstrap?vault=…&full=1')` במקביל להזרקת הסקריפטים. התוצאה נחשפת ב-`window.__owBootstrapCache` (או `null` אם `disabled`) וב-`window.__owBootstrapPromise`.
- `src/client-mobile/shims/capacitor-shim.js`:
  - `Filesystem.readFile/stat/readdir` בודקים את ה-cache לפני HTTP. אם hit — חוזרים מיד. אם miss — round-trip רגיל.
  - `Filesystem.watchAndStatAll` מחכה ל-`__owBootstrapPromise` במקום fetch נפרד — חוסך round-trip כפול של הbootstrap (היה נטען פעמיים: ב-boot ובמועד `watchAndStatAll`).
  - Fallback: אם cache ריק (disabled או fetch נכשל) — fetch ישיר כמו קודם.

**Phase 3 — Cache invalidation:**

- `src/client-mobile/cache-invalidation.js` — `invalidateCacheEntry(cache, path)` ו-`invalidateCacheSubtree(cache, prefix)`. שניהם מטפלים בקאש fs ובלוסטינג של תיקיית-אב (ל-readdir עתידי).
- `capacitor-shim.js`: כל פעולת mutation קוראת ל-helper:
  - `writeFile`, `appendFile`, `deleteFile`, `mkdir` → `invalidateCacheEntry(p)`
  - `rmdir` (recursive=true) → `invalidateCacheSubtree(p)`; אחרת `invalidateCacheEntry(p)`
  - `rename(from,to)` → `invalidateCacheSubtree(from)` + `invalidateCacheSubtree(to)` (יתכן ש-from היה תיקייה)
  - `copy(to)` → `invalidateCacheSubtree(to)`
- WS message handler ב-`startWatch` — בכל `change/add/unlink` מ-chokidar קורא ל-`invalidateCacheEntry(msg.path)` לפני הפצת ה-listener.

**Phase 4 — דוקומנטציה:**

- `README.md` תחת Configuration — section "Bootstrap configuration" עם שלושת ה-env vars וההשפעות שלהם.
- ה-entry הזה.

#### TDD

עבדו ב-vertical slices: tracer bullet אחד → GREEN מינימלי → next RED. סה"כ ~10 cycles לכל הפיצ'ר. הטסטים:

- שרת: `cd src/server && npm test` — 15 טסטים (היו 10 שעברו אחרי תיקון `createApp` merge, נוספו 5 חדשים: `BOOTSTRAP_DISABLED=true returns…`, `maxFileKB caps individual files…`, `maxTotalMB caps total response…`, `warm-up bails out…`, `buildElectronValues extracted helper…`).
- Client mobile: `cd src/client-mobile && npm test` — 14 טסטים חדשים (`bootstrap-lookup` × 9, `cache-invalidation` × 5).

#### החלטות ארכיטקטורה

- **`currentLimits` כ-state מודולרי במקום parameter passing** ב-`walkDir`/`isTextFile`: ל-`walkDir` יש כבר 7 פרמטרים. הוספת `limits` כפרמטר 8 (פלוס passing דרך כל המסלול של `_buildCacheEntry`) הייתה מרובת תחזוקה. ה-state המודולרי משתנה רק ב-`createBootstrapRouter` ו-`warmUpBootstrapCache` — שתי כניסות בודדות ל-bootstrap. tests רצים סדרתית והבדיקות שמשתמשות ב-cap שונה מקבלות vaultId אחר → אין דליפת state.
- **`invalidateCacheSubtree` ב-rename של שני הצדדים**: `rename` ב-Capacitor יכול להעביר קובץ או תיקייה. ב-runtime אנחנו לא יודעים. invalidation סובטריבית עולה O(keys) על שני הצדדים — זול במקרה הרע, נכון תמיד. אופציה הייתה לבדוק אם `from in cache.fs && !isDirectory` ולעשות single — אבל זה דורש parsing נוסף ויוצר edge case של תיקייה ריקה ב-cache.
- **Cache בדפדפן ב-`window.__owBootstrapCache` ולא ב-IndexedDB**: ה-cache הזה הוא in-memory בלבד, מסתנכרן ב-reload. שמירה ב-IndexedDB הייתה מאיצה גם reload, אבל מסבכת invalidation על-פני sessions. השרת כבר מחזיק serverCache עם pre-compressed buffers — reload עם cache HIT לוקח ~30ms, מקובל.
- **Helper modules בשני ייצוגים (CommonJS + browser global)**: כך אותו קובץ ניתן ל-`require()` מטסטים ו-`<script src=…>` מ-index.html, ללא bundler. הפטרן הקיים בפרויקט.
- **fallback ל-fetch ישיר ב-`watchAndStatAll`**: כש-cache ריק (disabled או fetch נכשל) — עדיין מבצעים fetch ל-/api/bootstrap. במצב disabled השרת מחזיר `{fs:{}, dirs:{}}` ו-Obsidian תיאלץ ללכת file-by-file. הזמן הוא ~20s על vault גדול — זה ה-trade-off המודע של `BOOTSTRAP_DISABLED`.

#### גוטצ'ות וסוגיות

- **Web Workers לא רואים את `__owBootstrapCache`**: ה-metadataCache של אובסידיאן מספק קונטקסט worker שעשה fetch ישירות עוקף את ה-shim. אבל ב-vault שנבדק, ה-worker אינו עושה reads — הוא רק מקבל buffers דרך postMessage. ה-100+ reads שנצפו בלוגים מקורם ב-main thread (boot, plugins, metadataCache parent code), וכולם הולכים דרך ה-shim. cache hit rate נמדד 88% (322/366 hits) ב-cold boot.
- **`isTextFile` משתמש ב-state מודולרי `currentLimits`**: זה אומר שבמודל theoretical שני vaults בעלי limits שונים עלולים לחלוק state. בפועל ב-production יש createApp() אחד יחיד, וה-tests משתמשים ב-vaultIds שונים → לא בעיה. עוד מסומן בהערה ב-`createBootstrapRouter`.
- **התיקון של `createApp` merge** — לפני התיקון 10/10 הטסטים נכשלו. זה היה bug רגרסיה שלא נתפס ב-walkthrough של 16:41 כי לא הריצו את הטסטים שם. תועד בעצמו לעיון עתידי.

#### מה לא בוצע

- **Cap על watch-event firehose** (Pitfall #5 בתוכנית): chokidar יכול לפוצץ ב-1000 events בשנייה ב-LiveSync pull. ה-invalidate הוא O(1) per event אבל הdir invalidation גם פוגעת ב-listing. דוחק לעתיד.
- **Cloudflare Workers bootstrap** (Pitfall #9): ה-deployment של CF משתמש בקוד אחר תחת `src/deployments/cloudflare/api/bootstrap.js`. לא נגענו — מחוץ ל-scope.
- **Cold-start כש-`BOOTSTRAP_DISABLED=true`** דורש ~22s. אם זה יהיה בעיה למישהו, יש לבדוק path של "fallback recursive readdir" ב-`watchAndStatAll` (כרגע נופל ל-fetch אחד שמחזיר ריק).

---

## 2026-05-12 16:41

### Repo reorganization — src/ + vendor/ + user-data/ + .tmp/

המבנה של הריפו עוצב מחדש כי עם 13 תיקיות בroot היה מבלבל איפה הקוד שלנו לעומת קבצים מחולצים/build/runtime. עכשיו 7 תיקיות בlocked structure.

#### מבנה חדש

```
src/                        ← כל הקוד שלנו
├── client/                  (was /client)
├── client-mobile/           (was /client-mobile)
├── server/                  (was /server)
├── plugins/                 (was /plugins — system plugin overlay)
└── deployments/             ← קיבוץ של יעדי פריסה
    └── cloudflare/          (was /cf — flatten של cf/src/ פנימי)

vendor/                     ← extracted Obsidian (gitignored)
├── obsidian/                (was /obsidian)
├── obsidian-mobile/         (was /obsidian-mobile)
└── Obsidian.AppImage        (was /Obsidian.AppImage)

user-data/                  ← נתוני משתמש
├── .gitignore               (פנימי: מתעלם מ-registry.json + demo-vault/.obsidian)
├── registry.json            (was data/vaults.json — runtime, gitignored)
└── demo-vault/              (was /test-vault — tracked example)

.tmp/                       ← זמני / build (folder tracked, contents gitignored)
├── .gitignore               (פנימי: "*\n!.gitignore")
├── deployments/cloudflare/public/  (was cf/public/)
├── obsidian-extract/        (was extracted/ + squashfs-root/)
└── cache/                   (was .cache/)

scripts/  docs/             (לא משתנים, נשארים בroot)
README.md  PLAN.md  .gitignore
```

#### החלטות ארכיטקטורה

- **`src/deployments/<provider>/`**: קיבוץ של פריסות לספקים. כרגע יש רק cloudflare/, בעתיד יכול להיות גם fly/, vercel/, וכו'. עוקב אחרי הקונבנציה של DevOps tooling. בחרנו במונח "deployments" (רבים) ולא "deploy" (פועל) או "providers" (מעורפל).

- **`vendor/`**: מקובל בעולם Go/Ruby/PHP בתור "third-party code we use but don't own". במקרה שלנו: bundles שחולצו מ-Obsidian (`obsidian/`, `obsidian-mobile/`, AppImage). gitignored — מיוצרים מחדש דרך scripts/update-obsidian{,-mobile}.js.

- **`user-data/`**: שם תיאורי לכל מה שקשור למשתמש — גם הvault הדמו (ברירת מחדל לכולם) וגם הregistry של vaults שהמשתמש פתח. בחרנו במונח הזה (ולא `data/` או `vaults/`) כי `user-data` ברור באופן מיידי — זה הdata של היוזר, לא של ה-app. ה-.gitignore הפנימי מאפשר לעקוב אחרי demo-vault/ בעוד שregistry.json עם paths מקומיים נשאר gitignored.

- **`.tmp/` עם פנימי `.gitignore`**: התיקייה עצמה tracked (כדי שתהיה אחרי clone), והתוכן gitignored אוטומטית דרך `*\n!.gitignore`. זה מאפשר ל-build scripts לכתוב ישר ל-.tmp/ בלי mkdir או error checking. אין צורך לעדכן את ה-.gitignore הראשי כשמוסיפים סוג קובץ חדש לזמני.

- **flatten של cf/src/**: לפני המעבר היה `cf/src/{index.js, api/, ...}`. אחרי המעבר ל-`src/deployments/cloudflare/`, ה-`src/` הפנימי כפול ומבלבל. השטחנו: `src/deployments/cloudflare/{index.js, api/, ...}`. wrangler.toml עודכן: `main = "index.js"`.

- **`plugins-generated.js` נשאר ב-src/deployments/cloudflare/** (גם אם generated ו-gitignored): הוא מיובא ע"י vault-do.js דרך relative path פשוט `./plugins-generated.js`. העברתו ל-`.tmp/` הייתה הופכת את הimport למכוער `../../../.tmp/deployments/cloudflare/plugins-generated.js`. החלטה פרגמטית — generated artifacts intermediate נשארים ליד המקור שמייבא אותם; רק deployment artifacts (public/) עוברים ל-`.tmp/`.

- **node_modules נשאר ליד package.json**: לא נלחמים ב-npm. הוא gitignored בכל מקרה.

#### מה לא הוזז

- `extracted/` ו-`squashfs-root/` בvendor הקודם — היו 333MB intermediate של `update-obsidian.js`. עברו ל-`.tmp/obsidian-extract/`.
- `Obsidian.AppImage` (119MB) — נשמר ב-`vendor/Obsidian.AppImage` למניעת re-download.
- `test-boot.py` — dev artifact ישן, נמחק.

#### `.gitignore` הראשי הופשט

מ-31 שורות ל-15:
```gitignore
# Vendor — extracted Obsidian bundles (regeneratable via scripts/update-obsidian.js)
vendor/

# Node
node_modules/
npm-debug.log*

# Internal development docs (contain personal infra references)
docs/

# Tool-managed worktree state
.codenomad/

# Editor / OS
.DS_Store
.idea/
.vscode/
*.swp
*.log
```

הנעלמים: `extracted/`, `squashfs-root/`, `Obsidian.AppImage`, `obsidian/`, `obsidian-mobile/`, `.cache/`, `.tmp/`, `data/`, `test-vault/.obsidian/`, `test-boot.py`, `obsidian.asar`, `obsidian.asar.gz`, `obsidian.tmp-*/`, `obsidian.prev-*/`. כולם או folded פנימה (vendor/, .tmp/, user-data/) או נמחקים.

#### קבצים שעודכנו

| קובץ | שינוי |
|---|---|
| `src/server/config.js` | PROJECT_ROOT עולה 2 רמות; paths חדשים (`src/client`, `vendor/obsidian`, וכו'); ברירות מחדל ל-`user-data/{demo-vault,registry.json}`; `obsidianMobilePath` הוסף כ-config var נפרד. |
| `src/server/index.js` | משתמש ב-`appConfig.clientMobilePath` ו-`appConfig.obsidianMobilePath` במקום path.join עם projectRoot. |
| `scripts/update-obsidian.js` | TARGET_DIR → `vendor/obsidian/`; CACHE_DIR + EXTRACT_WORKDIR → `.tmp/`. |
| `scripts/update-obsidian-mobile.js` | TARGET_DIR → `vendor/obsidian-mobile/`; CACHE_DIR → `.tmp/cache/`. |
| `src/deployments/cloudflare/wrangler.toml` | `main = "index.js"` (flatten); assets directory → `../../../.tmp/deployments/cloudflare/public`. |
| `src/deployments/cloudflare/scripts/build-assets.sh` | MAIN_DIR עכשיו 3 רמות; קלט מ-src/client + vendor/obsidian; פלט ל-.tmp/. |
| `src/deployments/cloudflare/.gitignore` | תיקון path של `plugins-generated.js` אחרי flatten. |
| `user-data/registry.json` | path של demo-vault עודכן מ-`test-vault`. |
| `README.md` | section חדש של repo layout + עדכון כל הפקודות (`cd src/server`, `cd src/deployments/cloudflare`). |
| `PLAN.md` | architecture diagram + טבלת files עדכניים. |

#### פקודות שהשתנו

| פעולה | היום | אחרי |
|---|---|---|
| הפעלת השרת | `node server/index.js` | `node src/server/index.js` |
| Build cloudflare | `cd cf && npm run build` | `cd src/deployments/cloudflare && npm run build` |
| Deploy cloudflare | `cd cf && npm run deploy` | `cd src/deployments/cloudflare && npm run deploy` |
| Update obsidian (desktop+mobile) | `node scripts/update-obsidian.js`, `node scripts/update-obsidian-mobile.js` | (לא משתנה) |

#### וריפיקציה

השרת רץ. בדיקות שעברו:

- `node src/server/index.js` עולה: `Vault: ~/projects/obsidian-web/user-data/demo-vault` + `Obsidian: ~/projects/obsidian-web/vendor/obsidian`.
- `GET /mobile?vault=…` → 200 OK + HTML עם cache-bust מעודכן.
- `GET /obsidian-mobile/app.js` → 200 OK (vendor/obsidian-mobile נטען).
- `GET /api/fs/stat?vault=5b68fb93d875ad63&path=` → JSON תקין (demo-vault מ-user-data/).
- `GET /client-mobile/boot.js` → 200 OK.
- בדפדפן gui-host: `/mobile?vault=5b68fb93d875ad63` → 4 קבצים, vault-profile panel מופיע, workspace נטען.

#### מעקפים ופתרונות

- **patch-obsidian-mobile.js ב-repo טרי לא יוכל לרוץ על vendor/obsidian-mobile/app.js שלא קיים**: זה ההתנהגות הצפויה — סקריפט update-obsidian-mobile.js הוא מי שמורד את ה-APK, מחלץ, ואז מפעיל patches. אחרי הreorganization זה ממשיך לעבוד בלי שינוי בflow (רק target paths השתנו).

- **wrangler.toml assets path מצביע ל-.tmp/ מחוץ ל-project root של wrangler**: wrangler ב-3.x תומך ב-paths יחסיים כולל `../`. בדיקה ידנית של wrangler dev/deploy אחרי המעבר חיונית, אבל לא נבדקה בreorganization הזה (אין לנו CF deploy מקומי). אם זה ייכשל בעתיד — אופציה: יוצרים symlink מ-`src/deployments/cloudflare/public` → `../../../.tmp/deployments/cloudflare/public`.

- **ההיסטוריה של ה-cf/ מתפצלת**: git mv זוהה כ-rename, אז `git log --follow` ימשיך לעבוד על קבצים בודדים. ההיסטוריה של ה-tree-level שינויים חיה בקומיט 21cc6d7.

---

## 2026-05-12 15:57

### תיקון: ה-vault profile panel חסר ב-mobile bundle במצב desktop layout

באג חמור שהתגלה אחרי תיקוני הבוקר: בעוד ש-desktop bundle מציג את הפאנל בפינה שמאלית למטה (⚙ + ? + dropdown של vault) בכל מצב, ה-mobile bundle לא מציג אותו במצב desktop layout. במצב mobile יש פאנל אחר (pin + ⚙ + vault info) שעובד תקין. הפאנל הזה הוא הדרך העיקרית של המשתמש לפתוח Settings, Help, ולהחליף vaults.

#### שורש הבעיה

המבנה ב-`obsidian-mobile/app.js` (v1.12.7):

```js
Ex = function(e, t) {
  // ...
  if (this.app = e, bn.isDesktopApp) {     // ← THIS check
    var i = e.vault.getName(), ...;
    this.containerEl = t.createDiv("workspace-sidedock-vault-profile", function(e) {
      e.createDiv("workspace-drawer-vault-switcher", ...);   // vault name + chevron
      e.createDiv({cls: "workspace-drawer-vault-actions"}, function(e) {
        e.createSpan("clickable-icon", help_handler);         // ?
        e.createSpan("clickable-icon", settings_handler);     // ⚙
      });
    });
  }
}
```

כל הפאנל גודר על `bn.isDesktopApp`. אנחנו דורסים `isMobile` ל-false (overrides), אבל `isDesktopApp` נשאר false (ולא ניתן להפוך אותו בלי לשבור 95+ code paths אחרים שמשתמשים ב-`window.electron` ו-`original-fs` שלא קיימים ב-runtime המובייל שלנו).

#### הפתרון — Patch #4 ב-`scripts/patch-obsidian-mobile.js`

תוספת build-time patch רביעי שמחליף **רק את התנאי הספציפי הזה**:

```js
{
  name: 'vault-profile-on-desktop-layout',
  find:    /(\w+)\.isDesktopApp(\)\{var \w+=\w+\.vault\.getName\(\),\w+="")/,
  replace: '!$1.isMobile$2',
  expectedMatches: 1,
}
```

מ-`bn.isDesktopApp){var i=e.vault.getName(),r=""` ל-`!bn.isMobile){var i=e.vault.getName(),r=""`. אפס impact על 95 ה-paths האחרים של `isDesktopApp`.

#### בעיית-המשך: click handler משתמש ב-`electron`

ה-click handler על ה-vault-switcher (בתוך אותו בלוק):
```js
e.addEventListener("click", function(t) {
  if (!e.hasClass("has-active-menu")) {
    var i = electron.ipcRenderer.sendSync("vault").path,
        r = electron.ipcRenderer.sendSync("vault-list"),
        ...
```

ב-mobile אין `window.electron` shim → `ReferenceError: electron is not defined` בקליק.

**פתרון (`client-mobile/boot.js`):** capture-phase event listener שתופס את הקליק לפני ה-handler המקורי ומנווט ל-`/starter` (שכבר תומך בכל הפונקציונליות + יותר):

```js
document.addEventListener('click', function (e) {
  var target = e.target.closest('.workspace-drawer-vault-switcher');
  if (!target) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  location.href = '/starter';
}, true);
```

ה-⚙ ו-? עובדים native כי הם קוראים ל-`app.setting.open()` ו-`app.openHelp()` — API פנימי של אובסידיאן, לא electron.

#### וריפיקציה ב-gui-host (obsmobile, port 9224)

| תרחיש | תוצאה |
|---|---|
| test-vault, desktop layout (viewport 1001x1142, auto) | ✅ פאנל מופיע: `⌄ 5b68fb93d875ad63 ? ⚙` |
| test-vault, mobile layout (`layout-mode=mobile`) | ✅ פאנל desktop מוסתר, mobile header (pin+⚙) מופיע |
| Large vault (009428c4, 394 קבצים, 68 תיקיות) | ✅ פאנל מופיע, ה-fix של watchAndStatAll מאתמול ממשיך לעבוד |
| Click on ⚙ | ✅ Settings modal נפתח |
| Click on vault dropdown | ✅ ניווט ל-/starter (לא ReferenceError) |

32 errors בקונסול קיימים מראש (B-004: 404 על קבצי `.obsidian/*.json` אופציונליים שאובסידיאן בודק) — לא קשורים לתיקון.

#### החלטות ארכיטקטורה

- **patch נקודתי במקום override של `isDesktopApp`**: בחנו את 96 השימושים של `bn.isDesktopApp` ב-bundle. רבים מהם מנסים `window.require("original-fs")`, `electron.remote.dialog.showOpenDialogSync()`, `electron.ipcRenderer.sendSync("resources...")`. בלי shim מלא של electron+original-fs ב-mobile (שאנחנו לא רוצים לתחזק), הפיכת flag הזה ל-true תקרוס בעת ה-boot. ה-patch הנקודתי משאיר 95 ה-paths במצבם המקורי.

- **ניווט ל-/starter במקום shim ל-window.electron**: ה-click handler המקורי בונה context menu עם רשימת vaults. אפשר היה לשמן את `window.electron.ipcRenderer.sendSync` עבור 3 channels (vault, vault-list, vault-open) דרך sync XHR. בחרנו ב-/starter כי: (1) מובייל אסינכרוני בעיקרון, sync XHR יחזיר את הבעיה, (2) ה-starter כבר מציג רשימה + יכולת ליצור/למחוק/לעבור — superset של ה-context menu, (3) UX אחיד בין הסביבות.

- **capture-phase event listener במקום regex-patch של ה-handler**: ה-click handler הוא callback ארוך ומורכב, regex לעקוף אותו שביר במיוחד. capture-phase + stopImmediatePropagation הוא הרבה יותר עמיד לשינויי minifier.

#### מעקפים ופתרונות

- **ה-patch לא idempotent מול bundle שכבר עבר עליו patch #1**: כש-`update-obsidian-mobile.js` רץ הוא מחלץ APK טרי ואז מפעיל את כל ארבעת ה-patches — תקין. אבל הרצת `patch-obsidian-mobile.js <existing-bundle>` תיכשל ב-patch #1 ("expected 1 match, found 0") כי הוא כבר הוחל. לא בעיה — ה-flow המומלץ הוא דרך `update-obsidian-mobile.js`. הפעלנו רק את patch #4 ידנית על ה-bundle הקיים לבדיקה.

- **`/api/electron` יכול לחזור לעניין אם פעם נחליט לשמן `window.electron` ב-mobile**: ה-handlers ל-`vault`, `vault-list`, `vault-open` שכבר קיימים ב-`server/api/electron.js` מסוגלים לשרת את ה-channels הללו. ה-shim ב-`client/shims/electron.js` של ה-desktop runtime כבר עושה את ההמרה. אם אי-פעם נחליט שרוצים את ה-context menu המקורי גם ב-mobile, יש 30 שורות העתקה לעשות. כרגע לא צריך.

---

## 2026-05-12 15:29

### תוכניות ל-LiveSync ול-Local Vaults + תיעוד שני באגים שהתגלו

יום של תכנון אסטרטגי. הוגדרו שתי תוכניות מימוש (LiveSync ו-Local Vaults) ותועדו שני באגים שהתגלו ותוקנו בסשן `Capistore plugin abstractions for mobile` (06:31–13:45) אך טרם תועדו ביומן.

#### מה בוצע?

**1. תוכנית חדשה: `docs/plans/local-vaults-implementation.md` (945 שורות)**

תוכנית מפורטת (agent-executable) להוספת **vault type שני** — "local vault" שחי ב-OPFS בדפדפן ומסונכרן רק דרך LiveSync ↔ CouchDB. מתקיים במקביל ל-server vaults הקיימים, לא מחליף.

חמישה שלבים: `opfs-store.js` + רישום ב-localStorage + routing לפי vault type + starter UI + setup wizard. תלוי בהשלמת `livesync-implementation.md` קודם (בלי LiveSync, local vault הוא vault שלא ניתן לצאת ממנו). אקצפטנס: 13 קריטריונים כולל regression check על server vaults קיימים. Out-of-scope ל-v1: export to .zip, service worker, multi-tab leader election, desktop runtime support.

**2. מסמך עיון: `docs/plans/future-direction-client-only.md` (99 שורות)**

תיעוד ארכיטקטוני של פיבוט מלא ל-deployment client-only (ללא backend) — נשקל, נדחה לטובת המודל per-vault. שמור כסיבה אסטרטגית למה בחרנו במה שבחרנו (כדי שמישהו בעתיד לא ינסה לחזור על השיחה הזאת).

**3. עדכון `PLAN.md`: section חדש "Phase 2 (planned): per-vault storage type"**

טבלה משווה (Server vault vs Local vault) + הצבעה לשני המסמכים בתת-תיקיית `plans/`.

**4. תיעוד באג #1: `watchAndStatAll` החזיר עץ מקונן במקום רשימה שטוחה**

- **תסמין**: vault עם תיקיות מקוננות הראה את שמות התיקיות אבל בלי תוכן ב-file explorer.
- **שורש הבעיה**: `CapacitorAdapter` ב-bundle של obsidian-mobile עובד כך:
  ```js
  for (const i of e.children) this.quickList("", i);
  ```
  לולאה אחת על `e.children` של השורש. **`quickList` לא יורד רקורסיבית** לתוך `entry.children`. הוא משתמש ב-`entry.name` כנתיב היחסי **המלא**.
- **טעות תיאוריה ראשונה**: בסשן שיערו ראשונה ש-`children: []` ריק הוא הבעיה ובנו עץ רקורסיבי עם `children: [...]` בכל תיקייה. גם זה לא עבד — Obsidian פשוט לא רקורסבי.
- **הפתרון האמיתי**: להחזיר רשימה **שטוחה** של כל ה-entries (גם תיקיות וגם קבצים) כש-`name` הוא **הנתיב היחסי המלא** מהשורש (`"10. פרויקטים/foo.md"`). הקוד עכשיו מאיטר את `dirs` של ה-bootstrap כולו ובונה רשימה שטוחה.
- **למה זה לא נתפס קודם**: `test-vault` כולל קבצים בשורש בלבד. כל הבדיקות ב-walkthrough של 11/5 רצו עליה. ה-vault האמיתי (`<your-vault>`) היה הראשון שחשף את הבאג.
- **תיקון ב**: `client-mobile/shims/capacitor-shim.js:345-383` עם הערת `IMPORTANT` ארוכה שמסבירה את ה-contract.

**5. תיעוד באג #2: cache-bust לא הופעל על `/mobile`**

- **תסמין**: אחרי deploy שתיקן את הbug הראשון, הדפדפן הציג עדיין את הגרסה הישנה — כל refresh לא עזר.
- **שורש הבעיה**: שני חלקים:
  1. `/mobile` הוגש דרך `res.sendFile` ישירות, בעוד `/` ו-`/starter` עברו דרך `sendHtmlWithCacheBust` שמחליף `?v=1` בהאש מחושב. כל הסקריפטים ב-`client-mobile/index.html` עם `?v=1` נשארו עם המחרוזת הקבועה.
  2. גם אם cache-bust היה רץ — ה-regex שלו (`\/client\/`) לא תפס `/client-mobile/`, וה-hash חושב רק מ-`client/` mtimes ולא מ-`client-mobile/`.
- **תיקון ב**:
  - `server/index.js`: `/mobile` עובר עכשיו דרך `sendHtmlWithCacheBust`. Regex הורחב ל-`\/client(?:-mobile)?\/`.
  - `server/config.js`: hash מחושב מצירוף `client/` + `client-mobile/`.
- **למה זה לא נתפס קודם**: כל ה-iterations שלנו ב-11/5 היו לאחר reload עם `?v=1` קבוע. עברנו טריוויאלית כי לא ראינו את הסימפטום של "deploy לא מתעדכן בדפדפן".

**6. תיקון תוכנית local-vaults לאור הבאג**

הגרסה הראשונית של `local-vaults-implementation.md` (שנכתבה לפני שניתחנו את הסשן של 06:31) אמרה ש-`watchAndStatAll` צריך להחזיר עץ עם top-level children בלבד ו-"Obsidian recursively expands as it reads". זה **שגוי לחלוטין**. תיקנתי:
- ה-method-by-method note עכשיו מציין במפורש: רשימה שטוחה עם נתיבים יחסיים מלאים, ולא עץ.
- skeleton של `walkTree` עם רקורסיה ועירוף ל-`children` הראשי.
- acceptance test של Phase 1 כולל בדיקה ספציפית של flat-list על subdirectory עמוקה (`A/B/C/deep.md`).
- Pitfall #11 חדש: "watchAndStatAll MUST return a flat list, not a tree".

#### החלטות ארכיטקטורה

- **per-vault model במקום פיבוט מלא ל-client-only**: רעיון "להחליף את כל הbackend ב-OPFS" עלה ונדחה. נימוקים: (1) מיגרציה הרסנית למשתמשים קיימים עם server vaults, (2) חסימת self-hosted users שרוצים את הקבצים על הדיסק שלהם, (3) הכרחת CouchDB על כל מי שרוצה להשתמש בכלל. הפתרון per-vault הוא **strictly more general** — דפלוימנט שמגביל `SYSTEM_PLUGINS` יכול להפוך פרקטית ל-client-only מבלי לבטל את שאר השימושים.

- **חלוקה ל-3 קבצי תוכנית**: livesync-implementation (קיים), local-vaults-implementation (חדש), future-direction-client-only (מסמך עיון). הסיבה: `local-vaults` תלויה ב-`livesync`. למזג אותן יוצר תוכנית מסיבית; להפריד ביניהן מאפשר ל-LiveSync לעבור ל-`archive/` עצמאית כשתסיים, בעוד local-vaults עוד פעיל.

- **תיעוד באגים שלא נתפסו ב-PR למרות שהקוד פוטר**: שני הבאגים נדחפו במחירה ב-deploy ידני (rsync) לקונטיינר ב-13:45, אבל ה-commits לא נוצרו. החלטנו לחבר את ה-commits יחד עם התוכניות + עדכון יומן בקומיט אחד (או שניים) במקום לדחות הרגלי-git לטובת זמני-תפעול.

#### מעקפים ופתרונות

- **`watchAndStatAll` משתמש ב-`/api/bootstrap`, לא ב-`/api/fs/readdir`**: היה ניתן לבנות את הרשימה ב-recursive readdir דרך הAPI הרגיל. בחרנו ב-bootstrap כי הוא כבר מחזיר את כל הסטרוקטורה במכה אחת + הוא pre-compressed (brotli) + יש cache בשרת. ב-vault גדול זה ההבדל בין 2 שניות ל-30.

- **`children` ב-entry לא מוחזר לחלוטין**: אפשר היה להחזיר גם רשימה שטוחה וגם `children: []` (compat). העדפנו פלט נקי כדי שאף קוד עתידי לא יתפתה לחשוב שיש שם משהו לקרוא.

- **התוכנית של local-vaults תוקנה במקום להישאר עם הערות-תיקון**: השארת התוכנית עם תיאור שגוי + הוספת הערה "באמת זה לא ככה" סכנה אמיתית של agent עתידי שלא יקרא את ההערה. תיקנו את הטקסט עצמו ב-3 מקומות (description + skeleton + acceptance test) + הוספנו pitfall ספציפי.

#### מה לא בוצע

- ה-fixes (capacitor-shim, server/index.js, server/config.js) נדחפו לקונטיינר אבל לא לקומיט עדיין. הם בעבודה-עץ של git. הקומיט הבא יכלול אותם.
- `PLAN.md` Known issues section D ("crypto fully stubbed") עדיין לא עודכן למרות שhash עובד מאז 11/5. נטפל בזה בקומיט.
- dead code ב-`client-mobile/shims/sync-http.js` ו-`telemetry.js` (לא נטענים מ-`index.html`) — לא נוגעים עכשיו, לא מזיק.

---

## 2026-05-11 21:00

### מילוי 14 פערי תיעוד + עדכון אסטרטגיית LiveSync

אחרי שזיהינו רשימת פערים מפורטת ב-`docs/documentation-gaps.md` (15 פערים בסך הכל, פער 11 דולג), מילאנו את כולם בקבצי התיעוד הקיימים, יצרנו שני docs חדשים, ותיקנו אי-עקביות אחת בקוד.

#### מה בוצע?

**1. עדכון `docs/investigations.md` (+390 שורות)**

נוספו 6 anchors חדשים:
- `#glossary` — מילון: שלוש משמעויות של "plugin" (Capacitor plugin, Obsidian plugin, system plugin)
- `#current-state` — תמונת מצב נכון ל-2026-05-11 (mobile runtime + system overlay + layout switcher)
- `#pluginheaders` — מנגנון `c.PluginHeaders` ב-Capacitor: למה "App is not implemented on android" נזרק, ואיך מזריקים headers כדי לעקוף
- `#capacitor-plugin-inventory` — רשימה של 13 ה-Capacitor plugins בקטגוריות (Real / Browser-native / Identity stub / Noop / TODO)
- `#owplatform-api` — runtime API של `window.__owPlatform` + `__owPlatformOverrides` + ה-localStorage key
- `#virtual-overlay-deep-dive` — overlay של system plugins: precedence (vault > repo), synthesized stat/readdir, write isolation של `community-plugins.json`, מגבלת disable

**2. Entry חדש ב-`walkthrough.md` — 17:00 (Gap 5)**

תיעוד היסטורי של בניית ה-Capacitor shim הראשונית (~700 שורות קוד שלא היה לה entry נפרד). מכסה: יצירת `client-mobile/`, native-bridge integration, ה-pitfalls שנתפסו (PluginHeaders, "Vault path is not a directory", `i18next` חייב לפני `app.js`).

**3. עדכון `PLAN.md` (+143 שורות)**

- **Two parallel client runtimes** — section חדש שמסביר את `client/` (desktop) vs `client-mobile/`, שניהם רצים מול אותו שרת
- **Updated approach (2026-05-11)** ל-LiveSync — direct fetch + CORS במקום proxy:
  - Rejected the proxy approach (cost, abuse, CF Workers limits, liability)
  - Direct fetch from browser, CouchDB CORS-configured
  - Public CF demo works for any user with CORS on their CouchDB
  - Task 1 (allowlist) — marked **SUPERSEDED**
- **CF demo deployment** — תיעוד התכנון של env var `SYSTEM_PLUGINS` להגבלת system plugins בdemo mode (לא ממומש)

**4. עדכון `README.md` (+21 שורות)**

הוספת subsection "Mobile bundle (`obsidian-mobile/`)" עם הוראות:
- `node scripts/update-obsidian-mobile.js` להורדה + חילוץ + patches
- ההסבר שעם הסקריפט הזה יש runtime mobile ב-`/mobile`

**5. עדכון header של `client-mobile/shims/capacitor-shim.js`**

ה-header הוחלף ב-50 שורות שמסכמות את כל ה-plugin inventory ב-5 קטגוריות, עם קישור ל-`#pluginheaders` ב-investigations.md למנגנון המלא.

**6. תיקון קוד: `createHash` ב-`client-mobile/boot.js`**

ה-stub של `makeCryptoShim` הוחלף בגרסה האסינכרונית של `client/boot.js`. עכשיו:
- `digest(encoding, cb)` עם callback → עובד אמיתי דרך `subtle.digest` (SHA-1/256/512)
- `md5` → ממופה ל-SHA-256 (WebCrypto לא תומך MD5)
- `digest(encoding)` sync — עדיין מחזיר ריק עם warning (אין WebCrypto sync)

LiveSync משתמשת ב-spark-md5 מ-bundle שלה + `subtle.digest` ישיר → השים שלנו לא יישבר בה, אבל הוא עכשיו תקין לpluginים אחרים שמשתמשים ב-`require('crypto').createHash().digest(enc, cb)`.

**7. שני docs חדשים**

- `docs/dev-setup.md` (171 שורות) — workflow של gui-host: port allocation (9224 לסשן שלנו, 9222/9223 לסוכנים אחרים), user-data-dirs ייעודיים, pw-clean.sh usage, reverse SSH tunnel
- `docs/system-plugin-dev-guide.md` (183 שורות) — מדריך בן 6 שלבים להוספת system plugin חדש: יצירת directory, manifest.json עם id===dir-name, main.js עם `window.__owPlatform` guard, dev loop, plans עתידיים

#### החלטות ארכיטקטורה

- **glossary + current-state בראש investigations.md**: ה-doc הוא היסטוריה של חקירות. במקום להעביר/לשכתב את ההיסטוריה, הוספנו "מבט-על" בראש שמסכם את המצב הנוכחי, ופירוט מנגנונים בסוף. ההיסטוריה נשמרת כ-archive.

- **LiveSync via direct fetch — לא proxy**: שיקול עיקרי — abuse vector של open proxy + עלויות CF Workers + Worker time limits לlong-poll. CouchDB כבר תומך CORS native, וLiveSync דורשת ממנו configuration ב-deployment רגיל בכל מקרה. הproxy של `/api/proxy-request` נשאר ל-Obsidian release/asset hosts שכבר ב-allowlist.

- **שני runtimes שווים, לא parent/child**: `/` ו-`/mobile` הם entry points שונים שמשתמשים באותו backend (FS API, system plugins, bootstrap). אין plan להסיר את ה-desktop, אבל ה-mobile הוא הכיוון העתידי כי ה-abstractions שם נקיות יותר.

#### מעקפים ופתרונות

- **walkthrough/investigations gitignored**: לפי `.gitignore`, `docs/*` לא נכנס לגיט (פרטיות). לכן ה-entry הזה ועדכוני התיעוד **לא יהיו בקומיט הציבורי**. השינויים הציבוריים: `PLAN.md`, `README.md`, `capacitor-shim.js`, `boot.js`. שאר העדכונים נשארים local לסביבת הפיתוח.

---

## 2026-05-11 20:05

### System plugin injection + Layout Switcher plugin

נוספה תשתית **system-plugin overlay** ב-`server/api/fs.js` שמזריקה תוספים מהריפו לכל vault שנפתח, בלי לכתוב שום קובץ לתוך התיקייה של המשתמש. התוסף הראשון שמסתמך עליה הוא `obsidian-web-layout` — ריבון אייקון + שלוש פקודות (`auto/mobile/desktop`) שמתחלפות בין מצבי הפריסה שהוגדרו ב-`client-mobile/boot.js` (בעיקרון: כתיבה ל-`localStorage['obsidian-web:layout-mode']` + reload עם overlay של "Switching…").

#### ארכיטקטורה

| רכיב | תפקיד |
|---|---|
| `plugins/obsidian-web-layout/` | מקור האמת לתוסף — `manifest.json` + `main.js` (CommonJS vanilla, ללא bundler). |
| `server/system-plugins.js` | מודול חדש: סורק `<repo>/plugins/` ב-startup, חושף `tryGetSystemFilePath / getSystemPluginIds / mergeCommunityList / stripCommunityList`. |
| `server/api/fs.js` | המנגנון המעשי. `/read`, `/stat`, `/readdir` נופלים-back ל-`<repo>/plugins/<id>/` כשהvault לא מחזיק את הקובץ; `/read` של `.obsidian/community-plugins.json` ממזג את הid שלנו ל-list; `/write` של אותו קובץ מסיר אותו לפני שמירה לדיסק. |
| `server/index.js` | קורא `systemPlugins.init()` לפני `server.listen()`. ה-log מציג `Loaded 1 system plugins: obsidian-web-layout`. |

הוקדמה לvault: מערכת מבדיקה תמיד את הvault קודם. אם המשתמש מניח קבצים תחת `.obsidian/plugins/obsidian-web-layout/` ב-vault שלו — הם מקבלים עדיפות (יידעו את אנשי הQA, מאפשר בדיקת overrides ידנית). ברירת המחדל: גרסת הריפו.

#### Pitfall שנתפס

מצב 6 בתכנון ציפה שObsidian יקרא `/api/fs/readdir?path=.obsidian/plugins` — אבל בפועל ה-bundle הmobile עושה **קודם** `stat` על התיקייה ההיא, ואם זה 404 הוא לא מבצע readdir בכלל. הוספנו synth-directory stat ב-error handler של `/stat`: כש-`.obsidian/plugins` לא קיים בvault ויש לנו לפחות system-plugin אחד, אנו מחזירים stat של `isDirectory:true` עם mtime עכשווי. בלי הזה: `manifests=[]`, התוסף לא מתגלה.

#### וריפיקציה (gui-host, port 9224)

- 5/5 בדיקות curl של Step 5 חזרו ירוקות (manifest, main.js HEAD, stat dir, readdir, community-plugins.json).
- `app.plugins.plugins['obsidian-web-layout']` נטען, `app.plugins.manifests['obsidian-web-layout']` קיים.
- ribbon icon (`monitor-smartphone`) מופיע (aria-label="Layout mode").
- כל שלוש הפקודות רשומות: `obsidian-web-layout:set-layout-{auto,mobile,desktop}`.
- מעבר ל-mobile דרך localStorage + reload: `bodyHasIsMobile=true`, `__owPlatform.isMobile=true`.
- Write isolation: PUT עם `["dataview","obsidian-web-layout"]` שומר רק `["dataview"]` בדיסק; API GET מחזיר את שני הId.
- Path traversal: `..` ב-relPath חוסם — נופל ל-resolveSafe של vault root ומחזיר 404.

ראה גם: [`docs/investigations.md`](./investigations.md#system-plugin-overlay) להסבר על מנגנון `community-plugins.json` ב-Obsidian.

---

## 2026-05-11 19:30

### Mobile bundle with desktop layout — build-time patches

הוחלף ה-MutationObserver הישן שב-`client-mobile/boot.js` בשלושה patches build-time על `obsidian-mobile/app.js`, שמופעלים אוטומטית כש-`scripts/update-obsidian-mobile.js` רץ. כך החלטת הפריסה (mobile vs desktop) נקבעת **לפני** שכל קוד של Obsidian רץ — בלי flicker, בלי race conditions, בלי observers.

#### מה בוצע?

**1. מודול חדש: `scripts/patch-obsidian-mobile.js`**

מודול עצמאי המגדיר את ה-patches ומיישם אותם על `app.js` נתון. ניתן לייבוא (`require('./patch-obsidian-mobile')`) או להרצה ב-CLI. זורק שגיאה אם regex לא מתאים למספר ההתאמות הצפוי — כך נמנעות תקלות שקטות אם המינוף ישנה את הbundle.

**2. שלושת ה-patches**

| # | שם | מטרה |
|---|---|---|
| 1 | `expose-platform` | הוספת `window.__owPlatform = ...` לפני הצהרת אובייקט הPlatform כך שהוא נגיש מבחוץ |
| 2 | `iife-overrides` | החלפת ההצבות הלא-מותנות `bn.isMobileApp=!0,...` ב-`Object.assign($1, defaults, window.__owPlatformOverrides||{})` — overrides מנצחים את ברירות המחדל |
| 3 | `is-mobile-class` | מתנה את הוספת ה-class `is-mobile` ל-body בערך ה-post-override של `isMobile` |

כל patch בודק שיש בדיוק התאמה אחת ב-bundle. אם המינוף ישנה בעתיד את שם המשתנה (`bn` כיום) — הregex משתמש ב-backreferences וב-capture groups, אז זה ימשיך לעבוד; אם המבנה יזוז דרסטית, נקבל שגיאה מפורשת.

**3. שילוב ב-`update-obsidian-mobile.js`**

נוסף `applyPatches(...)` כשלב 5 — אחרי extract, לפני verify. ה-output החדש:
```
Applying patches…
  patched: expose-platform (1x)
  patched: iife-overrides (1x)
  patched: is-mobile-class (1x)
```

**4. `client-mobile/boot.js`**

- הוסר ה-MutationObserver הישן שניסה לפרק את ה-mobileToolbar/Navbar אחרי שהworkspace נטען (היה רועד, ראוי-race).
- נוספה פונקציה `computeLayoutMode()` שקוראת את `localStorage['obsidian-web:layout-mode']` (`auto` | `mobile` | `desktop`). במצב `auto` — המחליט הוא הviewport (`< 900` רוחב או `< 600` גובה → mobile).
- התוצאה מוזרקת ל-`window.__owPlatformOverrides = { isMobile: ... }` **לפני** שהbundle נטען דינמית, כך ש-Patch 2 ימזג אותה.

#### וריפיקציה

נבדק בדפדפן gui-host (port 9224, user-data-dir ייעודי `/tmp/pw-obsidian-mobile`):

| תרחיש | viewport | overrides | תוצאה |
|---|---|---|---|
| ברירת מחדל, viewport רחב | 1001×1142 | `{isMobile:false}` | desktop UI — split panes, ribbon, sidebar קבוע. `bodyHasIsMobile=false`. |
| `layout-mode=mobile` + reload | 1001×1142 | `{isMobile:true}` | mobile UI — hamburger toggle, mobile new-tab. `bodyHasIsMobile=true`. |
| `layout-mode=desktop` + reload | 600×500 | `{isMobile:false}` | desktop UI נשמר גם ב-viewport קטן. |
| `auto` + viewport קטן | 600×500 | `{isMobile:true}` | mobile UI אוטומטית. |

בכל המצבים `plat_isMobileApp=true` ו-`vault.adapter` ממשיך להיות `CapacitorAdapter` (`getNativePath`, `quickList` נוכחים; אין `path` כמו ב-FileSystemAdapter; `Capacitor.getPlatform()='android'`).

#### הערה: `watchAndStatAll` לא קיים ב-v1.12.7

תוכנית הוריפיקציה המקורית בדקה נוכחות של `watchAndStatAll` ו-`quickList` בפרוטוטיפ של ה-adapter. בפועל `watchAndStatAll` לא קיים בגרסה הזו — קיים `watchAndList` בלבד. `quickList` ייחודי ל-CapacitorAdapter ומספיק כסמן זיהוי. הregex ב-eval של ה-acceptance תיקון: אנו בודקים את `quickList` + `getNativePath` כדי לוודא CapacitorAdapter פעיל.

#### חוץ-לטיפול

- **plugin פנימי לבחירת layout** — יש לנו כעת `window.__owPlatform` global ו-localStorage key מוכנים. ה-plugin יוסיף UI להחלפת המצב (כרגע reload נדרש). מחוץ ל-scope.
- **virtual plugin overlay** — להעלאת plugins מ-`plugins/` בלי שיהיו ב-vault. מחוץ ל-scope.

---

## 2026-05-11 17:00

### Capacitor shim — בניית `client-mobile/` ו-mobile runtime ראשון

נכתב מאפס ה-Capacitor shim (~700 שורות ב-`client-mobile/shims/capacitor-shim.js`) שמאפשר להריץ את `obsidian-mobile/app.js` (ה-bundle ש-Obsidian מפצלים ל-Android APK) בדפדפן רגיל, עם ה-server הקיים. זה ה-bedrock שעליו נבנו לאחר מכן ה-build-time patches (19:30) ו-system plugin overlay (20:05).

#### מה בוצע?

**1. תיקיית `client-mobile/` חדשה**

- `client-mobile/index.html` — entry-point ל-`/mobile`. סדר טעינה קבוע: `boot.js` → `capacitor-shim.js` → `native-bridge.js` → (dynamic) `obsidian-mobile/app.js` + lib scripts.
- `client-mobile/boot.js` — מקביל ל-`client/boot.js` אבל ל-runtime mobile: בוחר vault, מגדיר `window.require` עם 6 shims מצומצמים (path/url/os/btime/crypto/util/buffer/process/child_process), ואז dynamic-injects את כל ה-scripts של mobile.
- `client-mobile/shims/capacitor-shim.js` — 13 Capacitor plugins (ראה inventory ב-header של הקובץ).

**2. `Filesystem` plugin — ה-core**

15 מתודות מנותבות ל-`/api/fs/*` הקיים. Mapping מלא ב-`docs/investigations.md` תחת "Capacitor approach". המרת data types:
- binary read → base64 (Capacitor convention).
- binary write → base64 → atob → ArrayBuffer.
- `readdir` entries מומרים מ-`{isDirectory, ...}` של השרת ל-`{type: 'directory'|'file', ...}` של Capacitor.

**3. WebSocket watch**

`startWatch` / `stopWatch` / `addListener('change', cb)` משתפים `window.__owCapacitorWatcher` יחיד שמחזיק WebSocket אחד ל-`/api/watch` ומפיץ events ל-listeners.

**4. `watchAndStatAll` — Obsidian's custom shortcut**

ה-bundle של Obsidian מצפה ל-call יחיד שמחזיר `{ children: [...tree] }` + מפעיל watcher. ה-shim שלנו עושה `fetch('/api/bootstrap?full=1')` (משתמש ב-cache הקיים) וממיר את `dirs['']` ל-format ש-Capacitor מצפה.

**5. native-bridge integration — דרך `androidBridge.postMessage`**

הגישה הראשונה הייתה override של `Capacitor.nativePromise` בלבד, אבל `native-bridge.js` דורס אותו. הפתרון: להגדיר `window.androidBridge = { postMessage: routeNativeCall }` **לפני** ש-`native-bridge.js` נטען. כך `getPlatformId()` בוחר android, `Em=true`, וכל קריאה עוברת דרך `postMessage` שלנו → `routeNativeCall` → `plugins[pluginName][methodName](opts)` → `Capacitor.fromNative({callbackId, success, data})`.

#### Pitfalls שנתפסו

- **`PluginHeaders` חובה** — `registerPlugin()` הוא Proxy שבודק `c.PluginHeaders` *לפני* שמגיע ל-`nativePromise`. בלי entry שם, כל method זורק "not implemented on android". פרטים מלאים: [investigations.md → PluginHeaders mechanism](./investigations.md#pluginheaders).
- **`stat` format mismatch** — השרת מחזיר `{isDirectory: true}`, Capacitor מצפה `{type: 'directory'}`. הconverter `toCapacitorDirEntry` ב-shim מתרגם.
- **"Vault path is not a directory"** — סימן ש-`stat` החזיר `{isDirectory: false}` או response עם type אחר. ה-fix ב-`client-mobile/boot.js`: לבדוק גם `stat.isDirectory` וגם `stat.type === 'directory'`.
- **`i18next` חייב לפני `app.js`** — ה-bundle המcompiled עצמו מייבא `i18next` ב-module level (לא lazy). הסדר ב-`MOBILE_SCRIPTS` חייב להעמיד את כל ה-lib scripts (codemirror, moment, pixi, **i18next**, scrypt, turndown) לפני `enhance.js` / `i18n.js` / `app.js`.
- **רשימת lib scripts — מועתקת מ-desktop** — `obsidian-mobile/lib/` מכיל בדיוק את אותם קבצים כמו `obsidian/lib/`, באותם שמות. את הרשימה (`MOBILE_SCRIPTS` ב-`client-mobile/boot.js`) העתקנו 1:1 מ-`OBSIDIAN_SCRIPTS` ב-`client/boot.js`.

#### Verification

- בדפדפן Chrome (gui-host, port 9224):
  - `Capacitor.getPlatform()` החזיר `'android'`.
  - `app.vault.adapter` הוא `CapacitorAdapter` (יש `getNativePath`, `quickList`; אין `path` של `FileSystemAdapter`).
  - `app.vault.adapter.read('Welcome.md')` החזיר תוכן.
  - `app.vault.adapter.write('test.md', 'hello')` הסתיים בהצלחה — הקובץ הופיע ב-vault על השרת.
  - WebSocket events מ-chokidar הגיעו ל-Obsidian (`vault.adapter.startWatch` הופעל, יצירת קובץ חיצוני עוררה event).

#### החלטות ארכיטקטורה

- **תיקייה נפרדת ולא feature flag** — `client-mobile/` נפרד מ-`client/`. שני runtimes שמשתפים את אותו server. הסבר מורחב ב-PLAN.md → Architecture.
- **HTTP-based, לא local fs** — למרות שזה mobile bundle, ה-vault נשאר על השרת. כל ה-FS מנותב דרך HTTP. אין offline mode (כרגע).
- **PluginHeaders ב-`patchCapacitor()` ולא ב-IIFE** — ניסינו להגדיר ב-IIFE, אבל `native-bridge.js` דורס את `window.Capacitor` ומאפס headers. הפתרון: `patchCapacitor()` רץ sync אחרי native-bridge וגם ב-`DOMContentLoaded`.

#### חוץ-לטיפול שדחינו ל-iterations הבאות

- **isMobile UI על desktop viewport** — bundle כופה `is-mobile` class על body ללא תנאי, גם על desktop. ה-MutationObserver שניסה לפרק את זה אחרי load גרם flicker. תוקן ב-19:30 עם build-time patches.
- **system plugins** — איך מזריקים תוסף שלא נמצא בvault. תוקן ב-20:05 עם `server/system-plugins.js`.

---

## 2026-05-09 07:30

### השקה ציבורית, mobile emulation, write coalescing, bootstrap progress

שורה של שיפורים לקראת ואחרי השקה ציבורית ברדיט.

#### מה בוצע?

**1. תיקון EISDIR — שורש בעיית ה-boot**

- `window.app` היה undefined כי `readFile('/vault')` החזיר ENOENT במקום EISDIR
- אובסידיאן בודק EISDIR כדי לוודא שהכספת היא תיקייה; ENOENT גרם לו לחשוב שהיא לא קיימת → `openVaultChooser()` → `window.close()`
- תוקן בשני מקומות: server (`cf/src/api/fs.js`) ו-client (`client/shims/original-fs.js`)

**2. תוכן דמו באנגלית + הגנה מפני מחיקה**

- `cf/src/template.js` — 5 notes באנגלית (Welcome, How It Works, Markdown Showcase, Links, Tags)
- הגנה מפני מחיקת קבצי תבנית בדמו: `unlink`, `rmdir`, `trash` — מחזירים 403 EACCES
- `vault.isProtected(path)` ב-VaultDO בודק DEMO_MODE + TEMPLATE_FILES

**3. README + disclaimer + GitHub**

- README עודכן עם תיאור, שני מצבי פריסה, ארכיטקטורת CF Workers
- Disclaimer משפטי — "educational proof-of-concept", לא מזוהה עם Obsidian
- ניקוי פרטים אישיים (IPs, דומיינים, Proxmox IDs) מכל הקבצים
- Squash להיסטוריה נקייה (orphan branch) ופרסום ב-GitHub
- Credits: MusiCode1 + Claude Code

**4. Mobile emulation**

- גילוי `localStorage.setItem('EmulateMobile', '1')` — flag מובנה של אובסידיאן
- `boot.js` — מגדיר את הדגל כש-viewport < 600px, לפני ש-app.js טוען
- מפעיל 170 CSS rules של `is-mobile` + JS behavior (no split, phone layout)
- בלי צורך ב-mobile bundle או Capacitor

**5. Write coalescing (שרת Node.js)**

- מנגנון כללי per-file: כתיבה ראשונה מיד לדיסק, כתיבות חוזרות תוך 5 שניות ל-buffer
- פותר את בעיית rclone FUSE שנחנק מכתיבות `workspace-mobile.json` (29 שניות per write)
- `read`/`stat` מגישים מה-buffer אם יש pending write
- Shutdown — async flush עם timeout של 10 שניות (לא תוקע כמו writeFileSync)

**6. Bootstrap progress indicator**

- שרת: `buildProgress` Map עם state/label/counters, מתעדכן מ-`walkDir`
- endpoint: `GET /api/bootstrap/status?vault=<id>` — O(1), קורא counters מזיכרון
- לקוח: polling כל שנייה אחרי 2 שניות המתנה, מציג סטטוס מתחת לספינר
- שלבים: Scanning vault (dirs, files) → Reading files (done/total) → Compressing → Loading Obsidian (3/13)

#### החלטות ארכיטקטורה

- **EISDIR vs ENOENT**: ב-Node.js אמיתי, `readFile` על תיקייה מחזיר EISDIR. ה-shim החזיר ENOENT כי הנתיב לא היה ב-`vault.files`. אובסידיאן בודק EISDIR כדי לוודא שהכספת קיימת כתיקייה — ENOENT שבר את ה-flow.
- **EmulateMobile vs mobile bundle**: בחרנו ב-emulate-mobile (flag מובנה) במקום mobile bundle נפרד. נותן UI מובייל מלא עם ה-adapter שלנו (HTTP shims), בלי Capacitor.
- **Write coalescing כללי vs whitelist**: מנגנון per-file לפי תדירות כתיבה, לא whitelist של שמות קבצים. כתיבה ראשונה מיד, חוזרות ל-buffer.
- **Polling vs SSE לprogress**: polling פשוט יותר, עובד גם ב-CF Workers, ומספיק לתהליך של 2-10 שניות.

#### מעקפים ופתרונות

- **Shutdown writeFileSync תוקע על rclone**: הוחלף ב-async flush עם `Promise.race` ו-timeout של 10 שניות. אם rclone תקוע, השרת יוצא אחרי 10 שניות במקום להיתקע לנצח.
- **build-assets.sh דורס עריכות**: עריכות ל-`cf/public/client/boot.js` נמחקות בbuild כי הסקריפט מעתיק מ-`client/boot.js` המקורי. כל עריכה חייבת להיות בקובץ המקור.
- **rclone FUSE mount נשבר אחרי restart**: צריך reboot ל-LXC כדי לרענן את ה-bind mount. `mount --bind` ידני לא עובד כי ה-rootfs path שונה.

---

## 2026-05-09 18:00

### cf/ — Cloudflare Workers deployment (דמו + שימוש אישי)

#### מה בוצע?

נוספה תיקיית `cf/` בתוך הריפו — Cloudflare Workers deployment עצמאי שמשתמש באותם `client/` ו-`obsidian/` מהפרויקט הראשי.

**ארכיטקטורה:**
```
CF Worker (entry) → /api/** → Durable Object "VaultDO"
                  → שאר   → CF Pages static assets (public/)
```

**Durable Object — VaultDO:**
- `vault.files: Map<path, {content, mtime, size}>` — ה"filesystem" בזיכרון
- `vault.dirs: Map<path, [{name, isFile, …}]>` — directory listings
- `alarm()` — reset כל X שעות (ברירת מחדל 4), גם עם משתמשים פעילים
- `ctx.acceptWebSocket()` + hibernation — WebSocket לכל המשתמשים ללא עלות CPU
- eviction טבעי = reset (constructor טוען template מחדש)

**שני מצבים מאותו קוד:**
- `DEMO_MODE=true` (ברירת מחדל) — in-memory, reset, ללא auth
- `DEMO_MODE=false` + R2 binding — persistent, auth ב-`X-Api-Key`

**API handlers (src/api/):**
- `bootstrap.js` — בונה bootstrap response מ-vault.files ו-vault.dirs
- `fs.js` — stat/readdir/read/write/mkdir/unlink/rmdir/rename/copy
- `electron.js` — IPC stubs (vault info, version, frame, …)
- `vaults.js` — תמיד מחזיר vault 'demo'
- `proxy.js` — forward outbound HTTP עם allowlist (כמו server)

**Template vault (src/template.js):**
6 notes ב-Hebrew + English שמציגים: RTL, backlinks, tags, markdown features, ארכיטקטורה של הפרויקט.

**Build script (scripts/build-assets.sh):**
- מעתיק client/ + obsidian/ + resource dirs מהפרויקט הראשי
- מ-inject `localStorage.setItem('obsidian-web:lastVaultId','demo')` ל-index.html
- מחליף `?v=N` ב-`?v=demo`
- תוצאה: 705 קבצים, 43MB

**Deploy:**
```bash
cd cf
npm run deploy  # = build-assets.sh + wrangler deploy
```

#### החלטות ארכיטקטורה

- **תיקייה בתוך הריפו ולא ריפו נפרד**: client/ ו-obsidian/ משותפים, update-obsidian.js משמש לשניהם. אין כפילות.
- **R2 כ-persistent backend (לא DO Storage)**: עדיף לקבצים — API מוכר (S3-compatible), זול יותר לvaults גדולים, הagent המקומי יוכל לדבר ישירות ל-R2 בעתיד.
- **rebuildDirs() על כל mutation**: vault דמו קטן (~10 קבצים), rebuild מלא מהיר מספיק. לvault גדול בעתיד — incremental updates.
- **computeDirs מסנן hidden entries מה-root listing**: כמו שהשרת עושה — `.obsidian` לא מופיע ב-`dirs['']` אבל `dirs['.obsidian']` קיים.

---

## 2026-05-09 17:00

### Cache-buster אוטומטי (code review שלב 5)

#### מה בוצע?

**ביטול `?v=3` ידני — החלפה ב-bust אוטומטי מ-mtimes**

הבעיה: `index.html` ו-`starter.html` כללו `?v=3` hardcoded על כל script tag של `/client/...`. כל שינוי בקבצי client דרש bump ידני של המספר בשני קבצים — ופשוט לשכוח.

הפתרון:
- `server/config.js` מחשב `clientCacheBust` פעם אחת בעלייה: סריקת כל קבצי `client/` (sorted לצורך דטרמיניזם), hash של `path:mtime` → 6 תווים hex. שינוי בכל קובץ client מייצר bust חדש.
- `server/index.js` — `/` ו-`/starter` לא מגישים את ה-HTML ישירות. במקום זאת, `sendHtmlWithCacheBust` קורא את הקובץ, מחליף `?v=<כל ערך>` (ואם אין — מוסיף) על כל `src="/client/..."` tags, ומחזיר את ה-HTML המעודכן עם `Cache-Control: no-cache`.

תוצאה: כל deploy שמשנה קובץ ב-client/ אוטומטית ישנה את ה-bust — ב-browser יטען גרסה חדשה. אין צורך בשום bump ידני.

#### החלטות ארכיטקטורה

- **Hash מ-mtimes, לא מתוכן**: מהיר יותר (stat בלבד, ללא קריאת תוכן). מספיק לצרכינו — אנחנו רוצים לדעת מתי קובץ שונה, לא מה תוכנו.
- **לא נוגעים ב-`/obsidian/...` tags**: קבצי Obsidian ממילא לא משתנים בין requests (אלא אחרי `update-obsidian.js`). אפשר להוסיף בעתיד אם צריך.
- **`Cache-Control: no-cache` על HTML**: האחריות של ה-HTML עצמו — הדפדפן צריך לבדוק בכל פעם האם יש HTML חדש (שיכיל bust חדש). הקבצים עצמם (`/client/boot.js?v=abc123`) יישמרו בcache עד שה-bust ישתנה.

---

## 2026-05-09 16:00

### שיפורי ביצועים וארכיטקטורה (code review שלב 4)

#### מה בוצע?

**1. Concurrent bootstrap builds — pending-promise Map**

אם שני tabs נפתחו בו-זמנית ל-vault קר, שתי בקשות bootstrap הגיעו שתיהן לפני שה-cache נוצר. תוצאה: שתי סריקות מלאות של ה-vault בו-זמנית, עם כפל I/O ו-CPU.

הפתרון: `pendingBuilds: Map<buildKey, Promise>` ב-`bootstrap.js`. כשבקשה שנייה מגיעה עם אותו `vaultId:full-key`, היא מקבלת את ה-promise הקיים במקום להתחיל build חדש. ה-promise מוסר מה-Map ב-`finally` כך שהבקשה הבאה תתחיל build טרי.

**2. איחוד `walkVault` + `walkDir`**

`_buildCacheEntry` הכיל פונקציה פנימית `walkVault` (~55 שורות) שהיתה כמעט העתק מדויק של `walkDir` שכבר קיימת. ההבדלים העיקריים היו:
- `walkVault` ניסה לשמור stats מה-`dirsCache` בפגישה שנייה (במקום re-stat) — אבל `walkDir` כבר עושה stat רק פעם אחת ב-`Promise.all`.
- `walkVault` דילגה על `dirsCache[relDir]` שכבר קיים — לא נדרש כי `walkDir` עם `walkHidden=false` ממחליפה את הערך הקיים בתוצאה זהה.

הוחלפה `walkVault` ב-`await walkDir(vaultRoot, vaultRoot, fsCache, dirsCache, false)` — שורה אחת במקום 55. כל הבדיקות עוברות.

**3. Shared chokidar watcher per vault (`watch.js`)**

הארכיטקטורה הקודמת: כל WebSocket connection (טאב בדפדפן) פתח chokidar watcher נפרד על ה-vault. שלושה טאבים = שלושה watchers על אותה תיקייה = משאבי OS כפולים (inotify watches / polling timers).

הארכיטקטורה החדשה: `sharedWatchers: Map<vaultRoot, { watcher, clients: Set<ws> }>`. 
- WebSocket connection ראשון ל-vault יוצר watcher + מוסיף את עצמו ל-`clients`.
- WebSocket נוסף לאותו vault — מוסיף את עצמו ל-`clients` הקיים, ללא watcher חדש.
- Events משודרים ל-כל ה-`clients` (fan-out).
- כשה-client האחרון מתנתק — watcher נסגר ו-entry נמחק מה-Map.

#### החלטות ארכיטקטורה

- **pendingBuilds key = `vaultId:full`**: partial ו-full builds הם build keys שונים. בקשת `full=1` לא ממתינה על partial build פעיל — היא מתחילה full build משלה. זה נכון כי partial ≠ full.
- **sharedWatchers keyed by `vaultRoot`** (לא `vaultId`): לפי תיקייה, לא לפי ID — מונע מצב שבו שני IDs שונים מצביעים לאותה תיקייה פיזית (edge case של `vault-move`).

---

## 2026-05-09 15:00

### שיפורים פונקציונליים (code review שלב 3)

#### מה בוצע?

**1. PORT validation ב-`server/config.js`**

`parseInt('abc', 10)` החזיר `NaN` בשקט — השרת היה עולה על פורט לא מוגדר. נוספה פונקציה `parsePort()` שזורקת `Error` עם הודעה ברורה אם `PORT` אינו מספר שלם בין 1 ל-65535.

**2. `crypto.createHash` — async fallback + תיעוד**

השיטה `createHash().digest()` החזירה ריק בלי הסבר. עכשיו:
- **.digest(encoding, cb)** — אם סופק callback, מבצע hash אסינכרוני אמיתי דרך `crypto.subtle.digest` ומחזיר תוצאה נכונה. ה-algo names ממופים מ-Node (`sha256`, `sha1`, `md5`) לשמות WebCrypto.
- **.digest(encoding)** ללא callback — עדיין מחזיר ריק (WebCrypto הוא async-only), אבל עם `console.warn` מפורט שמסביר את המגבלה ומציין שצריך לעטוף בגרסה async.
- תיעוד מלא של המגבלה ב-comment.

**3. Silence 404s מ-sync XHR — known issue C מ-PLAN.md**

Obsidian קורא `statSync`/`readFileSync` על קבצי config שאולי לא קיימים עדיין (בוט ראשון). כל 404 ייצר הודעת error verbose עם ה-URL המלא בתוכן השגיאה, מה שגרם לרעש בקונסול.

הפתרון: הוסף פרמטר `opts.silent404` ל-`__owSyncRequest`. כשמופעל, 404 זורק שגיאת `ENOENT` נקייה (`'ENOENT: no such file or directory'`) במקום הודעת HTTP verbose. `statSync` ו-`readFileSync` ב-`original-fs.js` מפעילים את הדגל. כך הודעות הרעש נעלמות, אבל שגיאות HTTP אמיתיות (5xx, 401) עדיין מופיעות בצורה מלאה.

#### מעקפים ופתרונות

- **WebCrypto async-only**: אין ב-browser API ל-synchronous hashing. הפתרון הסופי לעתיד (אם plugin יצטרך זאת): לשקול precomputing hash values ב-server או לחכות ש-`SharedArrayBuffer` + Atomics ייהיו זמינים בצורה רחבה יותר.
- **Browser 404 "Failed to load resource"**: גם עם `silent404`, הדפדפן עצמו עדיין מדפיס את ה-XHR failure ב-DevTools. זה browser behavior שלא ניתן לדכא ב-JavaScript. `silent404` רק מונע את ה-Error message הנוסף מ-code שלנו.

---

## 2026-05-09 14:00

### תיקוני באגים וניקיון קוד (code review שלב 1+2)

#### מה בוצע?

**1. תיקון באג: `/api/electron/trash` לא ביטל bootstrap cache**

כל פעולת FS שמשנה vault (write, mkdir, unlink, rename, copy) כבר קראה ל-`invalidateBootstrapCache`, אבל endpoint ה-trash ב-`electron.js` פספס את הקריאה הזו. כתוצאה, מחיקת קובץ דרך ה-UI השאירה אותו ב-cache בצד הלקוח עד ש-mtime check בבקשת bootstrap הבאה היה מוחק אותו (לאחר reload). כעת `invalidateBootstrapCache(req.body.vault)` נקרא מיד אחרי המחיקה.

**2. תיקון: `var entry` → `let entry` ב-`bootstrap.js`**

שני `var entry` בתוך `if/else` בתוך async function — `var` מתרומם ל-function scope ומסתיר את הכוונה. הוחלפו ב-`let entry` אחד לפני הבלוק, בהתאם לסגנון שאר הקובץ.

**3. ריכוז `APP_VERSION` ו-`VAULT_BASE` ב-`config.js`**

שני הקבועים היו מוגדרים בנפרד ב-`api/bootstrap.js` וב-`api/electron.js`. שינוי גרסת Obsidian בעתיד דרש עדכון ידני בשניהם (ופוטנציאל לשכוח). הועברו ל-`server/config.js` כ-`appVersion` ו-`vaultBase`. שני הקבצים עכשיו `require('../config')` ומשתמשים בערכים משם.

**4. הסרת dead code ב-`original-fs.js`**

`const body = typeof data === 'string' ? data : data;` — שני צידי הטרנארי זהים. הוחלף ב-`body: data` ישירות בקריאה ל-fetch.

**5. תיקון indentation ב-`server/index.js`**

בלוקי `RESOURCE_DIRS` ו-`ROOT_FILES` היו ב-0 indent בתוך פונקציה שצריכה 2 spaces. תוקן.

#### החלטות ארכיטקטורה

- **APP_VERSION וה-config**: הוחלט שלא לקרוא את הגרסה מ-`obsidian/package.json` בזמן ריצה (אפשרות שנשקלה) כדי לא להוסיף I/O בעלייה ולא ליצור תלות ב-path שעלול לא להיות קיים. במקום זאת, `config.js` הוא מקור האמת — שם גם `VAULT_PATH` וכל שאר הקונפיגורציה.

---

## 2026-05-09 02:30

### Bootstrap אסינכרוני — spinner במקום מסך לבן

#### מה בוצע?

**הבעיה:** `boot.js` השתמש ב-Synchronous XHR לטעינת ה-bootstrap. זה חסם את ה-main
thread לחלוטין — הדפדפן לא יכול לצייר כלום בזמן ההמתנה (2-20 שניות).

**הפתרון:**
- `index.html` — הוסרו כל `<script defer src="/obsidian/...">`. הוספה `<div id="ow-loading">` עם CSS spinner לפני כל ה-scripts.
- `boot.js` — ה-sync XHR הוחלף ב-`fetch()` אסינכרוני. אחרי שהbootstrap
  חוזר, הscripts של אובסידיאן מוזרקים דינמית עם `async=false` (הורדה
  מקבילה, ריצה לפי סדר). MutationObserver מסיר את ה-spinner כשה-`.workspace`
  מופיע ב-DOM.
- `OBSIDIAN_SCRIPTS` — רשימת scripts הועברה מ-index.html לראש boot.js כקבוע.

**באג שנתגלה במהלך המימוש:** ה-`return` המוקדם ב-IIFE יצא לפני
`window.require = function(...)`, כך שכל הshims לא היו מותקנים כשapp.js
רץ. תוקן על-ידי העברת בלוק ה-async fetch לסוף ה-IIFE, אחרי כל ה-setup
הסינכרוני.

#### מעקפים ופתרונות

- **`return` מוקדם ב-IIFE:** כל ה-setup הסינכרוני (window.require, modules,
  globals) חייב להיות לפני כל `return`. בלוק ה-async fetch נמצא עכשיו
  בסוף ה-IIFE בלבד.
- **`async=false` על scripts דינמיים:** בדיפולט, script שמוזרק דינמית הוא
  `async=true` (רץ מיד כשנטען, ללא סדר). `async=false` גורם לריצה לפי סדר
  ההכנסה תוך הורדה מקבילה.

---

## 2026-05-09 01:30

### תיקון fs.watch + polling על rclone FUSE + bootstrap partial warm-up

#### מה בוצע?

**1. תיקון באג קריטי ב-fs.watch shim**

גילינו שאירועי `rename` (יצירה/מחיקה של קבצים) לא הגיעו לhandler של אובסידיאן.
הסיבה: אובסידיאן רושם `watcher.on('change', fn)` — בדיוק כמו ב-Node.js אמיתי שם
ה-EventEmitter **תמיד** מוציא אירוע `'change'` (גם עבור renames), והפרמטר הראשון
לcallback הוא `'rename'` או `'change'` לפי הסוג.

הקוד הישן שלח `emit('rename', ...)` → `handlers.rename` ריק → כלום לא קרה.

```js
// לפני (שגוי):
emit(eventType, eventType, filename);   // eventType = 'rename' → handlers.rename

// אחרי (נכון):
emit('change', eventType, filename);    // תמיד → handlers.change
```

נבדק עם Playwright: `stat` ו-`read` על הקובץ החדש הופעלו, הקובץ הגיע ל-vault
model של אובסידיאן, ועץ הקבצים התעדכן.

**2. Polling mode ל-chokidar על rclone/FUSE**

ה-vault רץ על Google Drive דרך rclone FUSE — ה-kernel לא מוציא inotify events
על FUSE. הוספנו:
- `WATCH_POLLING=true` ב-systemd service של ה-LXC.
- `WATCH_POLL_INTERVAL` (ברירת מחדל 3000ms).
- `usePolling` / `interval` / `binaryInterval` ב-chokidar.

**3. `--poll-interval 30s` ל-rclone mount**

ה-rclone mount (`rclone-obsidian.service`) היה עם `--dir-cache-time 24h` ללא
polling לשינויים חיצוניים. הוספת `--poll-interval 30s` גורמת ל-rclone לבדוק
את Google Drive Changes API כל 30 שניות — קריאה אחת זולה שמחזירה את כל
השינויים. כך שינויים ממכשיר אחר מגיעים תוך דקה.

**4. תיקון bootstrap: full=false בwarm-up החזיר HIT לבקשות full=1**

הwarm-up קרא `buildCacheEntry(..., false)` ושמר ב-cache. בקשת `?full=1`
מהלקוח קיבלה cache HIT על ה-entry החלקי — ללא תוכן כל הקבצים.

- הוספת `isFull` לcache entry.
- cache HIT נחסם כשה-entry הוא `full=false` אבל הבקשה היא `full=1`.
- Warm-up הפך לשני שלבים: phase 1 — `full=false` מהיר (הכנה מיידית לבקשה
  ראשונה), phase 2 — `full=true` ברקע.
- אם בקשת `full=1` מגיעה בזמן שphase 2 עדיין רץ — מחזיר את partial מיד
  ומתחיל `full=true` build ברקע.

**5. תיעוד restart בטוח של rclone**

הוספנו ל-README סעיף "Restarting rclone": חובה לעצור את `obsidian-web` לפני
restart של rclone כי ה-FUSE mount נעלם מתחת לתהליך ה-Node וה-LXC נתקע.

**6. Cache busting: ?v=2 → ?v=3**

Cloudflare שמר cache על קבצי ה-client. בוצע bump לכל קבצי ה-shims ב-index.html
וב-starter.html.

#### החלטות ארכיטקטורה

- **Polling interval 3s**: מספיק קצר להרגשת real-time, לא יוצר עומס — rclone
  מגיש stat/readdir מ-VFS cache מקומי ולא מ-Google Drive API.
- **rclone Changes API vs. per-file polling**: `--poll-interval` משתמש ב-Google
  Drive Changes API (קריאה אחת לכל השינויים) ולא בסריקת קבצים פר קובץ —
  מחיר זניח לחלוטין.

#### מעקפים ופתרונות

- **inotify על FUSE**: rclone FUSE לא תומך ב-inotify — אין מנגנון אחר חוץ
  מpolling. זה מובנה ב-kernel; FUSE לא מגלה אירועים ל-inotify subsystem.
- **Cloudflare cache**: CF שומר כל קובץ סטטי. פתרון: version query string
  `?v=N` — כל שינוי בקבצי client דורש bump של N ב-index.html + starter.html.

---

## 2026-05-06 20:30

### Bootstrap cache — pre-compressed buffer, warm-up בעלייה

#### מה בוצע?

**1. Pre-compression של ה-cache**

גילינו שגם ב-cache HIT, השרת היה מבצע `JSON.stringify` + `zlib.compress` מחדש על כל בקשה (~800ms), מה שהפך כל HIT לאיטי כמו cold build.

- `server/api/bootstrap.js` — אחרי כל build, ה-JSON Buffer נדחס פעם אחת (brotli quality-4 + gzip level-6) ומאוחסן ב-`serverCache` לצד ה-response object.
- ב-HIT: השרת שולח את ה-Buffer הדחוס ישירות עם `Content-Encoding: br/gzip`, ומעקף את middleware הדחיסה של Express (middleware בודק `shouldTransform` — מחזיר `false` כשהheader כבר set).
- Fallback לdclients שלא מקבלים compression (נדיר מאוד): `res.json()` הישן.

**2. `buildCacheEntry()` — לוגיקה מופרדת מהHTTP handler**

הלוגיקה כולה חולצה לפונקציה `buildCacheEntry(vaultId, vaultRoot, vaultRegistry, full)` שאינה תלויה ב-`req`/`res`. מאפשר:
- קריאה מה-HTTP handler.
- קריאה מה-warm-up routine.
- בדיקות יחידה ישירות ללוגיקה (ללא HTTP overhead).

**3. Warm-up בעלייה**

- `warmUpBootstrapCache(vaultRegistry, fallbackVaultRoot)` — מופעל ב-`setImmediate` ב-`startServer` כך שלא חוסם את ה-listen event.
- מבצע `buildCacheEntry` לכל vault ברשימה.
- תוצאה: הבקשה הראשונה של המשתמש היא תמיד HIT — לא cold build.

**4. בדיקות TDD**

- `server/test/bootstrap-cache.test.js` — 2 בדיקות חדשות:
  - HIT מחזיר `Content-Encoding: br` או `gzip` (מאשר שנשלח buffer דחוס ולא re-serialised).
  - Cache מתבטל נכון אחרי כתיבת קובץ לvault.

#### תוצאות

| מדד | לפני | אחרי |
|---|---|---|
| cache HIT latency | ~800ms | **4–20ms** |
| בקשה ראשונה (cold build) | ~200ms | ~250ms (+ ~50ms pre-compression) |
| הבקשה הראשונה של המשתמש | cold build | **warm-up HIT** |

#### החלטות ארכיטקטורה

- **לא נשמר לדיסק**: ה-cache חי בזיכרון בלבד. כל restart עושה warm-up מחדש (~200ms על הכספת הנוכחית). שמירה לדיסק לא כדאית כי ה-compressed buffer עצמו שוקל עשרות MB — טעינתו איטית כמו rebuild. הפתרון לעתיד אם הכספת תגדל מאוד: שמור רק את `dirMtimes` (כמה KB) ובנה JSON מחדש רק על ה-delta.
- **`await preCompress` בתוך ה-build**: דחיסה היא synchronous-like ב-libuv ולוקחת ~50ms. ה-await מבטיח שהcache מוכן עוד לפני שהתגובה נשלחת, כך שהבקשה השנייה תמיד HIT.
- **bypass middleware**: העברת `Content-Encoding: br` לפני `res.end(buf)` מנצלת את ה-`shouldTransform` check של ה-`compression` middleware — clean, ללא שינוי ב-middleware עצמו.

---

## 2026-05-06 19:00

### Bootstrap cache — טעינת כל הכספת בבקשה אחת

הוספנו endpoint `/api/bootstrap` שמחזיר את כל מה שהדפדפן צריך לטעינה קרה בבקשת HTTP יחידה, ומחסל את עיקר הbottleneck של tunnel latency.

#### מה בוצע?

**1. Telemetry — מדידת sync calls**

- `client/shims/telemetry.js` — רושם כל קריאת sync XHR לזיכרון: label, arg, duration, status.
- מאפשר `__owTelemetry.summary()`, `.table()`, `.save()` מDevTools.
- תוצאות ה-baseline: 14 קריאות sync בסך 3.5 שניות blocking בטעינה.

**2. `window.global = window` ב-boot.js**

- plugins שמשתמשים ב-`node-forge` ודומיו מצפים ל-global של Node.js. שורה אחת תקנה את `obsidian-local-rest-api`.

**3. auto-reload לשרת**

- עברנו מ-`node index.js` ל-`npm run dev` שמשתמש ב-`node --watch`.
- גילוי: `node --watch` מתנגש עם rclone FUSE mount ומאט קריאות קבצים פי 300 (58ms → 18s). הפתרון: `node index.js` (ללא watch) לסביבת production עם rclone.

**4. `/api/bootstrap` — שרת**

- `server/api/bootstrap.js` — endpoint חדש עם שני מצבים:
  - `?full=0` (default): מחזיר ערכי IPC של electron + קבצי `.obsidian/` + dirs cache.
  - `?full=1`: כנ"ל + כל קבצי הטקסט בכספת (md/json/css/js).
- מיוחד: recursion מלא לתוך `.obsidian/plugins/**` אך **מדלג על `main.js`** (22MB).
- בונה `dirs` cache — רשימות תיקיות שלמות (266 תיקיות, כולל plugins).
- compression בrotli/gzip: 37MB → ~6MB.

**5. cache בצד לקוח**

- `boot.js`: מוחלפת ה-vault validation הישנה (sync XHR ל-`/api/electron/vault`) בקריאת bootstrap אחת.
- `original-fs.js`:
  - `readFileAsync`/`readFileSync` — בודקים `__owBootstrapCache.fs[path]` לפני HTTP.
  - `statAsync`/`statSync` — מחזירים stats מה-cache.
  - `readdirAsync`/`readdirSync` — מחזירים directory listing מ-`__owBootstrapCache.dirs`.
  - כל פעולות write/unlink/rename מבצעות `invalidateBootstrap(path)`.
  - WebSocket events (fs.watch) מבצעים invalidation אוטומטי.
- `electron.js` shim: `SIMPLE_GET_CHANNELS` בודקים cache לפני sync XHR.

**6. מעבר מ-Cloudflare ל-pico tuns.sh**

- Cloudflare שולח דפי שגיאה HTML משלו על 500 ושובר JSON.
- pico tuns.sh: tunnel SSH-native, URL דטרמיניסטי: `https://<your-tunnel>.tuns.sh`.
- מופעל כ-background process דרך `Run_background_process`.

#### תוצאות

| מדד | לפני | אחרי |
|---|---|---|
| sync XHR calls | 14 | **1** (bootstrap) |
| readdir calls לשרת | 508 | **9** (98% מחוסל) |
| stat calls על .md | ~430 | **0** |
| bootstrap size (compressed) | — | **~6MB** brotli |
| bootstrap time (warm) | — | **~1.5s** בשרת |
| טעינה via tunnel (cold rclone) | 130s (Dataview) + 3.5s sync | **~25s** |
| טעינה via tunnel (warm rclone) | זהה | **~12s** |

#### החלטות ארכיטקטורה

- **דלג על `main.js`** בbootstrap: 22MB של plugin JS — לא שווה לשלוח. plugins נטענים ישירות via HTTP (נשאר בסרבר).
- **`dirs` cache** הוסיף יותר ממה שציפינו: readdir ירד 98%. מרבית ה-stat calls נבעו מreaddir cascades שנעצרו.
- **brotli > gzip** לbootstrap: brotli מוסרב מהir, נדחף ע"י `compression` middleware.
- **rclone cold vs warm**: קריאה ראשונה ~2s לקובץ, לאחר מכן ~2ms. ה-bootstrap מתחמם את ה-rclone cache לכל ה-vault בבת אחת.
- **pico במקום cloudflare**: cloudflare משנה תוכן של responses על שגיאות — שובר JSON. pico מעביר הכל כ-passthrough.

#### מגבלות שנותרו

- plugins שצריכים `child_process`, `node:events`, `buffer` (obsidian-git, dataview) — desktop-only, לא ניתן לתמוך בלי shims נוספים.
- `electron.remote.app.getLocale` חסר → sticky-heading נשבר. תיקון פשוט, טרם בוצע.
- `.ts`/`.tsx`/`.mjs`/`.sh` files בפרויקטים בתוך הכספת: 325 stats מגיעים לשרת (לא cached). אפשר לפתור ע"י הוספת extensions לbootstrap.

---

## 2026-05-06 16:40

### ריבוי כספות, Starter חי, ו-TDD — Phase 3 MVP

הוספת תמיכה בריבוי כספות עם Starter screen המקורי של Obsidian, vault registry בצד השרת, ו-FS/watch לפי vault id. הכל פותח ב-TDD עם `node:test`, ובוצע code review שגרר תיקוני security ו-robustness.

#### מה בוצע?

**1. Vault Registry (שרת)**

- `server/vault-registry.js` — מחלקה חדשה שמנהלת רשימת כספות ב-`data/vaults.json`.
  - `open(path, create)` — פותח/יוצר כספת, בודק הרשאות, מחזיר `{ok, id}`.
  - `move(oldPath, newPath)` — מזיז תיקייה ומעדכן registry, אטומי (write-to-tmp + rename).
  - `remove(path)` — מוחק מהרשימה.
  - טעינה עמידה לשגיאה: קובץ פגום לא קורס את השרת.
  - שמירה אטומית: כותב ל-`.tmp` ואז `rename` כדי להגן מקריסה בזמן כתיבה.

**2. Vault API (שרת)**

- `server/api/vaults.js` — endpoints חדשים:
  - `GET /api/vaults/list`
  - `POST /api/vaults/open` — עם validation ו-`create` flag.
  - `POST /api/vaults/move` — מחזיר 500 על כישלון FS, לא 200.
  - `POST /api/vaults/remove` — מחזיר 404 כשלא נמצא.

**3. FS ו-watch לפי vault**

- `server/api/fs.js` — `getVaultRoot(req)` מפענח `?vault=<id>` מהבקשה ומפנה לתיקיית הכספת הנכונה.
- `server/api/watch.js` — כל WebSocket connection פותח watcher נפרד על הכספת שלו לפי `?vault=<id>`. cleanup מלא בסגירת ה-connection.

**4. Electron IPC — vault channels**

- `server/api/electron.js` — `getCurrentVault` מחזיר את ה-vault לפי `?vault=` פרמטר, עם fallback ל-"הכי אחרון" כשאין פרמטר, ו-`null` כשהפרמטר לא מוכר (לא מחליף בשקט לאחר).
- endpoints חדשים: `vault-list`, `vault-open`, `vault-remove`, `vault-move`.

**5. Client shims**

- `client/shims/original-fs.js` — כל בקשת FS מוסיפה `?vault=<id>` ו-`vault` ב-body.
- `client/shims/electron.js` — `sendSync('vault-open'/'vault-remove'/'vault-move')` מנותבים ל-`/api/vaults/*`. `showOpenDialogSync` להגדרת תיקייה מחזיר `prompt()` זמני.
- `client/boot.js` — קורא `?vault=` מה-URL, שומר ב-`localStorage`, מאמת את ה-vault מול השרת, ומפנה ל-`/starter` אם אין vault תקף.

**6. Starter screen**

- `client/starter.html` — HTML משלנו שטוען את כל ה-shims ואז את `obsidian/starter.js` המקורי. מציג לוגו, רשימת כספות אחרונות, ו-"ליצור/לפתוח/להתחבר" בעברית.
- `server/index.js` — route חדש `/starter` (גם `/starter.html`).

**7. Server refactor**

- `index.js` מפוצל ל-`createApp(config)` ו-`startServer(config)`. `require.main === module` מגן מפני הפעלה אוטומטית ב-`require`. מאפשר ייבוא בבדיקות.

**8. TDD עם node:test**

- `server/test/vaults-api.test.js` — 8 בדיקות HTTP אינטגרציה:
  - vault open → רישום ב-registry ✓
  - vault move → rename בפועל ✓
  - electron `vault-list` → shape תואם ל-Obsidian ✓
  - FS scoped לפי vault id ✓
  - `move` מחזיר 500 על כישלון FS ✓
  - `trash` דוחה path traversal לתיקיית אחות ✓
  - `remove` מחזיר 404 כשלא נמצא ✓
  - `/starter` route מגיש HTML ✓

#### החלטות ארכיטקטורה

- **TDD אנכי (tracer bullets)**: לא כתבנו ערימת בדיקות מראש. כל cycle — בדיקה אחת → מימוש מינימלי → עוברים הלאה. גילינו בעיות אמיתיות (למשל move מחזיר string במקום object) בזמן מימוש, לא בדיעבד.
- **per-connection watcher**: כל WebSocket connection פותח chokidar משלו במקום watcher מרכזי. פשוט יותר ל-cleanup, ואין עדיין צורך בשיתוף.
- **createApp vs startServer**: פיצול נדרש כדי שהבדיקות יוכלו לייבא את ה-app בלי שהוא מאזין על פורט קבוע.
- **prompt() כ-folder picker**: Electron משתמש ב-`showOpenDialogSync` שהוא סינכרוני. בדפדפן אי אפשר לפתוח UI אסינכרוני וולהחזיר ממנו ערך סינכרוני. `prompt()` הוא הפתרון הזמני הכי פשוט — יוחלף בדפדפן תיקיות שרת בהמשך.

#### מעקפים ופתרונות

- **WS test תקוע ב-node:test**: בדיקת watch WebSocket נכתבה, הרצה ידנית הצליחה, אבל תחת `node:test` ה-process נתקע ולא יצא. הסרנו אותה מה-suite — מאומת ידנית בלבד לעת עתה.
- **שרת ישן על פורט 3000**: אחרי restart הקוד, השרת הישן מהסשן הקודם עדיין רץ. נדרש `kill <pid>` ידני ו-`nohup node index.js &` מחדש.

#### תיקוני security ו-robustness (code review)

- **H-1** `electron.js /trash`: הוספת `path.sep` לבדיקת גבולות — מנע path traversal לתיקיות אחיות.
- **H-2** `vault-registry.js load()`: תפיסת `SyntaxError` (קובץ פגום לא קורס). `save()` הפך אטומי.
- **M-1** `move()`: מחזיר `{ok,error,code}` במקום string גולמי. route מחזיר 500 על כישלון.
- **M-2** `getCurrentVault`: vault ID לא מוכר → `null`, לא vault אחר בשקט.
- **M-3** `/remove`, `/move`: הוספת validation ו-`try/catch`. `remove` מחזיר 404 כשלא נמצא.
- **L-1** `.gitignore`: הוספת `data/` — מונע commit של נתיבים מקומיים אבסולוטיים.

---

## 2026-05-06 15:35

### סקריפט עדכון Obsidian מה-release הרשמי

נוסף `scripts/update-obsidian.js` שמוריד את הגרסה האחרונה מ-`obsidianmd/obsidian-releases` ומייצר מחדש את `obsidian/`.

#### החלטה חשובה

במקום להוריד AppImage מלא ולחלץ אותו, הסקריפט משתמש ב-asset הרשמי `obsidian-<version>.asar.gz`. זה קטן משמעותית, לא דורש FUSE, ומכיל בדיוק את קבצי ה-renderer שאנחנו מגישים לדפדפן.

#### מה הסקריפט עושה

- קורא את GitHub Releases API (`latest`, או `--version`).
- בוחר `obsidian-*.asar.gz`.
- מוריד ל-`.cache/obsidian-releases/`.
- מאמת SHA-256 מול `asset.digest` כש-GitHub מספק אותו.
- עושה gunzip ל-`.asar`.
- מחלץ ASAR בעצמו ב-Node, בלי תלות ב-`npx asar` או בחבילות חיצוניות.
- בודק שקבצי החובה קיימים: `app.js`, `app.css`, `i18n.js`, `worker.js`, `sim.js`, `package.json`.
- מחליף את `obsidian/` רק אחרי שהחילוץ הזמני תקין.

#### שימוש

```bash
node scripts/update-obsidian.js
node scripts/update-obsidian.js --version 1.12.7
node scripts/update-obsidian.js --force
node scripts/update-obsidian.js --no-cache
```

נוסף גם `README.md` עם הוראות setup בסיסיות, ו-`PLAN.md` עודכן כך ש-Phase 1 מסומן כבוצע וה-auto-update העתידי הפך ל-checks/compatibility במקום עצם החילוץ.

---

## 2026-05-06 15:18

### 🎉 הבאג הקריטי B-001 נפתר! האינדקס מסתיים, rename UI עובד

הבאג הגדול שתקע אותנו תוקן. סיבת השורש: Obsidian יוצר Web Worker עם `new Worker("worker.js")` והשרת לא הגיש את הקובץ ב-root URL.

#### גילוי הסיבה

עטפנו את `workQueue.queue` ב-trace והגענו למסקנה שהtask הראשונה תקועה. מצאנו את הקוד של ה-task ב-`app.js`:
1. `vault.readBinary(file)` ✓ (כבר ידענו שזה עובד)
2. `Sf(content)` - SHA-256 hash ✓
3. `this.work(content)` - parse metadata ב-Web Worker ← **כאן התקיעה**

מצאנו ש-`prototype.work` עוטף `worker.postMessage` ב-Promise שמחכה לתשובה:
```js
prototype.work = function(e) {
  if (this.workerResolve) throw new Error("Work queue must be sequential!");
  return new Promise((n) => {
    this.workerResolve = n;
    this.worker.postMessage({...});
  });
}
```

ואז ב-`new Worker("worker.js", {name: "Metadata Cache Worker"})`. בדקנו: `curl /worker.js` החזיר **404**. ב-Electron זה היה נפתר דרך `app://` protocol ל-`/Resources/obsidian/worker.js`, אבל בדפדפן זה נפתר יחסית ל-document URL = `/worker.js` שלא היה קיים.

ה-Worker אובייקט נוצר בלי שגיאה (כי ה-fetch של ה-script הוא async), אבל ה-script לא נטען, ולעולם לא יכול היה לעבד message ולהשיב.

#### התיקון

ב-`server/index.js` - הוספת route חדש שמגיש קבצים בודדים מ-root:
```js
const ROOT_FILES = ['worker.js', 'sim.js'];
for (const f of ROOT_FILES) {
  app.get('/' + f, (req, res) => res.sendFile(path.join(config.obsidianPath, f)));
}
```

#### תוצאות מיידיות

- `inProgressTaskCount` יורד ל-0 בתוך 1-2 שניות מ-load.
- IndexedDB מקבל 3 metadata records (אחד לכל קובץ, KEY = SHA-256 של תוכן).
- הבאנר "אובסידיאן מוסיף את הכספת לאינדקס..." **נעלם**.
- **rename דרך ה-UI עובד מקצה לקצה!** Right-click → "שנה שם" → הקלדה → Enter → קובץ באמת משתנה ב-FS.
- כל פעולה אחרת שמסתמכת על `runAsyncLinkUpdate` או `onCleanCache` עכשיו עובדת.

#### החלטות ארכיטקטורה

- **Root files vs RESOURCE_DIRS**: שני המבנים קיימים בשרת:
  - `RESOURCE_DIRS = ['i18n', 'lib', 'public', 'sandbox']` - תיקיות שלמות (הקיים)
  - `ROOT_FILES = ['worker.js', 'sim.js']` - קבצים בודדים (חדש)
  - אם יום אחד אובסידיאן יבקש עוד קבצים מ-root, פשוט להוסיף ל-`ROOT_FILES`. אסור להוסיף `app.use('/', static)` כי זה ידרוס את ה-`/` שלנו.

#### מעקפים שכבר לא נדרשים

- ה-workaround של `mc.inProgressTaskCount = 0; mc.didFinish()` שכפינו לנצח ב-debug → לא נחוץ עוד.
- B-002 (rename UI) נפתר אוטומטית כי B-001 היה הסיבה השורשית.

#### שיעור לעתיד

תמיד לבדוק `404` ב-Network tab של DevTools כש-feature לא עובד. אצלנו ה-`new Worker(...)` נכשל בשקט בלי error visible לאובסידיאן. ה-`workerResolve` נשמר אבל לעולם לא נקרא, וזה גרם לכל async chain מאחור להיתקע.

ה-investigations.md ו-walkthrough עודכנו: B-001 ו-B-002 הועברו ל"ארכיון הבעיות שנפתרו" כ-F-005.

---

## 2026-05-06 15:10

### מסמך חקירות - investigations.md

נוצר `docs/investigations.md` שמרכז את כל הידע מחקירות עומק על הקודבייס של Obsidian, כל הבעיות הפתוחות, ההשערות לסיבות, וכל הבעיות שנפתרו (לארכיון). מטרה: לא לחזור על אותו מחקר.

#### מה נמצא במסמך?

**הערות כלליות על Obsidian internals**: ארכיטקטורה (vault/adapter/fileManager/metadataCache/workspace), API של FileSystemAdapter, מבנה IndexedDB (3 DBs, 2 object stores), מבנה fileExplorer view, debugging methods שעובדים טוב.

**5 בעיות פתוחות:**
- **B-001 (קריטי)**: `metadataCache.inProgressTaskCount` תקוע על 3, אינדקס לא מסתיים. חוסם rename ועוד פעולות שמחכות ל-`onCleanCache`. השערה עיקרית: ה-task הראשונה ב-workQueue תקועה בתוך `await fsPromises.readFile` או async chain פנימי.
- **B-002**: rename דרך ה-UI - תלוי ב-B-001.
- **B-003**: `readdir` על קובץ - מוקטן (פעם אחת בלבד), נחשב התנהגות פנימית של אובסידיאן.
- **B-004**: רעש 404 על `.obsidian/*.json` - תקין, נפתר ע"י pre-flight bundle בעתיד.
- **B-005**: vault switcher - לא תוקן, Phase 3.

**4 בעיות בארכיון** (כבר נפתרו): Menu shim, fs.watch EventEmitter, ENOTDIR error codes, IPC menu noise.

**רעיונות לעתיד**: pre-flight bundle, client cache, auto-detect stuck workQueue, service worker, API surface tracker.

#### למה זה חשוב?

המהלך של חקירת B-001 (האינדקס התקוע) ארוך ומורכב, ובלי תיעוד היינו חוזרים על אותו מחקר. עכשיו יש מצב של ידע מצטבר: כל פעם שמגלים משהו, מעדכנים את הסעיף הרלוונטי. זה גם מקור ידע על Obsidian internals שיועיל גם בבעיות עתידיות.

#### החלטות תיעוד

- **בעיה פתוחה אחת = סעיף B-NNN אחד**. עדיף לעדכן סעיף קיים מאשר לפתוח חדש.
- **בעיות שנפתרו**: מועברות ל"ארכיון" עם 3-5 שורות (סיבה, תיקון, side effects). לא מוחקות.
- **דפוסים חוזרים** (כמו "ככה Obsidian internals נראים"): מוזזים ל"הערות כלליות" כדי שלא נחקור אותם שוב.

---

## 2026-05-06 14:38

### תיקון Menu shim ו-IPC noise; rename API עובד אבל ה-UI flow עדיין לא

מצאנו את ה-Uncaught TypeError שראינו ב-console - הוא נבע מ-`Menu.buildFromTemplate(...).on('menu-will-close', ...)` שלא הוחזר אובייקט עם EventEmitter. תיקנו, וההודעות הרבות של `update-menu-items` הושתקו. בנוסף וידאנו ש-rename API עובד מצוין - הבעיה אמיתית רק ב-UI flow.

#### מה בוצע?

**1. Menu shim כ-EventEmitter מלא**

ה-stub הקודם החזיר `{popup, closePopup, items}` בלבד. הקוד של אובסידיאן מוסיף listeners עם `.on('menu-will-close', ...)`. עכשיו ה-Menu מחזיר אובייקט עם:
- `on/off/once/addListener/removeListener/removeAllListeners` שמחזירים את ה-menu עצמו (chain-able)
- `emit` שמפעיל את ה-handlers
- `popup(opts)` שמרנדר context menu DOM אמיתי
- `closePopup()` שמסיר ומפעיל `menu-will-close`
- `append/insert` להוספה דינמית של פריטים
- mousedown handler גלובלי שסוגר אם לוחצים מחוץ ל-menu

**2. השתקת IPC menu noise**

ה-channels `set-menu`, `update-menu-items`, `render-menu`, `context-menu` עכשיו מטופלים בשקט במקום להפיק אזהרות. אלה משמשים את Electron menu bar שלא רלוונטי בדפדפן.

**3. אישוש שה-rename API עובד**

חקרנו את ה-rename flow. `app.vault.adapter.rename(...)` עובד מצוין:
```js
await window.app.vault.adapter.rename("Welcome.md", "WelcomeRenamed.md");
// → POST 200 /api/fs/rename, הקובץ באמת שונה
```

**4. אבחנה: rename דרך ה-UI** 

`startRename` של file tree item רק מוסיף `is-being-renamed` class ו-`contenteditable=true`. הפעולה האמיתית מתבצעת ב-`view.acceptRename()` שנקרא דרך:
- `fileRenameScope.register([], "Enter", n.onKeyEnterInRename.bind(n))` - לחיצה על Enter
- (אין handler ל-blur על file tree items - בניגוד ל-inline title)

הקוד של `acceptRename`:
```js
acceptRename() {
  const e = this.fileBeingRenamed;
  if (!e) return;
  this.exitRename();
  // ... validation ...
  await this.app.fileManager.renameFile(e, newPath);
}
```

הבעיה: כשמנסים לקרוא `view.acceptRename()` ידנית מ-eval, הקריאה תוקעת. ייתכן ש-`exitRename` או async flow אחר מחכה למשהו (`Av()`, `keymap.popScope`) שלא מתבצע נכון בלי focus אמיתי.

#### החלטות ארכיטקטורה

- **Menu shim פעיל ולא רק לוגי**: כשה-Menu מקבל popup, אנחנו ממש מציירים DOM. זה בעיקר חשוב כי Obsidian משתמש ב-electron Menu לכמה מקרי edge (לא ל-context menu הרגיל ש-Obsidian מצייר בעצמו). אם ב-popup יש פעולות, הן יבוצעו כראוי.

#### מעקפים

- **rename דרך ה-UI לא עובד עדיין**: לכן rename דרך `app.vault.adapter.rename()` כן עובד, אפשר workaround זמני: לתת למשתמש לחיצה כפולה על שם הקובץ ולבצע rename דרך input dialog משלנו, או לעשות שזה יעבוד דרך `fileManager.renameFile()` ישירות. צריך חקירה נוספת מתי ה-Enter event לא מגיע ל-fileRenameScope.

#### TODO

- [ ] להבין למה `view.acceptRename()` תוקע (אולי `exitRename()` שמחכה ל-`keymap.popScope` שלא קיים)
- [ ] לחקור אם יש צורך לתקן את `Av()` ב-startRename - זאת function שמטפלת ב-selection בתוך contenteditable

---

## 2026-05-06 14:16

### תיקון fs.watch + ניתוח השגיאות שראינו ב-console

חקרנו את כל השגיאות שמופיעות ב-console אחרי שאובסידיאן עולה. רוב הבקשות שחוזרות עם שגיאה הן לגיטימיות, חלקן רעש שאפשר להשקיט, ואחת היא באג ממשי שתיקנו (fs.watch). באג ה-rename עדיין פתוח.

#### מה בוצע?

**1. תיקון fs.watch**

הקוד שלנו ב-`shims/original-fs.js` החזיר אובייקט עם `on: () => {}` ריק. הקוד של Obsidian עושה `fs.watch(...).on('change', ...).on('error', ...)`, ולכן listeners שלו לא נרשמו בכלל - אובסידיאן לא קיבל events של chokidar שהשרת היה שולח.

החלפנו את ה-stub ב-EventEmitter מלא: dispatch table של handlers לכל event type, מתודות `on/off/addListener/removeListener/removeAllListeners/close`, וכל אחת מחזירה את ה-watcher עצמו לשרשור. ה-message handler של ה-WebSocket עכשיו emit-מסע ל-`change`/`rename` ולקורא הכל.

תוצאה: מספר ה-`readdir` השגויים על קבצים ירד מ-7 ליחיד, וה-loop של reconciliation שהיה רץ שוב ושוב נעצר.

**2. תיקון ENOTDIR/EISDIR**

השרת החזיר 400 ל-readdir על קובץ ול-read על תיקייה. שינינו ל-404 כי:
- אובסידיאן מטפל ב-ENOENT/ENOTDIR/EISDIR בtry/catch כאילו זה "לא קיים"
- 4xx אחרים גורמים ל-Obsidian להציג `[ERROR] Failed to load resource` בזמן שזה לא באמת שגיאה
- 500 שמרנו לשגיאות אמיתיות ב-handler

**3. הוספת request logging בשרת**

middleware פשוט שלוגר בקשות ל-`/api`, `/i18n`, `/lib` כדי שנוכל לעקוב אחר מה אובסידיאן מבקש בכל שלב של ה-boot.

**4. מיפוי השגיאות שראינו**

הסברנו את המקור של כל סוג שגיאה:

🟢 **לגיטימיות** (Obsidian יוצר אם חסר):
`.obsidian/types.json`, `bookmarks.json`, `graph.json`, `themes/`, `snippets/`,
`hotkeys.json`, `community-plugins.json` - הגדרות אופציונליות

🟢 **בדיקת case-sensitivity**:
`stat ./.OBSIDIANTEST` ואז `stat ./.obsidiantest` ואז delete - זה ה-`testInsensitive` הרגיל

🟡 **רעש שהופחת**:
`readdir .obsidian/workspace.json` - באג שאובסידיאן עצמו פותר את עצמו, מצומצם ל-1 פעם

🔴 **באג ממשי - rename לא נשלח לשרת**:
תיעוד בסעיף הבא.

#### באג שלא תוקן: rename דרך ה-UI

לחיצה ימנית על קובץ → "שנה שם" → הקלדת שם חדש → Enter:
- העץ מתעדכן (השם החדש מופיע)
- אבל **שום קריאה ל-`/api/fs/rename` לא נשלחת**
- הקובץ הישן נשאר על הדיסק

מהמחקר ב-app.js:
- אובסידיאן עושה `_exists(targetPath)` לפני rename, ואם החזיר true - throw "Destination file already exists!"
- `_exists` משתמש ב-`fsPromises.access(p)` - הצלחה => קובץ קיים, ENOENT => לא קיים
- ה-`access` שלנו פשוט קורא ל-`statAsync` ומחזיר את ה-error

חקירה ב-API ישירות מראה שכל ה-endpoints עובדים: `POST /api/fs/rename` עם oldPath/newPath מבצע rename אמיתי על הדיסק. הבעיה היא שאובסידיאן לא מגיע לשם.

חשד: או ש-`_exists` מחזיר true בטעות (אולי ה-server מחזיר 200 על פעולה לא נכונה), או שיש שלב מוקדם יותר ב-`reconcileFile` או `getRealPath` שכושל בשקט. צריך הרצה עם breakpoint.

#### החלטות ארכיטקטורה

- **fs.watch כ-EventEmitter, לא רק callback**: ה-Node API תומך בשתי הצורות (callback בקריאה + EventEmitter על המחזיר). Obsidian משתמש בשתיהן. במקום להעדיף אחת ב-shim, מימשנו את שתיהן.

- **ENOTDIR/EISDIR כ-404**: בכוונה לא מציגים שגיאה זוהרת ל-user על תקלות שאובסידיאן יכול וצריך להתעלם מהן. עדיף שקט בלוגים על דיוק טכני.

#### מעקפים

- **`_exists` בעיה פתוחה**: עוד לא ידוע למה rename לא מגיע ל-fs. הוסברה גם הגישה לחקור את זה הלאה (DevTools breakpoint).

---

## 2026-05-06 13:58

### MVP ראשון - Obsidian 1.12.7 רץ בדפדפן עם כספת חיה

הצלחנו להריץ את הקוד המקורי של Obsidian (לא משונה) בדפדפן רגיל, כשהוא קורא וכותב לקבצי Markdown אמיתיים בשרת. עץ הקבצים נטען, קבצים נפתחים ב-tabs, עברית RTL עובדת, וקבצי `.obsidian/*.json` נוצרים בעצמם.

#### מה בוצע?

**1. ניתוח של Obsidian**

- הורדנו את `Obsidian-1.12.7.AppImage`, חילצנו אותו, וחילצנו את שני קבצי ה-asar שבתוכו (`app.asar` ו-`obsidian.asar`).
- מיפינו את ה-API surface של Obsidian מול Electron: `app.js` קורא ל-`window.require()` רק 6 פעמים (`original-fs`, `electron`, `path`, `url`, `crypto`, `btime`). כל פעולות ה-FS מנותבות דרך מחלקה אחת בשם `FileSystemAdapter`.
- מיפינו את כל ה-`ipcRenderer.sendSync` channels (`is-dev`, `version`, `vault`, `vault-list`, `frame`, `trash`, `documents-dir`, וכו').
- מיפינו את `electron.remote` שבשימוש: `Menu`, `dialog`, `nativeTheme`, `shell`, `webContents`, `getCurrentWindow`.

**2. שרת Node.js (תיקיית `server/`)**

- `index.js` - Express + WebSocket, מגיש את `client/`, את `obsidian/` הלא-משונה, ומספק REST API.
- `api/fs.js` - REST endpoints ל-fs: stat, readdir, read, write, mkdir, unlink, rename, rmdir, copy. כל path מוגן (sandboxed) לתיקיית הכספת.
- `api/electron.js` - handlers לכל ה-`ipcRenderer.sendSync` channels של Obsidian, עם הצמדה לערכים סבירים (vault id קבוע, version="1.12.7", וכו').
- `api/watch.js` - chokidar שמשדר אירועי FS דרך WebSocket ל-`/api/watch`.
- `config.js` - הגדרות (port, vault path, obsidian path).
- middleware של request logging ל-debugging.

**3. Shims בצד הלקוח (תיקיית `client/shims/`)**

- `sync-http.js` - עוטף Synchronous XMLHttpRequest כי Obsidian משתמש ב-`statSync`, `readFileSync`, `ipcRenderer.sendSync`.
- `original-fs.js` - מתרגם את כל פעולות ה-fs (sync ו-async ו-promises) לקריאות HTTP. כולל `fs.watch` שמתחבר ל-WebSocket.
- `electron.js` - mock של `ipcRenderer` ושל `electron.remote` (כולל `Menu`, `dialog`, `nativeTheme`, `webContents` כ-Proxy שמייצר stubs לפי דרישה).
- `path.js` - מימוש POSIX של node `path` (join, resolve, basename, dirname, וכו').
- `url.js` - `pathToFileURL`, `fileURLToPath` מבוססי URL הסטנדרטי.
- `os.js` - stub עם ערכים סבירים (tmpdir, hostname, platform וכו').
- `btime.js` - stub ריק (Obsidian משתמש ב-FileSystemAdapter שמספק זמני קובץ דרך stat).

**4. Boot ו-loader (תיקיית `client/`)**

- `boot.js` - מתקין `window.require` כפונקציה שממפה שמות מודולים לאחד מה-shims. גם מציב `window.electron`, `window.process`, `window.Buffer` כדי לכסות גישה ישירה (לא דרך require).
- `index.html` - דף נכנס משלנו, טוען את ה-shims, ה-boot, ואז את כל הקבצים של Obsidian בסדר המקורי שלהם **בלי שינוי**. החלק הזה הוא הליבה של ההפרדה בינינו לבין Obsidian.

**5. הרצה אמיתית**

- הוספנו cloudflared quick tunnel כדי לתת URL ציבורי לבדיקה.
- בדקנו ב-Chrome אמיתי דרך `gui-host` container (playwright-cli). אובסידיאן עולה, מזהה את הכספת, יוצר את `.obsidian/` עם ברירות-מחדל, פותח את `folder/Nested note.md` כ-tab ראשון, ומציג עץ קבצים מלא.

**6. תיעוד ותכנון**

- `PLAN.md` - תכנון מלא בן 5 פאזות: Phase 1 השלמת המסך הראשי, Phase 2 cache+bootstrap bundle, Phase 3 ריבוי כספות+auth, Phase 4 production quality, Phase 5 ביצועים.

#### החלטות ארכיטקטורה

- **שלוש שכבות נפרדות** (`server/`, `client/`, `obsidian/`): המטרה המרכזית היא לאפשר עדכון של Obsidian פשוט על-ידי החלפת התיקייה `obsidian/`. אם נגענו ב-`obsidian/app.js` ישירות, כל עדכון של Obsidian היה דורש merge ידני.

- **`window.require` interception במקום החלפת `app.js`**: הקוד של Obsidian ב-`app.js` מקזז לפעמים `window.require("electron")` ולפעמים פשוט מסתמך על `window.electron`. המינוף הקטן ביותר היה לכתוב מחדש את ה-`require` במקום לגעת ב-bundle.

- **Synchronous XHR למרות שזה deprecated**: Obsidian משתמש ב-`ipcRenderer.sendSync` ובכמה `*Sync` של fs. החלופות הן `SharedArrayBuffer + Atomics.wait` (דורש cross-origin headers וקצת BS) או preloading של כל הערכים. לפרויקט אישי על localhost, sync XHR פשוט עובד. נחליף אם נצטרך.

- **Vault id קבוע ("default") לפי שעה**: Obsidian תומך בריבוי כספות, אבל ב-MVP יש כספת אחת. ניהול כספות יוסיף API נפרד ב-Phase 3.

- **`/i18n`, `/lib`, `/public`, `/sandbox` משוקפים מ-`obsidian/`**: ה-app.js מבקש `/i18n/he.txt` כי תחת Electron זה נפתר על-ידי ה-`app://` protocol. במקום לתקן את ה-paths ב-app.js, השרת מגיש את התיקיות האלה בנתיבים שאובסידיאן מצפה להם.

#### מעקפים ופתרונות

- **`nativeTheme.removeAllListeners("updated").on("updated", l)`**: הקוד של Obsidian משרשר את הקריאות. ה-stub חייב להחזיר את `nativeTheme` עצמו מכל מתודה (`removeAllListeners`, `on`, וכו') כדי שהשרשור לא ישבר. תיקנו על-ידי חישוב ה-object עצמו ש-`return this` מכל מתודה.

- **`getCurrentWindow().webContents.getZoomFactor`**: Obsidian קורא `webContents.getZoomFactor` ועוד עשרות מתודות שלא ידענו עליהן מראש. במקום לכתוב כל מתודה בנפרד, ה-window stub הוא Proxy: כל גישה למתודה לא מוכרת מחזירה no-op. ה-zoom level מוחזק ב-module scope כדי ש-`webFrame` ו-`webContents` יסכימו על אותו ערך.

- **`crypto` shim חלקי**: Obsidian משתמש ב-`crypto.scrypt` בלבד (לא `createHash` כמו שחשבנו). יש לו stub ל-`createHash` שמחזיר ריק - אין שימוש בו כרגע אבל אם פלאגין יקרא לזה זה ישבר. ה-`scrypt` לא ממומש, אבל הוא בשימוש רק עבור הצפנת קבצים שלא מופעלת אצלנו.

- **400 על EISDIR/ENOTDIR**: השרת החזיר 500 כשניסו לקרוא תיקייה כקובץ. שינינו ל-400 כדי שזה יראה בלוגים כ"תקלה צפויה" ולא כ-server error אמיתי.

- **ההודעה "אובסידיאן מוסיף את הכספת לאינדקס"**: זו הודעה חד-פעמית של Obsidian בפעם הראשונה שכספת נפתחת. היא נעלמת מעצמה אחרי כמה שניות, לא אינדיקציה לתקלה.

#### מצב הידוע

- **לא עובד עדיין**: Vault switcher / starter (תפריט "נהל כספות..."). Phase 3.
- **רעש בלוגים**: 404s על קבצי `.obsidian/*.json` כשטוענים כספת חדשה - זה התנהגות תקינה (אובסידיאן יוצר אותם אם אין), אבל זה רועש.
- **טעינה איטית**: ~10 שניות מ-load ועד שהכספת מוכנה. מצביע על צורך ב-cache ו-`/api/bootstrap` endpoint שיחזיר את כל ה-config files במכה אחת. Phase 2.
- **plugins לא נבדקו**: לא ידוע אילו plugins של Obsidian יעבדו ב-web. Phase 4.

---

## 2026-06-13 — slice server-bootstrap-perf, Commit 0

### UV_THREADPOOL_SIZE knob + תיקון static-path guards

**Commit 0** של slice `server-bootstrap-perf`:

#### מה בוצע
- `src/server/config.js`: הוספת `threadPoolSize: parseInt(process.env.UV_THREADPOOL_SIZE || '64', 10)` ל-export.
- `src/server/index.js`: הוספת block בראש הקובץ (לפני כל require שנוגע ב-FS) שמגדיר `process.env.UV_THREADPOOL_SIZE` אם לא הוגדר ידנית. ערך ברירת מחדל 64 (במקום 4 של libuv).
- `src/server/index.js`: גורדו guards `if (appConfig.xPath)` סביב כל `express.static()` calls — תיקון pre-existing failure שנוצר ב-reorganization commit 9c0bec8 (כל הטסטים נכשלו עם "root path required" כשהועבר config חלקי).
- `README.md`: הוספת `UV_THREADPOOL_SIZE` לסעיף Configuration עם הסבר מלא.

#### מדידות (manual)
- vault: `eca2fa9fb0fa4b15` על rclone/Drive FUSE mount (~598 קבצים, 104 תיקיות)
- pool=4, VFS warm: full build 721ms, HIT 2ms
- pool=64, VFS warm: full build 715ms, HIT 3ms
- על VFS warm, ה-pool size לא מהותי (latency נסתרת). על VFS cold — pool=64 מוריד מ-~37s ל-~2s (ראה תיעוד ב-config.js).

#### בדיקות
- `npm test`: 10/10 ירוקים (כולל 2 שהיו broken לפני התיקון)
- Testing strategy: manual (לפי brief §4)

---

## 2026-06-13 — slice server-bootstrap-perf, Commit 1

### Surgical bootstrap cache invalidation

**Commit 1** של slice `server-bootstrap-perf`:

#### מה בוצע
- **חדש: `src/server/api/bootstrap-invalidate.js`** — לוגיקה טהורה (ללא express/FS) לעדכון surgical של entry ב-serverCache:
  - `updateEntryFile(entry, relPath, {content, size, mtime})`: מעדכן `fs[relPath]` + `dirs[parent]`
  - `removeEntryPath(entry, relPath)`: מוחק מ-`fs` ו-`dirs[parent]`; תיקיות → prune כל תת-עץ מ-`fs`/`dirs`/`dirMtimes`
  - שניהם מחזירים `{ changed: boolean }`, לא מקמפרסים (caller עושה debounce recompress)
- **`src/server/api/bootstrap.js`**: 
  - import של `bootstrap-invalidate.js`
  - הוספת `invalidateEntry(vaultId, relPath, opts)` עם debounced recompress (250ms)
  - Guard: אם `pendingBuilds` בריצה → fall back ל-`serverCache.delete` (race prevention)
  - export `invalidateEntry`
- **`src/server/api/fs.js`**: החלפת `invalidateBootstrapCache(vaultId)` ב-`invalidateEntry(vaultId, relPath, opts)` ב-7 call-sites:
  - `/write` (×2: coalesce + direct) → עם content+size+mtime מה-request (write-coalesce safe)
  - `/mkdir` → `{ removed: false }`
  - `/unlink`, `/rmdir` → `{ removed: true }`
  - `/rename` → שתי קריאות: removed old + not-removed new
  - `/copy` → `{ removed: false }` ל-destination
- **`src/server/api/electron.js`**: החלפת `invalidateBootstrapCache` ב-`invalidateEntry` ב-call-site שמיני (`/trash` — ממצא אביגיל #1/#2)

#### בדיקות
- TDD: test/bootstrap-invalidate.test.js נכתב ראשון (10 טסטים אדומים), אחר כך bootstrap-invalidate.js
- `npm test`: 20/20 ירוקים (10 חדשים + 10 קיימים)
- Testing strategy: tdd (לפי brief §4)
