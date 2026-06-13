---
project: "obsidian-web"
slice: "server-shims"
verifier: "avigail"
date: "2026-06-13"
verdict: "READY"
findings:
  - id: 1
    severity: "minor"
    category: "outdated-risk"
    summary: "Risk row says pbkdf2 output is RFC-6070 but it is SHA256, not the RFC-6070 SHA1 vector"
    source_brief: "§6 row 'vector pbkdf2'"
    source_code: "src/server/api/pbkdf2.js:46"
    cost_estimate: "0min"
  - id: 2
    severity: "minor"
    category: "dropped-branch"
    summary: "Curl verification block lacks Service-Worker/sw.js note but that is out-of-scope and harmless"
    source_brief: "§4 Verification"
    source_code: "src/server/index.js:137"
    cost_estimate: "0min"
---

# Plan Verification — server-shims

> **Brief**: docs/plans/server-shims.md
> **Base tip**: 51e09db (main, single-branch)
> **Verdict**: ✅ READY
> **אומדן זמן confusion אם לא תוקן**: ~0 דק' (שני ה-minor לא חוסמים ולא מבלבלים בפועל)

זהו בריף חריג: כמעט כל claim ניתן לאימות פוינט-באי-פוינט והכל יצא נכון. הבדיקה המעמיקה של 8 הנקודות החזירה רק 2 minor שלא משפיעים על אליעזר. ה-track-record של "תמיד יש בעיה אמיתית" לא מתממש כאן — וזה תקין, כי זה חילוץ as-is של קוד שכבר עבר ב-PR אמיתי, עם anchors שאומתו מול main בפועל.

## בעיות שנמצאו

### 🔴 Blocker / Regression risk

אין.

### 🟡 Confusion / Type error / Outdated

אין ברמה שתעכב את אליעזר.

### 🟢 Minor

| # | בעיה | מקור |
|---|------|------|
| 1 | §6 בטבלת הסיכונים, שורת "וקטור pbkdf2 לא תואם" כותבת בעמודת המיטיגציה `output RFC-6070`. ה-output `65acafe9...` הוא PBKDF2-HMAC-**SHA256**, לא RFC-6070 (ש-RFC-6070 הוא SHA1). §4/§1 כבר מבהירים את זה נכון; רק שורת ה-§6 משתמשת בניסוח מטעה. לא חוסם — הערך עצמו נכון ואומת. | brief §6 / src/server/api/pbkdf2.js:46 (`'sha256'`) |
| 2 | בלוק ה-curl ב-§4 לא כולל הערה על `/sw.js` — אבל זה מכוון (sw.js הוא out-of-scope לפי §2), ולא דרוש לאימות הסלייס. | brief §4 Verification |

## Spot-check שעבר (לא מצא בעיה)

- ✅ **Check 1 — קבצי router קיימים ותקינים ב-pr9-ref**: `keytar.js` (86 שורות, `module.exports = createKeytarRouter`, חתימה `createKeytarRouter(userDataPath)`), `localstorage.js` (76 שורות, `createLocalStorageRouter(userDataPath)`), `pbkdf2.js` (57 שורות, `createPbkdf2Router()`). כולם שלמים, ללא truncation.
- ✅ **Check 2 — index.js/config.js חתוכים ב-pr9-tmp**: אומת ב-`git diff main..pr9-tmp`. index.js נגמר באמצע שורה (`console.log('  ` + `No newline at end of file`), ה-`module.exports`, `startServer`, ו-`warmUpBootstrapCache` נמחקו. config.js — בלוק `bootstrap` נמחק לגמרי. הטענה ב-§0 שאסור להעתיק as-is מאומתת לחלוטין.
- ✅ **Check 3 — anchor lines של config.js**: `module.exports = {` בשורה 64 (✓ ברירף), `projectRoot: PROJECT_ROOT` בשורה 73 (✓ ברירף). ההוראה "הוסף `userDataPath` מיד אחרי פתיחת module.exports" מדויקת.
- ✅ **Check 3 — anchor lines של index.js**: `const createProxyRouter = require('./api/proxy');` בשורה 24 (✓), בלוק require שורות 19-25 (✓: createFsRouter@19, attachWatchServer@25), `// API routes.` בשורה 130 (✓ "~130"), `app.use('/api/bootstrap', ...)` בשורה 131 (✓). כל ה-anchors תואמים את main מילה-במילה.
- ✅ **Check 4 — signature שמירה**: ב-main `createBootstrapRouter(vaultRegistry, appConfig.vaultPath, appConfig.bootstrap)` עם הארגומנט השלישי (שורה 131), ו-`function createApp(appConfig = {})` (שורה 28). אומת ש-pr9-tmp הוריד את הארגומנט השלישי (רגרסיה) — ה-brief נכון להזהיר לשמר את גרסת main.
- ✅ **Check 5 — וקטור pbkdf2**: `node crypto.pbkdf2Sync(Buffer.from('70617373','hex'), Buffer.from('73616c74','hex'), 1, 20, 'sha256')` → `65acafe9655d154ebe7ca04e8b7ebdbc2bfd1684`. תואם בדיוק. ה-router אכן עושה `Buffer.from(password,'hex')` + `'sha256'` (שורות 39-46), אז ה-hex-encoding והאלגוריתם תואמים.
- ✅ **Check 6 — baseline**: `npm test` ב-main → **15/15 pass** (test/bootstrap-cache.test.js + test/vaults-api.test.js). תואם את "15/15" ברירף.
- ✅ **Check 7 — outdated risks**: כל הסיכונים ב-§6 רלוונטיים. הרגרסיות (truncation, dropped bootstrap arg, dropped warm-up) אומתו כקיימות ב-pr9-tmp עכשיו.
- ✅ **Check 8 — depends_on**: `depends_on = []` עקבי. שלושת ה-routers מקבלים רק `userDataPath`, לא נוגעים ב-vault-registry/auth/bootstrap. אין state.json בריפו single-branch הזה — וזה תקין. אין תלות ב-slice אחר.
- ✅ **בונוס — אין קונפליקט קבצים**: `src/server/api/{keytar,localstorage,pbkdf2}.js` לא קיימים ב-main (cp ייצור קבצים חדשים, לא ידרוס). תיקיית `src/server/api/` קיימת.
- ✅ **בונוס — deps**: ה-routers משתמשים רק ב-express (קיים ב-package.json), crypto/fs-promises/path (Node builtins). אין תלות חדשה.
- ✅ **בונוס — worktree + docs**: worktree `server-shims` הוקם על 51e09db. `docs/` gitignored אבל הבריף + EXECUTOR_DISPATCH.md כבר הועתקו פיזית לתוך ה-worktree (אליעזר יוכל לקרוא). `../pr9-ref` resolves נכון מ-server-shims/.

## Verdict

✅ **READY** — העבר לאליעזר. כל 8 הבדיקות עברו. שני ה-minor שנמצאו הם ניסוחיים (§6 "RFC-6070" מטעה אבל הערך נכון) ולא משפיעים על הביצוע. מרדכי יכול לתקן את ניסוח §6 ב-30 שניות אם רוצה, אבל זה לא תנאי ל-dispatch.
