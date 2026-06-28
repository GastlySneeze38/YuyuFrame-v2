@echo off
setlocal
cd /d "%~dp0"

echo.
echo  ========================================
echo    content-core  -  Build + Deploy DLL
echo  ========================================
echo.

cargo build --release --lib
if errorlevel 1 (
    echo.
    echo  [ERREUR] Compilation Rust echouee.
    echo.
    pause
    exit /b 1
)

set "DLL=target\release\content_core.dll"
set "AGENT_DIR=%APPDATA%\YuyuFrame\agent"

if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%"
copy /Y "%DLL%" "%AGENT_DIR%\content_core.dll" >nul

echo.
echo  ========================================
echo    content_core.dll deploye dans :
echo    %AGENT_DIR%
echo  ========================================
echo.
pause
exit /b 0
