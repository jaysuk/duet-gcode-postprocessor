@echo off
REM Build the installable plugin ZIP against a local DuetWebControl checkout.
REM Edit DWC_DIR if your checkout lives elsewhere.
set DWC_DIR=C:\Users\live\Documents\Github\DuetWebControl
pushd %DWC_DIR%
node scripts/build-plugin.js "%~dp0."
popd
