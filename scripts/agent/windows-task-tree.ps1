param(
  [Parameter(Mandatory = $true)]
  [string]$Payload
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

try {
  $bytes = [Convert]::FromBase64String($Payload)
  if ($bytes.Length -lt 1 -or $bytes.Length -gt 65536) {
    exit 1
  }
  $request = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  $properties = @($request.PSObject.Properties.Name | Sort-Object)
  if (($properties -join ",") -cne "argumentLine,command,schemaVersion,workingDirectory") {
    exit 1
  }
  if ($request.schemaVersion -ne 1) {
    exit 1
  }
  if (
    [String]::IsNullOrWhiteSpace($request.command) -or
    [String]::IsNullOrWhiteSpace($request.workingDirectory) -or
    $request.argumentLine -isnot [string]
  ) {
    exit 1
  }
  if (
    -not (Test-Path -LiteralPath $request.command -PathType Leaf) -or
    -not (Test-Path -LiteralPath $request.workingDirectory -PathType Container)
  ) {
    exit 1
  }
  $process = Start-Process `
    -FilePath $request.command `
    -ArgumentList $request.argumentLine `
    -WorkingDirectory $request.workingDirectory `
    -NoNewWindow `
    -PassThru `
    -Wait
  exit $process.ExitCode
} catch {
  exit 1
}
