# Slice — server-shims — ‏בריף

> **‏תאריך**: 2026-06-13
> **‏סוג מסמך**: ‏בריף ביצועי לסלייס
> **‏סטטוס**: ‏טיוטה
> **‏אימות אביגיל**: ‏לא מאומת (‏דוח: `reports/obsidian-web/server-shims-avigail.md`)
> **Dispatch**: ‏מותר לאליעזר רק אם `אימות אביגיל = READY`.
> **Complexity**: 3/10 (verifier: light)
> **‏תלויות (`depends_on`)**: []
> **‏Base**: main (‏אין ענף dev בריפו הזה)
> **‏Dev tip**: `51e09db`

---

## §0 — Pre-flight

> ‏Boilerplate פר-פרויקט: **`docs/plans/EXECUTOR_DISPATCH.md`** — ‏קרא אותו קודם.
> ‏הוא מכסה: single-branch (אין dev), npm (לא pnpm), ports (4000+), אין tunnel/browser לסלייס שרת-בלבד, ‏אין merge/push.
> ‏מה שכתוב פה גובר על ה-boilerplate אם יש סתירה.

### ‏תלויות (‏חובה!)

‏slice זה **‏אין לו תלויות** — ‏בנוי ישירות על `main` (`51e09db`).
‏שלושת ה-routers החדשים עצמאיים לחלוטין: ‏הם מקבלים רק `userDataPath` ‏ולא נוגעים ב-vault-registry, auth, bootstrap, ‏או כל רכיב אחר ב-PR #9.

### ‏מקור החילוץ

‏הקוד מגיע מ-PR #9 (fork חיצוני). ‏worktree reference לקריאה בלבד:
`~/projects/obsidian-web/.worktrees/pr9-ref/` (‏ענף `pr9-tmp`, ‏hash `dab0c97`).

> ⚠️ **‏אזהרה קריטית — ‏אל תחלץ `src/server/index.js` ‏או `src/server/config.js` ‏מ-pr9-ref.**
> ‏שני הקבצים האלה **‏חתוכים פיזית** ‏ב-PR head (‏נגמרים באמצע שורה, `No newline at end of file`,
> ‏וב-config.js ‏בלוק `bootstrap` ‏נמחק לגמרי — ‏זו רגרסיה). ‏את ה-wiring וה-config
> ‏מוסיפים **‏ידנית** ‏על גבי גרסת `main` ‏התקינה, ‏לפי ההוראות המדויקות ב-§4 ‏למטה.
> ‏מותר להעתיק as-is **‏רק** ‏את שלושת קבצי ה-router החדשים (api/keytar.js, api/localstorage.js, api/pbkdf2.js)
> — ‏אלה קבצים שלמים ותקינים ב-pr9-ref.

### Worktree

‏ה-worktree **‏כבר הוקם** ‏ע"י מרדכי:
```bash
# (‏כבר בוצע) git worktree add ~/projects/obsidian-web/.worktrees/server-shims -b server-shims main
cd ~/projects/obsidian-web/.worktrees/server-shims/src/server
npm install
```

### ‏איך להריץ

- **BE**: `cd src/server && PORT=4000 node index.js` (‏אם 4000 ‏תפוס → 4001+, ‏בדוק `ss -tln | grep :4000`)
- **Tests (server)**: `cd src/server && npm test` (‏= `node --test`) ‏או `node --test test/<file>`
- **‏אין browser, ‏אין tunnel** — ‏סלייס שרת-בלבד. ‏אימות ב-curl ‏ובטסטים.

### Baseline ‏ירוק (‏לפני שמתחילים)

‏אחרי `npm install`, ‏הרץ `npm test` — ‏צריך **15/15 pass**. ‏אם לא 15 ‏ירוקים, ‏עצור (Escalation).
‏(‏הערה: ‏בלי `npm install` ‏הטסטים נכשלים על `Cannot find module 'express'` — ‏זה רק חוסר node_modules, ‏לא באג.)

### Reading list

**must-read**:
- `docs/plans/EXECUTOR_DISPATCH.md` (‏פר-פרויקט)
- `src/server/index.js` ‏ב-main (‏לדעת לאן להוסיף את ה-wiring — §4)
- `src/server/config.js` ‏ב-main (‏לדעת לאן להוסיף `userDataPath` — §4)

**reference**:
- `.worktrees/pr9-ref/src/server/api/{keytar,localstorage,pbkdf2}.js` (‏מקור החילוץ)
- `.worktrees/pr9-ref/CLAUDE.md` (‏מסביר את תפקיד כל shim)

---

## §1 — ‏מטרה

‏שלושת ה-shims ‏צד-שרת שאליהם הקליינט (boot.js / ‏shims) ‏יפנה בעתיד — keychain, localStorage ‏מרוחק, ו-PBKDF2 ‏— ‏יהיו זמינים וטעונים בשרת. ‏אף משתמש לא רואה שינוי עדיין (‏אין client wiring ‏בסלייס זה), ‏אבל ה-endpoints ‏עונים נכון ל-curl ‏ושמורים בדיסק תחת `user-data/`. ‏זהו החילוץ הנקי הראשון מ-PR #9: ‏שלושה קבצים עצמאיים, ‏בלי קונפליקט מול main, ‏בלי תלויות חדשות.

---

## §2 — Scope

| ‏פיצ'ר | ‏כן/לא | ‏לאן |
|------|------|------|
| `POST /api/pbkdf2` ‏(‏key derivation) | ✅ | ‏בסלייס הזה |
| `/api/keytar` ‏GET/PUT/DELETE/all ‏(‏keychain) | ✅ | ‏בסלייס הזה |
| `/api/localstorage` ‏GET/PUT ‏(‏server-backed) | ✅ | ‏בסלייס הזה |
| `userDataPath` ‏ב-config | ✅ | ‏בסלייס הזה (‏נדרש ע"י השלושה) |
| ‏wiring ‏מינימלי ב-index.js ‏(3 ‏require + 3 app.use) | ✅ | ‏בסלייס הזה |
| TOTP auth middleware (`middleware/auth.js`) | ❌ | slice ‏עתידי (otplib/qrcode, ‏אבטחה) |
| vault-registry path-guard (`vaultsRoot`/`allowPaths`) | ❌ | slice ‏עתידי |
| ‏MIME types / mkdirRepair ‏ב-fs.js | ❌ | slice ‏עתידי |
| ‏Client shims (remote-localstorage.js, boot.js crypto) | ❌ | slice ‏עתידי |
| ‏שינוי ל-`bootstrap` config ‏או ל-`createApp` signature | ❌ | ‏לא נוגעים — ‏רגרסיה ב-PR |
| Service Worker (sw.js), ‏favicon routes | ❌ | slice ‏עתידי |

> **‏גבול קריטי**: ‏אל תיגע ב-`bootstrap` config, ‏ב-signature ‏של `createApp(appConfig = {})`,
> ‏או ב-warm-up. ‏גרסת ה-PR שינתה אותם והכניסה רגרסיה (`warmUpBootstrapCache` ‏לא נקרא).
> ‏בסלייס זה משאירים את כל זה **‏כמו ב-main**.

---

## §3 — Architecture diagram

```
                         src/server/index.js  (main, ‏מוסיפים 3 require + 3 app.use)
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
┌────────────────┐      ┌──────────────────┐      ┌────────────────┐
│ api/keytar.js  │      │ api/localstorage │      │  api/pbkdf2.js │  ← ‏חדשים (‏חילוץ as-is)
│ (createKeytar  │      │ .js (createLocal │      │ (createPbkdf2  │
│  Router)       │      │  StorageRouter)  │      │  Router)       │
└───────┬────────┘      └────────┬─────────┘      └───────┬────────┘
        │ userDataPath           │ userDataPath           │ (‏none)
        ▼                        ▼                        ▼
 user-data/.keychain    user-data/.localstorage   crypto.pbkdf2
   .json                  .json                    (‏native, ‏async)
        ▲                        ▲
        └──── config.js: userDataPath = PROJECT_ROOT/user-data ────┘ ← ‏חדש בקונפיג
```

---

## §4 — Commits ‏בסדר

### Commit 0 — ‏הוספת שלושת ה-routers + config + wiring (approach: integration)

**‏קבצים חדשים** (‏העתק as-is ‏מ-`.worktrees/pr9-ref/`):
- `src/server/api/keytar.js` — ‏זהה ל-pr9-ref. ‏מייצא `createKeytarRouter(userDataPath)`.
- `src/server/api/localstorage.js` — ‏זהה ל-pr9-ref. ‏מייצא `createLocalStorageRouter(userDataPath)`.
- `src/server/api/pbkdf2.js` — ‏זהה ל-pr9-ref. ‏מייצא `createPbkdf2Router()`.

‏פקודת ההעתקה:
```bash
cd ~/projects/obsidian-web/.worktrees/server-shims
cp ../pr9-ref/src/server/api/keytar.js       src/server/api/keytar.js
cp ../pr9-ref/src/server/api/localstorage.js src/server/api/localstorage.js
cp ../pr9-ref/src/server/api/pbkdf2.js       src/server/api/pbkdf2.js
```

**‏קבצים שמשתנים** — ‏עריכה ידנית מדויקת (‏לא העתקה!):

**(א) `src/server/config.js`** — ‏הוסף `userDataPath` ‏ל-`module.exports`.
‏ב-main, ‏`module.exports = {` ‏מתחיל בשורה 64, ‏ו-`projectRoot: PROJECT_ROOT,` ‏בשורה 73.
‏הוסף שורה אחת מיד אחרי פתיחת `module.exports = {`:
```js
module.exports = {
  userDataPath: path.resolve(PROJECT_ROOT, 'user-data'),   // ← ‏שורה חדשה
  port: parsePort(process.env.PORT),
  // ... ‏שאר השדות ‏ללא שינוי
```
> ‏אל תוסיף `vaultsRoot` ‏ולא תיגע בבלוק `bootstrap`. ‏רק `userDataPath`.

**(ב) `src/server/index.js`** — ‏שני שינויים מינימליים, ‏שום דבר אחר:

1. ‏require ‏לשלושת ה-routers. ‏ב-main, ‏שורות 19-25 ‏הן בלוק ה-require ‏של ה-routers.
   ‏הוסף שלוש שורות מיד אחרי `const createProxyRouter = require('./api/proxy');` (‏שורה 24):
```js
const createProxyRouter = require('./api/proxy');
const createKeytarRouter = require('./api/keytar');           // ← ‏חדש
const createLocalStorageRouter = require('./api/localstorage'); // ← ‏חדש
const createPbkdf2Router = require('./api/pbkdf2');            // ← ‏חדש
const attachWatchServer = require('./api/watch');
```

2. ‏wiring ‏של ה-routes. ‏ב-main, ‏בלוק `// API routes.` ‏מתחיל בשורה ~130,
   ‏ו-`app.use('/api/bootstrap', ...)` ‏בשורה 131. ‏הוסף שלוש שורות **‏לפני** ‏שורת ה-bootstrap:
```js
  // API routes.
  app.use('/api/keytar', createKeytarRouter(appConfig.userDataPath));            // ← ‏חדש
  app.use('/api/localstorage', createLocalStorageRouter(appConfig.userDataPath)); // ← ‏חדש
  app.use('/api/pbkdf2', createPbkdf2Router());                                  // ← ‏חדש
  app.use('/api/bootstrap', createBootstrapRouter(vaultRegistry, appConfig.vaultPath, appConfig.bootstrap));
```
> ⚠️ ‏שמור על `createBootstrapRouter(vaultRegistry, appConfig.vaultPath, appConfig.bootstrap)` ‏**‏כמו ב-main**
> — ‏עם הארגומנט השלישי `appConfig.bootstrap`. ‏גרסת ה-PR הורידה אותו (‏רגרסיה). ‏אל תיגע בו.
> ⚠️ ‏אל תשנה את signature ‏של `createApp` ‏(‏ב-main: `createApp(appConfig = {})` ‏עם merge ל-config).

**API skeleton** (‏לתיעוד — ‏החתימות שאסור לשנות, ‏כבר בקבצים שמועתקים):
```js
createKeytarRouter(userDataPath: string): express.Router
createLocalStorageRouter(userDataPath: string): express.Router
createPbkdf2Router(): express.Router
// config: userDataPath = path.resolve(PROJECT_ROOT, 'user-data')
```

**Verification** (‏ידני, ‏אחרי Commit 0):
```bash
cd ~/projects/obsidian-web/.worktrees/server-shims/src/server
npm install                       # ‏אם node_modules ‏עדיין לא קיים
npm test                          # ‏צריך עדיין 15/15 ‏ירוק (‏רגרסיה: ‏הטסטים הקיימים לא נשברו)
PORT=4000 node index.js &         # ‏או 4001+ ‏אם תפוס
sleep 1
# pbkdf2: ‏וקטור בדיקה ידוע
curl -s -X POST http://127.0.0.1:4000/api/pbkdf2 -H 'Content-Type: application/json' \
  -d '{"password":"70617373","salt":"73616c74","iterations":1,"keyLen":20}'
# ‏צפוי: {"key":"65acafe9655d154ebe7ca04e8b7ebdbc2bfd1684"}  ← PBKDF2-HMAC-SHA256("pass","salt",1,20)
# keytar: PUT ‏ואז GET
curl -s -X PUT http://127.0.0.1:4000/api/keytar -H 'Content-Type: application/json' \
  -d '{"service":"obsidian","account":"tok","password":"hunter2"}'
curl -s 'http://127.0.0.1:4000/api/keytar?service=obsidian&account=tok'   # ‏צפוי: {"password":"hunter2"}
# localstorage: PUT ‏ואז GET
curl -s -X PUT http://127.0.0.1:4000/api/localstorage -H 'Content-Type: application/json' \
  -d '{"entries":{"theme":"dark"}}'
curl -s http://127.0.0.1:4000/api/localstorage   # ‏צפוי: {"theme":"dark"}
kill %1
```

### Commit 1 — ‏טסט אינטגרציה ל-3 ה-endpoints (approach: tdd)

**‏קובץ חדש**:
- `src/server/test/server-shims.test.js` — ‏טסט node:test ‏שמרים את האפליקציה דרך `createApp(config)`
  ‏עם `userDataPath` ‏מצביע ל-tmp dir, ‏ועובר על שלושת ה-routers.

> ‏הסתכל על `src/server/test/vaults-api.test.js` ‏כתבנית: ‏הוא מקים tmp dir,
> ‏בונה config ‏עם `registryPath: path.join(tmp, 'vaults.json')`, ‏ומריץ `createApp(config)`
> ‏מול `http`. ‏השתמש באותה גישה — ‏פשוט הוסף `userDataPath: path.join(tmp, 'user-data')` ‏ל-config שהטסט בונה.

**‏מה הטסט בודק** (‏מינימום DoD):
1. `POST /api/pbkdf2` ‏עם וקטור (`"pass"/"salt"` ‏כ-hex, ‏iterations=1, keyLen=20) ‏מחזיר
   `key === "65acafe9655d154ebe7ca04e8b7ebdbc2bfd1684"`. ‏זה הערך עבור PBKDF2-**HMAC-SHA256**
   ‏(‏מאומת מקומית עם `crypto.pbkdf2`). ‏שים לב: ‏וקטור RFC-6070 ‏המקורי `0c60c80f...` ‏הוא ל-SHA**1** ‏— ‏לא נכון פה.
2. `POST /api/pbkdf2` ‏עם body ‏חסר/לא-תקין → 400.
3. `PUT /api/keytar` ‏ואז `GET /api/keytar?service=&account=` ‏מחזיר את הסיסמה שנשמרה.
4. `GET /api/keytar` ‏על account ‏לא קיים → 404. `DELETE` ‏ואז GET → 404.
5. `PUT /api/localstorage {entries:{a:"1"}}` ‏ואז `GET` ‏מחזיר `{a:"1"}`; `PUT {entries:{a:null}}` ‏מוחק.
6. ‏הקבצים `.keychain.json` ‏ו-`.localstorage.json` ‏נכתבים תחת `userDataPath` ‏(‏לא תחת PROJECT_ROOT ‏האמיתי).

> **‏הערת וקטור-בדיקה**: ‏ה-pbkdf2 endpoint ‏מקבל password+salt ‏כ-**hex**. ‏לכן "pass" → `70617373`,
> "salt" → `73616c74`. ‏אם הטסט בונה את ה-input מ-string, ‏המר ל-hex ‏עם `Buffer.from("pass").toString("hex")`.
> ‏ה-output ‏הצפוי `65acafe9655d154ebe7ca04e8b7ebdbc2bfd1684` ‏הוא PBKDF2-HMAC-**SHA256**, 1 iteration, 20 bytes
> ‏(‏מאומת מקומית). ‏ה-endpoint ‏מקודד תמיד SHA256 (`crypto.pbkdf2(..., 'sha256', ...)`).

**Verification**:
```bash
cd ~/projects/obsidian-web/.worktrees/server-shims/src/server
node --test test/server-shims.test.js   # ‏הטסט החדש ‏עובר
npm test                                # ‏כל הטסטים (‏ישנים + ‏חדש) ‏ירוקים
```

---

## §5 — DoD verifiable

| # | ‏בדיקה | ‏איך |
|---|------|------|
| 1 | ‏כל הטסטים ירוקים (‏ישנים + ‏חדש) | `cd src/server && npm test` → ‏לפחות 15 ‏ישנים + ‏החדש, ‏0 fail |
| 2 | ‏השרת עולה ללא שגיאה | `PORT=4000 node index.js` — ‏רואים את ה-banner, ‏אין crash |
| 3 | pbkdf2 ‏וקטור-בדיקה | curl POST → `key === "65acafe9655d154ebe7ca04e8b7ebdbc2bfd1684"` |
| 4 | keytar roundtrip | PUT ‏ואז GET ‏מחזיר את הסיסמה; DELETE ‏ואז GET → 404 |
| 5 | localstorage roundtrip | PUT ‏ואז GET ‏מחזיר את ה-map; `null` ‏מוחק key |
| 6 | ‏אין רגרסיה ל-bootstrap | `createBootstrapRouter(...)` ‏עדיין נקרא עם 3 ‏ארגומנטים; `createApp` signature ‏לא שונה |
| 7 | ‏קבצים נשמרים תחת user-data | `.keychain.json` / `.localstorage.json` ‏נכתבים ל-`userDataPath`, ‏לא ל-root |

---

## §6 — Risks + mitigations

| ‏סיכון | ‏מקור | ‏מיטיגציה |
|------|------|----------|
| ‏העתקת index.js/config.js ‏חתוכים מ-pr9-ref | ‏סקירת PR #9 — ‏שני הקבצים truncated | §0 + §4: ‏עריכה ידנית בלבד, ‏אסור cp ‏לשני הקבצים האלה |
| ‏שכפול רגרסיית warm-up / bootstrap config | PR head ‏הוריד `appConfig.bootstrap` | §4: ‏שמור על `createBootstrapRouter(..., appConfig.bootstrap)` ‏כמו main |
| ‏שינוי signature ‏של `createApp` ‏שובר טסטים קיימים | PR ‏שינה ל-`createApp(appConfig = config)` | ‏אל תיגע ב-signature; ‏טסטים מסתמכים על merge-with-default |
| ‏וקטור pbkdf2 ‏לא תואם (hex vs utf8) | ‏ה-endpoint ‏מצפה hex | §4: "pass"→70617373, "salt"→73616c74; ‏output PBKDF2-HMAC-SHA256 = `65acafe9...` (‏לא וקטור RFC-6070 ‏ש-הוא SHA1) |
| ‏טסט כותב ל-user-data ‏האמיתי | ‏ברירת מחדל של config | ‏הטסט בונה `userDataPath: path.join(tmp, ...)` — ‏לא משתמש בברירת המחדל |
| ‏node_modules ‏חסר → "Cannot find module express" | worktree ‏טרי | `npm install` ‏לפני test/run (‏ראה Baseline) |

> ‏3 ‏שתמיד נשכחים:
> 1. Hardcoded strings → i18n — **‏לא רלוונטי** (‏צד-שרת בלבד, ‏אין UI).
> 2. ‏Reactivity gotchas — **‏לא רלוונטי** (‏אין Svelte/client).
> 3. ‏OneCLI placeholder — **‏לא רלוונטי**.

---

## §7 — Escalation triggers

‏עצור ושאל את מרדכי אם:
- ‏הטסטים הקיימים (15) ‏לא ירוקים אחרי `npm install` ‏עוד **‏לפני** ‏שנגעת בכלום.
- ‏העתקת router ‏מ-pr9-ref ‏דורשת תלות שלא ב-`package.json` ‏של main (‏לא אמורה — ‏השלושה משתמשים רק ב-express/crypto/fs).
- ‏וקטור ה-pbkdf2 ‏לא תואם את הערך הצפוי (‏ייתכן בעיית hex/encoding — ‏אל "תתקן" ‏את ה-endpoint ‏בלי לשאול).
- ‏אתה רוצה לסטות מ-Testing strategy (Commit 0 = integration ‏ידני, Commit 1 = tdd).
- ‏ה-brief ‏סותר את עצמו.

---

## §8 — Complexity score + verifier tier

| ‏פרמטר | ‏ניקוד |
|------|------|
| Greenfield, ‏אין call sites קיימים (‏3 routers ‏עצמאיים) | -1 |
| Pure logic, ‏IO ‏פשוט (‏read/write JSON, crypto) | -2 |
| TDD ‏ל-Commit 1, ‏וקטור-בדיקה קנוני | -1 |
| >5 files? ‏לא (‏3 ‏חדשים + 2 ‏עריכות זעירות + 1 ‏טסט) | 0 |
| ‏ספרייה חיצונית חדשה? ‏לא (express/crypto ‏קיימים) | 0 |
| ‏עריכה ידנית עדינה לקבצים מ-PR ‏חתוך (‏מקור לטעות) | +2 |
| Cross-store / streaming / protocol | 0 |

**Score**: 3 / 10 (‏הבסיס שלילי; +2 ‏על עדינות העריכה הידנית מקבצים חתוכים)

**Tier**: 0-3 → `calev` (mode: light) ‏בלבד. ‏אין phase-verifier.

**‏Verifier בסוף**: `Task(subagent_type="calev", prompt="... mode: light ...")` — ‏מאמת DoD §5.

---

## §9 — ‏שאלות פתוחות

| # | ‏שאלה | ‏ברירת מחדל | ‏חוסם? |
|---|------|----------|------|
| 1 | ‏האם להוסיף `userDataPath` ‏גם ל-config של הטסטים שכבר קיימים? | ‏לא — ‏רק הטסט החדש צריך אותו; ‏הקיימים לא נוגעים ב-3 ה-routers | ❌ |
| 2 | ‏ליצור את תיקיית `user-data` ‏אם חסרה? | ‏ה-routers ‏עושים `mkdir(dirname, {recursive:true})` ‏ב-save — ‏לא צריך ידני | ❌ |
| 3 | ‏האם ה-endpoints ‏צריכים auth? | ‏לא בסלייס זה — auth ‏הוא slice ‏נפרד; ‏כרגע פתוחים כמו שאר ה-API | ❌ |

---

## ‏סטיות מהתכנון (‏מתעדכן ע"י executor ‏תוך כדי)

- ‏(‏ריק)
