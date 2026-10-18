@echo off
setlocal
cd /d "%~dp0"
if exist "review-desk\app.py" cd "review-desk"
if not exist "app.py" goto missing_app

where py >nul 2>nul
if errorlevel 1 goto try_python
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if errorlevel 1 goto try_python
echo Starting Uptight Review Desk on this computer. Keep this window open while reviewing.
py -3 app.py %*
set "review_desk_status=%errorlevel%"
goto finished

:try_python
where python >nul 2>nul
if errorlevel 1 goto missing_python
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if errorlevel 1 goto missing_python
echo Starting Uptight Review Desk on this computer. Keep this window open while reviewing.
python app.py %*
set "review_desk_status=%errorlevel%"
goto finished

:missing_app
echo The review app is missing. Extract the complete ZIP before starting it.
pause
exit /b 1

:missing_python
echo This app needs Python 3.10 or newer. Install it from https://www.python.org/downloads/ and open this launcher again.
pause
exit /b 1

:finished
if not "%review_desk_status%"=="0" pause
exit /b %review_desk_status%
