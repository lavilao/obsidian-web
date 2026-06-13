# Slice A (LiveSync) — App.requestUrl — ‏בריף

> **‏תאריך**: 2026-06-13
> **‏סוג מסמך**: ‏בריף ביצועי לסלייס
> **‏סטטוס**: ‏מאושר (plan-verified)
> **‏אימות אביגיל**: ✅ READY (‏דוח: `reports/obsidian-web/livesync-requesturl-avigail.md`, 0 ‏חוסמים, 2 ‏nits ‏מוטמעים)
> **Dispatch**: ‏מותר לאליעזר — plan-gate ‏עבר.
> **Complexity**: 5/10 (verifier: **light** + phase verifier אחרי Commit 1)
> **‏תלויות (`depends_on`)**: []
> **‏Base**: main (`a5f5a4d`)
> **‏Dev tip**: `a5f5a4d`

---

## §0 — Pre-flight

### ‏תלויות (‏חובה!)

‏אין תלויות. ‏בנוי על main (`a5f5a4d`). ‏נוגע ‏רק ב-`src/client-mobile/shims/capacitor-shim.js`.
‏זהו ה-slice הראשון ‏מתוך 3 ‏לאינטגרציית LiveSync:
- **Slice A (זה)** — `App.requestUrl` ‏אמיתי (fetch wrapper). `depends_on: []`.
- Slice B — `scripts/install-livesync.js` (‏מוריד את הפלאגין). `depends_on: []` (‏עצמאי, ‏מקביל).
- Slice C — E2E ‏מול CouchDB + docs. `depends_on: [A, B]`.

> ‏מקור-אמת ‏לחוזה ה-requestUrl: `docs/plans/livesync-implementation.md` §"The exact
> `App.requestUrl` contract" — ‏אומת ‏מ-`vendor/obsidian-mobile/app.js` ‏ב-v1.12.7.
> ‏זה ה-slice ‏שמממש ‏את Phase 1+2 ‏של ‏התוכנית ‏ההיא (‏מעודכן ל-layout ‏אחרי ה-reorg).

### Worktree

```bash
cd ~/projects/obsidian-web
git worktree add .worktrees/livesync-requesturl -b livesync-requesturl main
cd .worktrees/livesync-requesturl
```

‏אין `npm install` ‏לצד-לקוח — ‏ה-shim ‏טעון ‏ע"י ‏הדפדפן ‏כקובץ static.
‏לטסטי-יחידה ‏של ‏ה-base64 helpers: `node --test` (‏ראה Commit 0).

### ‏איך להריץ

- **BE**: `cd src/server && PORT=3000 node index.js` (‏או 4001 ‏אם 3000 ‏תפוס).
- **Browser** (‏ל-Phase 2 self-test): ‏ראה §Browser למטה — `gui-host` + playwright-cli.
- **Unit tests**: `node --test src/client-mobile/test/requesturl-base64.test.js`.

### Browser (‏חובה ל-self-test)

‏ה-self-test ‏של Phase 2 ‏רץ ב-DevTools console ‏מול `/mobile`. ‏ראה
`docs/dev-setup.md` ‏ל-workflow ‏המלא ‏של gui-host. ‏בקצרה:
- session `obsmobile`, port 9224, `--user-data-dir=/tmp/pw-obsidian-mobile`.
- ‏נווט ל-`http://localhost:3000/mobile?vault=5b68fb93d875ad63` (demo vault מקומי).
- ‏המתן ל-`.workspace`, ‏אז ‏הרץ ‏את ה-self-test (§5 DoD).
- ‏reverse tunnel ‏ל-port 3000 ‏אם ‏ERR_CONNECTION_REFUSED (`ssh -R 3000:localhost:3000 gui-host -N -f`).

### Reading list

**must-read**:
- `docs/plans/livesync-implementation.md` ‏שורות 51-133 — ‏חוזה ה-request/response ‏המדויק.
- `src/client-mobile/shims/capacitor-shim.js` ‏שורות 548-562 (`const App`, ‏ה-stub @560)
  ‏ושורות 188-213 (‏דפוס ה-base64 ‏הקיים ב-Filesystem readFile/writeFile — **‏לשימוש-חוזר**).
- `src/client-mobile/shims/capacitor-shim.js` ‏שורות 744-756 (`PluginHeaders`, `pm('requestUrl')`).

---

## §1 — ‏מטרה

‏פלאגין LiveSync ‏(שיתווסף ב-Slice B) ‏קורא ל-`requestUrl()` ‏של Obsidian, ‏שב-mobile
‏runtime ‏מנותב ל-`Capacitor.Plugins.App.requestUrl`. ‏היום ‏זה stub ‏שמחזיר `{}` ‏—
‏כל ‏קריאת-רשת ‏של ‏פלאגין ‏נשברת. ‏אחרי ‏slice ‏זה: `App.requestUrl` ‏הוא ‏עטיפת `fetch()`
‏אמיתית ‏שמכבדת ‏את ‏חוזה ה-request/response ‏של Obsidian (‏כולל base64 ‏round-trip ‏לבינארי),
‏כך ‏שכל ‏פלאגין ‏שמשתמש ב-`requestUrl` ‏(לא ‏רק LiveSync) ‏עובד. ‏הדפדפן ‏פונה ‏ישירות ‏ל-target
‏(‏בלי proxy ‏בצד-שרת).

---

## §2 — Scope

| ‏פיצ'ר | ‏כן/לא | ‏לאן |
|------|------|------|
| `App.requestUrl` ‏עטיפת fetch (GET/POST/PUT, headers, body, binary) | ✅ | Commit 1 |
| base64↔ArrayBuffer helpers ‏(reuse/extract) + unit tests | ✅ | Commit 0 |
| self-test ‏בדפדפן (GET JSON, POST echo, binary PNG) | ✅ | Phase 2 / DoD |
| ‏הורדת ‏פלאגין LiveSync | ❌ | Slice B |
| ‏בדיקת CouchDB ‏אמיתי | ❌ | Slice C |
| `CapacitorHttp.request` | ❌ | ‏לא speculative — ‏רק ‏אם ‏נראה ‏בקונסול |
| server-side proxy | ❌ | ‏**‏נדחה ‏מפורשות** (PLAN.md) — fetch ‏ישיר + CORS |

---

## §3 — ‏חוזה ה-requestUrl (‏מ-`app.js` v1.12.7)

```
‏Obsidian ‏שולח ‏לנו:           ‏אנחנו ‏מחזירים:
{                            {
  url:         string          status:  number,
  method?:     string          headers: {[name]: string},
  contentType?: string         body:    string   ← BASE64 ‏תמיד (‏גם ‏טקסט!)
  headers?:    {..}          }
  body:        string|base64
  binary:      boolean   ← ‏אם true, body ‏הוא base64
}
        │
        ▼  fetch(url, {method, headers, body, credentials:'include'})
        ▼  res.arrayBuffer() → base64 → { status, headers, body }
        │
        ▼  Obsidian ‏עושה atob(body) ‏ללא-תנאי (‏פונקציית X), ‏אז ‏ה-body ‏**‏חייב** base64.
```

---

## §4 — Commits ‏בסדר

### Commit 0 — base64 helpers + unit tests (approach: **tdd**)

**‏הקשר**: ‏הדפוס ‏כבר ‏קיים ‏ב-Filesystem (‏שורות 192-197 btoa ‏מקוטע, 211-213 atob),
‏אבל inline. ‏נחלץ ‏ל-2 ‏פונקציות ‏ברמת-המודול ‏וננצל ‏אותן ‏גם ב-requestUrl ‏וגם ב-Filesystem.

**‏קבצים שמשתנים**:
- `src/client-mobile/shims/capacitor-shim.js` — ‏הוסף ‏ברמת-המודול:
  ```js
  // base64 string → ArrayBuffer
  function base64ToArrayBuffer(b64) {
    const bin = atob(b64 || '');
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr.buffer;
  }
  // ArrayBuffer → base64 (chunked — btoa blows the arg stack at ~65k)
  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    let s = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }
  ```
  ‏ושנה ‏את ‏Filesystem readFile/writeFile ‏להשתמש ‏בהן (‏החלפת ‏ה-inline, ‏בלי ‏שינוי ‏התנהגות).

**‏קבצים חדשים**:
- `src/client-mobile/test/requesturl-base64.test.js` — round-trip ‏על: ‏טקסט ASCII,
  ‏UTF-8 (‏עברית), ‏בינארי >65KB (‏לוודא ‏שה-chunking ‏לא ‏שובר), ‏מחרוזת ‏ריקה.

> ‏הערה ל-executor: ‏ה-helpers ‏טהורים ‏אבל ‏משתמשים ב-`atob`/`btoa` (‏זמינים ב-Node 18+
> ‏global). ‏אם ‏הטסט ‏רץ ‏ב-`node --test` ‏ללא ‏them — ‏ייבא ‏מ-`buffer` ‏או ‏הגדר ‏shim ‏בטסט.

**Verification**: `node --test src/client-mobile/test/requesturl-base64.test.js` — ‏כל ‏ה-round-trips ‏ירוקים.

---

### Commit 1 — App.requestUrl impl (approach: **manual** — browser self-test)

**‏קבצים שמשתנים**:
- `src/client-mobile/shims/capacitor-shim.js` — ‏החלף ‏את ‏שורה 560
  (`requestUrl: () => Promise.resolve({})`) ‏בממומש:
  ```js
  async requestUrl(opts) {
    const { url, method, contentType, headers, body, binary } = opts;
    const reqHeaders = Object.assign({}, headers || {});
    // case-insensitive check — a mixed-case user header (e.g. 'Content-type')
    // must not be duplicated (Avigail finding).
    const hasCT = Object.keys(reqHeaders).some(k => k.toLowerCase() === 'content-type');
    if (contentType && !hasCT) reqHeaders['Content-Type'] = contentType;
    let reqBody;
    if (body == null) reqBody = undefined;
    else if (binary) reqBody = base64ToArrayBuffer(body);  // Obsidian sent base64
    else reqBody = body;                                    // string passthrough

    const res = await fetch(url, {
      method: method || 'GET',
      headers: reqHeaders,
      body: reqBody,
      credentials: 'omit',   // ‏native requestUrl ‏לא ‏שולח cookies; ‏auth ‏עובר ‏ב-Authorization header.
                             // ‏`include` ‏שובר ‏endpoints ‏עם wildcard CORS (GitHub) — ‏אומת ‏ש-LiveSync→CouchDB
                             // ‏משתמש ‏ב-basic-auth (‏לא cookies), ‏אז omit ‏בטוח. ‏ראה §6.
    });
    const respHeaders = {};
    res.headers.forEach((v, k) => { respHeaders[k] = v; });
    const respBuffer = await res.arrayBuffer();
    return { status: res.status, headers: respHeaders, body: arrayBufferToBase64(respBuffer) };
  }
  ```
  > **‏קריטי**: `body` ‏בתשובה ‏**‏תמיד** base64 (‏גם ‏טקסט; ‏body ‏ריק → `''`). Obsidian
  > ‏מריץ `atob` ‏ללא-תנאי. ‏אל ‏תחזיר ‏טקסט ‏גולמי ‏או `{}`.
  > **‏שגיאות-רשת**: ‏אם `fetch` ‏זורק (CORS/DNS/down) — ‏תן ‏ל-rejection ‏להתפשט. LiveSync ‏מטפל.

**PluginHeaders**: `pm('requestUrl')` ‏כבר ‏מוצהר ‏(שורה ~752). ‏ודא ‏שה-`pm()` ‏נותן `rtype: 'promise'`
(‏בדוק ‏את ‏הגדרת `pm`). ‏**‏אל ‏תשנה** ‏אם ‏כבר ‏promise.

**Verification** (manual — ‏ה-self-test ‏של Phase 2 ‏ב-§5).
**Phase verifier**: ‏הרץ `calev` (mode: phase) ‏אחרי ‏Commit 1 — ‏ה-base64 round-trip ‏על ‏בינארי
‏הוא ‏ה-נקודה ‏המסוכנת (‏אם ‏הוא ‏שבור, LiveSync chunk transfer ‏יישבר ‏מאוחר ‏ויקר ‏לדבג).

---

## §5 — DoD verifiable (‏ה-self-test ‏של Phase 2)

‏נווט ל-`/mobile?vault=5b68fb93d875ad63`, ‏המתן ל-`.workspace`, ‏הרץ ב-console:

```js
async () => {
  const r1 = await window.app.requestUrl({
    url: 'https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest', method: 'GET' });
  const r2 = await window.app.requestUrl({
    url: 'https://httpbin.org/post', method: 'POST',
    contentType: 'application/json', body: JSON.stringify({ hello: 'world' }) });
  const r3 = await window.app.requestUrl({ url: 'https://httpbin.org/image/png', method: 'GET' });
  return JSON.stringify({
    t1: { status: r1.status, hasTag: !!r1.json?.tag_name },
    t2: { status: r2.status, echoed: r2.json?.json?.hello },
    t3: { status: r3.status, bytes: r3.arrayBuffer.byteLength,
          png: new Uint8Array(r3.arrayBuffer).slice(0,4).join(',') === '137,80,78,71' },
  }, null, 2);
}
```

| # | ‏בדיקה | ‏צפוי |
|---|------|------|
| 1 | unit tests (base64) | `node --test …/requesturl-base64.test.js` ‏ירוק |
| 2 | GET JSON | `t1.status===200`, `t1.hasTag===true` |
| 3 | POST echo | `t2.status===200`, `t2.echoed==='world'` |
| 4 | **binary PNG round-trip** | `t3.status===200`, `t3.bytes>0`, `t3.png===true` |
| 5 | ‏ה-stub ‏נעלם | `grep 'Promise.resolve({})' capacitor-shim.js` ‏על ‏requestUrl → ‏אין |
| 6 | ‏לא ‏שברנו Filesystem | ‏טעינת vault ‏רגילה עדיין ‏עובדת (workspace ‏נטען, ‏קבצים ‏נקראים) |
| 7 | walkthrough entry | `docs/walkthrough.md` |
| 8 | **‏אין commits** | ‏מרדכי ‏ממזג |

---

## §6 — Risks + mitigations

| ‏סיכון | ‏מקור | ‏מיטיגציה |
|------|------|----------|
| base64 ‏round-trip ‏שובר ‏בינארי | plan pitfall #2/#4 | reuse ‏ה-chunked helper ‏הקיים; ‏טסט #4 (PNG) + unit על >65KB |
| `credentials:'include'` ‏שובר wildcard-CORS (GitHub) | **‏אומת ב-runtime** — Obsidian ‏ו-LiveSync ‏שניהם ‏מושכים ‏מ-GitHub ‏ונחסמים | **‏fix: `credentials:'omit'`**. ‏native requestUrl ‏לא ‏שולח cookies; LiveSync→CouchDB ‏אומת ‏כ-basic-auth (‏לא cookies). cookie-session CouchDB (‏edge נדיר) ‏לא ‏נתמך — ‏slice ‏נפרד ‏אם ‏יידרש. |
| ‏`_changes?feed=continuous` ‏(stream ‏אינסופי) ‏חוסם `arrayBuffer()` | plan pitfall #6 | **‏לא ‏ב-scope ‏של ‏slice ‏זה** — ‏ה-self-test ‏one-shot. ‏אם ‏עולה ‏ב-Slice C → escalation, ‏plan ‏נפרד |
| ‏שינוי ה-base64 ‏ב-Filesystem ‏שובר ‏קריאת/כתיבת ‏קבצים ‏קיימת | refactor | טסט #6 (vault ‏נטען); ‏ה-helpers ‏זהים ‏פונקציונלית ל-inline |
| `atob`/`btoa` ‏לא ‏זמינים ‏ב-`node --test` | env | shim ‏בטסט ‏או ‏ייבוא ‏מ-`buffer` |

---

## §7 — Escalation triggers

- ‏ה-`pm()` ‏לא ‏נותן `rtype:'promise'` ל-requestUrl ‏(‏ה-bridge ‏לא ‏יעטוף ‏נכון) — ‏עצור ‏ושאל.
- ‏ה-self-test ‏מראה ‏שה-bridge ‏לא ‏מעביר ‏את `binary`/`body` ‏כמצופה ‏מ-app.js — ‏בדוק ‏את ה-caller, ‏עצור.
- ‏פלאגין ‏קורא `CapacitorHttp` ‏ולא `App.requestUrl` (‏נראה ‏בקונסול) — ‏דווח, ‏אל ‏תממש ‏speculative.
- ‏סטייה ‏מ-Testing strategy ‏שה-brief ‏קבע.

---

## §8 — Complexity score + verifier tier

| ‏פרמטר | ‏ניקוד |
|------|------|
| Protocol contract ‏חדש (requestUrl request/response shape) | +2 |
| ‏ספרייה DOM/browser (fetch) | +1 |
| Refactor ‏קל (‏extract base64) | +1 |
| Pure logic ‏בחלק (base64 helpers) | -2 |
| TDD ‏על Commit 0 | -1 |
| ‏בינארי ‏round-trip ‏(‏correctness ‏עדין) | +2 |
| Greenfield ‏(stub→impl, ‏אין call-sites ‏שלנו ‏לשבור) | -1 |
| ‏שדרת ‏פלאגינים ‏עתידיים ‏תלויה ‏בזה | +2 |

**Score**: **5 / 10**

**Tier**: light + **phase verifier אחרי Commit 1** (‏ה-impl, ‏לפני ‏שמכריזים ‏גמור).

---

## §9 — ‏שאלות פתוחות

| # | ‏שאלה | ‏ברירת מחדל | ‏חוסם? |
|---|------|----------|------|
| 1 | ‏ערך ‏ל-`credentials` | **‏הוכרע: `omit`** (‏אומת ‏ב-runtime — basic-auth, ‏ו-`include` ‏שובר GitHub) | ✅ ‏סגור |
| 2 | ‏האם ‏לחלץ ‏את ה-base64 ‏גם ‏מ-Filesystem ‏או ‏רק ‏להוסיף ‏helpers ‏חדשים | ‏לחלץ (‏DRY) | ❌ |

---

## ‏סטיות מהתכנון (‏מתעדכן ע"י executor)

- (‏ריק)
