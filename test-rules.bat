@echo off
setlocal
cd /d "%~dp0"

cls
echo ==========================================================
echo   Security rules test
echo ==========================================================
echo.
echo Starts a real Firestore on this computer, compiles the
echo security rules, and runs every scenario against them:
echo a firefighter reading someone else hours, a firefighter
echo promoting himself, an outsider reading the directory.
echo.
echo Nothing touches the live system. Nothing goes online.
echo.
pause

echo.
echo [1/3] Checking Java...
rem  "where" only looks at PATH. Running java -version here used to
rem  print a stray path error on some machines, which looked like a
rem  failure even though everything worked.
where java >/dev/null 2>nul
if errorlevel 1 (
  echo       [X] Java not found.
  echo           Install JDK 21 from https://adoptium.net
  echo           then open a NEW window and run this again.
  goto done
)
echo       found.

echo.
echo [2/3] Test dependencies...
cd rules-test
if not exist node_modules (
  echo       First time - about a minute.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo       [X] npm install failed. Send the error to Claude.
    cd ..
    goto done
  )
) else (
  echo       already installed.
)
cd ..

echo.
echo [3/3] Starting Firestore and running the tests...
echo       First run downloads the emulator ^(137 MB^). Be patient.
echo.
rem  demo-resq ולא station-102.
rem
rem  Firebase חוסם כל מזהה פרויקט שמתחיל ב-demo- מלהתחבר
rem  לשירותים אמיתיים. זו רשת ביטחון, לא מוסכמת שמות: אם
rem  האמולטור לא עלה, או שלקוח כלשהו לא הופנה אליו, מזהה
rem  ייצור פירושו שפנייה אמיתית לא תיעצר בשום מקום.
rem
rem  .github/workflows/tests.yml משתמש ב-demo-resq בכל ששת
rem  שלבי האמולטור. הסקריפט הזה היה היחיד שלא.
call firebase emulators:exec --only firestore --project demo-resq "cd rules-test && npm test"
set RESULT=%errorlevel%

echo.
if "%RESULT%"=="0" (
  echo ==========================================================
  echo   ALL RULES PASSED.
  echo ==========================================================
) else (
  echo ==========================================================
  echo   SOMETHING FAILED - scroll up and read the red lines.
  echo   A line with the open-lock icon is a real hole.
  echo ==========================================================
)

:done
echo.
echo ----------------------------------------------------------
echo Go to Claude and paste everything above.
echo ----------------------------------------------------------
pause
