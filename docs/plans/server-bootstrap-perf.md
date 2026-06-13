# Slice 1 — server-bootstrap-perf — ‏בריף

> **‏תאריך**: 2026-06-13
> **‏סוג מסמך**: ‏בריף ביצועי לסלייס
> **‏סטטוס**: הושלם — סבב fix רביעי בוצע; מוטציות תיקיות (mkdir/rename-dir) מתוקנות; ממתין ל-re-verification (calev-heavy)
> **‏אימות אביגיל**: ✅ READY (‏דוח: `reports/obsidian-web/server-bootstrap-perf-avigail.md`, ‏סבב 2, 0 ‏ממצאים)
> **‏אימות כלב-heavy**: ⚠️ PARTIAL (‏דוח: `reports/obsidian-web/server-bootstrap-perf-calev.md`) — 0 regressions, 2 ‏סטיות-contract minor (תוקנו בסבב fix)
> **Dispatch**: ‏מותר לאליעזר — plan-gate ‏עבר.
> **Complexity**: 8/10 (verifier: **heavy** — calev-heavy/Opus)
> **‏תלויות (`depends_on`)**: []
> **‏Base**: main (‏אין branch dev בריפו הזה — single-branch)
> **‏Dev tip**: `9c0bec8`

---

## §0 — Pre-flight

### ‏תלויות (‏חובה!)

‏אין תלויות. ‏בנוי ישירות על `main`. ‏נוגע רק בצד-שרת
(`src/server/api/bootstrap.js`, `src/server/index.js`, `src/server/config.js`,
`src/server/api/fs.js`). **‏לא מתנגש** ‏עם ה-WIP הלא-מקומיט של mobile-bootstrap-cache
(‏שנוגע ב-`src/client-mobile/` ‏ובצד-לקוח). ‏אפשר לעבוד במקביל.

> ⚠️ ‏יש WIP לא-מקומיט בעץ העבודה (mobile-bootstrap-cache: 8 ‏קבצים שונים +
> ‏קבצים חדשים תחת `src/client-mobile/`). **‏אל תיגע בו, ‏אל תקמיט אותו.**
> ה-worktree של slice זה נוצר מ-`main` הנקי (HEAD), ‏לכן ה-WIP לא ייכלל בו.

### Worktree

```bash
cd ~/projects/obsidian-web
git worktree add .worktrees/slice-1-server-bootstrap-perf -b slice-1-server-bootstrap-perf main
cd .worktrees/slice-1-server-bootstrap-perf/src/server
npm install
```

### ‏איך להריץ

- **BE**: `cd src/server && node index.js` (‏default `PORT=3000`, `HOST=127.0.0.1`).
  ‏ל-vault ‏ספציפי: `VAULT_PATH=<your-vault> node index.js`.
- **Tests (server)**: `cd src/server && npm test` ‏— ‏או `node --test test/`.
- **Tests (mobile unit, ‏לא קשור אבל אסור לשבור)**: `node --test src/client-mobile/test/`.
- ‏אין root `package.json`. ‏ה-deps של השרת ‏ב-`src/server/package.json` (express, compression, chokidar).

### Browser

‏לא נדרש browser ל-slice זה — ‏הכל צד-שרת. ‏המדידה (Phase 1/3) ‏נעשית מול
‏endpoint ‏ב-`curl` ‏ובלוגים של השרת, ‏ולא ב-DOM. ‏(כלב יבדוק את ההשפעה
‏על המובייל בנפרד, ‏ב-Slice 2.)

### Reading list

**must-read**:
- `src/server/api/bootstrap.js` ‏— ‏כל הקובץ. ‏לב ה-slice.
- `src/server/api/fs.js` ‏שורות 23-29 (‏`invalidateBootstrapCache`) ‏ו-403-500 (mutation routes).
- `src/server/api/electron.js` ‏שורות 14-20 (‏עותק שני ‏של `invalidateBootstrapCache`) ‏ו-52-74 (‏route `/trash` — **‏נתיב-מחיקה שני** ‏שעוקף ‏את `/api/fs`).
- `src/server/index.js` ‏שורות 1-40 ‏ו-159-165 (warm-up).

**reference**:
- `src/server/config.js` ‏— ‏בלוק `bootstrap` ‏ו-`watchPolling`.
- `docs/plans/mobile-bootstrap-cache.md` ‏— ‏רקע על ה-cache (‏slice סמוך).

---

## §1 — ‏מטרה

‏היום, ‏בכל פעם שמשהו ב-vault משתנה (Obsidian ‏שומר `workspace.json`, ‏עורך note),
‏ה-bootstrap cache **‏כולו** ‏נמחק, ‏וה-bootstrap הבא בונה מחדש את כל ה-vault
‏מאפס — ‏~1100 ‏פעולות FS, ‏שעל מאונט rclone/Drive קר לוקחות עשרות שניות.
‏אחרי slice זה: ‏שינוי קובץ בודד יעדכן רק את הרשומה שלו ב-cache (לא ימחק הכל),
‏ה-bootstrap הקר ‏הראשון יהיה ‏מהיר פי-עשרות בזכות concurrency גבוה יותר,
‏ו-rebuild ‏אחרי שינוי-חיצוני יבנה רק את התיקיות שהשתנו. ‏הצרכן (desktop +
‏mobile) ‏רואה אותו payload בדיוק — ‏רק ‏מהר ‏ועקבי, ‏בלי ה"לפעמים תקוע".

---

## §2 — Scope

| ‏פיצ'ר | ‏כן/לא | ‏לאן |
|------|------|------|
| `UV_THREADPOOL_SIZE` ‏knob + ברירת-מחדל מוגדלת | ✅ | Phase 1 |
| Surgical invalidation ‏ב-`fs.js` (7 call-sites) | ✅ | Phase 2 |
| Surgical invalidation ‏ב-`electron.js` `/trash` (call-site ‏8) | ✅ | Phase 2 |
| Incremental rebuild ל-`changedDirs` (‏במקום full re-scan) | ✅ | Phase 3 |
| ‏שינוי פורמט ה-payload (`fs`/`dirs`/`electron`) | ❌ | ‏אסור — ‏הצרכן לא משתנה |
| rclone VFS tuning (`--vfs-cache-mode` ‏וכו') | ❌ | host-managed (Proxmox), ‏מחוץ לריפו |
| ‏שינוי בצד-לקוח (desktop/mobile shims) | ❌ | ‏לא ב-slice הזה |
| ‏watcher-driven invalidation (chokidar → cache) | ❌ | ‏לא נדרש (‏ראה הערה למטה) |

> ‏עקרון: ‏הצרכן (‏ה-shims) ‏מקבל בדיוק אותו JSON. ‏זה slice ‏של **‏ביצועי-build**,
> ‏לא ‏שינוי-contract.
>
> ⚠️ **‏שני נתיבי-כתיבה, ‏לא אחד** (‏ממצא אביגיל #1/#2): ‏הכתיבות עוברות דרך
> `/api/fs/*` (`fs.js`) **‏וגם** ‏דרך `/api/electron/trash` (`electron.js` — ‏מחיקות).
> ‏**‏שניהם** ‏מחזיקים עותק ‏של `invalidateBootstrapCache` ‏ו**‏שניהם** ‏חייבים לעבור
> ל-surgical ‏ב-Phase 2. ‏אם ‏מחמיצים ‏את `trash` — ‏מחיקה ‏נשארת ‏ב-cache ‏עד restart
> (stale שקט, ‏עובר את הטסטים). ‏Phase 3 ‏הוא ‏רשת-ביטחון נוספת ‏אבל ‏לא תחליף.

---

## §3 — Architecture diagram

```
   /api/fs/{write,mkdir,unlink,rmdir,rename,copy}   +   /api/electron/trash
                                        │  (‏**‏שני** ‏נתיבי-כתיבה עוברים פה)
                                        ▼
   ‏היום:  invalidateBootstrapCache(vaultId)  ──►  serverCache.delete(vaultId)
          (‏עותק ‏ב-fs.js ‏**‏וגם** ‏ב-electron.js)        │  ⛔ ‏מוחק הכל
                                                         ▼
                                              ‏ה-bootstrap הבא = full re-scan (~1100 ops)

   ‏אחרי Phase 2:  invalidateEntry(vaultId, relPath, {removed})   ‏(‏שם ‏אחיד ‏בכל ה-brief)
                                        │  ✅ ‏מעדכן רשומה אחת
                                        ▼
                    entry.response.fs[relPath]    ‏מתעדכן/נמחק   ‏(‏מפתחות ה-entry: fs/dirs,
                    entry.response.dirs[parent]   ‏מתעדכן          ‏לא ה-locals fsCache/dirsCache)
                    entry.dirMtimes[parent]       ‏מתעדכן
                    ‏→ re-compress (debounced)  ‏→ ‏ה-bootstrap הבא = HIT

   ‏Phase 1:  index.js ‏בראש הקובץ ──► process.env.UV_THREADPOOL_SIZE ||= '64'
                    ‏→ rclone latency ‏מוסתר ב-concurrency (cold 37s → ~2s)

   ‏Phase 3:  _buildCacheEntry, ‏כשיש cache ‏ו-changedDirs.length>0:
                    ‏במקום fall-through ל-full walk →
                    re-walk ‏רק את changedDirs, prune/recurse לפי diff
```

---

## §4 — Commits ‏בסדר

### Commit 0 — `UV_THREADPOOL_SIZE` knob (approach: **manual**)

**‏קבצים שמשתנים**:
- `src/server/index.js` — ‏בראש הקובץ **‏לפני כל `require`** ‏שנוגע ב-FS
  (‏לפני `require('express')` ‏בשורה ~11), ‏הוסף:
  ```js
  // libuv runs all fs.* ops on a thread pool (default 4). On high-latency
  // mounts (rclone/Drive/NFS) the bootstrap walk is latency-bound, so a wider
  // pool hides that latency. Cold full bootstrap on a Drive-backed vault drops
  // from ~37s to ~2s. Override with UV_THREADPOOL_SIZE; we default it higher.
  if (!process.env.UV_THREADPOOL_SIZE) {
    process.env.UV_THREADPOOL_SIZE = String(require('./config').threadPoolSize);
  }
  ```
  > ⚠️ ‏חובה שזה יקרה **‏לפני** ‏ש-libuv מאתחל את ה-pool (‏כלומר לפני פעולת FS
  > ‏ראשונה). ‏בראש index.js, ‏לפני requires אחרים, ‏זה בטוח. ‏הערך לא משפיע
  > ‏אם נקבע אחרי שה-pool כבר אותחל.
- `src/server/config.js` — ‏הוסף ל-export:
  ```js
  // libuv thread-pool size. Higher helps latency-bound FS (rclone/NFS).
  threadPoolSize: parseInt(process.env.UV_THREADPOOL_SIZE || '64', 10),
  ```

**Verification** (manual):
```bash
cd src/server
# ‏מדידת before: ‏שמור את הערך הנוכחי, ‏הרץ עם pool=4 ‏וזמן את ה-bootstrap הקר.
# ‏(להפלת ה-VFS cache — ‏ראה §5 ‏שורה 1 ‏הערה.)
UV_THREADPOOL_SIZE=4 VAULT_PATH=<your-vault> node index.js &
time curl -s 'http://127.0.0.1:3000/api/bootstrap?vault=009428c4bd1ac698&full=1' -H 'accept-encoding: br' -o /dev/null
# ‏ואז עם ברירת המחדל החדשה (64) ‏— ‏וודא ירידה משמעותית בקר.
```

---

### Commit 1 — Surgical bootstrap invalidation (approach: **tdd**)

**‏מהות**: ‏היום `invalidateBootstrapCache(vaultId)` (`src/server/api/fs.js:24`)
‏עושה `serverCache.delete(vaultId)` — ‏מוחק את **‏כל** ‏ה-cache בכל mutation.
‏נחליף ב-invalidation ‏ברמת-רשומה.

**‏קבצים חדשים**:
- `src/server/api/bootstrap-invalidate.js` — ‏לוגיקה טהורה, ‏ניתנת ל-unit-test
  ‏בלי express/FS. ‏פועלת על אובייקט `entry` ‏(`{ response, dirMtimes, compressed }`).

**API skeleton**:
```js
// bootstrap-invalidate.js — pure functions over a cache entry.
//
// updateEntryFile(entry, relPath, { content, size, mtime }):
//   set entry.response.fs[relPath] = { mtime, size, isFile:true, content? }
//   ensure parent dir listing in entry.response.dirs[parent] has/updates the entry
//
// removeEntryPath(entry, relPath):
//   delete entry.response.fs[relPath]
//   if it was a directory → prune every fs/dirs/dirMtimes key under relPath+'/'
//   remove the entry from its parent's entry.response.dirs[parent] listing
//
// Both return { changed: boolean }. They do NOT recompress — caller does.
module.exports = { updateEntryFile, removeEntryPath };
```

**‏קבצים שמשתנים**:
- `src/server/api/bootstrap.js` — ‏הוסף ‏export ‏של ‏פונקציה ‏בשם **`invalidateEntry`**
  (‏שם ‏אחיד — ‏לא `invalidateBootstrapEntry`) `invalidateEntry(vaultId, relPath, { removed, content, size, mtime })`
  ‏שמושכת את ה-entry מ-`serverCache`, ‏קוראת ל-`updateEntryFile`/`removeEntryPath`,
  ‏ו**‏מקמפרסת מחדש debounced** (‏ראה risk #4). ‏אם אין entry ל-vault → no-op (‏ה-warm-up יבנה).
  ```js
  // exported alongside serverCache / warmUpBootstrapCache
  module.exports.invalidateEntry = invalidateEntry;   // (vaultId, relPath, {removed,content,size,mtime}) => void
  ```
- `src/server/api/fs.js` — ‏שנה את `invalidateBootstrapCache` ‏שתקרא ל-
  `bootstrap.invalidateEntry(vaultId, relPath, opts)` ‏במקום `serverCache.delete`.
  ‏7 ‏ה-call-sites (‏שורות 429, 436, 448, 459, 475, 487, 499) ‏כבר יושבים ליד
  ‏ה-route ‏הרלוונטי — ‏העבר את ה-relPath:
  - `/write` (429,436) → relPath ‏של ‏הקובץ שנכתב, `removed:false`, **‏עם** `content/size/mtime` ‏מ-ה-request (‏ראה ‏הערת write-coalesce למטה).
  - `/mkdir` (448) → relPath ‏של ‏התיקייה, `removed:false`.
  - `/unlink` (459), `/rmdir` (475) → relPath, `removed:true`.
  - `/rename` (487) → ‏**‏שתי קריאות**: `removed:true` ‏ל-old; ‏ול-new — `removed:false`
    ‏**‏עם `content`/`size`/`mtime`** (‏stat+read של ‏ה-newPath ‏מהדיסק אחרי ה-rename;
    ‏text ‏בתוך limit → ‏כולל content, ‏בינארי/‏oversized → ‏stat-only). ‏בלי זה ‏הקובץ
    ‏החדש ‏נשמר ‏עם `size=0/mtime=0` ‏וללא content — ‏סטייה ‏מ-full re-scan (‏תיקון NBug1).
  - **‏עדכון dir-mtime (‏כל add/remove/rename)** → ‏כשמשתנה ‏תוכן ‏תיקייה, ‏רענן ‏את ה-mtime
    ‏של ‏אותה ‏תיקייה ‏גם ב-(‏א) `fs[dir]` ‏(ה-dir-stat) ‏ו-(‏ב) ‏ה-entry ‏שלה ב-`dirs[parent]`.
    ‏אחרת ‏ה-mtime ‏בתצוגת-ההורה ‏נשאר ‏ישן — ‏סטייה ‏מ-full re-scan (‏תיקון NBug2).
  - `/copy` (499) → relPath ‏של היעד, `removed:false`.
- `src/server/api/electron.js` — **‏call-site ‏שמיני** (‏ממצא אביגיל #1/#2): ‏route `/trash`
  (‏שורה 54) ‏מוחק קובץ/‏תיקייה ‏ועושה `invalidateBootstrapCache(req.body.vault)` ‏בשורה 69
  ‏עם **‏עותק משלו** ‏של ‏הפונקציה (‏שורות 15-20). ‏שנה ‏גם ‏אותו ל-
  `bootstrap.invalidateEntry(req.body.vault, req.body.path, { removed: true })`.
  ‏(‏ה-`rel` ‏כבר ‏קיים ‏בשורה 56.)

  > **‏relPath — ‏מאיפה ‏הוא ‏מגיע** (‏ממצא #3, ‏תיקון): ‏ה-relPath ‏**‏כבר ‏יחסי-ל-vault**
  > — ‏הוא ‏מגיע ‏ישירות ‏מ-`req.query.path` / `req.body.path` / `oldPath` / `newPath`
  > (‏לא ‏מ-`target` ‏ה-absolute). **‏אין** helper absolute→relative ‏ב-fs.js (`resolveSafe`
  > ‏בשורה 135 ‏הולך ‏בכיוון ‏ההפוך) ‏ו**‏אין צורך בו**. ‏צריך ‏רק ‏לנרמל separators:
  > `relPath.split(path.sep).join('/')` — ‏כדי ‏שיתאים ‏למפתחות ‏ב-`fs`/`dirs`.
  >
  > **‏write-coalesce** (‏ממצא #7): `/write` ‏ב-rapid-fire ‏לא ‏כותב ‏לדיסק ‏מיד ‏אלא
  > ‏ל-buffer `pendingWrites` (`fs.js:88-90,426-431`). ‏לכן ‏ה-surgical update ‏חייב
  > ‏להשתמש ב-`data`/`encoding` ‏מ-ה-request (‏content+size+mtime ‏מחושבים ‏ממנו),
  > ‏**‏לא** ‏ב-`stat`/`readFile` ‏מהדיסק — ‏שעוד ‏לא ‏עודכן. ‏לכן `invalidateEntry`
  > ‏מקבל `content/size/mtime` ‏אופציונלית.

**Verification** (tdd — ‏טסטים ‏ראשונים):
```bash
cd src/server && node --test test/bootstrap-invalidate.test.js
# ‏מקרים: update קובץ קיים (‏content משתנה), ‏הוספת קובץ חדש (‏מופיע ב-dirs[parent]),
# ‏מחיקת קובץ (‏נעלם מ-fs ‏ומ-dirs[parent]), ‏מחיקת תיקייה (‏prune ‏לכל תת-העץ),
# rename (‏old ‏נעלם, new ‏מופיע), ‏no-op ‏כשאין entry ל-vault,
# update ‏עם content מ-request (‏לא re-stat מהדיסק — write-coalesce), trash→removed.
node --test test/  # ‏כל ה-server tests ‏עדיין ירוקים (‏כולל bootstrap-cache.test.js)
```

---

### Commit 2 — Incremental rebuild ל-changedDirs (approach: **integration**)

**‏מהות** (‏מנוסח ‏מחדש ‏לפי ‏ממצא אביגיל #5): ‏ב-`_buildCacheEntry` (`bootstrap.js:286`),
`changedDirs` ‏מחושב ‏בשורה 295 ‏ו**‏כן ‏בשימוש** — ‏הוא ‏קובע HIT-vs-MISS (‏שורה 310)
‏ומודפס ‏בלוג (316). ‏אבל ‏כש-MISS, ‏ה-rebuild ‏**‏תמיד ‏מלא**: ‏הקוד ‏ממשיך ‏ובונה ‏מאפס
‏דרך ‏**‏שתי** ‏קריאות `walkDir` — `.obsidian` (‏שורה 350) ‏ו-vault ‏המלא (‏שורה 391).
‏אין ‏שימוש ב-`changedDirs` ‏לצמצום ‏הסריקה. ‏נוסיף **‏ענף incremental לפני שורה 336**:
‏כש-`cached` ‏קיים ‏ו-`changedDirs.length > 0` — ‏לבנות ‏מחדש ‏רק ‏את ‏אותן ‏תיקיות.

**‏קבצים שמשתנים**:
- `src/server/api/bootstrap.js`, `_buildCacheEntry`:
  - ‏הוסף ענף: ‏אם `cached && changedDirs.length > 0 && cached.isFull === full`:
    - ‏התחל מ-`structuredClone(cached.response)` (‏או deep-copy ‏של `fs`/`dirs`).
    - ‏עבור כל `relDir` ‏ב-`changedDirs`: ‏re-`readdir`+`stat` ‏רק אותה תיקייה,
      ‏diff מול הרשומה הישנה ב-`dirs[relDir]`:
      - entry ‏שנעלם (file) → `delete fs[childRel]`.
      - entry ‏שנעלם (dir) → prune ‏כל ‏מפתח ב-`fs`/`dirs`/`dirMtimes` ‏עם prefix `childRel + '/'`.
      - entry ‏חדש (dir) → `walkDir` ‏מלא ‏פנימה (‏הוא לא ב-cache).
      - entry ‏חדש/‏שמתי-שונה (text file) → `readFile` ‏ועדכן `fs[childRel].content`.
    - ‏עדכן `dirs[relDir]` ‏ו-`dirMtimes[relDir]` (‏ולכל dir חדש/‏נמחק).
    - re-compress, ‏שמור entry. ‏log: `incremental rebuild (N dirs)` ‏— ‏לא `full`.
  - ‏שמור את ה-full re-walk ‏כ-fallback ‏אם **‏אין** `cached` (cold ‏אמיתי).

> ‏שים לב: ‏Phase 2 (write-path) ‏מטפל ב-99% (‏כתיבות של האפליקציה). Phase 3 ‏הוא
> ‏רשת-ביטחון ל-(א) restart לשרת (cache ‏אבד), (ב) ‏שינוי **‏חיצוני** ‏ישיר ב-Drive
> ‏שלא עבר דרך `/api/fs`. ‏זה גם ‏מתקן את ‏ה-stale-on-external-edit.

**Verification** (integration):
```bash
cd src/server && node --test test/bootstrap-incremental.test.js
# ‏fixture: ‏תיקיית tmp ‏אמיתית. ‏build מלא → ‏הוסף/מחק/שנה-שם קובץ →
# ‏build שוב → ‏וודא שרק changedDirs ‏נסרקו (‏spy על fsp.readFile ‏או ‏ספירת קריאות),
# ‏וש-fs/dirs ‏זהים ל-full re-scan ‏על אותו מצב (‏correctness).
node --test test/
```

---

## §5 — DoD verifiable

| # | ‏בדיקה | ‏איך |
|---|------|------|
| 1 | ‏כל ה-server tests ‏ירוקים | `cd src/server && npm install && node --test test/` |
| 2 | mobile unit tests ‏לא נשברו | `node --test src/client-mobile/test/` ‏(14 ‏ירוקים) |
| 3 | **Cold bootstrap ‏מהיר יותר** | ‏הפל VFS (`echo 3 > /proc/sys/vm/drop_caches` ‏אם זמין, ‏או ‏המתן/restart rclone — ‏תעד מה עשית), ‏מדוד `time curl '…/api/bootstrap?vault=009428c4bd1ac698&full=1'` ‏עם pool=4 ‏מול pool=64. ‏יעד: ‏שיפור ‏ניכר (‏פי-כמה). ‏**‏תעד מצב VFS**. |
| 4 | **‏שמירה ‏לא מוחקת cache** | ‏אחרי `PUT /api/fs/write?vault=…` ‏על קובץ אחד, ‏ה-bootstrap הבא הוא **HIT** (‏לוג `cache HIT`), ‏לא MISS/full. |
| 5 | **‏עדכון מדויק** | ‏כתוב תוכן חדש לקובץ קיים → ‏ה-bootstrap הבא מחזיר את ‏ה-content ‏החדש (‏לא ישן). |
| 6 | **‏מחיקה מדויקת — ‏שני הנתיבים** | (‏א) `DELETE /api/fs/unlink` ‏ו-(‏ב) `POST /api/electron/trash` → ‏בשני המקרים ‏הקובץ ‏נעלם מ-`fs` ‏ומ-`dirs[parent]` ‏ב-bootstrap הבא, ‏וה-bootstrap ‏נשאר HIT (‏לא ‏full re-scan); ‏שאר ה-vault ‏שלם. |
| 7 | **Incremental ‏מול full** | ‏שינוי חיצוני בקובץ אחד → ‏לוג מראה `incremental (1 dir)` ‏ולא full; ‏ה-payload ‏זהה ל-full re-scan ‏על אותו מצב. |
| 8 | ‏HIT נקי ‏נשאר ‏מהיר | ‏bootstrap ‏שני ‏ברצף (‏בלי שינוי) = `cache HIT (<… ms)`, ‏תת-שנייה. |
| 9 | README ‏מתעד `UV_THREADPOOL_SIZE` | ‏סעיף env vars. |
| 10 | walkthrough entry ‏מתוארך | `docs/walkthrough.md`. |
| 11 | **‏אין commits** | ‏השאר ל-merge ‏של מרדכי. |

---

## §6 — Risks + mitigations

| ‏סיכון | ‏מקור | ‏מיטיגציה |
|------|------|----------|
| `UV_THREADPOOL_SIZE` ‏נקבע ‏אחרי אתחול ה-pool → ‏לא משפיע | libuv ‏מאתחל ‏ב-FS ‏ראשון | ‏לקבוע ‏בראש index.js ‏לפני ‏כל require ‏שנוגע ב-FS. ‏אמת ב-`require('worker_threads')`-‏בדיקה ‏או ‏מדידת before/after. |
| relPath ‏לא תואם ‏למפתחות ה-cache (sep/encoding) | `walkDir:219` ‏משתמש ב-`split(sep).join('/')` | ‏השתמש ‏באותו helper ‏בדיוק; ‏טסט #5/#6 ‏יתפסו mismatch. |
| prune ‏של תת-עץ ‏מפספס/‏מוחק יותר מדי | recursion | ‏prune ‏לפי prefix `relDir + '/'` ‏בדיוק; ‏טסט ‏ייעודי למחיקת תיקייה ‏עם ‏ילדים. |
| race: invalidation ‏בזמן `pendingBuilds` ‏פעיל | build ‏רץ ברקע (‏שורה 506) | ‏**‏ממצא אביגיל #6**: `pendingBuilds` ‏ממופתח ב-`vaultId+':full'`/`+':partial'` (‏שורה 276), ‏לא ב-vaultId ‏חשוף. ‏הבדיקה ‏חייבת ‏להיות `[...pendingBuilds.keys()].some(k => k.startsWith(vaultId + ':'))` — ‏ואם ‏true, ‏ליפול ל-`serverCache.delete` (‏ההתנהגות הישנה). `pendingBuilds.has(vaultId)` ‏תמיד ‏false → ‏no-op ‏שקט. |
| re-compress ‏על כל כתיבה ‏בודדת ‏= CPU | ‏Obsidian ‏שומר ‏בתכיפות | **debounce** ‏את ה-recompress (‏~250ms) ‏— ‏עדכן את `response` ‏מיד, ‏דחה ‏רק את ‏יצירת ה-`compressed` Buffers. ‏HIT ‏שמגיע ‏לפני recompress ‏משתמש ב-buffer ‏הקודם ‏או ‏בונה ad-hoc. |
| `structuredClone` ‏על fs גדול ‏יקר | Phase 3 | ‏clone ‏רק את ה-sub-objects שמשתנים, ‏או mutate-in-place ‏על ה-entry ‏הקיים (‏ה-entry ‏ ‏ ‏ ‏לא ‏משותף ‏מחוץ ל-serverCache). |

> 3 ‏שתמיד נשכחים: (1) ‏ה-payload ‏חייב להישאר ‏זהה byte-for-byte ‏ל-full (‏טסט #7).
> (2) ‏binary files ‏לא נכנסים ל-`fs.content` (‏רק stat) — ‏שמור ‏על זה ב-invalidation.
> (3) ‏ה-`isFull` flag ‏על ‏ה-entry — ‏אל ‏תוריד אותו ‏ב-rebuild חלקי.

---

## §7 — Escalation triggers

‏עצור ושאל את מרדכי ‏אם:
- ‏ה-recompress debounce ‏יוצר ‏race ‏שמחזיר ‏payload ‏לא-עקבי ‏ואין פתרון נקי.
- ‏מתברר ש-`UV_THREADPOOL_SIZE` ‏לא מספיק ‏וצריך ‏לשנות ‏ארכיטקטורה (‏worker threads / ‏streaming).
- ‏ה-diff ‏ב-Phase 3 ‏דורש ‏לשמור ‏מבנה-נתונים ‏נוסף ‏שלא ‏קיים (‏שינוי contract ‏של ה-entry).
- ‏פתחת 3+ ‏גישות ל-incremental ‏ואף אחת ‏לא ‏נותנת payload ‏זהה ל-full.
- ‏ה-brief ‏סותר ‏את ‏עצמו, ‏או ‏רוצה ‏לסטות מ-Testing strategy ‏שנקבע ‏פר-commit.

---

## §8 — Complexity score + verifier tier

| ‏פרמטר | ‏ניקוד |
|------|------|
| Refactor ‏של קוד קיים (‏invalidation, build path) | +1 |
| State machine / async coordination (debounce, pendingBuilds, race) | +2 |
| >5 files? (‏4 ‏קבצים) | 0 |
| Pure logic ‏בחלק (bootstrap-invalidate ‏טהור) | -2 |
| TDD ‏על Phase 2 | -1 |
| FS edge-cases (prune, rename, dir-vs-file) | +2 |
| Latency-bound IO / ‏מאונט לא-טריוויאלי (rclone) | +2 |
| ‏סיכון regression ‏ל-payload ‏שצרכן קריטי (mobile+desktop) ‏תלוי בו | +2 |
| Pre-compression + Content-Encoding bypass ‏עדין | +2 |

**Score**: **8 / 10**

**Tier**: 8+ → **calev-heavy** (Opus). ‏7-stage protocol.

**Verifier-phase**: ‏הרץ `calev` (mode: phase) ‏אחרי **Commit 1** (‏ה-invalidation —
‏המסוכן ביותר ל-correctness של ה-payload), ‏לפני שממשיכים ל-Commit 2.

---

## §9 — ‏שאלות פתוחות

| # | ‏שאלה | ‏ברירת מחדל | ‏חוסם? |
|---|------|----------|------|
| 1 | ‏ערך ברירת-מחדל ל-`threadPoolSize` | 64 | ❌ |
| 2 | debounce window ‏ל-recompress | 250ms | ❌ |
| 3 | ‏האם ‏להפיל VFS ‏אפשרי ‏בסביבה (‏drop_caches דורש root) ‏או ‏שכלב ‏ימדוד warm-only | ‏כלב ‏יתעד ‏מה ‏שאפשר | ❌ |

---

## ‏סטיות מהתכנון (‏מתעדכן ע"י executor)

- **`incFsCache[relDir].size/mtime`**: המפרט לא ציין במפורש עדכון stat של הדירקטורי עצמו ב-fsCache — נוסף כי correctness gate נכשל ללא זה.
- **dead code cleanup**: WIP מ-reboot הכיל `const vault` + `const vaultData` שלא נוצלו — נוקו.
- **File-content update limitation**: עדכון תוכן קובץ קיים (ללא שינוי listing) לא נתפס ע"י incremental (dir mtime לא משתנה). זו מגבלה של mtime-based invalidation — גם בקוד המקורי. Phase 2 (surgical write-path) מטפל בזה.
- **Commits**: Phase 1=52b2a23, Phase 2=f460b98, Phase 3=ef4d3a7.
- **NBug1 fix — re-stat מהדיסק (לא מה-cache)**: הWIP לקח content/size/mtime מה-entry הישן ב-cache, אבל זה שבור כשהקובץ הישן לא ב-cache (oversized/binary/חדש). ההחלטה: stat+readFile של newPath מהדיסק אחרי הrename — כמו שה-brief §4 Commit 1 ציין. Edge-case: אם stat נכשל (גזירה?) → size/mtime ל-undefined → updateEntryFile משאיר 0 — זה מקבל אבל נדיר.
- **NBug2 fix — invalidateEntry הפך async**: _refreshDirMtimes הייתה fire-and-forget, כך שbootstrap request שהגיע לפני שהstat הסתיים ראה mtime ישן. הפתרון: await ל-_refreshDirMtimes בתוך invalidateEntry — כך route handlers מחכים לסיום הrefresh לפני שמחזירים 200. write-coalesce path (שם הקובץ עדיין לא על הדיסק) לא awaits — MISS יקרה אחרי flush וPhase3 יטפל ב-incremental rebuild.
- **סבב fix שלישי — ביטול ה-async**: התברר שה-async גרם latency על rclone ו-Phase 3 כבר מכסה dir-mtime parity. הוחזרנו ל-sync. dir-mtime parity = הכרעה מודעת: Phase 3 incremental rebuild מטפל בזה חינם.
- **isText flag**: updateEntryFile קיבל flag isText במקום לשכפל isTextFile לתוך bootstrap-invalidate.js — שומר על טהרת המודול.
- **/copy fix**: call-site של /copy פוספס ב-NBug1 fix. עכשיו עושה stat+readFile של dest ומעביר isText כמו rename.
- **compressedStale flag**: HIT path בחלון 250ms debounce הגיש buffer ישן ל-Accept-Encoding: br. תוקן דרך flag שמסמן stale מיד ב-scheduleRecompress ומנקה רק אחרי build buffer חדש.
- **מוטציות תיקיות → Phase 3 (force-stale parent), לא surgical — הכרעה מודעת**: mkdir/rename-dir לא קוראים ל-updateEntryFile. במקום זה: `isDir:true` flag ב-invalidateEntry כופה `dirMtimes[parent]=0` (stale). Phase 3 incremental rebuild מגלה changedDir ובונה את הסאבטרי נכון — byte-for-byte זהה ל-full. Guard ב-`_refreshDirMtimes` מונע דריסת ה-stale sentinel על-ידי async fire-and-forget. סדר קריאות ב-rename-dir: isDir(new) לפני removed(old) — נדרש לתזמון.
- **סטטוס**: הושלם — סבב fix רביעי בוצע; ממתין ל-re-verification (calev-heavy)
