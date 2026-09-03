@echo off
setlocal

rem  RESULT is set to failure HERE, before anything else.
rem
rem  This script used to exit 0 even when it failed. Two reasons,
rem  both silent:
rem
rem    1. RESULT was never initialised. An early exit (no Java, npm
rem       install failed) jumped to :done without ever touching it.
rem    2. The script ended on "pause". A batch file's exit code is the
rem       exit code of its last command, and pause returns 0. So a
rem       REAL rules failure also exited 0.
rem
rem  A CI gate calling this file would have seen success on total
rem  failure. Hence: RESULT=1 by default, and "exit /b %RESULT%" at
rem  the very end - after pause.
set RESULT=1

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
echo Nothing touches the live project. Every scenario runs
echo against the emulator under the id demo-resq.
echo.
echo NOTE: the first run DOES download the emulator from Google
echo ^(about 137 MB^). That is the one thing here that uses the
echo network.
echo.
pause

echo.
echo [1/3] Checking Java...
rem  "where" only looks at PATH. Running java -version here used to
rem  print a stray path error on some machines, which looked like a
rem  failure even though everything worked.
rem
rem  Redirect to nul, not to /dev/null. The old form is Unix; cmd
rem  reads it as the file path \dev\null, and when that folder does
rem  not exist the redirection itself fails and raises errorlevel -
rem  so the check could report "no Java" on a machine that has Java.
where java >nul 2>nul
if errorlevel 1 (
  echo       [X] Java not found.
  echo           Install JDK 21 from https://adoptium.net
  echo           then open a NEW window and run this again.
  goto done
)
set JAVA_VERSION=
for /f "tokens=3" %%V in ('java -version 2^>^&1 ^| findstr /i "version"') do set JAVA_VERSION=%%~V
set JAVA_MAJOR=
for /f "tokens=1 delims=." %%M in ("%JAVA_VERSION%") do set JAVA_MAJOR=%%M
if not "%JAVA_MAJOR%"=="21" (
  echo       [X] JDK 21 required; found %JAVA_VERSION%.
  echo           Install JDK 21 from https://adoptium.net
  goto done
)
echo       JDK %JAVA_VERSION% found.

echo.
echo [2/3] Test dependencies...
cd rules-test
echo       Installing the exact lockfile state.
call npm ci --no-audit --no-fund
if errorlevel 1 (
  echo       [X] npm ci failed. Send the error to Claude.
  cd ..
  goto done
)
cd ..

echo.
echo [3/3] Starting Firestore and running the tests...
echo.
rem  demo-resq guarantees that an emulator-only test cannot accidentally
rem  address the production Firebase project. The id station-102 must
rem  never appear on this line.
call npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd rules-test && npm test"
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

rem  After pause, deliberately. pause returns 0, and without this
rem  line it would BE the exit code of the whole script.
exit /b %RESULT%
