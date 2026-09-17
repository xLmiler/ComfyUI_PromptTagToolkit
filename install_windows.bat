@echo off
setlocal
cd /d "%~dp0"

set "PY=..\..\..\python_embeded\python.exe"
if exist "%PY%" goto portable

where python >nul 2>nul
if errorlevel 1 (
  echo [Prompt Tag Toolkit] Python not found.
  echo Install manually with the Python environment used by ComfyUI:
  echo   python -m pip install -r "%~dp0requirements.txt"
  pause
  exit /b 1
)
set "PY=python"

:portable
echo [Prompt Tag Toolkit] Installing Python dependency...
"%PY%" -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 (
  echo Installation failed.
  pause
  exit /b 1
)
echo.
echo Done. Restart ComfyUI and hard refresh the browser with Ctrl+F5.
pause
