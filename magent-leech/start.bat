@echo off
title Seedr - Quick & Easy (4GB Free Cloud Engine)
cd /d "%~dp0"

echo ========================================================
echo   Seedr - 4GB Free Cloud Magnet to Direct Link Engine
echo ========================================================
echo.
echo Cleaning any old instances...
taskkill /F /IM aria2c.exe >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1

timeout /t 1 /nobreak >nul

echo Starting Server on http://localhost:3000 ...
start "" "http://localhost:3000"
"%~dp0bin\node.exe" server.js
pause
