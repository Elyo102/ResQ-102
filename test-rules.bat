@echo off
setlocal
cd /d "%~dp0"

cls
echo ==========================================================
echo   Security rules test
echo ==========================================================
echo.
echo This starts a real Firestore on this computer, compiles
echo the 1081 security rules, and runs 51 scenarios against
echo them - a firefighter reading someone else hours, a
echo firefighter promoting himself, an outsider reading the
echo station directory.
echo.
echo Nothing touches the live system. Nothing goes online.
echo.
echo Needs Java. If it is missing, get JDK 21 from adoptium.net
echo.
pause

echo.
echo [1/3] Checking Java...
java -version >/dev/null 2>&1
if errorlevel 1 (
  echo.
  echo [X] Java not found.
  echo     Install JDK 21 from https://adoptium.net
  echo     then open a NEW window and run this again.
  goto done
)
echo       ok.

echo.
echo [2/3] Test dependencies...
cd rules-test
if not exist node_modules (
  echo       First time - this takes a minute.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [X] npm install failed. Send the error to Claude.
    cd ..
    goto done
  )
) else (
  echo       Already installed.
)
cd ..
echo       ok.

echo.
echo [3/3] Starting Firestore and running the tests...
echo       First run downloads the emulator. Be patient.
echo.
call firebase emulators:exec --only firestore --project station-102 "cd rules-test && npm test"
set RESULT=%errorlevel%

echo.
if "%RESULT%"=="0" (
  echo ==========================================================
  echo   ALL RULES PASSED.
  echo ==========================================================
) else (
  echo ==========================================================
  echo   SOMETHING FAILED - scroll up and read the red lines.
  echo   A line starting with the open-lock icon is a real hole.
  echo ==========================================================
)

:done
echo.
echo ----------------------------------------------------------
echo Go to Claude and paste everything above.
echo ----------------------------------------------------------
pause
