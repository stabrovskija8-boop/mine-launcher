@echo off
setlocal
cd /d "%~dp0"

rem Запуск MINE Launcher.
rem Параметр --console оставляет окно консоли открытым (для диагностики).

set "ELECTRON=node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" goto install
goto run

:install
echo.
echo Не найдены файлы Electron. Устанавливаю зависимости...
echo Для установки нужен Node.js: https://nodejs.org
echo.
call npm install
if errorlevel 1 goto fail

:run
if /i "%~1"=="--console" goto run_console
start "" "%ELECTRON%" .
goto :eof

:run_console
"%ELECTRON%" .
echo.
echo Лаунчер закрыт.
pause
goto :eof

:fail
echo.
echo Не удалось установить зависимости.
pause
exit /b 1
