# Slice B (LiveSync) — install-livesync + vendor/plugins overlay — ‏בריף

> **‏תאריך**: 2026-06-13
> **‏סוג מסמך**: ‏בריף ביצועי לסלייס
> **‏סטטוס**: ‏מאושר (plan-verified)
> **‏אימות אביגיל**: ✅ READY (‏דוח: `reports/obsidian-web/livesync-install-avigail.md`, ‏סבב 2, 0 ‏ממצאים)
> **Dispatch**: ‏מותר לאליעזר — plan-gate ‏עבר.
> **Complexity**: 4/10 (verifier: **light**)
> **‏תלויות (`depends_on`)**: []
> **‏Base**: main (`a5f5a4d`)
> **‏Dev tip**: `a5f5a4d`

---

## §0 — Pre-flight

### ‏תלויות (‏חובה!)

‏אין תלויות. ‏בנוי על main (`a5f5a4d`). ‏נוגע ב-`src/server/system-plugins.js`,
`src/server/api/fs.js` (‏שורה ‏אחת), ‏וקובץ ‏חדש `scripts/install-livesync.js`.
**‏עצמאי ‏מ-Slice A** (‏A ‏נוגע ב-`capacitor-shim.js` ‏בלבד) — ‏אפשר ‏להריץ ‏במקביל.

> ‏זה Slice B ‏מתוך 3 (‏ראה `livesync-requesturl.md` §0). ‏Slice C (E2E) ‏תלוי ב-A ‏וגם ‏ב-B.
> ‏מקור-רקע: `livesync-implementation.md` Phase 3 (‏מעודכן ‏ל-layout ‏אחרי reorg + ‏החלטת vendor/plugins).

### Worktree

```bash
cd ~/projects/obsidian-web
git worktree add .worktrees/livesync-install -b livesync-install main
cd .worktrees/livesync-install
```

### ‏איך להריץ

- **BE**: `cd src/server && PORT=3000 node index.js` (‏או 4001 ‏אם ‏תפוס).
- **Tests**: `cd src/server && node --test test/` ‏(ה-server tests ‏הקיימים). ‏טסט ה-overlay
  `test/system-plugins.test.js` ‏**‏עדיין ‏לא ‏קיים — ‏אתה ‏יוצר ‏אותו ‏ב-Commit 0** (‏ראה §4).
- **‏הסקריפט**: `node scripts/install-livesync.js` (‏דורש ‏רשת — GitHub).

### Reading list

**must-read**:
- `src/server/system-plugins.js` — ‏כל הקובץ (‏ה-overlay; `SYSTEM_PLUGIN_IDS` Set → ‏יהפוך Map).
- `src/server/api/fs.js` ‏שורות 236-253 (‏readdir ‏של ‏plugin dir — **‏שורה 253 ‏משתמשת ‏ב-`SYSTEM_PLUGINS_DIR` ‏הקבוע, ‏חייבת ‏תיקון**) ‏ו-188-192 (‏read ‏דרך `tryGetSystemFilePath`).
- `scripts/update-obsidian-mobile.js` ‏שורות 1-90 — **‏דפוס ‏ההורדה** (‏`https`, `--version`/`--force`, `withRetries`, cache ‏ב-`.tmp/`). ‏מודל ל-install-livesync.js.

**reference**:
- `livesync-implementation.md` ‏שורות 273-315 (Phase 3 ‏המקורי).
- `.gitignore` — `vendor/` ‏כבר ‏שם → `vendor/plugins/` ‏אוטומטית ‏gitignored (‏אל ‏תוסיף ‏כלום).

---

## §1 — ‏מטרה

‏כדי ‏ש-LiveSync (‏ושאר ‏פלאגיני ‏צד-שלישי ‏עתידיים) ‏יופיעו ‏אוטומטית ‏בכל vault ‏בלי ‏לזהם ‏את ‏הכספת
‏ובלי ‏להיכנס ‏לגיט: (1) ה-overlay ‏יסרוק ‏**‏שתי** ‏תיקיות — `src/plugins/` (‏הפלאגינים ‏שלנו, ‏tracked)
‏ו-`vendor/plugins/` (‏הורדות ‏צד-שלישי, ‏gitignored ‏כמו ‏שאר `vendor/`). (2) ‏סקריפט `install-livesync.js`
‏יוריד ‏את ‏obsidian-livesync ‏מ-GitHub ‏ל-`vendor/plugins/obsidian-livesync/`. ‏אחרי ‏ההרצה, ‏ה-overlay
‏מגיש ‏אותו ‏אוטומטית — ‏LiveSync ‏מופיע ‏ב-Settings → Community plugins.

---

## §2 — Scope

| ‏פיצ'ר | ‏כן/לא | ‏לאן |
|------|------|------|
| overlay ‏סורק ‏שתי ‏תיקיות (`src/plugins` + `vendor/plugins`) | ✅ | Commit 0 |
| `Set` → `Map` (id → rootDir) ‏ב-system-plugins.js | ✅ | Commit 0 |
| ‏תיקון `fs.js:253` ‏(`SYSTEM_PLUGINS_DIR` ‏קבוע → resolver ‏פר-id) | ✅ | Commit 0 |
| `scripts/install-livesync.js` (download → `vendor/plugins/obsidian-livesync/` + `data.json`) | ✅ | Commit 1 |
| ‏מימוש `App.requestUrl` | ❌ | Slice A |
| E2E ‏מול CouchDB | ❌ | Slice C |
| ‏שינוי ‏פורמט ‏manifest/community-plugins.json | ❌ | ‏אסור |
| `SYSTEM_PLUGINS` env-var ‏gating | ❌ | future (PLAN.md) |

> ‏עיקרון ‏הקונבנציה (‏החלטה ‏שנקבעה): ‏קוד ‏שלנו → `src/plugins/` (‏בגיט). ‏הורדות ‏צד-שלישי →
> `vendor/plugins/` (‏gitignored, ‏regenerated ‏ע"י ‏הסקריפט, ‏כמו `vendor/obsidian`). ‏לא ‏בגיט, ‏לא ‏בכספת.

---

## §3 — Architecture diagram

```
‏לפני:  system-plugins.init() ──► readdir(SYSTEM_PLUGINS_DIR = src/plugins) ──► Set<id>
                                                                              │
        fs.js read/readdir ──► tryGetSystemFilePath(id) / fs.js:253 ─────────┘
                                ‏(‏שניהם ‏מניחים ‏תיקייה ‏אחת)

‏אחרי:  system-plugins.init() ──► readdir(src/plugins)  ─┐
                                  readdir(vendor/plugins) ─┴──► Map<id → rootDir>
                                                                  │
        tryGetSystemFilePath(id) ──► resolve ‏מול Map[id]          │
        getSystemPluginDir(id)  ◄─── fs.js:253 ‏משתמש ‏בזה ‏במקום ‏הקבוע
                                                                  │
        install-livesync.js ──download──► vendor/plugins/obsidian-livesync/{main.js,manifest.json,styles.css,data.json}
                                                                  │
                                                  ‏ה-overlay ‏מגיש ‏אותו ‏→ ‏מופיע ‏ב-Obsidian
```

---

## §4 — Commits ‏בסדר

### Commit 0 — overlay ‏סורק ‏שתי ‏תיקיות (approach: **integration**)

**‏מהות**: `SYSTEM_PLUGIN_IDS` ‏(Set) ‏לא ‏מספיק — ‏צריך ‏לדעת ‏**‏מאיזו ‏תיקייה** ‏בא ‏כל id ‏כדי ‏לפתור ‏נתיב.
‏הפוך ‏ל-`Map<id, rootDir>`.

**‏קבצים שמשתנים**:
- `src/server/system-plugins.js`:
  - ‏הוסף `VENDOR_PLUGINS_DIR = path.resolve(__dirname, '..', '..', 'vendor', 'plugins')`.
    > ⚠️ `__dirname` ‏= `src/server`; `'..','..'` ‏= ‏repo root; ‏+`vendor/plugins`. ‏(‏שונה ‏מ-`SYSTEM_PLUGINS_DIR`
    > ‏שהוא `'..'` ‏בלבד = `src/plugins`. ‏אמת ‏את ‏שני ‏ה-resolve.)
  - ‏החלף `const SYSTEM_PLUGIN_IDS = new Set()` ‏ב-`const SYSTEM_PLUGIN_DIRS = new Map()` (id → ‏absolute rootDir).
  - `init()`: ‏סרוק ‏**‏את ‏שתי ‏התיקיות** ‏בסדר `src/plugins` ‏ואז `vendor/plugins`. ‏ENOENT ‏על ‏אחת ‏מהן →
    warn ‏והמשך (‏`vendor/plugins` ‏לא ‏קיים ‏עד ‏שהסקריפט ‏רץ).
    > 🔴 **‏precedence (‏ממצא ‏אביגיל)**: `Map.set` ‏נאיבי ‏בסדר ‏src→vendor ‏יגרום ‏ל-vendor ‏**‏לדרוס**
    > ‏את ‏src — ‏הפוך ‏מהרצוי. ‏לכן **‏first-wins ‏מפורש**: `if (SYSTEM_PLUGIN_DIRS.has(id)) { warn(‏"duplicate id, keeping src"); continue; } else SYSTEM_PLUGIN_DIRS.set(id, path.join(dir, dirName));`
    > ‏מכיוון ‏ש-`src/plugins` ‏נסרק ‏ראשון, ‏first-wins = `src/plugins` ‏מנצח (‏override ‏מכוון ‏שלנו).
  - ‏הוסף ‏ו-export `getSystemPluginDir(id)` → `SYSTEM_PLUGIN_DIRS.get(id) || null`.
  - `tryGetSystemFilePath(relPath)`: ‏פתור ‏מול `getSystemPluginDir(id)` ‏במקום `path.join(SYSTEM_PLUGINS_DIR, id)`.
    ‏שמור ‏על ‏guard ‏ה-path-traversal (‏resolved ‏חייב ‏להישאר ‏תחת ‏ה-rootDir ‏הספציפי).
  - `getSystemPluginIds()` → `Array.from(SYSTEM_PLUGIN_DIRS.keys()).sort()` (‏ללא ‏שינוי ‏ב-API).
  - `mergeCommunityList`/`stripCommunityList`/`isSystemPluginPath` — ‏עדכן ‏לעבוד ‏מול ‏ה-Map keys (‏זהה ‏פונקציונלית).
- `src/server/api/fs.js` ‏שורה 253:
  - ‏החלף `path.join(SYSTEM_PLUGINS_DIR, inSysDirMatch[1])` ‏ב-`getSystemPluginDir(inSysDirMatch[1])`
    (‏ייבא ‏אותו ‏מ-system-plugins). ‏זה ‏ה-readdir ‏שמרכיב ‏את ‏רשימת ‏קבצי ‏הפלאגין — ‏בלי ‏התיקון,
    ‏פלאגין ב-`vendor/plugins` ‏ייפתר ‏לתיקייה ‏הלא-נכונה.
  - > 🟡 **‏ממצא ‏אביגיל**: `fs.js` ‏מייבא `SYSTEM_PLUGINS_DIR` ‏בשורה 20. ‏אם ‏אחרי ‏החלפת ‏שורה 253
    > ‏הוא ‏כבר ‏לא ‏בשימוש ‏ב-fs.js — **‏הסר ‏את ‏הייבוא** (‏אחרת import ‏מת). ‏בדוק ‏עם grep ‏לפני ‏הסרה.

**Verification** (integration):
```bash
cd src/server && node --test test/system-plugins.test.js
# fixture: ‏תיקיית tmp ‏עם src/plugins/{ours} + vendor/plugins/{thirdparty}.
# ‏אמת: init ‏טוען ‏את ‏שניהם; getSystemPluginDir ‏מחזיר ‏את ‏הנכון ‏לכל id;
# tryGetSystemFilePath ‏פותר ‏קבצים ‏משתיהן; id ‏כפול → src/plugins ‏מנצח.
node --test test/   # ‏כל ה-server tests ‏ירוקים
```
+ ‏manual: ‏הרץ ‏שרת, ‏טען vault, ‏וודא ‏ש-obsidian-web-layout (‏שב-src/plugins) ‏עדיין ‏מופיע (‏לא ‏רגרסיה).

---

### Commit 1 — scripts/install-livesync.js (approach: **manual** + integration ‏על ‏ה-parse)

**‏קובץ חדש**: `scripts/install-livesync.js` — ‏מודל ‏על `scripts/update-obsidian-mobile.js`:
- `https` ‏(לא fetch), `withRetries`, cache ‏ב-`.tmp/cache/livesync-releases/`.
- ‏שלב ‏את ‏release metadata ‏מ-`https://api.github.com/repos/vrtmrz/obsidian-livesync/releases/latest`
  (‏או `--version <tag>`). Header `User-Agent` ‏חובה ל-GitHub API.
- ‏הורד ‏מה-assets ‏של ‏אותו release: `main.js`, `manifest.json`, ‏ו-`styles.css` ‏אם ‏קיים.
  **‏fail loud** ‏אם asset ‏חסר (‏ראה pitfall — ‏שם ה-asset ‏יכול ‏להשתנות upstream).
- ‏כתוב ‏ל-`vendor/plugins/obsidian-livesync/` (‏צור ‏את ‏התיקייה; `vendor/` ‏כבר ‏gitignored).
- ‏אחרי ‏ההורדה, ‏צור `data.json` ‏מינימלי ‏ליד ‏ה-manifest:
  ```json
  { "version": "<מ-manifest>", "remote_type": "couchdb",
    "_obsidian_web_note": "Configure your CouchDB URI in the LiveSync settings tab." }
  ```
  (‏אם ‏כבר ‏קיים `data.json` — ‏אל ‏תדרוס, ‏אלא ‏אם `--force`.)
- CLI: `node scripts/install-livesync.js [--version <tag>] [--force]`.

**Verification** (manual):
```bash
node scripts/install-livesync.js
ls vendor/plugins/obsidian-livesync/   # main.js, manifest.json, [styles.css], data.json
git check-ignore vendor/plugins/obsidian-livesync/main.js   # ‏מאומת ‏gitignored
```
+ ‏אם ‏אפשר ‏unit על ‏ה-asset-pick logic (‏טהור) ‏מול JSON ‏release ‏מדומה.

---

## §5 — DoD verifiable

| # | ‏בדיקה | ‏איך |
|---|------|------|
| 1 | server tests ‏ירוקים ‏(כולל ‏overlay ‏החדש) | `cd src/server && node --test test/` |
| 2 | overlay ‏טוען ‏משתי ‏התיקיות | טסט: ‏plugin ב-src/plugins **‏וגם** ‏ב-vendor/plugins ‏נטענים, getSystemPluginDir ‏מחזיר ‏נכון |
| 3 | ‏לא ‏רגרסיה: obsidian-web-layout ‏עדיין ‏מוגש | ‏טען vault → ‏הפלאגין ‏שלנו ‏עדיין ‏מופיע/‏עובד |
| 4 | install-livesync ‏מוריד ‏ל-vendor/plugins | `ls vendor/plugins/obsidian-livesync/` → main.js+manifest.json+data.json |
| 5 | ‏הפלאגין ‏gitignored ‏(לא ‏בגיט) | `git check-ignore vendor/plugins/obsidian-livesync/main.js` → ‏מודפס; `git status` ‏נקי ‏מהפלאגין |
| 6 | ‏אחרי ‏הרצה+טעינה, LiveSync ‏מוגש | `curl …/api/fs/read?…path=.obsidian/plugins/obsidian-livesync/main.js` → ‏מחזיר ‏את ‏הקובץ ‏מ-vendor/plugins (‏overlay) |
| 7 | `--force` ‏מעדכן; ‏בלי ‏force ‏לא ‏דורס data.json | ‏הרץ ‏פעמיים |
| 8 | walkthrough entry | `docs/walkthrough.md` |
| 9 | **‏אין commits** (‏גם ‏לא ‏הפלאגין — ‏gitignored) | ‏מרדכי |

---

## §6 — Risks + mitigations

| ‏סיכון | ‏מקור | ‏מיטיגציה |
|------|------|----------|
| `fs.js:253` ‏לא ‏מתוקן → ‏plugin ב-vendor/plugins ‏לא ‏מוגש ‏ב-readdir | overlay ‏refactor | ‏DoD #6 ‏(read ‏ישיר) + ‏בדיקת readdir ‏על ‏plugin ‏מ-vendor/plugins |
| ‏`vendor/plugins` ‏לא ‏קיים ‏ב-init (‏לפני ‏הרצת ‏הסקריפט) | ‏סדר | init ‏מטפל ‏ב-ENOENT ‏בחן ‏(warn+continue), ‏כמו ‏היום ‏ל-src/plugins |
| ‏שם ה-asset ‏ב-release ‏משתנה upstream (tarball ‏וכו') | plan pitfall #8 | **fail loud** ‏על asset-not-found; ‏לא ‏לנחש |
| GitHub API rate-limit ‏ללא ‏User-Agent/token | ‏רשת | `User-Agent` header ‏חובה; cache ‏ב-.tmp; ‏הודעת ‏שגיאה ‏ברורה |
| ‏id ‏כפול ‏בין ‏שתי ‏התיקיות | overlay | `src/plugins` ‏מנצח (‏override ‏שלנו) + warn — ‏מתועד ‏ב-§4 |
| ‏deploy: vendor/plugins ‏לא ‏ב-git archive | (‏מחוץ ל-slice) | ‏מרדכי ‏יזכור — ‏rsync ‏נפרד ‏ב-deploy ‏כמו `vendor/` (‏לא ‏חלק ‏מה-slice) |

> ‏3 ‏שנשכחים: (1) path-traversal guard ‏ב-tryGetSystemFilePath ‏חייב ‏להישאר ‏אחרי ‏המעבר ‏ל-Map.
> (2) ‏`getSystemPluginIds()` ‏API ‏לא ‏משתנה (‏צרכנים ‏ב-fs.js ‏סומכים ‏עליו). (3) ‏מחרוזות-לוג ‏בעברית/i18n — ‏לא ‏רלוונטי ‏פה.

---

## §7 — Escalation triggers

- ‏release ‏של ‏obsidian-livesync ‏לא ‏מצרף `main.js`/`manifest.json` ‏כקבצים (‏tarball) — ‏עצור, ‏דווח.
- ‏ה-overlay ‏צריך ‏יותר ‏מ-id→dir (‏למשל ‏precedence ‏מורכב) — ‏עצור, ‏שאל ‏מרדכי.
- ‏LiveSync ‏דורש ‏קבצים ‏נוספים ‏מעבר ‏ל-main/manifest/styles/data — ‏דווח.
- ‏סטייה ‏מ-Testing strategy.

---

## §8 — Complexity score + verifier tier

| ‏פרמטר | ‏ניקוד |
|------|------|
| Refactor ‏של ‏קוד ‏קיים (Set→Map, 2 ‏call-sites) | +1 |
| ‏ספרייה ‏חיצונית ‏חדשה | 0 (‏רק `https` ‏stdlib) |
| ‏רשת/IO (download) | +1 |
| >5 files? (‏3 ‏קבצים) | 0 |
| Pure logic ‏בחלק (overlay Map, asset-pick) | -1 |
| Greenfield ‏(הסקריפט ‏חדש, ‏אין ‏call-sites ‏לשבור) | -1 |
| ‏overlay ‏הוא ‏נתיב ‏קריטי ‏(כל ‏קריאת ‏פלאגין ‏עוברת ‏בו) | +2 |
| ‏שדרת ‏פלאגינים ‏עתידיים ‏תלויה ‏בקונבנציה | +2 |

**Score**: **4 / 10**

**Tier**: light. (‏אופציונלי phase verifier ‏אחרי Commit 0 — ‏ה-overlay ‏refactor — ‏אם ‏אליעזר ‏רוצה ‏ביטחון ‏לפני ‏Commit 1.)

---

## §9 — ‏שאלות פתוחות

| # | ‏שאלה | ‏ברירת מחדל | ‏חוסם? |
|---|------|----------|------|
| 1 | precedence ‏על id ‏כפול | `src/plugins` ‏מנצח | ❌ |
| 2 | ‏האם ‏לאחסן ‏cache ‏של ‏ה-release ‏ב-.tmp ‏(כמו update-obsidian) | ‏כן | ❌ |
| 3 | data.json ‏ברירת-מחדל — ‏שדות ‏מינימליים ‏או ‏ריק | ‏מינימלי ‏(§4) | ❌ |

---

## ‏סטיות מהתכנון (‏מתעדכן ע"י executor)

- (‏ריק)
