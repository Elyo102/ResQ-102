# ResQ-102 · הוראות פריסה

עודכן: 3.9.2026

מסמך אחד, מדורג, עם פרויקט מפורש בכל פקודה. מי שמריץ אותו נוגע
בייצור — קרא עד הסוף לפני שאתה מריץ שורה ראשונה.

> **הגרסה הקודמת של המסמך הזה הייתה שגויה בשלושה מובנים** והוחלפה:
> היא טענה שדבר אינו פרוס (המערכת פרוסה); היא פרסה
> `firestore:rules,functions` בפקודה אחת **בלי `firestore:indexes`
> ובלי `hosting`**; והיא הסתמכה על ספירת Functions חלקית במקום על מצב הייצור בפועל.

---

## 0 · מה נדרש על המחשב

| | |
|---|---|
| Node | **22** — זה מה ש-`functions/package.json` מצהיר כ-engine |
| Java | **JDK 21** — נדרש **רק** לשער האמולטור, לא לפריסה. https://adoptium.net |
| Firebase CLI | מחובר: `npx --yes firebase-tools@15.28.1 login` |
| GitHub CLI | `gh` מחובר לחשבון שמורשה למזג את ה-PR המאושר |
| הרשאה | חשבון עם הרשאת פריסה לפרויקט `station-102` |

### עץ שחרור נקי וקשור ל-SHA המאושר

לא פורסים מה-clone שבו מפתחים. יוצרים worktree מבודד מה-SHA המועמד;
כך קובץ מקומי, ignored או untracked אינו יכול להיכנס לפריסה:

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
function Assert-ResQNative([string]$step) {
  if ($LASTEXITCODE -ne 0) { throw "$step failed with exit $LASTEXITCODE" }
}
$resqCandidateSha = '<SHA מלא של המועמד לבדיקה>'
$resqCandidateBranch = '<שם ענף המועמד ב-origin>'
$resqPrNumber = <מספר PR>
$resqReleaseDir = Join-Path $env:TEMP ("resq-candidate-" + $resqCandidateSha.Substring(0, 12) + '-' + [guid]::NewGuid().ToString('N'))
git fetch origin --prune
Assert-ResQNative 'git fetch'
$resqRollbackSha = (git rev-parse origin/main).Trim()
Assert-ResQNative 'capture rollback SHA'
$resqRollbackTree = (git rev-parse ($resqRollbackSha + '^{tree}')).Trim()
Assert-ResQNative 'capture rollback tree'
$resqRollbackVersionRaw = (git show ($resqRollbackSha + ':version.json') | Out-String).Trim()
Assert-ResQNative 'capture rollback version.json'
$resqRollbackVersion = $resqRollbackVersionRaw | ConvertFrom-Json
if (-not $resqRollbackVersion.v -or -not $resqRollbackVersion.d) { throw 'rollback version.json is incomplete' }

$resqHostingBeforeRaw = (npx --yes firebase-tools@15.28.1 hosting:channel:list --site station-102 --project station-102 --json | Out-String)
Assert-ResQNative 'capture live Hosting channel'
$resqHostingBefore = $resqHostingBeforeRaw | ConvertFrom-Json
if ($resqHostingBefore.status -ne 'success') { throw 'Hosting channel query did not succeed' }
$resqLiveChannels = @($resqHostingBefore.result.channels | Where-Object { $_.name -eq 'projects/station-102/sites/station-102/channels/live' })
if ($resqLiveChannels.Count -ne 1) { throw 'expected exactly one live Hosting channel' }
$resqLiveBefore = $resqLiveChannels[0]
if ($resqLiveBefore.release.version.status -ne 'FINALIZED') { throw 'live Hosting version is not FINALIZED' }
$resqPrevHostingReleaseName = [string]$resqLiveBefore.release.name
$resqPrevHostingVersionName = [string]$resqLiveBefore.release.version.name
$resqPrevHostingVersionId = ($resqPrevHostingVersionName -split '/')[-1]
if (-not $resqPrevHostingReleaseName -or -not $resqPrevHostingVersionId) { throw 'Hosting rollback identifiers are missing' }

$resqLiveVersionBefore = Invoke-RestMethod -Method Get -Uri ('https://station-102.web.app/version.json?rollback_probe=' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -TimeoutSec 15 -Headers @{ 'Cache-Control' = 'no-cache' }
if ($resqLiveVersionBefore.v -ne $resqRollbackVersion.v -or $resqLiveVersionBefore.d -ne $resqRollbackVersion.d) {
  throw 'live Hosting version does not match origin/main; rollback set is not coherent'
}

$resqLedgerPath = Join-Path $env:TEMP ("resq-release-ledger-" + $resqCandidateSha.Substring(0, 12) + '.json')
[ordered]@{
  captured_at = [DateTimeOffset]::UtcNow.ToString('o')
  candidate_sha = $resqCandidateSha
  rollback_sha = $resqRollbackSha
  rollback_tree = $resqRollbackTree
  rollback_version = $resqRollbackVersion
  hosting_release_name = $resqPrevHostingReleaseName
  hosting_version_name = $resqPrevHostingVersionName
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resqLedgerPath -Encoding utf8
$resqAttemptLedgerPath = Join-Path $env:TEMP ("resq-release-attempts-" + $resqCandidateSha.Substring(0, 12) + '.json')
$resqAttemptCounts = [ordered]@{ rules_indexes = 0; functions = 0; hosting_clone = 0 }
$resqAttemptCounts | ConvertTo-Json | Set-Content -LiteralPath $resqAttemptLedgerPath -Encoding utf8

function Invoke-ResQDeployWith429Backoff([string]$only, [string]$step, [string]$attemptKey) {
  $delays = @(0, 60, 180)
  for ($attempt = 0; $attempt -lt $delays.Count; $attempt++) {
    if ($delays[$attempt] -gt 0) { Start-Sleep -Seconds $delays[$attempt] }
    $resqAttemptCounts[$attemptKey] = [int]$resqAttemptCounts[$attemptKey] + 1
    $resqAttemptCounts | ConvertTo-Json | Set-Content -LiteralPath $resqAttemptLedgerPath -Encoding utf8
    $resqNativeErrorsBeforeDeploy = $PSNativeCommandUseErrorActionPreference
    try {
      # A non-zero native exit is data here: it must be classified as 429 or
      # terminal before Stop semantics are restored.
      $PSNativeCommandUseErrorActionPreference = $false
      $output = (& npx --yes firebase-tools@15.28.1 deploy --only $only --project station-102 2>&1 | Out-String)
      $exitCode = $LASTEXITCODE
    } finally {
      $PSNativeCommandUseErrorActionPreference = $resqNativeErrorsBeforeDeploy
    }
    Write-Host $output
    if ($exitCode -eq 0) { return }
    $rateLimited = $output -match '(?i)(?:\b429\b|too many requests|rate.?limit|quota exceeded)'
    if (-not $rateLimited -or $attempt -eq $delays.Count - 1) {
      throw "$step failed with exit $exitCode after $($attempt + 1) attempt(s)"
    }
  }
}

gh --version
Assert-ResQNative 'GitHub CLI availability'
gh auth status
Assert-ResQNative 'GitHub CLI authentication'
$resqRemoteCandidate = (git rev-parse ("origin/" + $resqCandidateBranch)).Trim()
Assert-ResQNative 'resolve remote candidate'
if ($resqRemoteCandidate -ne $resqCandidateSha) { throw 'candidate SHA is not the remote branch head' }
git worktree add --detach $resqReleaseDir $resqCandidateSha
Assert-ResQNative 'create candidate worktree'
Set-Location -LiteralPath $resqReleaseDir
$resqStatus = @(git status --porcelain=v1 --untracked-files=all)
Assert-ResQNative 'candidate status'
if ($resqStatus.Count -ne 0) { throw 'candidate worktree is not clean' }
$resqValidatedHead = (git rev-parse HEAD).Trim()
Assert-ResQNative 'candidate HEAD'
$resqValidatedTree = (git rev-parse 'HEAD^{tree}').Trim()
Assert-ResQNative 'candidate tree'
if ($resqValidatedHead -ne $resqCandidateSha) { throw 'candidate HEAD mismatch' }
```

הפלט של `git status` חייב להיות ריק, ו-`HEAD` חייב להיות ה-SHA המלא
שאושר. שמור גם את SHA העץ בדוח השחרור. רשימת `hosting.ignore` חוסמת
בנפרד סודות וחבילות מסירה — הגנה כפולה, לא תחליף לעץ מבודד.

רק עכשיו, מתוך שורש ה-worktree המבודד, מתקינים תלויות. משתמשים
ב-**`npm ci` ולא `npm install`**: `ci` מתקין בדיוק את מה שכתוב בקובץ
הנעילה; `install` רשאי לעדכן גרסאות, ופריסה שמתקינה גרסה אחרת ממה
שנבדק אינה פריסה של מה שנבדק.

```powershell
npm ci --prefix functions
Assert-ResQNative 'functions npm ci'
npm ci --prefix tests
Assert-ResQNative 'tests npm ci'
npm ci --prefix rules-test
Assert-ResQNative 'rules-test npm ci'
npm --prefix tests exec -- playwright install chromium
Assert-ResQNative 'Playwright install'
```

---

## 1 · השערים · לפני שנוגעים בייצור

### שער א' — שער האפליקציה

```powershell
npm --prefix tests run all
Assert-ResQNative 'application gate'
```

`static` + `browser` + `browser:mobile`. חייב לצאת **0**.

> זהו גם ה-`predeploy` של הפונקציות, כלומר `firebase deploy --only
> functions` יריץ אותו שוב מעצמו. זה מכוון וזה מאט את הפריסה בכמה
> דקות. פריסה שעוקפת את השער היא פריסה שלא נבדקה.

### שער ב' — כללי האבטחה

```powershell
.\test-rules.bat
```

או ישירות:

```powershell
npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd rules-test && npm test"
Assert-ResQNative 'rules emulator gate'
```

**`--project demo-resq` ולא `station-102`.** האמולטור אינו נוגע
בייצור, אבל מזהה פרויקט אמיתי בשורת אמולטור הוא הרגל שנגמר רע.

הריצה הראשונה **מורידה את האמולטור מגוגל, כ-137 MB.** גם `git fetch`,
`npm ci`, התקנת Playwright, `npx`, הפריסה ובדיקת ה-live משתמשים ברשת.

### שער ג' — כל אינטגרציות Firestore שב-CI

```powershell
npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node bulletin.integration.test.js"
Assert-ResQNative 'bulletin integration'
npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && npm run test:identity"
Assert-ResQNative 'identity integration'
npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node station-transfer.integration.test.js"
Assert-ResQNative 'station transfer integration'
npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node attendance-shadow.integration.test.js"
Assert-ResQNative 'attendance shadow integration'
npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node invitations.integration.test.js"
Assert-ResQNative 'invitations integration'
npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node schedule-runtime.integration.test.js"
Assert-ResQNative 'schedule runtime integration'
npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node schedule-authoring.integration.test.js"
Assert-ResQNative 'schedule authoring integration'
npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node schedule-sheet-import.integration.test.js"
Assert-ResQNative 'schedule sheet-import integration'
npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node schedule-edit.integration.test.js"
Assert-ResQNative 'schedule edit integration'
npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node schedule-qualifications.integration.test.js"
Assert-ResQNative 'schedule qualifications integration'
npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node schedule-gaps.integration.test.js"
Assert-ResQNative 'schedule gaps integration'
npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node callout-delivery.integration.test.js"
Assert-ResQNative 'callout delivery security integration'
```

מיד אחרי השערים מודדים שוב את אותו עץ. אסור להכין אישור מתוך מצב
שהשתנה בזמן הבדיקות:

```powershell
$resqStatus = @(git status --porcelain=v1 --untracked-files=all)
Assert-ResQNative 'post-test status'
if ($resqStatus.Count -ne 0) { throw 'candidate changed during validation' }
if ((git rev-parse HEAD).Trim() -ne $resqValidatedHead) { throw 'candidate HEAD changed' }
Assert-ResQNative 'post-test HEAD'
if ((git rev-parse 'HEAD^{tree}').Trim() -ne $resqValidatedTree) { throw 'candidate tree changed' }
Assert-ResQNative 'post-test tree'
```

לפני שנוגעים בייצור מכינים גם worktree נקי של נקודת החזרה, מתקינים
בו את תלויות הפונקציות ומוודאים שהאינדקסים קדימה הם תוספת בלבד:

```powershell
$resqRollbackDir = Join-Path $env:TEMP ("resq-rollback-" + $resqRollbackSha.Substring(0, 12) + '-' + [guid]::NewGuid().ToString('N'))
git worktree add --detach $resqRollbackDir $resqRollbackSha
Assert-ResQNative 'create rollback worktree'
npm ci --prefix (Join-Path $resqRollbackDir 'functions')
Assert-ResQNative 'rollback functions npm ci'
$resqOldIndexes = ((git show ($resqRollbackSha + ':firestore.indexes.json') | Out-String) | ConvertFrom-Json).indexes |
  ForEach-Object { $_ | ConvertTo-Json -Depth 20 -Compress }
$resqNewIndexes = (Get-Content -LiteralPath (Join-Path $resqReleaseDir 'firestore.indexes.json') -Raw | ConvertFrom-Json).indexes |
  ForEach-Object { $_ | ConvertTo-Json -Depth 20 -Compress }
foreach ($resqOldIndex in $resqOldIndexes) {
  if ($resqNewIndexes -cnotcontains $resqOldIndex) { throw 'candidate removes or mutates an existing Firestore index' }
}
```

---

## 2 · המיזוג והפריסה · רק אחרי האישור שבסעיף 4

### 2.0 · מיזוג וקשירה מחדש ל-origin/main

```powershell
git fetch origin --prune
Assert-ResQNative 'pre-merge fetch'
if ((git rev-parse origin/main).Trim() -ne $resqRollbackSha) { throw 'origin/main changed after approval; approval is void' }
$resqPrHeadBeforeChecks = (gh pr view $resqPrNumber --json headRefOid --jq '.headRefOid').Trim()
Assert-ResQNative 'read PR head before checks'
if ($resqPrHeadBeforeChecks -ne $resqCandidateSha) { throw 'PR head differs from the approved candidate' }
gh pr checks $resqPrNumber --watch --fail-fast
Assert-ResQNative 'wait for required PR checks'
$resqPrHeadAfterChecks = (gh pr view $resqPrNumber --json headRefOid --jq '.headRefOid').Trim()
Assert-ResQNative 're-read PR head after checks'
if ($resqPrHeadAfterChecks -ne $resqCandidateSha) { throw 'PR head changed while checks were running' }
$resqHostingNowRaw = (npx --yes firebase-tools@15.28.1 hosting:channel:list --site station-102 --project station-102 --json | Out-String)
Assert-ResQNative 'pre-merge Hosting recheck'
$resqHostingNow = $resqHostingNowRaw | ConvertFrom-Json
$resqLiveNow = @($resqHostingNow.result.channels | Where-Object { $_.name -eq 'projects/station-102/sites/station-102/channels/live' })
if ($resqHostingNow.status -ne 'success' -or $resqLiveNow.Count -ne 1 -or
    $resqLiveNow[0].release.name -ne $resqPrevHostingReleaseName -or
    $resqLiveNow[0].release.version.name -ne $resqPrevHostingVersionName -or
    $resqLiveNow[0].release.version.status -ne 'FINALIZED') {
  throw 'live Hosting changed after approval; approval is void'
}
gh pr merge $resqPrNumber --merge --match-head-commit $resqCandidateSha
Assert-ResQNative 'merge PR'
git fetch origin --prune
Assert-ResQNative 'fetch merged main'
$resqMergeSha = (git rev-parse origin/main).Trim()
Assert-ResQNative 'resolve merged main'
$resqMergeTree = (git rev-parse ($resqMergeSha + '^{tree}')).Trim()
Assert-ResQNative 'resolve merged tree'
if ($resqMergeTree -ne $resqValidatedTree) { throw 'origin/main tree differs from the approved candidate' }
$resqDeployDir = Join-Path $env:TEMP ("resq-deploy-" + $resqMergeSha.Substring(0, 12) + '-' + [guid]::NewGuid().ToString('N'))
$resqPreviewChannel = "candidate-" + $resqMergeSha.Substring(0, 12)
git worktree add --detach $resqDeployDir $resqMergeSha
Assert-ResQNative 'create deploy worktree'
Set-Location -LiteralPath $resqDeployDir
npm ci --prefix functions
Assert-ResQNative 'deploy functions npm ci'
npm ci --prefix tests
Assert-ResQNative 'deploy tests npm ci'
npm ci --prefix rules-test
Assert-ResQNative 'deploy rules-test npm ci'
npm --prefix tests exec -- playwright install chromium
Assert-ResQNative 'deploy Playwright install'
$resqDeployStatus = @(git status --porcelain=v1 --untracked-files=all)
Assert-ResQNative 'predeploy status'
if ($resqDeployStatus.Count -ne 0) { throw 'deploy worktree is not clean' }
if ((git rev-parse HEAD).Trim() -ne $resqMergeSha) { throw 'deploy HEAD is not merged origin/main' }
Assert-ResQNative 'predeploy HEAD'
if ((git rev-parse 'HEAD^{tree}').Trim() -ne $resqValidatedTree) { throw 'deploy tree is not the approved tree' }
Assert-ResQNative 'predeploy tree'
```

**לא פקודה אחת.** הסדר אינו שרירותי: קודם יוצרים ובודקים Preview סטטי
בלי לשנות את ערוץ ה-live או את ה-Backend. אחר כך כללים ואינדקסים חייבים
להיות במקום לפני שקוד חדש מתחיל לכתוב, וה-hosting מקודם אחרון.

### 2.1 · Preview של האתר — לפני כל שינוי ייצור

```powershell
npx --yes firebase-tools@15.28.1 hosting:channel:deploy $resqPreviewChannel --project station-102 --expires 1d
Assert-ResQNative 'deploy hosting preview'
$resqPreviewListRaw = (npx --yes firebase-tools@15.28.1 hosting:channel:list --site station-102 --project station-102 --json | Out-String)
Assert-ResQNative 'read hosting preview'
$resqPreviewList = $resqPreviewListRaw | ConvertFrom-Json
$resqPreviewRows = @($resqPreviewList.result.channels | Where-Object { $_.name -eq ("projects/station-102/sites/station-102/channels/" + $resqPreviewChannel) })
if ($resqPreviewList.status -ne 'success' -or $resqPreviewRows.Count -ne 1 -or $resqPreviewRows[0].release.version.status -ne 'FINALIZED') {
  throw 'preview channel is missing or not finalized'
}
$resqPreviewOrigin = [string]$resqPreviewRows[0].url
$resqPreviewVersionName = [string]$resqPreviewRows[0].release.version.name
$resqPreviewVersionId = ($resqPreviewVersionName -split '/')[-1]
if (-not $resqPreviewVersionId) { throw 'preview version id is missing' }
$resqPreviewCache = Join-Path $resqDeployDir '.firebase/hosting..cache'
if (-not (Test-Path -LiteralPath $resqPreviewCache -PathType Leaf)) { throw 'Firebase did not create a Hosting artifact manifest' }
$resqPreviewCacheSha = (Get-FileHash -LiteralPath $resqPreviewCache -Algorithm SHA256).Hash
npm --prefix tests run pages:preview -- "$resqDeployDir" $resqPreviewOrigin
Assert-ResQNative 'preview HTTP bytes, MIME, cache headers and private paths'
if ((Get-FileHash -LiteralPath $resqPreviewCache -Algorithm SHA256).Hash -ne $resqPreviewCacheSha) {
  throw 'Hosting artifact changed after preview verification'
}
```

### 2.2 · כללים ואינדקסים

```powershell
$resqRulesAttempted = $true
Invoke-ResQDeployWith429Backoff 'firestore:rules,firestore:indexes' 'deploy rules and indexes' 'rules_indexes'
```

**⚠ `firestore:indexes` הייתה חסרה בגרסה הקודמת של המסמך.** אינדקס
חסר אינו שגיאת פריסה — הוא שאילתה שנופלת בזמן אמת, למשתמש, בשדה.

עצור וּודא שהפקודה הסתיימה בהצלחה לפני שאתה ממשיך. לאחר מכן המתן
בצורה חסומה לשלושת האינדקסים החדשים של קריאת הפתע. הצלחת פקודת
הפריסה אינה אומרת שבניית האינדקס הסתיימה:

```powershell
node tests/firebase-release-state.mjs indexes station-102 1800000 15000 `
  'callouts|COLLECTION|by_uid:ASCENDING,created_key:DESCENDING' `
  'callouts|COLLECTION|uids:ARRAY_CONTAINS,created_key:DESCENDING' `
  'callouts|COLLECTION|uids:ARRAY_CONTAINS,active:ASCENDING,created_key:DESCENDING'
Assert-ResQNative 'wait for raw Firestore callout index states'
```

### 2.3 · פונקציות

```powershell
node tests/firebase-release-state.mjs functions station-102
Assert-ResQNative 'assert no active Cloud Functions rollout'
$resqFunctionsAttempted = $true
Invoke-ResQDeployWith429Backoff 'functions' 'deploy functions' 'functions'
```

מספר ה־Functions אינו מקובע במסמך: שער המצב הגולמי שלמעלה מונה את כולן
ודורש שכל אחת תהיה `ACTIVE` לפני הפריסה. סביבת הריצה הנתמכת היא Node 22.

הפקודה מריצה קודם את שער האפליקציה (`predeploy`). אם השער נכשל —
**הפריסה לא יוצאת לדרך.** זה תקין, ואין לעקוף אותו.

בפריסה הראשונה של שירות חדש גוגל מבקשת אישור להפעלת API. אשר.

### 2.4 · קידום Preview נעול ל-live

קוראים שוב את הערוץ ומוודאים שהוא עדיין מצביע ל-Version ID שנבדק.
ה-clone משתמש ב-Version ID הקפוא, לא בשם הערוץ המשתנה.

```powershell
$resqPreviewListRaw = (npx --yes firebase-tools@15.28.1 hosting:channel:list --site station-102 --project station-102 --json | Out-String)
Assert-ResQNative 're-read hosting preview before promotion'
$resqPreviewList = $resqPreviewListRaw | ConvertFrom-Json
$resqPreviewRows = @($resqPreviewList.result.channels | Where-Object { $_.name -eq ("projects/station-102/sites/station-102/channels/" + $resqPreviewChannel) })
if ($resqPreviewList.status -ne 'success' -or $resqPreviewRows.Count -ne 1 -or
    [string]$resqPreviewRows[0].release.version.name -ne $resqPreviewVersionName -or
    $resqPreviewRows[0].release.version.status -ne 'FINALIZED') {
  throw 'preview channel changed after verification'
}
$resqHostingAttempted = $true
$resqAttemptCounts.hosting_clone = [int]$resqAttemptCounts.hosting_clone + 1
$resqAttemptCounts | ConvertTo-Json | Set-Content -LiteralPath $resqAttemptLedgerPath -Encoding utf8
npx --yes firebase-tools@15.28.1 hosting:clone ("station-102@" + $resqPreviewVersionId) station-102:live --project station-102
Assert-ResQNative 'promote verified preview to live'
```

אין להריץ `deploy --only hosting` על live במסלול שחרור: הוא יוצר
ארטיפקט שני שלא נבדק. מיד אחרי הקידום מודדים שוב את ה-CDN החי:

```powershell
npm --prefix tests run live:headers
Assert-ResQNative 'live headers and version'
```

כשל כאן הוא כשל שחרור: עוצרים ומחזירים את Hosting לגרסה הקודמת.

---

## 3 · חזרה לאחור

כל פקודת Production מסומנת כ-`Attempted` **לפני** הפעלתה. גם פקודה
שחזרה עם קוד 1 עלולה הייתה לשנות חלק מהשירות. במקרה של כשל מפעילים
את כל שלבי החזרה הרלוונטיים בסדר ההפוך לפריסה; כשל בשלב אחד נאסף
אך אינו מונע ניסיון בשלב הבא:

```powershell
$resqRollbackFailures = [System.Collections.Generic.List[string]]::new()

if ($resqHostingAttempted) {
  try {
    npx --yes firebase-tools@15.28.1 hosting:clone ("station-102@" + $resqPrevHostingVersionId) station-102:live --project station-102
    Assert-ResQNative 'rollback Hosting'
  } catch { $resqRollbackFailures.Add('Hosting: ' + $_.Exception.Message) }
}

if ($resqFunctionsAttempted) {
  try {
    Set-Location -LiteralPath $resqRollbackDir
    npx --yes firebase-tools@15.28.1 deploy --only functions --project station-102
    Assert-ResQNative 'rollback Functions'
  } catch { $resqRollbackFailures.Add('Functions: ' + $_.Exception.Message) }
}

if ($resqRulesAttempted) {
  try {
    Set-Location -LiteralPath $resqRollbackDir
    npx --yes firebase-tools@15.28.1 deploy --only firestore:rules --project station-102
    Assert-ResQNative 'rollback Firestore rules'
  } catch { $resqRollbackFailures.Add('Firestore rules: ' + $_.Exception.Message) }
}

try {
  $resqAfterRollbackRaw = (npx --yes firebase-tools@15.28.1 hosting:channel:list --site station-102 --project station-102 --json | Out-String)
  Assert-ResQNative 'verify rollback Hosting channel'
  $resqAfterRollback = $resqAfterRollbackRaw | ConvertFrom-Json
  $resqRollbackLive = @($resqAfterRollback.result.channels | Where-Object { $_.name -eq 'projects/station-102/sites/station-102/channels/live' })
  if ($resqAfterRollback.status -ne 'success' -or $resqRollbackLive.Count -ne 1 -or
      $resqRollbackLive[0].release.version.name -ne $resqPrevHostingVersionName -or
      $resqRollbackLive[0].release.version.status -ne 'FINALIZED') {
    throw 'live channel does not point to the captured Hosting version'
  }
  $resqLiveRollbackVersion = Invoke-RestMethod -Method Get -Uri ('https://station-102.web.app/version.json?rollback_verify=' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -TimeoutSec 15 -Headers @{ 'Cache-Control' = 'no-cache' }
  if ($resqLiveRollbackVersion.v -ne $resqRollbackVersion.v -or $resqLiveRollbackVersion.d -ne $resqRollbackVersion.d) {
    throw 'live version.json does not match the rollback worktree'
  }
} catch { $resqRollbackFailures.Add('live rollback verification: ' + $_.Exception.Message) }

if ($resqRollbackFailures.Count -gt 0) {
  throw ('rollback incomplete: ' + ($resqRollbackFailures -join ' | '))
}
```

אינדקסים חדשים נשארים בזמן האירוע. אין לפרוס אוטומטית את
`firestore.indexes.json` הישן: בניית/מחיקת אינדקס היא אסינכרונית ועלולה
להשבית שאילתה נוספת. מחיקה דורשת דיף נפרד, הוכחת אי-שימוש ואישור חדש.

**מה שאין לו חזרה לאחור:** נתונים שנכתבו על ידי הגרסה החדשה. פונקציה
שכתבה מבנה חדש למסמכים לא תתבטל בכך שתחזיר את הקוד. זו הסיבה שכל
שינוי סכימה נבדק באמולטור לפני, ולא אחרי.

---

## 3.1 · סנכרון אפליקציית GitHub Pages

האפליקציה המותקנת אצל חלק מהמשתמשים נטענת גם מן הענף הציבורי
`codex/pages-public-42h7`. לכן שחרור Hosting אינו שלם עד ששני המארחים
מציגים את אותו manifest ציבורי. מכינים worktree מבודד של הענף הציבורי,
מעתיקים אליו **רק** את קובצי `.firebase/hosting..cache` ואת הקובץ הריק
`.nojekyll`, ואז מריצים לפני commit או push:

```powershell
npm --prefix tests run pages:artifact -- "$resqDeployDir" "$resqPagesDir"
```

השער נכשל על קובץ חסר, עודף או שונה, על קובץ פרטי, ועל קישור או
`.nojekyll` שאינו קובץ ריק. רק אחרי PASS, ואחרי אישור ייצור שמציין במפורש
גם את פעולת ה-push ואת ה-SHA הציבורי, דוחפים fast-forward בלבד:

```powershell
git -C "$resqPagesDir" push origin HEAD:refs/heads/codex/pages-public-42h7
```

אחרי ש-Firebase Hosting וגם GitHub Pages פורסמו, מריצים בדיקת HTTP חיה:

```powershell
npm --prefix tests run pages:live -- "$resqDeployDir"
```

Firebase חייב להתאים מיד. GitHub Pages מקבל חלון התכנסות מוגבל של עשר
דקות ונבדק מחדש כל 30 שניות; אחרי החלון אי-התאמה היא כשל שחרור. החזרה
לאחור של Pages נעשית ב-commit חדש שמחזיר את עץ הנכסים הציבורי הקודם
וב-push fast-forward; אין force-push ואין חיבור היסטוריית `main` לענף
הציבורי.

---

## 4 · האישור החד-פעמי לייצור

**פריסה אינה מתבצעת על סמך „הבדיקות ירוקות".** לפני כל פריסה נדרש
אישור אנושי מפורש וחד-פעמי של אלדד שכולל, בכתב, את חמשת אלה:

1. **הפעולה והפקודות המדויקות** — מיזוג ל-`main`, שלוש פקודות הפריסה ובדיקת ה-live.
2. **יעד ושירותים** — `station-102`; כללים, אינדקסים, Functions ו-Hosting.
3. **ה-commit או ה-diff המדויק** — SHA מלא, SHA עץ וסיכום קבצים ששונו.
4. **אימות וסיכונים** — תוצאות כל השערים, מה לא רץ ומה עלול להישבר ולמי.
5. **תוכנית חזרה לאחור** — SHA קודם והפעולה המדויקת לכל שירות.

האישור מצטט גם את `$resqRollbackSha`, `$resqRollbackTree`,
`$resqPrevHostingReleaseName`, `$resqPrevHostingVersionName`, גרסת
`version.json` הצפויה אחרי החזרה וסדר החזרה מפריסה חלקית. קובץ ה-ledger
נשמר מחוץ לעץ ה-Hosting ומצורף לדוח השחרור.

האישור חייב לנקוב במפורש גם במיזוג ל-`main` וגם בפריסה אם מבקשים את
שניהם. אישור לפריסה אחת אינו אישור לפריסה הבאה, ושינוי SHA או תוצאה
אחרי האישור מבטל אותו.

---

## 5 · המלכודת שחוזרת · הטוקן

אחרי כל שינוי תפקיד, ואחרי אימות מייל, **הטוקן הישן עדיין נושא את
הערכים הקודמים**. גוגל מרעננת אותו לבד רק אחרי כשעה.

לכן, בכל מקום שבו ההרשאות משתנות:

```javascript
await user.getIdToken(true);
```

בלי זה הכל נראה תקין בצד אחד, וכללי האבטחה דוחים בצד השני.

---

## 6 · מה שהמסמך הזה אינו מכסה

- **הגדרת מנהל-על.** פעולה חד-פעמית שכבר בוצעה בתחנה הזאת.
- **מעבר ל-Blaze.** בוצע.
- **בליטת גרסה** (`version.json`, `version.js`, מטמון ה-Service Worker
  ומחרוזות ה-`?v=`) חייבת להיות בקומיט המועמד לפני הרצת השערים ולפני
  האישור. אין לפרוס שרת חדש עם מזהי מטמון של הגרסה הקודמת.
- **תחנה שנייה בייצור.** חסום עד 42A–42C.
