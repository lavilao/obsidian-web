# פערי תיעוד — obsidian-web

> Created: 2026-05-11
>
> מטרת המסמך: למפות את כל החורים בתיעוד הנוכחי כך שנוכל למלא אותם
> באופן שיטתי. לא מסמך לפתרון — מסמך לזיהוי הבעיות.
>
> כל פער כולל: מיקום הבעיה, מה חסר בדיוק, איפה לתעד, רמת חומרה.

---

## חומרה: 🔴 קריטי / 🟠 חשוב / 🟡 nice-to-have

---

## 🔴 1. מנגנון `PluginHeaders` של Capacitor

**הבעיה:** הgילוי המרכזי שפתח את כל ה-debugging של ה-mobile bundle —
ש-`registerPlugin()` יוצר Proxy שבודק `c.PluginHeaders` לפני שמגיע
ל-`nativePromise`. בלי הheaders, כל קריאה זורקת
`"<plugin> is not implemented on android"`. **לא מתועד באף מסמך.**

**מיקום הקוד:**
- `client-mobile/shims/capacitor-shim.js` שורות 583-682 (יש comment קצר)
- מינוחים: `c.PluginHeaders`, `rtype: 'promise'`, `nativePromise`, `registerPlugin Proxy`

**איפה לתעד:** `docs/investigations.md`, סעיף חדש תחת "Capacitor approach"

**מה צריך לכלול:**
- ה-Proxy שיוצר `registerPlugin` ב-`app.js` (offset 181781 ב-v1.12.7)
- המעבר: method call → check methods array → אם קיים → `nativePromise` (שלנו); אם לא → throw
- למה `androidBridge.postMessage` לבד לא מספיק
- למה צריך לחשוף `cap.PluginHeaders` **לאחר** ש-`native-bridge.js` רץ
- ההבחנה בין `rtype: 'promise'` ל-`rtype: 'callback'`

---

## 🔴 2. שמות "plugins" — שני concepts שונים

**הבעיה:** ה-codebase משתמש ב-"plugin" ל-**שני דברים שונים**:

| מינוח | משמעות |
|---|---|
| Capacitor plugin | מודול native Capacitor (`Filesystem`, `App`, `Device`) |
| Obsidian plugin | extension של Obsidian (`obsidian-web-layout`, LiveSync) |
| System plugin | Obsidian plugin שהשרת מזריק (`plugins/` בריפו) |

**לא מתועד.** סוכן או reader חדש יבלבל בין השניים — הקבצים `system-plugins.js`
ו-`PluginHeaders` עוסקים בשני concepts אורתוגונליים.

**איפה לתעד:** `docs/investigations.md` — Glossary section בראש המסמך

**מה צריך לכלול:**
- טבלת מינוח
- Diagram: Obsidian plugin → vault.adapter (CapacitorAdapter) → Capacitor.Plugins.Filesystem → our shim → HTTP API
- הבהרה שlivesync (Obsidian plugin) משתמשת ב-Filesystem (Capacitor plugin) דרך CapacitorAdapter

---

## 🔴 3. רשימת ה-Capacitor plugins המלאה והרציונל

**הבעיה:** ב-`capacitor-shim.js` יש 13 plugins implemented/stubbed, אבל
אין שום סיכום של:
- אילו הם real implementations (HTTP → /api/fs)
- אילו browser-native (Clipboard → navigator.clipboard)
- אילו identity stubs (App.getInfo, Device.getInfo — מחזירים מידע אמיתי)
- אילו noop stubs (SplashScreen, StatusBar — לא רלוונטי בweb)
- אילו עדיין TODO (App.requestUrl — לoLiveSync)

**איפה לתעד:** Header של `capacitor-shim.js` (sections עם רשימת plugins)
ועותק חוזר ב-`investigations.md`

**מה צריך לכלול:**
```
Real implementations (route to HTTP API):
  Filesystem — readFile, writeFile, stat, readdir, mkdir, rmdir,
               rename, copy, deleteFile, getUri, startWatch,
               stopWatch, watchAndStatAll, addListener
               
Browser-native (delegate to Web APIs):
  Clipboard   — navigator.clipboard
  Browser     — window.open
  Preferences — localStorage (cap: prefix)
  SecureStorage — localStorage (sec: prefix)

Identity stubs (return realistic info):
  Device   — getInfo returns { platform: 'android', ... }
  App      — getInfo returns { name: 'Obsidian', version: '1.12.7', ... }

Noop stubs (return success, do nothing):
  SplashScreen, StatusBar, Keyboard, KeepAwake, Haptics, RateApp

TODO / known limitations:
  App.requestUrl — currently returns {}; needs fetch implementation 
                   for LiveSync support (CORS-dependent)
```

---

## 🔴 4. `window.__owPlatform` ו-`__owPlatformOverrides`

**הבעיה:** ה-mechanism שמאפשר control בזמן ריצה על ה-Platform flags של
Obsidian הוא לב הלב של ה-mobile runtime. מתועד **חלקית**:
- `walkthrough.md` 19:30 מדבר על ה-patches — טוב
- אבל לא מסביר את ה-**runtime API** של `__owPlatform`

**איפה לתעד:** `docs/investigations.md` (סעיף חדש) או doc ייעודי
`docs/runtime-api.md`

**מה צריך לכלול:**
- `window.__owPlatform` — reference חי ל-Platform object של Obsidian. כל
  שינוי משפיע על תנהגות פנימית של Obsidian (אבל לא retroactively).
- `window.__owPlatformOverrides` — נקרא ב-IIFE, מוזרק ל-`Object.assign`.
  הגדרה שלו לפני הbundle נטען = שליטה מלאה.
- localStorage key `obsidian-web:layout-mode` — מקור האמת ל-`__owPlatformOverrides`
- API שhamilton plugin של obsidian-web יכול להשתמש בו (קריאה + הזנה לreload)

---

## 🟠 5. בניית ה-Capacitor shim — אין walkthrough entry

**הבעיה:** העבודה של בניית כל הshim (~700 שורות) קרתה בשיחה ולא תועדה
ב-walkthrough בentry נפרד. ה-entries הקיימים מתייחסים ל-**שכבות מעל**
(build-time patches, system plugin overlay) אבל לא לbase.

**איפה לתעד:** `docs/walkthrough.md` — entry חדש עם תאריך אחורה

**מה צריך לכלול:**
- מתי: 2026-05-11 (לפני 18:00)
- מה: יצירת `client-mobile/`, `capacitor-shim.js`, native-bridge integration
- Pitfalls: PluginHeaders (ראה פער 1), "Vault path is not a directory"
  (server מחזיר `isDirectory:true` לא `type:'directory'`), `i18next`
  חייב להיטען לפני `app.js`, רשימת lib scripts מ-desktop (codemirror,
  moment, pixi, etc.)
- Verification: דפדפן Chrome, `app.vault.adapter` הוא CapacitorAdapter,
  Capacitor.getPlatform()='android'

---

## 🟠 6. Virtual plugin overlay — מנגנון מלא

**הבעיה:** ה-overlay של plugins מ-repo מתועד חלקית:
- `walkthrough.md` 20:05 — אזכור קצר
- `system-plugins.js` — header אבל לא comprehensive
- אין הסבר על **rationale** של precedence (vault > repo) או על synthesized stat

**איפה לתעד:** `docs/investigations.md` — סעיף חדש

**מה צריך לכלול:**
- Diagram של החלטות:
  ```
  GET /api/fs/read .obsidian/plugins/<id>/main.js
    → vault file exists? Yes → serve vault file
    → No                    → tryGetSystemFilePath() → serve repo file
  ```
- `community-plugins.json`:
  - Read: merge system plugin ids into the array
  - Write: strip them before saving (vault stays clean)
- Synthesized stat ל-`.obsidian/plugins` כשלא קיים בvault
- Synthesized readdir ל-`.obsidian/plugins` כשלא קיים בvault
- Precedence: vault > repo (overrides אפשריים)
- Limitations: disable של plugin דרך UI לא persist (re-injected each load)

---

## 🟠 7. סטטוס נוכחי של `createHash`

**הבעיה:** אי-עקביות בין `client/boot.js` ל-`client-mobile/boot.js`:

| | client/boot.js (desktop) | client-mobile/boot.js |
|---|---|---|
| sync `.digest()` | Empty + warning | Empty + warning |
| async `.digest(enc, cb)` | ✅ עובד דרך subtle.digest | ❌ לא ממומש |
| `algo: 'md5'` | מתחפש ל-SHA-256 | מתחפש ל-SHA-256 |

ב-walkthrough כתוב שתיקנו, אבל זה תוקן רק ב-desktop. ה-mobile לא ייהנה מה-async path.

**איפה לתעד:** `docs/investigations.md` תחת Open issues / OR לתקן את הקוד

**מה צריך:**
- אופציה א: לתעד את האי-עקביות כידועה
- אופציה ב: להעתיק את הimplementation מהdesktop boot.js ל-mobile

**ההמלצה:** ב, כי זה תיקון של ~30 שורות

---

## 🟠 8. הנתיב הסופי ל-LiveSync — direct fetch + CORS

**הבעיה:** ה-LiveSync integration plan ב-`PLAN.md` עדיין מתאר את הגישה
הישנה (`PROXY_ALLOWED_HOSTS`). דיברנו בשיחה על כיוון חדש (direct fetch
+ CouchDB CORS) — לא תועד בשום מקום.

**איפה לתעד:** `PLAN.md` (לעדכן את הסעיף הקיים) +
`docs/livesync-integration.md` (doc חדש מפורט)

**מה צריך לכלול:**
- **דחיית הproxy approach** — סיבות (cost, abuse, CF Workers limits, liability)
- **הbחירה ב-direct fetch** — סיבות (no infra, infinite scale, מקובל בLiveSync)
- **דרישת CORS על CouchDB** — דוגמה ל-`local.ini`
- **שינויים נדרשים בקוד:**
  - `App.requestUrl` / `CapacitorHttp.request` ב-shim → direct fetch
  - הסרת הdependency על `PROXY_ALLOWED_HOSTS` (הproxy נשאר רק לdesktop hosts)
- **גישת public deployment:** LiveSync על CF demo עובד אם המשתמש הגדיר CORS
- **התלות בcrypto:** LiveSync משתמשת ב-spark-md5 מ-bundle שלה + subtle.digest
  async — ה-shim שלנו לא נדרש

---

## 🟡 9. `client/` vs `client-mobile/` — שני runtimes

**הבעיה:** הפרויקט תומך ב-**שני entry points**:
- `/` → desktop bundle + electron shims (legacy)
- `/mobile` → mobile bundle + Capacitor shim (preferred)

לא מתועד שזה הולך להיות המצב לטווח הארוך, או איך לבחור ביניהם.

**איפה לתעד:** `PLAN.md` — Architecture section

**מה צריך לכלול:**
- Diagram של שני הruntimes משתפים את אותו שרת
- מתי להשתמש בכל אחד (default: mobile, desktop כ-fallback?)
- האם planning להסיר את desktop בעתיד?

---

## 🟡 10. מבנה הDirectory `obsidian-mobile/` — gitignored

**הבעיה:** `obsidian-mobile/` הוא extracted from APK (כמו `obsidian/`),
gitignored, ויש סקריפט להוריד. **לא מסובך אבל לא מתועד** ב-README.

**איפה לתעד:** `README.md` — setup section

**מה צריך לכלול:**
- `node scripts/update-obsidian.js` ל-desktop bundle
- `node scripts/update-obsidian-mobile.js` ל-mobile bundle
- שניהם נדרשים אם רוצים את שני הruntimes
- האחרון מחיל patches אוטומטית (linking לpatch-obsidian-mobile.js)

---

## 🟡 11. Test artifacts ב-`test-vault/`

**הבעיה:** יש קבצים שcreated by accident בtest-vault (`Untitled.md`,
`ללא כותרת.base`). לא מזיק, אבל ה-`.base` extension (Obsidian Bases —
חדש בגרסה 1.12) לא מתועד.

**איפה לתעד:** אופציונלי. אפשר פשוט להוסיף ל-gitignore את `test-vault/*.base`
ולא לתעד.

---

## 🟡 12. workflow של דפדפן בgui-host

**הבעיה:** הסוכן הבא שיצטרך לבדוק שוב לא יידע על:
- port 9224 (כדי לא להפריע ל-9222/9223)
- `--user-data-dir=/tmp/pw-obsidian-mobile`
- צורך ב-reverse SSH tunnel ל-3000
- שמות sessions (default vs obsmobile)

**איפה לתעד:** `docs/dev-setup.md` (doc חדש) או section ב-`docs/investigations.md`

**מה צריך לכלול:**
- Port allocation
- Session naming convention
- Tunnel command (אם נדרש)
- pw-clean.sh usage

---

## 🟡 13. Server-side proxy allowlist — לא רלוונטי יותר

**הבעיה:** הplan ל-`PROXY_ALLOWED_HOSTS` (ב-`PLAN.md` תחת LiveSync) הוא
כעת מיושן בעקבות הבחירה ב-direct fetch. ה-proxy עצמו (`/api/proxy-request`)
נשאר ל-desktop bundle (`releases.obsidian.md`, etc.) אבל לא יקבל הרחבה.

**איפה לתעד:** `PLAN.md` — עדכון הסעיף הקיים

**מה צריך:** קצר — "Direct fetch + CORS bypass זה — proxy allowlist
לא נדרש לLiveSync. הproxy נשאר ל-Obsidian release/asset hosts בלבד."

---

## 🟡 14. Developer guide ל-system plugin חדש

**הבעיה:** איך מוסיפים system plugin חדש? התשובה לא מתועדת:
1. `mkdir plugins/obsidian-web-<name>`
2. צור `manifest.json` עם `id` ששווה לdirectory name
3. צור `main.js` עם CommonJS module + `class extends Plugin`
4. בdoc: בדוק `window.__owPlatform` כדי לדעת שאתה ב-obsidian-web
5. אין צורך ב-build (אין TS, אין bundler)
6. הplugin נטען אוטומטית בכל vault — `server/system-plugins.js` סורק
   ב-startup

**איפה לתעד:** `docs/system-plugin-dev-guide.md` (doc חדש)

---

## 🟡 15. ה-LiveSync ב-DEMO_MODE של CF

**הבעיה:** ה-CF deployment (`cf/`) הוא in-memory בdemo mode. אם נוסיף את
LiveSync כsystem plugin, ב-CF demo הוא ינסה לפעול על vault שמתאפס כל 4
שעות. לא הגיוני.

**איפה לתעד:** `cf/README.md` (אם קיים) ו-`PLAN.md`

**מה צריך:**
- ה-system plugin של LiveSync צריך להיות **opt-in via env var**
- ב-CF demo: `SYSTEM_PLUGINS=obsidian-web-layout` (ללא LiveSync)
- בself-hosted: `SYSTEM_PLUGINS=obsidian-web-layout,obsidian-livesync`

---

## סיכום — סדר עדיפויות מוצע

**Phase 1 (קריטי, חוסם הבנה):**
- פער 1: PluginHeaders mechanism
- פער 2: Terminology glossary
- פער 3: Capacitor shim plugin list

**Phase 2 (חשוב, עוזר לcontinuity):**
- פער 4: `__owPlatform` API
- פער 5: Walkthrough entry על הshim
- פער 6: Virtual overlay full mechanism
- פער 8: LiveSync new direction (direct fetch)

**Phase 3 (nice-to-have, אחרי שyer LiveSync יתממש):**
- פערים 7, 9, 10, 12-15 — לפי הצורך

**תיקון קוד (לא תיעוד):**
- פער 7: copy `createHash` async path מ-`client/boot.js` ל-`client-mobile/boot.js`

---

## הערה אחרונה

חלק מהמסמכים הקיימים — בעיקר `investigations.md` — מתפקדים גם כיומן
חקירה היסטורי. צריך להחליט: לעדכן in-place או להוסיף סעיפים חדשים תחת
"Updates" / "Current state"?

**המלצה:** להוסיף **glossary בראש** + **"Current state" section** שמסכם
את המצב הנוכחי. החלקים ההיסטוריים נשארים כ"חקירה לאורך הדרך" — ערך
ארכיוני.
