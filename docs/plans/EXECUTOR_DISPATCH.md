# Executor Dispatch — obsidian-web (פר-פרויקט)

> Boilerplate לאליעזר בפרויקט obsidian-web. ה-brief מפנה לכאן ב-§0 ולא חוזר עליו.
> אם ה-brief סותר משהו פה — ה-brief מנצח. לא ברור — Escalation למרדכי.
> הבסיס הכללי (role, BLOCKED, batch) ב-
> `~/projects/brief-driven-slices/main/briefs/EXECUTOR_DISPATCH.md`. פה רק הספציפי.

---

## Role

אם קיבלת prompt "בצע docs/plans/<slice>.md" — **אתה אליעזר**. מבצע ישירות.
**אל תקרא ל-sub-agent מסוג `eliezer`.** ה-sub-agents היחידים: `calev`/`calev-heavy`.

---

## 1. Single-branch — אין `dev`

הריפו הזה הוא **single-branch**: יש רק `main`. ה-base לכל worktree הוא `main`
(לא `dev`). ה-`base` המדויק מצוטט ב-brief וב-state.json.

```bash
cd ~/projects/obsidian-web
git worktree add .worktrees/<slice-name> -b <slice-name> main
cd .worktrees/<slice-name>/src/server
npm install
```

> ⚠️ יש WIP לא-מקומיט ב-working tree של הריפו הראשי (slice mobile-bootstrap-cache).
> ה-worktree נגזר מ-`main` (HEAD) הנקי — ה-WIP **לא ייכלל** בו. אל תיגע בו.

> ⚠️ gotcha: אם cwd לא root הריפו, git יצור worktree במקום הלא-נכון.
> השתמש ב-absolute path אם אינך ב-root.

---

## 2. אין root `package.json` / אין pnpm / אין hooks

- אין `package.json` ב-root הריפו. ה-deps של השרת ב-`src/server/package.json`
  (express, compression, chokidar, ws).
- מנהל החבילות: **npm** (לא pnpm). אין `hooks:install`, אין pre-commit hook.
- התקנה: `cd src/server && npm install`.

---

## 3. איך להריץ

| רכיב | פקודה |
|------|--------|
| **BE (server)** | `cd src/server && PORT=<port> node index.js` |
| **BE מול ה-vault הגדול** | `PORT=<port> VAULT_PATH=<your-vault> node index.js` |
| **Tests (server)** | `cd src/server && npm test` (= `node --test`) או `node --test test/<file>` |
| **Tests (mobile unit)** | `node --test src/client-mobile/test/` — אסור לשבור (14 ירוקים) |

Vault גדול לבדיקות ביצועים: `009428c4bd1ac698` →
`<your-vault>` (מאונט **rclone FUSE מול Google Drive**,
~104 תיקיות + 450 קבצי טקסט). זה מקור ה-latency שה-slice מטפל בו.

---

## 4. Ports — חוק הברזל

worktree ראשון → `PORT=4000`; אם תפוס → 4001, 4002... בדוק `ss -tln | grep :4000`.
**אל תהרוג** BE שכבר רץ (ייתכן שמרדכי מריץ אחד). אל תשאל — יש קונבנציה.

---

## 5. אין tunnel / אין browser ל-slice זה

slice `server-bootstrap-perf` הוא צד-שרת בלבד. המדידות ב-`curl` ובלוגים,
לא ב-DOM. אין צורך ב-tunnel או browser. (ההשפעה על המובייל מאומתת בנפרד ב-Slice 2.)

---

## 6. Testing strategy — פר commit לפי ה-brief

ה-brief קובע פר-commit: `tdd` / `integration` / `manual` / `none`. **אסור לסטות.**
ל-slice זה: Commit 0 = `manual` (מדידת before/after), Commit 1 = `tdd`,
Commit 2 = `integration`. רוצה לסטות → Escalation.

---

## 7. Verifier (כלב)

ה-brief הוא **complexity 8 → calev-heavy** בסוף. בנוסף, phase-verifier אחרי
**Commit 1** (ה-invalidation): `Task(subagent_type="calev", prompt="... mode: phase ...")`.
בסוף: `Task(subagent_type="calev-heavy", prompt="...")` (בלי `mode:`).

---

## 8. Mode 2 (יתרו / tmux) — outcomes הוא ה-signal

אם `$BDS_SLICE` מוגדר — אתה רץ תחת יתרו. heartbeat אחרי כל commit, וב-סיום
כתוב **תמיד** `$BDS_STATE_DIR/outcomes/$BDS_SLICE.json`:

- הצלחה: `{"slice":"...","status":"completed","commits":"<base>..HEAD","calev_report":"<path|verdict>","deviations":[],"notes":""}`
- חסימה: `{"slice":"...","status":"blocked","issue":"...","source":"...","tried":"...","need":"..."}`

היעדר הקובץ = קריסה שקטה. `opencode run` תמיד מחזיר exit 0 — ה-outcome הוא ה-signal.

---

## 9. בסיום

- ✅ commit אחרון: walkthrough entry + סטטוס ב-brief "הושלם".
- ✅ הרץ calev-heavy.
- ✅ דווח: "branch מוכן ב-`.worktrees/<slice>/`. Report: <path>. סטיות: ...".
- ❌ **לא merge, לא מחיקת worktree, לא push.** — מרדכי ממזג אחרי אישור המשתמשת.

---

## 10. Gotchas ספציפיים

- **threadpool סדר-אתחול**: `UV_THREADPOOL_SIZE` חייב להיקבע בראש `index.js`
  **לפני** כל `require` שנוגע ב-FS אסינכרוני. אחרי אתחול ה-pool זה לא משפיע.
- **relPath מ-req**: המפתחות ב-`fs`/`dirs` הם vault-relative עם `/`. ה-relPath
  מגיע ישר מ-`req.query.path`/`req.body.path` — רק נרמל `.split(path.sep).join('/')`.
- **payload זהה**: אחרי incremental rebuild ה-`fs`/`dirs` חייבים להיות זהים
  ל-full re-scan על אותו מצב. זה ה-correctness gate המרכזי.
