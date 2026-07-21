#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $AssemblyPath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $ReceiptPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "The reviewed source tests require Windows."
}

$assemblyFile = Get-Item -LiteralPath $AssemblyPath -Force
if (
    $assemblyFile.PSIsContainer -or
    ($assemblyFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
) {
    throw "The reviewed source-test assembly must be a physical file."
}

$receiptFullPath = [IO.Path]::GetFullPath($ReceiptPath)
if (Test-Path -LiteralPath $receiptFullPath) {
    throw "The reviewed source-test receipt path must start absent."
}
$receiptDirectory = Get-Item -LiteralPath (Split-Path -Parent $receiptFullPath) -Force
if (
    -not $receiptDirectory.PSIsContainer -or
    ($receiptDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
) {
    throw "The reviewed source-test receipt directory must be a physical directory."
}

$assembly = [Reflection.Assembly]::LoadFrom($assemblyFile.FullName)
$testCases = @(
    [pscustomobject]@{
        TypeName = "Squirrel.Tests.Core.UtilityTests"
        MethodName = "DeleteDirectoryOrJustGiveUpRetriesTransientFileLocks"
        ReturnKind = "Task"
    }
    [pscustomobject]@{
        TypeName = "Squirrel.Tests.Core.UtilityTests"
        MethodName = "DeleteDirectoryOrJustGiveUpReturnsAfterBoundedRetriesForPermanentFileLocks"
        ReturnKind = "Task"
    }
    [pscustomobject]@{
        TypeName = "Squirrel.Tests.SquirrelAwareExecutableDetectorTests"
        MethodName = "NotSquirrelAware"
        ReturnKind = "Void"
    }
)
$bindingFlags = (
    [Reflection.BindingFlags]::Public -bor
    [Reflection.BindingFlags]::Instance -bor
    [Reflection.BindingFlags]::DeclaredOnly
)
$receiptLines = @()

foreach ($testCase in $testCases) {
    $type = $assembly.GetType($testCase.TypeName, $false, $false)
    if ($null -eq $type) {
        throw "The reviewed source-test type is absent: $($testCase.TypeName)"
    }
    $methods = @(
        $type.GetMethods($bindingFlags) |
            Where-Object {
                $_.Name -ceq $testCase.MethodName -and
                -not $_.IsGenericMethod -and
                -not $_.IsAbstract -and
                $_.GetParameters().Count -eq 0
            }
    )
    if ($methods.Count -ne 1) {
        throw "The reviewed source-test method identity is not unique: $($testCase.TypeName).$($testCase.MethodName)"
    }
    $method = $methods[0]
    $factAttributes = @(
        $method.GetCustomAttributesData() |
            Where-Object {
                $_.AttributeType.FullName -ceq "Xunit.FactAttribute" -and
                $_.AttributeType.Assembly.GetName().Name -ceq "xunit.core"
            }
    )
    if ($factAttributes.Count -ne 1) {
        throw "The reviewed source-test method does not have exactly one Fact attribute: $($testCase.TypeName).$($testCase.MethodName)"
    }
    if (
        $factAttributes[0].ConstructorArguments.Count -ne 0 -or
        $factAttributes[0].NamedArguments.Count -ne 0
    ) {
        throw "The reviewed source-test Fact attribute contains arguments: $($testCase.TypeName).$($testCase.MethodName)"
    }
    switch -CaseSensitive ($testCase.ReturnKind) {
        "Task" {
            if ($method.ReturnType -ne [Threading.Tasks.Task]) {
                throw "The reviewed async source-test method no longer returns Task: $($testCase.TypeName).$($testCase.MethodName)"
            }
            break
        }
        "Void" {
            if ($method.ReturnType -ne [void]) {
                throw "The reviewed synchronous source-test method no longer returns void: $($testCase.TypeName).$($testCase.MethodName)"
            }
            break
        }
        default {
            throw "The reviewed source-test return contract is invalid."
        }
    }

    $instance = $null
    try {
        $instance = [Activator]::CreateInstance($type)
        try {
            $result = $method.Invoke($instance, [object[]] @())
        } catch [Reflection.TargetInvocationException] {
            if ($null -ne $_.Exception.InnerException) {
                throw $_.Exception.InnerException
            }
            throw
        }
        if ($testCase.ReturnKind -ceq "Task") {
            $result.GetAwaiter().GetResult()
        }
    } finally {
        if ($instance -is [IDisposable]) {
            $instance.Dispose()
        }
    }

    $identity = "$($testCase.TypeName).$($testCase.MethodName)"
    $receiptLines += "passed`t$identity"
    Write-Output "Passed reviewed source test: $identity"
}

if ($receiptLines.Count -ne $testCases.Count -or $receiptLines.Count -ne 3) {
    throw "The reviewed source-test execution set was incomplete."
}

$receiptStream = [IO.FileStream]::new(
    $receiptFullPath,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
)
try {
    $receiptWriter = [IO.StreamWriter]::new(
        $receiptStream,
        [Text.UTF8Encoding]::new($false)
    )
    try {
        $receiptWriter.NewLine = "`n"
        foreach ($receiptLine in $receiptLines) {
            $receiptWriter.WriteLine($receiptLine)
        }
    } finally {
        $receiptWriter.Dispose()
    }
} finally {
    if ($null -ne $receiptStream) {
        $receiptStream.Dispose()
    }
}
