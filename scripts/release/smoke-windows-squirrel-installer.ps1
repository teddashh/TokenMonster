param(
  [Parameter(Mandatory = $true)]
  [string]$SetupPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$processTimeoutMilliseconds = 180000
$terminationGraceMilliseconds = 15000
$hookObservationTimeoutSeconds = 15
$uninstallRegistryPath =
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\TokenMonster"
$squirrelLogCulture = [Globalization.CultureInfo]::CurrentCulture
if (
  $squirrelLogCulture.Name -cne "en-US" -or
  $squirrelLogCulture.DateTimeFormat.DateSeparator -cne "/" -or
  $squirrelLogCulture.DateTimeFormat.TimeSeparator -cne ":" -or
  $squirrelLogCulture.TextInfo.ToLower("Info") -cne "info" -or
  $squirrelLogCulture.DateTimeFormat.Calendar -isnot [Globalization.GregorianCalendar]
) {
  throw "The Squirrel smoke requires the exact en-US log-format culture."
}

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

function Get-TokenMonsterProcessCount {
  $processes = @(Get-Process -Name "TokenMonster" -ErrorAction SilentlyContinue)
  try {
    return $processes.Count
  } finally {
    foreach ($process in $processes) {
      $process.Dispose()
    }
  }
}

function Get-ExactPathProcessCount {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath
  )
  $matchingProcessCount = 0
  $processes = @(Get-Process -Name "TokenMonster" -ErrorAction SilentlyContinue)
  try {
    foreach ($process in $processes) {
      try {
        if (
          [String]::Equals(
            $process.Path,
            $ExecutablePath,
            [StringComparison]::OrdinalIgnoreCase
          )
        ) {
          $matchingProcessCount += 1
        }
      } catch {
        # An inaccessible process cannot establish an exact executable match.
      }
    }
  } finally {
    foreach ($process in $processes) {
      $process.Dispose()
    }
  }
  return $matchingProcessCount
}

function Test-PathInsideDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CandidatePath,
    [Parameter(Mandatory = $true)]
    [string]$DirectoryPath
  )
  $directorySeparators = [char[]]@(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $normalizedDirectory =
    [IO.Path]::GetFullPath($DirectoryPath).TrimEnd($directorySeparators)
  $directoryPrefix =
    $normalizedDirectory + [IO.Path]::DirectorySeparatorChar
  $normalizedCandidate = [IO.Path]::GetFullPath($CandidatePath)
  return $normalizedCandidate.StartsWith(
    $directoryPrefix,
    [StringComparison]::OrdinalIgnoreCase
  )
}

function Get-InstallTreeProcessCount {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot
  )
  $matchingProcessCount = 0
  $processes = @(Get-Process -ErrorAction SilentlyContinue)
  try {
    foreach ($process in $processes) {
      try {
        $processPath = $process.Path
        if (
          -not [String]::IsNullOrWhiteSpace($processPath) -and
          (Test-PathInsideDirectory `
            -CandidatePath $processPath `
            -DirectoryPath $InstallRoot)
        ) {
          $matchingProcessCount += 1
        }
      } catch {
        # Inaccessible process metadata cannot establish an install-tree match.
      }
    }
  } finally {
    foreach ($process in $processes) {
      $process.Dispose()
    }
  }
  return $matchingProcessCount
}

function Get-ResidualApplicationSnapshot {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot
  )
  $applicationDirectories = @(
    Get-ChildItem `
      -LiteralPath $InstallRoot `
      -Directory `
      -Force `
      -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "app-*" }
  )
  $directoryCount = 0
  $fileCount = 0
  $exclusiveOpenAvailableCount = 0
  $exclusiveOpenUnavailableCount = 0
  $sharingOrLockViolationCount = 0
  $otherOpenFailureCount = 0
  $pendingDirectories =
    [Collections.Generic.Queue[System.IO.DirectoryInfo]]::new()

  foreach ($applicationDirectory in $applicationDirectories) {
    $physicalApplicationDirectory = Get-PhysicalDirectory `
      -LiteralPath $applicationDirectory.FullName `
      -Label "Residual Squirrel application directory"
    $pendingDirectories.Enqueue($physicalApplicationDirectory)
  }

  while ($pendingDirectories.Count -ne 0) {
    $currentDirectory = $pendingDirectories.Dequeue()
    $directoryCount += 1
    $entries = @($currentDirectory.EnumerateFileSystemInfos())
    foreach ($entry in $entries) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "A residual Squirrel application path is a reparse point."
      }
      if ($entry -is [System.IO.DirectoryInfo]) {
        $pendingDirectories.Enqueue($entry)
        continue
      }
      if ($entry -isnot [System.IO.FileInfo]) {
        throw "A residual Squirrel application entry has an unknown type."
      }

      $fileCount += 1
      $exclusiveStream = $null
      try {
        $exclusiveStream = [IO.File]::Open(
          $entry.FullName,
          [IO.FileMode]::Open,
          [IO.FileAccess]::Read,
          [IO.FileShare]::None
        )
        $exclusiveOpenAvailableCount += 1
      } catch {
        $exclusiveOpenUnavailableCount += 1
        $openException = $_.Exception
        while ($null -ne $openException.InnerException) {
          $openException = $openException.InnerException
        }
        $win32ErrorCode = $openException.HResult -band 0xffff
        if ($win32ErrorCode -eq 32 -or $win32ErrorCode -eq 33) {
          $sharingOrLockViolationCount += 1
        } else {
          $otherOpenFailureCount += 1
        }
      } finally {
        if ($null -ne $exclusiveStream) {
          $exclusiveStream.Dispose()
        }
      }
    }
  }

  return [PSCustomObject]@{
    AppDirectoryCount = $applicationDirectories.Count
    DirectoryCount = $directoryCount
    FileCount = $fileCount
    ExclusiveOpenAvailableCount = $exclusiveOpenAvailableCount
    ExclusiveOpenUnavailableCount = $exclusiveOpenUnavailableCount
    SharingOrLockViolationCount = $sharingOrLockViolationCount
    OtherOpenFailureCount = $otherOpenFailureCount
  }
}

function Get-FixedRoleExclusiveOpenStatus {
  param(
    [AllowNull()]
    [string]$LiteralPath,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )
  if ([String]::IsNullOrWhiteSpace($LiteralPath)) {
    return "not-applicable"
  }
  if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
    return "absent"
  }

  $physicalFile = Get-PhysicalFile `
    -LiteralPath $LiteralPath `
    -Label $Label
  $exclusiveStream = $null
  try {
    $exclusiveStream = [IO.File]::Open(
      $physicalFile.FullName,
      [IO.FileMode]::Open,
      [IO.FileAccess]::Read,
      [IO.FileShare]::None
    )
    return "available"
  } catch {
    return "denied"
  } finally {
    if ($null -ne $exclusiveStream) {
      $exclusiveStream.Dispose()
    }
  }
}

function Get-UninstallDiagnosticSnapshot {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,
    [AllowNull()]
    [string]$InstalledApplicationExecutablePath,
    [AllowNull()]
    [string]$InstalledPackagedSquirrelPath
  )
  $installedApplicationExactPathProcessCount = "not-applicable"
  if (
    -not [String]::IsNullOrWhiteSpace(
      $InstalledApplicationExecutablePath
    )
  ) {
    $installedApplicationExactPathProcessCount =
      Get-ExactPathProcessCount `
        -ExecutablePath $InstalledApplicationExecutablePath
  }
  $tokenMonsterProcessCount = Get-TokenMonsterProcessCount
  $installTreeLiveProcessCount = Get-InstallTreeProcessCount `
    -InstallRoot $InstallRoot
  $installedApplicationExclusiveOpenStatus =
    Get-FixedRoleExclusiveOpenStatus `
      -LiteralPath $InstalledApplicationExecutablePath `
      -Label "Installed application diagnostic role"
  $packagedSquirrelExclusiveOpenStatus =
    Get-FixedRoleExclusiveOpenStatus `
      -LiteralPath $InstalledPackagedSquirrelPath `
      -Label "Packaged Squirrel diagnostic role"
  $residualApplication = Get-ResidualApplicationSnapshot `
    -InstallRoot $InstallRoot
  return [PSCustomObject]@{
    TokenMonsterProcessCount = $tokenMonsterProcessCount
    InstallTreeLiveProcessCount = $installTreeLiveProcessCount
    InstalledApplicationExactPathProcessCount =
      $installedApplicationExactPathProcessCount
    InstalledApplicationExclusiveOpenStatus =
      $installedApplicationExclusiveOpenStatus
    PackagedSquirrelExclusiveOpenStatus =
      $packagedSquirrelExclusiveOpenStatus
    AppDirectoryCount = $residualApplication.AppDirectoryCount
    DirectoryCount = $residualApplication.DirectoryCount
    FileCount = $residualApplication.FileCount
    ExclusiveOpenAvailableCount =
      $residualApplication.ExclusiveOpenAvailableCount
    ExclusiveOpenUnavailableCount =
      $residualApplication.ExclusiveOpenUnavailableCount
    SharingOrLockViolationCount =
      $residualApplication.SharingOrLockViolationCount
    OtherOpenFailureCount = $residualApplication.OtherOpenFailureCount
  }
}

function New-UnavailableUninstallDiagnosticSnapshot {
  return [PSCustomObject]@{
    TokenMonsterProcessCount = "not-collected"
    InstallTreeLiveProcessCount = "not-collected"
    InstalledApplicationExactPathProcessCount = "not-collected"
    InstalledApplicationExclusiveOpenStatus = "not-collected"
    PackagedSquirrelExclusiveOpenStatus = "not-collected"
    AppDirectoryCount = "not-collected"
    DirectoryCount = "not-collected"
    FileCount = "not-collected"
    ExclusiveOpenAvailableCount = "not-collected"
    ExclusiveOpenUnavailableCount = "not-collected"
    SharingOrLockViolationCount = "not-collected"
    OtherOpenFailureCount = "not-collected"
  }
}

function Get-RequiredRegistryString {
  param(
    [Parameter(Mandatory = $true)]
    [object]$RegistryValues,
    [Parameter(Mandatory = $true)]
    [string]$ValueName
  )
  $property = $RegistryValues.PSObject.Properties[$ValueName]
  if (
    $null -eq $property -or
    $property.Value -isnot [string] -or
    [String]::IsNullOrWhiteSpace($property.Value)
  ) {
    throw "The Squirrel uninstall registry entry is incomplete."
  }
  return [string]$property.Value
}

$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop |
  Select-Object -First 1
$nodeExecutable = (
  Get-PhysicalFile -LiteralPath $nodeCommand.Source -Label "Node.js executable"
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
$installedApplicationExecutablePath = $null
$installedPackagedSquirrelPath = $null
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
  $installedApplicationExecutablePath =
    $installedApplicationExecutable.FullName
  $installedPackagedSquirrel = Get-PhysicalFile `
    -LiteralPath (Join-Path $installedApplication.FullName "squirrel.exe") `
    -Label "Installed packaged Squirrel updater"
  $installedPackagedSquirrelPath = $installedPackagedSquirrel.FullName
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

  # The Squirrel execution stub is already bound byte-for-byte above. It uses
  # a GUI launch that deliberately does not relay the application child's
  # stdout, so the dual-gated marker must be read from the exact installed app.
  & $nodeExecutable $executableSmoke $installedApplicationExecutable.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "The installed Squirrel application failed its startup smoke."
  }
  if ((Get-TokenMonsterProcessCount) -ne 0) {
    throw "The packaged startup smoke left a companion process running."
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

      $uninstallFailure = $null
      $rootEntryPointPath = Join-Path $installRoot "TokenMonster.exe"
      $preUninstallEntryPointHash = $null
      $preUninstallEntryPointLength = $null
      $hookObserved = $false
      $hookProcessStartCount = 0
      $hookWatcher = $null
      $hookWatcherStarted = $false
      $hookSubscriberRegistered = $false
      $hookSourceIdentifier =
        "TokenMonster.SquirrelUninstall.$PID.$([Guid]::NewGuid().ToString('N'))"
      $hookEvent = $null
      $immediateDiagnosticSnapshot =
        New-UnavailableUninstallDiagnosticSnapshot
      $settledDiagnosticSnapshot =
        New-UnavailableUninstallDiagnosticSnapshot
      $residualExclusiveOpenClearAfterPoll = "not-observed"
      $diagnosticSnapshotErrorCount = 0

      try {
        $uninstallRegistryValues = Get-ItemProperty `
          -LiteralPath $uninstallRegistryPath `
          -ErrorAction Stop
        $registeredInstallLocation = Get-RequiredRegistryString `
          -RegistryValues $uninstallRegistryValues `
          -ValueName "InstallLocation"
        $registeredUninstallString = Get-RequiredRegistryString `
          -RegistryValues $uninstallRegistryValues `
          -ValueName "UninstallString"
        $registeredQuietUninstallString = Get-RequiredRegistryString `
          -RegistryValues $uninstallRegistryValues `
          -ValueName "QuietUninstallString"
        $expectedUninstallString =
          '"{0}" --uninstall' -f $physicalUpdateExecutable.FullName
        $expectedQuietUninstallString = "$expectedUninstallString -s"
        if (
          -not [String]::Equals(
            $registeredInstallLocation,
            $installRoot,
            [StringComparison]::Ordinal
          ) -or
          -not [String]::Equals(
            $registeredUninstallString,
            $expectedUninstallString,
            [StringComparison]::Ordinal
          ) -or
          -not [String]::Equals(
            $registeredQuietUninstallString,
            $expectedQuietUninstallString,
            [StringComparison]::Ordinal
          )
        ) {
          throw "The Squirrel uninstall registry entry does not match the installed candidate."
        }
        if ((Get-TokenMonsterProcessCount) -ne 0) {
          throw "A companion process was running before Squirrel uninstall."
        }
      } catch {
        $uninstallFailure = [System.Management.Automation.RuntimeException]::new(
          "Squirrel uninstall registration proof failed.",
          $_.Exception
        )
      }

      try {
        $preUninstallEntryPoint = Get-PhysicalFile `
          -LiteralPath $rootEntryPointPath `
          -Label "Installed Squirrel execution stub before uninstall"
        $preUninstallEntryPointLength = $preUninstallEntryPoint.Length
        $preUninstallEntryPointHash = (
          Get-FileHash `
            -LiteralPath $preUninstallEntryPoint.FullName `
            -Algorithm SHA256 `
            -ErrorAction Stop
        ).Hash
      } catch {
        if ($null -eq $uninstallFailure) {
          $uninstallFailure = [System.Management.Automation.RuntimeException]::new(
            "Squirrel uninstall pre-state proof failed.",
            $_.Exception
          )
        }
      }

      try {
        $hookWatcher = [System.Management.ManagementEventWatcher]::new(
          "SELECT * FROM Win32_ProcessStartTrace WHERE ProcessName = 'TokenMonster.exe'"
        )
        Register-ObjectEvent `
          -InputObject $hookWatcher `
          -EventName "EventArrived" `
          -SourceIdentifier $hookSourceIdentifier |
          Out-Null
        $hookSubscriberRegistered = $true
        $hookWatcher.Start()
        $hookWatcherStarted = $true
      } catch {
        if ($null -eq $uninstallFailure) {
          $uninstallFailure = [System.Management.Automation.RuntimeException]::new(
            "Squirrel uninstall lifecycle observation could not start.",
            $_.Exception
          )
        }
      }

      try {
        $uninstallExitCode = Invoke-BoundedProcess `
          -FilePath $physicalUpdateExecutable.FullName `
          -ArgumentList @("--uninstall", "-s") `
          -Label "Squirrel silent uninstall" `
          -TimeoutMilliseconds $processTimeoutMilliseconds `
          -WorkingDirectory $localAppData.FullName
        if ($uninstallExitCode -ne 0) {
          throw "Squirrel silent uninstall returned a failure status."
        }
        try {
          $immediateDiagnosticSnapshot = Get-UninstallDiagnosticSnapshot `
            -InstallRoot $installRoot `
            -InstalledApplicationExecutablePath `
              $installedApplicationExecutablePath `
            -InstalledPackagedSquirrelPath $installedPackagedSquirrelPath
          if ($immediateDiagnosticSnapshot.FileCount -eq 0) {
            $residualExclusiveOpenClearAfterPoll = "not-applicable"
          } elseif (
            $immediateDiagnosticSnapshot.ExclusiveOpenUnavailableCount -eq 0
          ) {
            $residualExclusiveOpenClearAfterPoll = 0
          }
        } catch {
          $diagnosticSnapshotErrorCount += 1
        }
      } catch {
        if ($null -eq $uninstallFailure) {
          $uninstallFailure = [System.Management.Automation.RuntimeException]::new(
            "Squirrel silent uninstall could not be completed.",
            $_.Exception
          )
        }
      } finally {
        if ($hookWatcherStarted -and $hookSubscriberRegistered) {
          try {
            $hookEvent = Wait-Event `
              -SourceIdentifier $hookSourceIdentifier `
              -Timeout $hookObservationTimeoutSeconds `
              -ErrorAction Stop
            $hookProcessStartCount = @(
              Get-Event `
                -SourceIdentifier $hookSourceIdentifier `
                -ErrorAction SilentlyContinue
            ).Count
            if ($null -ne $hookEvent -and $hookProcessStartCount -eq 0) {
              $hookProcessStartCount = 1
            }
            $hookObserved = $hookProcessStartCount -ne 0
          } catch {
            if ($null -eq $uninstallFailure) {
              $uninstallFailure =
                [System.Management.Automation.RuntimeException]::new(
                  "Squirrel uninstall lifecycle observation failed.",
                  $_.Exception
                )
            }
          }
        }
        if ($hookWatcherStarted) {
          try {
            $hookWatcher.Stop()
          } catch {
            # Disposing the watcher remains the bounded cleanup authority.
          }
        }
        if ($hookSubscriberRegistered) {
          Unregister-Event `
            -SourceIdentifier $hookSourceIdentifier `
            -ErrorAction SilentlyContinue
        }
        Get-Event `
          -SourceIdentifier $hookSourceIdentifier `
          -ErrorAction SilentlyContinue |
          Remove-Event -ErrorAction SilentlyContinue
        if ($null -ne $hookWatcher) {
          $hookWatcher.Dispose()
        }
      }

      for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
        $remainingApplications = @(
          Get-ChildItem -LiteralPath $installRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "app-*" }
        )
        $remainingEntryPoint = Test-Path `
          -LiteralPath $rootEntryPointPath `
          -PathType Leaf
        $uninstallRegistryRemains = Test-Path `
          -LiteralPath $uninstallRegistryPath
        if (
          $remainingApplications.Count -eq 0 -and
          -not $remainingEntryPoint -and
          -not $uninstallRegistryRemains
        ) {
          break
        }
        Start-Sleep -Seconds 1
        if ($residualExclusiveOpenClearAfterPoll -ceq "not-observed") {
          try {
            $pollSnapshot = Get-ResidualApplicationSnapshot `
              -InstallRoot $installRoot
            if (
              $pollSnapshot.FileCount -ne 0 -and
              $pollSnapshot.ExclusiveOpenUnavailableCount -eq 0
            ) {
              $residualExclusiveOpenClearAfterPoll = $attempt + 1
            }
          } catch {
            $diagnosticSnapshotErrorCount += 1
          }
        }
      }
      $remainingApplications = @(
        Get-ChildItem -LiteralPath $installRoot -Directory -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -like "app-*" }
      )
      $remainingEntryPoint = Test-Path `
        -LiteralPath $rootEntryPointPath `
        -PathType Leaf
      $uninstallRegistryRemains = Test-Path `
        -LiteralPath $uninstallRegistryPath
      try {
        $settledDiagnosticSnapshot = Get-UninstallDiagnosticSnapshot `
          -InstallRoot $installRoot `
          -InstalledApplicationExecutablePath `
            $installedApplicationExecutablePath `
          -InstalledPackagedSquirrelPath $installedPackagedSquirrelPath
      } catch {
        $diagnosticSnapshotErrorCount += 1
      }

      if (
        $remainingApplications.Count -ne 0 -or
        $remainingEntryPoint -or
        $uninstallRegistryRemains -or
        -not $hookObserved -or
        $null -ne $uninstallFailure
      ) {
        $rootStubUnchanged = "not-applicable"
        $exclusiveOpenAvailable = "not-applicable"
        if ($remainingEntryPoint) {
          $rootStubUnchanged = "unknown"
          try {
            $remainingEntryPointItem = Get-PhysicalFile `
              -LiteralPath $rootEntryPointPath `
              -Label "Residual Squirrel execution stub"
            $remainingEntryPointHash = (
              Get-FileHash `
                -LiteralPath $remainingEntryPointItem.FullName `
                -Algorithm SHA256 `
                -ErrorAction Stop
            ).Hash
            if (
              $null -ne $preUninstallEntryPointHash -and
              $null -ne $preUninstallEntryPointLength -and
              [String]::Equals(
                $remainingEntryPointHash,
                $preUninstallEntryPointHash,
                [StringComparison]::Ordinal
              ) -and
              $remainingEntryPointItem.Length -eq
              $preUninstallEntryPointLength
            ) {
              $rootStubUnchanged = "yes"
            } else {
              $rootStubUnchanged = "no"
            }
          } catch {
            $rootStubUnchanged = "unknown"
          }

          $exclusiveStream = $null
          try {
            $exclusiveStream = [IO.File]::Open(
              $rootEntryPointPath,
              [IO.FileMode]::Open,
              [IO.FileAccess]::Read,
              [IO.FileShare]::None
            )
            $exclusiveOpenAvailable = "yes"
          } catch {
            $exclusiveOpenAvailable = "no"
          } finally {
            if ($null -ne $exclusiveStream) {
              $exclusiveStream.Dispose()
            }
          }
        }

        $rootStubExactPathLiveProcessCount = Get-ExactPathProcessCount `
          -ExecutablePath $rootEntryPointPath
        $deadMarkerPresent = Test-Path `
          -LiteralPath (Join-Path $installRoot ".dead") `
          -PathType Leaf

        $hookObservedText = if ($hookObserved) { "yes" } else { "no" }
        $rootStubPresentText = if ($remainingEntryPoint) { "yes" } else { "no" }
        $deadMarkerPresentText = if ($deadMarkerPresent) { "yes" } else { "no" }
        $registryKeyRemainsText =
          if ($uninstallRegistryRemains) { "yes" } else { "no" }
        Write-Output (
          "Squirrel uninstall classification: " +
          "hookObserved=$hookObservedText; " +
          "hookProcessStartCount=$hookProcessStartCount; " +
          "diagnosticSnapshotErrorCount=$diagnosticSnapshotErrorCount; " +
          "immediateTokenMonsterProcessCount=" +
          "$($immediateDiagnosticSnapshot.TokenMonsterProcessCount); " +
          "immediateInstallTreeLiveProcessCount=" +
          "$($immediateDiagnosticSnapshot.InstallTreeLiveProcessCount); " +
          "immediateInstalledAppExactPathLiveProcessCount=" +
          "$($immediateDiagnosticSnapshot.InstalledApplicationExactPathProcessCount); " +
          "immediateInstalledAppExclusiveOpen=" +
          "$($immediateDiagnosticSnapshot.InstalledApplicationExclusiveOpenStatus); " +
          "immediatePackagedSquirrelExclusiveOpen=" +
          "$($immediateDiagnosticSnapshot.PackagedSquirrelExclusiveOpenStatus); " +
          "immediateAppDirectoryCount=" +
          "$($immediateDiagnosticSnapshot.AppDirectoryCount); " +
          "immediateResidualDirectoryCount=" +
          "$($immediateDiagnosticSnapshot.DirectoryCount); " +
          "immediateResidualFileCount=" +
          "$($immediateDiagnosticSnapshot.FileCount); " +
          "immediateResidualExclusiveOpenAvailableCount=" +
          "$($immediateDiagnosticSnapshot.ExclusiveOpenAvailableCount); " +
          "immediateResidualExclusiveOpenUnavailableCount=" +
          "$($immediateDiagnosticSnapshot.ExclusiveOpenUnavailableCount); " +
          "immediateResidualSharingOrLockViolationCount=" +
          "$($immediateDiagnosticSnapshot.SharingOrLockViolationCount); " +
          "immediateResidualOtherOpenFailureCount=" +
          "$($immediateDiagnosticSnapshot.OtherOpenFailureCount); " +
          "settledTokenMonsterProcessCount=" +
          "$($settledDiagnosticSnapshot.TokenMonsterProcessCount); " +
          "settledInstallTreeLiveProcessCount=" +
          "$($settledDiagnosticSnapshot.InstallTreeLiveProcessCount); " +
          "settledInstalledAppExactPathLiveProcessCount=" +
          "$($settledDiagnosticSnapshot.InstalledApplicationExactPathProcessCount); " +
          "settledInstalledAppExclusiveOpen=" +
          "$($settledDiagnosticSnapshot.InstalledApplicationExclusiveOpenStatus); " +
          "settledPackagedSquirrelExclusiveOpen=" +
          "$($settledDiagnosticSnapshot.PackagedSquirrelExclusiveOpenStatus); " +
          "settledAppDirectoryCount=" +
          "$($settledDiagnosticSnapshot.AppDirectoryCount); " +
          "settledResidualDirectoryCount=" +
          "$($settledDiagnosticSnapshot.DirectoryCount); " +
          "settledResidualFileCount=" +
          "$($settledDiagnosticSnapshot.FileCount); " +
          "settledResidualExclusiveOpenAvailableCount=" +
          "$($settledDiagnosticSnapshot.ExclusiveOpenAvailableCount); " +
          "settledResidualExclusiveOpenUnavailableCount=" +
          "$($settledDiagnosticSnapshot.ExclusiveOpenUnavailableCount); " +
          "settledResidualSharingOrLockViolationCount=" +
          "$($settledDiagnosticSnapshot.SharingOrLockViolationCount); " +
          "settledResidualOtherOpenFailureCount=" +
          "$($settledDiagnosticSnapshot.OtherOpenFailureCount); " +
          "residualExclusiveOpenClearAfterPoll=" +
          "$residualExclusiveOpenClearAfterPoll; " +
          "rootStubPresent=$rootStubPresentText; " +
          "rootStubHashAndSizeUnchanged=$rootStubUnchanged; " +
          "exclusiveOpenAvailable=$exclusiveOpenAvailable; " +
          "rootStubExactPathLiveProcessCount=" +
          "$rootStubExactPathLiveProcessCount; " +
          "deadMarkerPresent=$deadMarkerPresentText; " +
          "registryKeyRemains=$registryKeyRemainsText"
        )
      }

      if ($remainingApplications.Count -ne 0 -or $remainingEntryPoint) {
        if ($null -eq $uninstallFailure) {
          $uninstallFailure = [System.Management.Automation.RuntimeException]::new(
            "Squirrel uninstall left an installed application entry point."
          )
        }
      }
      if ($uninstallRegistryRemains -and $null -eq $uninstallFailure) {
        $uninstallFailure = [System.Management.Automation.RuntimeException]::new(
          "Squirrel uninstall left its per-user registration behind."
        )
      }
      if (-not $hookObserved -and $null -eq $uninstallFailure) {
        $uninstallFailure = [System.Management.Automation.RuntimeException]::new(
          "Squirrel uninstall did not launch the companion lifecycle hook."
        )
      }
      if ($null -ne $uninstallFailure) {
        throw $uninstallFailure
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
