param(
  [Parameter(Mandatory = $true)]
  [string]$SetupPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$processTimeoutMilliseconds = 180000
$terminationGraceMilliseconds = 15000

function Assert-PhysicalPathChain {
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.FileSystemInfo]$Item,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )
  $current = $Item
  while ($null -ne $current) {
    if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "$Label path must not traverse a reparse point."
    }
    if ($current -is [System.IO.FileInfo]) {
      $current = $current.Directory
    } elseif ($current -is [System.IO.DirectoryInfo]) {
      $current = $current.Parent
    } else {
      throw "$Label path contains an unknown filesystem entry."
    }
  }
}

function Get-PhysicalFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )
  $item = Get-Item -LiteralPath $LiteralPath -Force
  if (
    $item.PSIsContainer -or
    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  ) {
    throw "$Label must be a physical file."
  }
  Assert-PhysicalPathChain -Item $item -Label $Label
  return $item
}

function Get-PhysicalDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )
  $item = Get-Item -LiteralPath $LiteralPath -Force
  if (
    -not $item.PSIsContainer -or
    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  ) {
    throw "$Label must be a physical directory."
  }
  Assert-PhysicalPathChain -Item $item -Label $Label
  return $item
}

function Invoke-BoundedProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList,
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [Parameter(Mandatory = $true)]
    [int]$TimeoutMilliseconds,
    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory
  )
  $process = $null
  try {
    $process = Start-Process `
      -FilePath $FilePath `
      -ArgumentList $ArgumentList `
      -WorkingDirectory $WorkingDirectory `
      -PassThru
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
      try {
        if (-not $process.HasExited) {
          $process.Kill($true)
        }
      } catch {
        # The bounded grace below remains authoritative if tree kill races exit.
      }
      if (-not $process.WaitForExit($terminationGraceMilliseconds)) {
        throw "$Label exceeded its time bound and process-tree cleanup failed."
      }
      throw "$Label exceeded its time bound."
    }
    return $process.ExitCode
  } finally {
    if ($null -ne $process) {
      $process.Dispose()
    }
  }
}

$nodeCommand = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$nodeExecutable = (
  Get-PhysicalFile -LiteralPath $nodeCommand -Label "Node.js executable"
).FullName
$installedVerifier = (
  Get-PhysicalFile `
    -LiteralPath (Join-Path $PSScriptRoot "verify-installed-companion.mjs") `
    -Label "Installed companion verifier"
).FullName
$executableSmoke = (
  Get-PhysicalFile `
    -LiteralPath (Join-Path $PSScriptRoot "smoke-companion-executable.mjs") `
    -Label "Packaged executable smoke verifier"
).FullName

$setupItem = Get-PhysicalFile -LiteralPath $SetupPath -Label "SetupPath"
$setup = $setupItem.FullName
$makerDirectory = Get-PhysicalDirectory `
  -LiteralPath $setupItem.Directory.FullName `
  -Label "Squirrel maker directory"
$fullPackages = @(
  Get-ChildItem -LiteralPath $makerDirectory.FullName -File -Force |
    Where-Object { $_.Name -like "*-full.nupkg" }
)
if ($fullPackages.Count -ne 1) {
  throw "The Squirrel maker directory must contain exactly one full package."
}
$fullPackage = Get-PhysicalFile `
  -LiteralPath $fullPackages[0].FullName `
  -Label "Full Squirrel package"
$releasesFiles = @(
  Get-ChildItem -LiteralPath $makerDirectory.FullName -File -Force |
    Where-Object { $_.Name -eq "RELEASES" }
)
if ($releasesFiles.Count -ne 1) {
  throw "The Squirrel maker directory must contain exactly one RELEASES file."
}
$releases = Get-PhysicalFile `
  -LiteralPath $releasesFiles[0].FullName `
  -Label "Squirrel RELEASES"

$bindingArguments = @(
  "--snapshot-maker",
  "--setup", $setup,
  "--full-package", $fullPackage.FullName,
  "--releases", $releases.FullName
)
$makerBindingBefore = [string](& $nodeExecutable $installedVerifier @bindingArguments)
if ($LASTEXITCODE -ne 0 -or [String]::IsNullOrWhiteSpace($makerBindingBefore)) {
  throw "The Squirrel maker artifacts could not be bound before installation."
}
$makerBindingBefore = $makerBindingBefore.Trim()

$localAppData = Get-PhysicalDirectory `
  -LiteralPath $env:LOCALAPPDATA `
  -Label "LOCALAPPDATA"
$installRoot = Join-Path $localAppData.FullName "TokenMonster"

if (Test-Path -LiteralPath $installRoot) {
  throw "The Squirrel smoke requires a clean ephemeral Windows profile."
}

$primaryFailure = $null
try {
  $setupExitCode = Invoke-BoundedProcess `
    -FilePath $setup `
    -ArgumentList @("--silent") `
    -Label "TokenMonsterSetup.exe" `
    -TimeoutMilliseconds $processTimeoutMilliseconds `
    -WorkingDirectory $makerDirectory.FullName
  if ($setupExitCode -ne 0) {
    throw "TokenMonsterSetup.exe failed during silent installation."
  }

  $installedRoot = Get-PhysicalDirectory `
    -LiteralPath $installRoot `
    -Label "Squirrel install root"
  $appDirectories = @(
    Get-ChildItem -LiteralPath $installedRoot.FullName -Directory |
      Where-Object { $_.Name -like "app-*" }
  )
  if ($appDirectories.Count -ne 1) {
    throw "Squirrel did not create exactly one installed application directory."
  }
  $installedApplication = Get-PhysicalDirectory `
    -LiteralPath $appDirectories[0].FullName `
    -Label "Installed Squirrel application"
  $installedApplicationExecutable = Get-PhysicalFile `
    -LiteralPath (Join-Path $installedApplication.FullName "TokenMonster.exe") `
    -Label "Installed Squirrel application executable"
  $installedEntryPoint = Get-PhysicalFile `
    -LiteralPath (Join-Path $installedRoot.FullName "TokenMonster.exe") `
    -Label "Installed Squirrel execution stub"

  & $nodeExecutable $installedVerifier `
    --full-package $fullPackage.FullName `
    --installed-directory $installedApplication.FullName `
    --install-root $installedRoot.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "The installed Squirrel payload differs from the verified package."
  }

  & $nodeExecutable $executableSmoke $installedEntryPoint.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "The installed Squirrel application failed its startup smoke."
  }
} catch {
  $primaryFailure = $_
} finally {
  $updateExecutable = Join-Path $installRoot "Update.exe"
  if (Test-Path -LiteralPath $updateExecutable -PathType Leaf) {
    try {
      $physicalUpdateExecutable = Get-PhysicalFile `
        -LiteralPath $updateExecutable `
        -Label "Squirrel Update.exe"
      $uninstallExitCode = Invoke-BoundedProcess `
        -FilePath $physicalUpdateExecutable.FullName `
        -ArgumentList @("--uninstall", "--silent") `
        -Label "Squirrel silent uninstall" `
        -TimeoutMilliseconds $processTimeoutMilliseconds `
        -WorkingDirectory $localAppData.FullName
      if ($uninstallExitCode -ne 0) {
        throw "Squirrel silent uninstall returned a failure status."
      }
      for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
        $remainingApplications = @(
          Get-ChildItem -LiteralPath $installRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "app-*" }
        )
        $remainingEntryPoint = Test-Path `
          -LiteralPath (Join-Path $installRoot "TokenMonster.exe") `
          -PathType Leaf
        if ($remainingApplications.Count -eq 0 -and -not $remainingEntryPoint) {
          break
        }
        Start-Sleep -Seconds 1
      }
      $remainingApplications = @(
        Get-ChildItem -LiteralPath $installRoot -Directory -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -like "app-*" }
      )
      $remainingEntryPoint = Test-Path `
        -LiteralPath (Join-Path $installRoot "TokenMonster.exe") `
        -PathType Leaf
      if ($remainingApplications.Count -ne 0 -or $remainingEntryPoint) {
        throw "Squirrel uninstall left an installed application entry point."
      }
    } catch {
      if ($null -eq $primaryFailure) {
        $primaryFailure = $_
      }
    }
  } elseif ($null -eq $primaryFailure) {
    $primaryFailure = [System.Management.Automation.RuntimeException]::new(
      "Squirrel installation did not provide Update.exe for uninstall."
    )
  }
  try {
    $makerBindingAfter = [string](
      & $nodeExecutable $installedVerifier @bindingArguments
    )
    if (
      $LASTEXITCODE -ne 0 -or
      [String]::IsNullOrWhiteSpace($makerBindingAfter) -or
      -not [String]::Equals(
        $makerBindingBefore,
        $makerBindingAfter.Trim(),
        [StringComparison]::Ordinal
      )
    ) {
      throw "Squirrel maker artifacts changed during install or smoke."
    }
  } catch {
    if ($null -eq $primaryFailure) {
      $primaryFailure = $_
    }
  }
}

if ($null -ne $primaryFailure) {
  throw $primaryFailure
}

Write-Output "Verified clean Squirrel install, packaged startup, and uninstall."
