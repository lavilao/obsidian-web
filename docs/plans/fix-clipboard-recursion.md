# Slice — fix-clipboard-recursion — ‏בריף

> **‏תאריך**: 2026-06-13
> **‏סוג מסמך**: ‏בריף ביצועי לסלייס (bugfix)
> **‏סטטוס**: ‏מאושר (READY)
> **‏אימות אביגיל**: READY (‏דוח: `reports/obsidian-web/fix-clipboard-recursion-avigail.md`)
> **Dispatch**: ‏מותר לאליעזר רק אם `אימות אביגיל = READY`.
> **Complexity**: 1/10 (verifier: light)
> **‏תלויות (`depends_on`)**: [] — ‏אין. ‏בנוי ישירות על main.
> **‏Base**: main
> **‏Dev tip**: `a5f5a4d`
> **‏Issue**: [#8](https://github.com/MusiCode1/obsidian-web/issues/8) — Copy button in code block throws "Maximum call stack size exceeded"

---

## §0 — Pre-flight

### ‏תלויות (‏חובה!)

‏אין תלויות. ‏slice עצמאי על `main` (state.json: `depends_on: []`).

### Worktree

```bash
cd ~/projects/obsidian-web
git worktree add .worktrees/fix-clipboard-recursion -b fix-clipboard-recursion main
cd .worktrees/fix-clipboard-recursion
# ‏אין pnpm install — ‏ה-shim הוא vanilla JS ‏שמוגש סטטית. ‏אין build step ל-client shim.
```

### ‏איך להריץ

- BE (‏מגיש גם את ה-client): מ-`src/server/` → `npm install && npm run dev` (port **3000**, ‏`node --watch`).
- ‏אין test runner רלוונטי ל-shim (ה-`npm test` ב-server ‏בודק קוד שרת, ‏לא את ה-client shim).
- ‏בדיקת syntax ל-shim: `node --check src/client/shims/electron.js`.

### Browser

‏gui-host, ‏port **9224**, ‏session `default`, ‏profile `/tmp/pw-obsidian-web`, ‏URL `http://localhost:3000/`.
‏(‏ראה `docs/dev-setup.md` ‏לפרטי gui-host + playwright-cli.)

> ‏הערה ל-verifier: ‏ה-Clipboard API ‏דורש secure context + ‏user gesture. ‏לחיצה אמיתית על
> ‏כפתור ה-copy ‏מספקת user activation; ‏הזרקת JS ‏שקוראת ל-`writeText` ‏ללא gesture עלולה
> ‏להיכשל מסיבה **‏אחרת** (NotAllowedError) — ‏זה לא הבאג. ‏יש ללחוץ על הכפתור בפועל.

### Reading list

**must-read**:
- ‏[`src/client/shims/electron.js`](src/client/shims/electron.js) ‏שורות 464-497 — ‏אובייקט `remote` ‏כולל `clipboard`.
- ‏ה-issue #8 + ‏ה-stack trace שבו.

**reference**:
- ‏[`src/client/index.html`](src/client/index.html) ‏שורה 60 — `<script src="/client/shims/electron.js?v=3">` (‏סינכרוני, ‏לפני app.js).
- ‏[`src/server/index.js`](src/server/index.js) ‏שורות 56-66 — ‏cache-bust אוטומטי לפי mtime (‏אין צורך בבמפ ידני ל-`?v=`).

---

## §1 — ‏מטרה

‏לחיצה על כפתור ה-copy ‏בתוך code block ‏ב-obsidian-web (‏וכל קריאה אחרת ל-clipboard
‏דרך ה-electron shim) ‏מעתיקה את הטקסט ל-clipboard בלי לזרוק. ‏היום היא נכשלת עם
`RangeError: Maximum call stack size exceeded`.

---

## §2 — Root cause

‏ב-[`electron.js:467-470`](src/client/shims/electron.js#L467-L470):

```js
clipboard: {
  writeText: (text) => navigator.clipboard.writeText(text),
  readText: () => navigator.clipboard.readText(),
},
```

‏ה-shim נטען **‏לפני** app.js (‏script סינכרוני). ‏בזמן ריצה, ‏ה-app.js של Obsidian
**‏מחליף** את `navigator.clipboard.writeText` ‏ב-method שמנתב חזרה ל-`electron.clipboard.writeText`
(‏התנהגות דסקטופ — ‏בדסקטופ Obsidian רוצה את ה-clipboard של Electron). ‏ה-shim שלנו, ‏שקורא
‏ל-`navigator.clipboard.writeText` ‏בזמן הקריאה (‏lazy), ‏פוגע ב-version המוחלף → ‏לולאה אינסופית:

```
electron.clipboard.writeText (shim, electron.js:468)
  → navigator.clipboard.writeText  [patched by Obsidian → Clipboard.<anonymous>, app.js]
    → electron.clipboard.writeText (shim, electron.js:468)
      → ... ‏עד stack overflow
```

‏זה בדיוק ה-stack ב-issue: ‏הלולאה `Object.writeText (electron.js:468)` ↔ `Clipboard.<anonymous> (app.js)`.

---

## §3 — ‏הפתרון

‏ללכוד reference ל-native `navigator.clipboard.writeText`/`readText` **‏בזמן בניית ה-shim**
(‏רץ לפני שObsidian מחליף), ‏ולקרוא ל-bound reference ‏ישירות. ‏כך ה-shim כבר לא נוגע
‏ב-property שObsidian מחליף, ‏והלולאה נשברת.

```
‏טעינת shim (‏סינכרוני)          app.js boot (‏מאוחר יותר)
       │                                │
   nav.clipboard.writeText = native     │
       │                                │
   bind → nativeWrite ───────────┐      │
       │                         │   navigator.clipboard.writeText = patched
       ▼                         │      │
   shim.clipboard.writeText      │      │
       calls nativeWrite ────────┘  (‏עוקף את patched — ‏אין לולאה)
```

---

## §4 — Commits ‏בסדר

### Commit 0 — fix: capture native clipboard before Obsidian patches it (approach: manual)

**‏קבצים שמשתנים**:
- ‏`src/client/shims/electron.js` — ‏מחליף את ה-literal `clipboard: { ... }` ‏ב-IIFE שלוכד native.

**‏השינוי המדויק** (‏executor אסור לשנות חתימה):

‏החלף את שורות 467-470:

```js
    clipboard: {
      writeText: (text) => navigator.clipboard.writeText(text),
      readText: () => navigator.clipboard.readText(),
    },
```

‏ב:

```js
    clipboard: (function () {
      // Capture the NATIVE clipboard methods now, at shim-load time (this
      // runs before Obsidian's app.js boots). Obsidian later monkey-patches
      // navigator.clipboard.writeText to delegate back to
      // electron.clipboard.writeText — if we resolved navigator.clipboard
      // lazily we'd call that patched version, which calls us, looping until
      // "RangeError: Maximum call stack size exceeded". See issue #8.
      const native = (typeof navigator !== 'undefined' && navigator.clipboard) || null;
      const nativeWrite = native && native.writeText ? native.writeText.bind(native) : null;
      const nativeRead = native && native.readText ? native.readText.bind(native) : null;
      return {
        writeText: (text) => nativeWrite
          ? nativeWrite(text)
          : Promise.reject(new Error('[obsidian-web] clipboard.writeText unavailable')),
        readText: () => nativeRead ? nativeRead() : Promise.resolve(''),
      };
    })(),
```

> ‏הערה: ‏ה-IIFE ‏רץ כשהאובייקט `remote` ‏נבנה, ‏כלומר בזמן ריצת ה-IIFE החיצוני
> `(function (global) { ... })(window)` ‏— ‏זה זמן טעינת ה-`<script>`, ‏לפני app.js. ‏לכן
> `native` ‏הוא ה-native object, ‏ו-`bind` ‏לוכד את ה-native function גם אחרי שObsidian
> ‏יחליף את ה-property.

**Verification**:

```bash
node --check src/client/shims/electron.js   # ‏syntax OK
```

‏(‏אין typecheck/build ל-shim — ‏זה vanilla JS שמוגש כמו שהוא.)

---

## §5 — DoD verifiable

| # | ‏בדיקה | ‏איך |
|---|------|------|
| 1 | syntax תקין | `node --check src/client/shims/electron.js` |
| 2 | ‏copy בתוך code block ‏עובד | ‏פתח `http://localhost:3000/` ‏עם vault שיש בו note עם code block (```), ‏hover על ה-block, ‏לחץ על כפתור ה-copy. ‏לא נזרק RangeError ב-console. |
| 3 | ‏הטקסט באמת ב-clipboard | ‏אחרי הלחיצה, ‏הדבק (`Ctrl+V`) ‏לתוך תא עריכה / ‏בדוק `navigator.clipboard.readText()` ‏ב-console (‏עם gesture) — ‏מכיל את תוכן ה-block. |
| 4 | ‏אין recursion ב-stack | console נקי מ-`Maximum call stack size exceeded`. |
| 5 | regression: ‏בוט תקין | ‏האפליקציה עולה רגיל, ‏אין שגיאות חדשות ב-console בזמן הטעינה. |

---

## §6 — Risks + mitigations

| ‏סיכון | ‏מקור | ‏מיטיגציה |
|------|------|----------|
| ‏ה-IIFE לא רץ לפני app.js | ‏אם סדר הטעינה ישתנה | ‏מאומת: `index.html:60` ‏טוען את ה-shim כ-`<script>` ‏סינכרוני, ‏ו-boot.js/app.js ‏נטענים אחריו. ‏ה-IIFE רץ בזמן evaluation של ה-script. |
| `navigator.clipboard` undefined (‏הקשר לא-secure) | http ‏לא localhost | ‏ה-guard מחזיר Promise.reject/'' ‏במקום לזרוק TypeError. ‏ב-`localhost`/https ‏ה-API קיים. |
| ‏native writeText ‏נכשל ב-NotAllowedError | ‏חוסר user gesture | ‏לא קשור לבאג; ‏לחיצה אמיתית על הכפתור מספקת activation. ‏לא לבלבל בין זה ל-RangeError. |
| ‏עותקים נוספים של ה-shim (cloudflare/server) | ‏יש 3 ‏עותקי electron.js | ‏רק `src/client/shims/electron.js` ‏הוא ה-client shim הרלוונטי. ‏`src/server/api/electron.js` ‏ו-`src/deployments/cloudflare/api/electron.js` ‏הם משהו אחר (server-side). ‏**‏לא** ‏לגעת בהם בלי בדיקה. ‏(`.tmp/...` ‏הוא build artifact.) |

---

## §7 — Escalation triggers

- ‏אם מסתבר שObsidian **‏לא** ‏מחליף את `navigator.clipboard` ‏וה-root cause שונה (‏עצור, ‏דווח).
- ‏אם התיקון לא שובר את הלולאה בבדיקה חיה — ‏עצור, ‏אל תנחש patch נוסף.
- ‏אם צריך לגעת ביותר מהקובץ האחד הזה.

---

## §8 — Complexity score + verifier tier

| ‏פרמטר | ‏ניקוד |
|------|------|
| Pure logic, ‏שינוי נקודתי בקובץ אחד | -2 |
| ‏אין IO ‏חדש, ‏אין data flow ‏חדש | -2 |
| ‏Refactor מינורי של literal קיים | +1 |

**Score**: 1/10

**Tier**: 0-3 → `calev` (light) ‏בלבד. ‏אין verifier-phase.

> ‏הערה: ‏ה-DoD ‏דורש בדיקה חיה בדפדפן (‏לחיצה אמיתית) — ‏זה החלק הקריטי, ‏לא ה-syntax.

---

## §9 — ‏שאלות פתוחות

| # | ‏שאלה | ‏ברירת מחדל | ‏חוסם? |
|---|------|----------|------|
| 1 | ‏האם ל-`readText` ‏יש את אותה בעיית רקורסיה? | ‏כן ככל הנראה (‏אותו דפוס) — ‏התיקון מטפל בשניהם יחד. | ❌ |
| 2 | ‏צריך לעדכן את העותק ב-`.tmp/deployments/...`? | ‏לא — ‏build artifact, ‏נוצר מחדש ב-`npm run build`. | ❌ |

---

## ‏סטיות מהתכנון (‏מתעדכן ע"י executor)

- ‏(‏ריק)
