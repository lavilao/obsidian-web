# Dev setup — gui-host browser workflow

> Added: 2026-05-11
>
> מסמך מעשי לסוכן/מפתח שצריך להריץ ולבדוק את obsidian-web (בעיקר את ה-mobile runtime) בדפדפן אמיתי דרך ה-`gui-host` container. בלי המסמך הזה כל סוכן חדש מבזבז 20-30 דקות לגלות את אותם פרטים שוב.

המסמך לא מחליף את הידע הגנרי על browser-automation (הרצת Chrome מרוחק + `playwright-cli`) — הוא משלים אותו עם הפרטים הספציפיים לפרויקט.

---

> **`gui-host`** = ה-alias שלך ב-`~/.ssh/config` למכונה/קונטיינר עם דפדפן headed
> (Chrome) ל-QA. החלף בכל הפקודות למטה בשם המארח שלך. הפקודות מניחות שיש שם
> `pw-clean.sh` + `playwright-cli` ונתיב `~/Documents/...` — התאם לסביבה שלך.

## למה gui-host ולא דפדפן מקומי?

- Obsidian mobile runtime נתפס יחסית בקלות ל-headed Chrome אמיתי (יש Web APIs שדורשים origin אמיתי, לא `file://`).
- Cloudflare/anti-bot pages — ה-`pw-clean.sh` script של gui-host חושף Chrome ללא automation flags, וצולח Cloudflare ו-similar.
- Persistent profile — ל-Obsidian יש state ב-IndexedDB ו-localStorage. profile נפרד לכל בדיקה מונע cross-contamination.

---

## Port allocation

`gui-host` רץ עם מספר Chrome instances. כדי לא להתנגש:

| Port | משמש ל |
|---|---|
| 9222 | ברירת מחדל של playwright-cli, generic sessions |
| 9223 | reserved — שני sessions במקביל |
| **9224** | **obsidian-web — desktop runtime (`/`)** |
| **9225** | **obsidian-web — mobile runtime (`/mobile`)** (אם רוצים שני profiles במקביל) |

אם יש סשן פעיל על port מסוים — סגור אותו לפני שמתחילים חדש:

```bash
ssh gui-host '~/Documents/scripts/pw-clean.sh --close --port=9224'
```

---

## User-data-dir naming convention

| Path | משתמש |
|---|---|
| `/tmp/pw-obsidian-web` | sessions של ה-desktop runtime |
| `/tmp/pw-obsidian-mobile` | sessions של ה-mobile runtime |

הפרדה נדרשת — אחרת `localStorage['obsidian-web:layout-mode']` ו-`obsidian-web:lastVaultId` של ה-desktop runtime יגלשו ל-mobile runtime ולהפך.

---

## Session naming conventions (playwright-cli)

playwright-cli תומך ב-`--session=<name>`. בפרויקט אנחנו משתמשים ב:

| Session name | URL | Profile |
|---|---|---|
| `default` | `http://localhost:3000/` | `/tmp/pw-obsidian-web` |
| `obsmobile` | `http://localhost:3000/mobile` | `/tmp/pw-obsidian-mobile` |

(הם שמות הקובץ של ה-Chrome profile + של playwright session — playwright-cli שומר state per-session.)

---

## Reverse SSH tunnel ל-port 3000

ה-server רץ על המכונה המקומית; ה-`gui-host` container צריך גישה אליו דרך `http://localhost:3000`. הtunnel נפתח אוטומטית כשמשתמשים ב-SSH config הסטנדרטי של ה-user (`~/.ssh/config`), אבל אם אתה רואה `ERR_CONNECTION_REFUSED` ב-Chrome פנימה:

```bash
# מ-machine מקומית — fresh reverse tunnel:
ssh -R 3000:localhost:3000 gui-host -N -f
```

תיבדק עם:

```bash
ssh gui-host 'curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/vaults/list'
# צריך 200
```

---

## `pw-clean.sh` usage (cheat sheet)

הסקריפט המלא ב-`~/Documents/scripts/pw-clean.sh` ב-gui-host. הflags השכיחים:

```bash
# פתח דפדפן ל-mobile runtime
ssh gui-host '~/Documents/scripts/pw-clean.sh \
  --url=http://localhost:3000/mobile \
  --port=9224 \
  --user-data-dir=/tmp/pw-obsidian-mobile'

# פתח עם DevTools פתוח
ssh gui-host '~/Documents/scripts/pw-clean.sh \
  --url=http://localhost:3000/mobile \
  --port=9224 \
  --user-data-dir=/tmp/pw-obsidian-mobile \
  --devtools'

# סגור
ssh gui-host '~/Documents/scripts/pw-clean.sh --close --port=9224'
```

אחרי שה-browser פעיל, playwright-cli מתחבר ב-CDP:

```bash
ssh gui-host 'playwright-cli connect --port=9224 --session=obsmobile'
ssh gui-host 'playwright-cli goto http://localhost:3000/mobile --session=obsmobile'
ssh gui-host 'playwright-cli snapshot --session=obsmobile --filename=mobile-init.yml'
scp gui-host:~/Documents/playwright-cli/results/mobile-init.yml /tmp/
```

---

## Console logs

```bash
# החיים מ-Chrome console מתועדים ל:
ssh gui-host 'ls -t ~/Documents/playwright-cli/results/console-* | head -1 | xargs cat'

# פילטור ל-traces שלנו:
ssh gui-host 'ls -t ~/Documents/playwright-cli/results/console-* | head -1 | xargs cat | grep "obsidian-web"'
```

---

## Eval helpers

```bash
# קרא window.__owPlatform
ssh gui-host 'playwright-cli eval --raw --session=obsmobile \
  "async () => JSON.stringify({isMobile: __owPlatform.isMobile, isPhone: __owPlatform.isPhone, isMobileApp: __owPlatform.isMobileApp})"'

# החלף layout
ssh gui-host 'playwright-cli eval --raw --session=obsmobile \
  "() => { localStorage.setItem(\"obsidian-web:layout-mode\", \"mobile\"); location.reload(); return \"ok\"; }"'
```

חובה `--raw` כדי לקבל return value נקי, וחובה JSON.stringify ל-objects (playwright-cli serializer נחנק על circular refs).

---

## Server log access

```bash
tail -f /tmp/obsidian-web-server.log

# פילטור ל-mobile runtime requests:
tail -f /tmp/obsidian-web-server.log | grep -E "/mobile|/api/(fs|bootstrap|watch)"
```

ה-middleware מסנן רק `/api`, `/i18n`, `/lib`. אם צריך לראות יותר, להרחיב ב-`server/index.js`.

---

## Common pitfalls

| תופעה | סיבה | פתרון |
|---|---|---|
| `localhost:3000` לא נטען בדפדפן | reverse tunnel נסגר | `ssh -R 3000:localhost:3000 gui-host -N -f` |
| ה-mobile UI מופיע גם על desktop viewport רחב | localStorage layout-mode = "mobile" | `localStorage.removeItem('obsidian-web:layout-mode')` + reload |
| Empty snapshot מ-playwright-cli | session לא חובר ל-port הנכון | `playwright-cli connect --port=9224 --session=obsmobile` |
| "Vault path is not a directory" ב-`client-mobile/boot.js` | stat החזיר `{type: 'file'}` (בעיית routing על השרת) | בדוק את `?vault=<id>` ב-URL ו-`/api/fs/stat?path=` |
| `Filesystem is not implemented on android` | `PluginHeaders` חסרים | ראה `docs/investigations.md` → PluginHeaders mechanism |

---

## הקשרים נוספים

- `docs/investigations.md` — ידע עומק על Obsidian internals + ה-mechanisms שלנו (PluginHeaders, __owPlatform, system plugin overlay).
- `docs/walkthrough.md` — יומן פיתוח כרונולוגי.
- `playwright-cli` — the browser-automation CLI used throughout (see its own docs for the command surface).
