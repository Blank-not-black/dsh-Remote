@echo off
rem ============================================================
rem  DSH Remote - HarmonyOS USB reverse tunnel (for on-device debugging)
rem
rem  Maps the phone's 127.0.0.1:8787 to this PC's 127.0.0.1:8787.
rem  Use when campus / public WiFi isolates clients (phone cannot
rem  reach the PC LAN IP) or when you do not want to expose the
rem  gateway to the internet via frp.
rem
rem  Usage:
rem    1. Connect the phone over USB, check: hdc list targets
rem    2. Run this script
rem    3. In the app: Settings > Server management > Add server
rem         address: 127.0.0.1:8787
rem         token:   copy from %USERPROFILE%\.dsh-remote\token
rem
rem  Note: the tunnel dies when USB is unplugged or the hdc server
rem        restarts. Just run this script again.
rem  hdc is resolved from PATH, or from the HDC environment variable,
rem  e.g.:  set "HDC=<DevEco Studio>\sdk\default\openharmony\toolchains\hdc.exe"
rem ============================================================

set "HDC="
for /f "delims=" %%i in ('where hdc.exe 2^>nul') do if not defined HDC set "HDC=%%i"

if "%HDC%"=="" (
  echo [ERROR] hdc not found in PATH.
  echo         Install DevEco Studio or set the HDC variable to hdc.exe full path.
  exit /b 1
)

echo [1/3] Checking device...
"%HDC%" list targets
if errorlevel 1 goto fail

echo.
echo [2/3] Creating reverse tunnel: phone 127.0.0.1:8787 -^> PC 127.0.0.1:8787
"%HDC%" rport tcp:8787 tcp:8787

echo.
echo [3/3] Current port forwards:
"%HDC%" fport ls

echo.
echo Done. Set the app server address to http://127.0.0.1:8787
exit /b 0

:fail
echo [ERROR] No device detected. Enable developer mode + USB debugging.
exit /b 1
