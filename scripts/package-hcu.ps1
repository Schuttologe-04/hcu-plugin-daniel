[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packageDirectory = Join-Path $taskRoot 'dist-package'
$imageTag = 'com.psd.hcu.goe.loadmanagement:0.1.0'
$archiveName = 'com.psd.hcu.goe.loadmanagement-0.1.0.tar.gz'
$checksumName = 'com.psd.hcu.goe.loadmanagement-0.1.0.sha256'
$stagingDirectory = Join-Path $packageDirectory ('.package-build-' + [guid]::NewGuid().ToString('N'))

function Invoke-Checked {
    param([Parameter(Mandatory = $true)][string]$Executable, [string[]]$Arguments = @())
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed: $Executable (exit $LASTEXITCODE)." }
}

function Get-ArchiveSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $hashStream = [System.IO.File]::OpenRead($Path)
    try {
        $algorithm = [System.Security.Cryptography.SHA256]::Create()
        try { $hashBytes = $algorithm.ComputeHash($hashStream) }
        finally { $algorithm.Dispose() }
    } finally { $hashStream.Dispose() }
    return -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
}

Push-Location -LiteralPath $taskRoot
try {
    Invoke-Checked 'npm.cmd' @('test')
    Invoke-Checked 'npm.cmd' @('run', 'typecheck')
    Invoke-Checked 'npm.cmd' @('run', 'build')
    Invoke-Checked 'node' @('scripts/check-package-inputs.mjs', $taskRoot)

    $docker = Get-Command 'docker' -ErrorAction SilentlyContinue
    $dockerExecutable = if ($null -ne $docker) { $docker.Source } else { $null }
    if ($null -eq $dockerExecutable) {
        # A Desktop installation can precede refreshing this terminal's PATH.
        $dockerCandidates = @(
            (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'),
            (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe')
        )
        foreach ($candidate in $dockerCandidates) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $dockerExecutable = $candidate; break }
        }
    }
    if ($null -eq $dockerExecutable) { throw 'Docker Desktop with Linux containers is required. No HCU archive was created.' }
    Invoke-Checked $dockerExecutable @('version', '--format', '{{.Server.Os}}')
    New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null
    Invoke-Checked $dockerExecutable @('build', '--platform', 'linux/arm64', '--provenance=false', '--tag', $imageTag, $taskRoot)

    $inspection = & $dockerExecutable image inspect $imageTag
    if ($LASTEXITCODE -ne 0) { throw 'Docker image inspect failed.' }
    $inspectionPath = Join-Path $stagingDirectory 'image-inspect.json'
    [System.IO.File]::WriteAllText($inspectionPath, ($inspection -join "`n"), [System.Text.UTF8Encoding]::new($false))
    Invoke-Checked 'node' @('scripts/validate-hcu-image.mjs', $inspectionPath)

    $mockDirectory = Join-Path $stagingDirectory 'smoke'
    $mockData = Join-Path $mockDirectory 'data'
    New-Item -ItemType Directory -Path $mockData -Force | Out-Null
    $encoding = [System.Text.UTF8Encoding]::new($false)
    foreach ($fixture in @(@{ Name = 'TOKEN'; Value = 'MOCK_CONTAINER_TOKEN' }, @{ Name = 'CLIENTID'; Value = 'MOCK_CONTAINER_CLIENT' }, @{ Name = 'SGTIN'; Value = 'MOCK_CONTAINER_SGTIN' })) {
        [System.IO.File]::WriteAllText((Join-Path $mockDirectory $fixture.Name), $fixture.Value, $encoding)
    }
    $smokeScript = Join-Path $taskRoot 'scripts/container-smoke.mjs'
    $smokeArguments = @('run', '--rm', '--platform', 'linux/arm64', '--network', 'none', '--entrypoint', 'node',
        '--mount', "type=bind,source=$smokeScript,target=/validation/container-smoke.mjs,readonly",
        '--mount', "type=bind,source=$(Join-Path $mockDirectory 'TOKEN'),target=/TOKEN,readonly",
        '--mount', "type=bind,source=$(Join-Path $mockDirectory 'CLIENTID'),target=/CLIENTID,readonly",
        '--mount', "type=bind,source=$(Join-Path $mockDirectory 'SGTIN'),target=/SGTIN,readonly",
        '--mount', "type=bind,source=$mockData,target=/data",
        $imageTag, '/validation/container-smoke.mjs')
    # Network isolation is mandatory. The production entrypoint is never started.
    Invoke-Checked $dockerExecutable $smokeArguments

    $tarPath = Join-Path $stagingDirectory 'plugin.tar'
    Invoke-Checked $dockerExecutable @('save', '--platform', 'linux/arm64', '--output', $tarPath, $imageTag)
    $compressedPath = Join-Path $stagingDirectory $archiveName
    $inputStream = [System.IO.File]::OpenRead($tarPath)
    try {
        $outputStream = [System.IO.File]::Create($compressedPath)
        try {
            $gzip = [System.IO.Compression.GZipStream]::new($outputStream, [System.IO.Compression.CompressionLevel]::Optimal, $true)
            try { $inputStream.CopyTo($gzip) } finally { $gzip.Dispose() }
        } finally { $outputStream.Dispose() }
    } finally { $inputStream.Dispose() }
    $checksum = Get-ArchiveSha256 -Path $compressedPath
    $checksumPath = Join-Path $stagingDirectory $checksumName
    [System.IO.File]::WriteAllText($checksumPath, "$checksum  $archiveName`n", [System.Text.Encoding]::ASCII)
    Move-Item -LiteralPath $compressedPath -Destination (Join-Path $packageDirectory $archiveName) -Force
    Move-Item -LiteralPath $checksumPath -Destination (Join-Path $packageDirectory $checksumName) -Force
    Move-Item -LiteralPath $inspectionPath -Destination (Join-Path $packageDirectory 'image-inspect.json') -Force
    Write-Output "HCU archive: $(Join-Path $packageDirectory $archiveName)"
    Write-Output "SHA-256: $checksum"
    Write-Output 'ARM64 metadata and isolated container smoke test passed. No real hardware writes were executed.'
} finally {
    Pop-Location
    # Delete only the unique temporary child created for this packaging run.
    $resolvedStaging = [System.IO.Path]::GetFullPath($stagingDirectory)
    $resolvedPackage = [System.IO.Path]::GetFullPath($packageDirectory) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedStaging.StartsWith($resolvedPackage, [System.StringComparison]::OrdinalIgnoreCase) -or
        [System.IO.Path]::GetFileName($resolvedStaging) -notmatch '^\.package-build-[a-f0-9]{32}$') {
        throw 'Unsafe temporary packaging cleanup target.'
    }
    if (Test-Path -LiteralPath $resolvedStaging) { Remove-Item -LiteralPath $resolvedStaging -Recurse -Force }
}
