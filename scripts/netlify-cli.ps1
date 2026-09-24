param([Parameter(ValueFromRemainingArguments=$true)][string[]]$CliArgs)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$savedAppData = $env:APPDATA
try {
  # Isolate CLI credentials from the Windows encrypted roaming directory.
  $env:APPDATA = Join-Path $projectRoot '.netlify-local'
  Push-Location $projectRoot
  & npx.cmd -y netlify-cli@latest @CliArgs
  exit $LASTEXITCODE
} finally {
  Pop-Location
  $env:APPDATA = $savedAppData
}
