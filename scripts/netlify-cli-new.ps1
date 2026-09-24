param([Parameter(ValueFromRemainingArguments=$true)][string[]]$CliArgs)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$savedAppData = $env:APPDATA
try {
  # The new Netlify account's CLI login lives here, separate from the old account in .netlify-local.
  $env:APPDATA = Join-Path $projectRoot '.netlify-local-new'
  New-Item -ItemType Directory -Force -Path $env:APPDATA | Out-Null
  Push-Location $projectRoot
  & npx.cmd -y netlify-cli@latest @CliArgs
  exit $LASTEXITCODE
} finally {
  Pop-Location
  $env:APPDATA = $savedAppData
}
