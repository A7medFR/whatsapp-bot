@echo off
title Clinic WhatsApp Bot
color 0A

echo.
echo  ==========================================
echo    Clinic WhatsApp Offer Bot - Starting
echo  ==========================================
echo.

:: Try to run node directly (skip "where" check which can fail on some setups)
node --version >nul 2>nul
if %errorlevel% neq 0 (
    :: Try common Node.js install paths manually
    set "NODE_PATH=C:\Program Files\nodejs\node.exe"
    if exist "%NODE_PATH%" (
        set "PATH=%PATH%;C:\Program Files\nodejs"
    ) else (
        set "NODE_PATH=C:\Program Files (x86)\nodejs\node.exe"
        if exist "%NODE_PATH%" (
            set "PATH=%PATH%;C:\Program Files (x86)\nodejs"
        ) else (
            color 0C
            echo  [ERROR] Cannot find Node.js.
            echo  Please open "Node.js command prompt" from the Start Menu
            echo  and run this command instead:
            echo.
            echo     cd /d "c:\Users\CS\Downloads\whatsapp-price-bot"
            echo     npm install
            echo     node src/server.js
            echo.
            pause
            exit /b 1
        )
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
        echo     cd /d "c:\Users\CS\Downloads\whatsapp-price-bot"
        echo     npm install
        echo.
        pause
        exit /b 1
    )
    echo.
)

echo  [2/2] Starting bot on http://localhost:3001
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
