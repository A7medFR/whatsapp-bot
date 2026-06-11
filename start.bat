@echo off
title Clinic WhatsApp Bot
color 0A

echo.
echo  ==========================================
echo    Clinic WhatsApp Offer Bot - Starting
echo  ==========================================
echo.

:: Check if node is in PATH using where
where node >nul 2>nul
if %errorlevel% neq 0 (
    :: Try common Node.js install paths manually
    if exist "C:\Program Files\nodejs\node.exe" (
        set "PATH=%PATH%;C:\Program Files\nodejs"
    ) else if exist "C:\Program Files (x86)\nodejs\node.exe" (
        set "PATH=%PATH%;C:\Program Files (x86)\nodejs"
    ) else (
        color 0C
        echo ===================================================
        echo  [ERROR] Node.js is not installed on this computer!
        echo ===================================================
        echo  Please download and install Node.js (LTS version) from:
        echo  https://nodejs.org/
        echo.
        echo  Once installed, close this window and open start.bat again.
        echo ===================================================
        pause
        exit /b 1
    )
)

echo  Node.js version:
node --version
echo.

:: Install dependencies on first run
if not exist "node_modules" (
    echo  [1/2] Installing packages (first time only - please wait ~1 min)...
    echo.
    npm install
    if %errorlevel% neq 0 (
        color 0C
        echo.
        echo  [ERROR] npm install failed.
        echo  Try opening "Node.js command prompt" from the Start Menu and running:
        echo     cd /d "c:\Users\HP\.gemini\antigravity-ide\scratch\whatsapp-bot"
        echo     npm install
        echo.
        pause
        exit /b 1
    )
    echo.
)

echo  [2/2] Starting bot on http://localhost:8005
echo.
echo  ==========================================
echo   Keep this window open while using the app
echo   Press Ctrl+C to stop the bot
echo  ==========================================
echo.

node src/server.js

if %errorlevel% neq 0 (
    color 0C
    echo.
    echo  [ERROR] Bot stopped. See error above.
    echo.
)

pause
