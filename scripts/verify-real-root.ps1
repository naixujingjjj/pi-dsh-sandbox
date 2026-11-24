#requires -Version 7.0
<#
.SYNOPSIS
    One-time, human-approved verification of the REAL workspace root against the SHIPPED runner.

.DESCRIPTION
    The verification answers one question: does the runner that a clean install runs actually
    authorize THIS directory layout without an extra permission repair?

    It only ever edits the ACL of the repository root that contains this script. Everything else is
    read-only or happens in a throw-away %TEMP% tree:

      1. validate paths (absolute, no reparse points, root == this repository, parent untouched);
      2. validate that the runner is the vendored patched build (marker, version, patch, provenance);
      3. prove the DACL-only restore works in an isolated same-NAME directory first;
      4. back up the real root's DACL (Access section only), owner/group and mandatory-label text,
         and record the current ACEs;
      5. run the shipped runner confined on the real root: `Get-Location`, a read-only
         `git status --porcelain --no-optional-locks`, and create+delete of ONE unique probe file;
      6. assert the only DACL additions are the capability-SID allow ACE and the Everyone
         delete-child deny, that no account/owner ACE was added, and that the Low label is unchanged;
      7. restore the saved DACL (unless -KeepGrant), verify it is byte-identical to the backup and
         that the label and the parent directory are unchanged; clean up in `finally`.

    Dry run is the default: without -Execute the script prints the plan and touches nothing.
    Run it from a normal (unconfined) PowerShell; the plugin's confined shell cannot write security
    descriptors. No global ACL reset is ever performed.

.PARAMETER Root
    The directory to verify. Must be this repository's root; defaults to it.

.PARAMETER RunnerModule
    Absolute path of the runner. Defaults to this package's vendored backend. A copy from a clean
    `npm install` of the packed tarball is also accepted. A path inside
    `node_modules/@deepseek-ai/dsh-sandbox-windows-acl` is refused (that is the unpatched dependency).

.PARAMETER TempRoot
    Runner --temp directory (outside the root). Defaults to a fresh directory under %TEMP%.

.PARAMETER Execute
    Perform the real-root ACL grant and verification. Without it this is a dry run.

.PARAMETER KeepGrant
    Do not restore the DACL after a successful verification. The saved backup and the generated
    restore.ps1 are still written, and their paths are printed.

.EXAMPLE
    pwsh -NoProfile -File scripts/verify-real-root.ps1
    # dry run: validates everything, prints the plan, changes nothing

.EXAMPLE
    pwsh -NoProfile -File scripts/verify-real-root.ps1 -Execute
    # one real grant on this repository root, full assertion set, DACL restored afterwards
#>
[CmdletBinding()]
param(
    [string]$Root,
    [string]$RunnerModule,
    [string]$TempRoot,
    [switch]$Execute,
    [switch]$KeepGrant
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Root) { $Root = $repo }
$rootFull = [System.IO.Path]::GetFullPath($Root)
$repoFull = [System.IO.Path]::GetFullPath($repo)
$parentFull = [System.IO.Path]::GetFullPath((Split-Path -Parent $rootFull))

function Assert-AbsoluteNonReparse([string]$path, [string]$label, [switch]$AllowMissing) {
    if (-not [System.IO.Path]::IsPathRooted($path)) { throw "$label must be an absolute path: $path" }
    $full = [System.IO.Path]::GetFullPath($path)
    if (-not $AllowMissing -and -not (Test-Path -LiteralPath $full)) { throw "$label does not exist: $full" }
    if (Test-Path -LiteralPath $full) {
        $item = Get-Item -LiteralPath $full -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$label must not be a reparse point (junction/symlink): $full"
        }
    }
    return $full
}

if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($rootFull.TrimEnd('\'), $repoFull.TrimEnd('\'))) {
    throw "Refusing to run: the only permitted real target is this repository root.`n  requested: $rootFull`n  repository: $repoFull"
}
if ((Split-Path -Parent $repoFull) -ne $parentFull) { throw 'Refusing to run: unexpected repository parent directory' }
$null = Assert-AbsoluteNonReparse $rootFull 'Root'
$null = Assert-AbsoluteNonReparse $parentFull 'Root parent (never modified)'
if (-not (Test-Path -LiteralPath (Join-Path $rootFull 'package.json'))) { throw "Root is not the plugin package: $rootFull" }

# --- the shipped runner -----------------------------------------------------------------------
if (-not $RunnerModule) { $RunnerModule = Join-Path $rootFull 'vendor\dsh-sandbox-windows-acl\lib\runner.js' }
$runnerFull = Assert-AbsoluteNonReparse $RunnerModule 'RunnerModule'
if ($runnerFull -like '*\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\*') {
    throw "Refusing an unpatched node_modules runner: $runnerFull`nPass the vendored/packaged runner, or a clean-install copy under ...\node_modules\pi-dsh-sandbox\vendor\..."
}
$runnerLib = Split-Path -Parent $runnerFull
$runnerPackage = Split-Path -Parent $runnerLib
$manifestPath = Join-Path $runnerPackage 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Runner package.json missing: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (-not ($manifest.PSObject.Properties.Name -contains 'piDshSandbox') -or $manifest.piDshSandbox.vendored -ne $true) {
    throw 'Runner is not the vendored patched build (piDshSandbox.vendored missing)'
}
if ($manifest.version -notmatch '\+pi-dsh\.\d+$') { throw "Runner version does not identify the patch: $($manifest.version)" }
$aclJs = Join-Path $runnerLib 'acl.js'
if (-not (Select-String -LiteralPath $aclJs -Pattern 'hasEffectiveLowLabel' -Quiet)) {
    throw 'Runner acl.js does not contain the inherited-Low-label guard; rebuild the vendor tree'
}
$provenancePath = Join-Path $runnerPackage 'PROVENANCE.json'
if (Test-Path -LiteralPath $provenancePath) {
    $provenance = Get-Content -LiteralPath $provenancePath -Raw | ConvertFrom-Json
    foreach ($relative in ($provenance.outputs.PSObject.Properties | ForEach-Object { $_.Name })) {
        $file = Join-Path $runnerPackage $relative
        if (-not (Test-Path -LiteralPath $file)) { throw "PROVENANCE lists a missing file: $relative" }
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -ne $provenance.outputs.$relative) { throw "Vendored file does not match PROVENANCE.json: $relative" }
    }
}
$node = (Get-Command node -ErrorAction Stop).Source
$node = Assert-AbsoluteNonReparse $node 'node'
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$pwsh = Assert-AbsoluteNonReparse $pwsh 'pwsh'
$git = (Get-Command git -ErrorAction Stop).Source
$git = Assert-AbsoluteNonReparse $git 'git'

# --- paths for the run ------------------------------------------------------------------------
if (-not $TempRoot) {
    $TempRoot = Join-Path ([System.IO.Path]::GetFullPath($env:TEMP)) ("pidsbx-realroot-" + [guid]::NewGuid().ToString('N'))
}
$workspaceArg = $rootFull   # replaced with the canonical real path before the runner calls
$tempFull = Assert-AbsoluteNonReparse $TempRoot 'TempRoot' -AllowMissing
$verificationTempBase = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
function Assert-OwnedTemp([string]$path, [string]$prefix) {
    $full = [IO.Path]::GetFullPath($path)
    if ([IO.Path]::GetDirectoryName($full) -ne $verificationTempBase -or
        [IO.Path]::GetFileName($full) -notmatch ('^' + [regex]::Escape($prefix) + '[0-9a-f]{32}$')) {
        throw "Refusing cleanup or creation outside the dedicated temporary directory: $full"
    }
    $null = Assert-AbsoluteNonReparse $full 'Owned temporary directory' -AllowMissing
}
Assert-OwnedTemp $tempFull 'pidsbx-realroot-'
if (Test-Path -LiteralPath $tempFull) { throw "TempRoot must be a fresh, absent directory: $tempFull" }
$rootPrefix = $rootFull.TrimEnd('\') + '\'
if ($tempFull.TrimEnd('\') -eq $rootFull.TrimEnd('\') -or $tempFull.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "TempRoot must be outside Root: $tempFull"
}
$stamp = [guid]::NewGuid().ToString('N')
$backupDir = Join-Path ([System.IO.Path]::GetFullPath($env:TEMP)) "pidsbx-realroot-backup-$stamp"
$daclBackup = Join-Path $backupDir 'root-dacl.sddl'
$restoreScript = Join-Path $backupDir 'restore.ps1'
$evidencePath = Join-Path $backupDir 'evidence.json'

# --- sandbox helpers --------------------------------------------------------------------------
$accessSections = [System.Security.AccessControl.AccessControlSections]::Access

function Get-DaclSddl([string]$path) {
    return (Get-Acl -LiteralPath $path).GetSecurityDescriptorSddlForm($accessSections)
}
function Get-FullSddl([string]$path) {
    return (Get-Acl -LiteralPath $path).Sddl
}
function Get-LabelText([string]$path) {
    return ((& icacls $path 2>&1) | Where-Object { $_ -match '\(NW\)|Mandatory' }) -join "`n"
}
function Get-AceRecords([string]$path) {
    $acl = Get-Acl -LiteralPath $path
    return @($acl.Access | ForEach-Object {
        $sid = try { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { [string]$_.IdentityReference }
        [pscustomobject]@{
            Sid       = $sid
            Type      = [string]$_.AccessControlType
            Rights    = [int]$_.FileSystemRights
            Inherit   = [string]$_.InheritanceFlags
            Propagate = [string]$_.PropagationFlags
            Inherited = [bool]$_.IsInherited
        }
    })
}
function Format-Ace([object]$record) {
    return "$($record.Sid)|$($record.Type)|$($record.Rights)|$($record.Inherit)|$($record.Propagate)|$($record.Inherited)"
}

function Write-RestoreScript([string]$path, [string]$target, [string]$backup) {
    $content = @"
# Generated by pi-dsh-sandbox scripts/verify-real-root.ps1
# Restores ONLY the DACL of `$Target; owner/group/SACL (Low label) are untouched.
param(
    [string]`$Target = '$target',
    [string]`$Backup = '$backup'
)
`$ErrorActionPreference = 'Stop'
if (-not [System.IO.Path]::IsPathRooted(`$Target)) { throw "Target must be absolute: `$Target" }
if (-not (Test-Path -LiteralPath `$Backup)) { throw "DACL backup missing: `$Backup" }
`$sections = [System.Security.AccessControl.AccessControlSections]::Access
`$acl = [System.Security.AccessControl.DirectorySecurity]::new()
`$acl.SetSecurityDescriptorSddlForm((Get-Content -LiteralPath `$Backup -Raw).Trim(), `$sections)
Set-Acl -LiteralPath `$Target -AclObject `$acl
"@
    Set-Content -LiteralPath $path -Value $content -Encoding utf8
}

function Invoke-Restore([string]$path, [string]$target, [string]$backup) {
    & $path -Target $target -Backup $backup
}

# --- isolated same-NAME restore validation (no real root involved) -----------------------------
function Test-RestoreInIsolation {
    $checkBase = Join-Path ([System.IO.Path]::GetFullPath($env:TEMP)) "pidsbx-restore-validate-$stamp"
    $checkParent = Join-Path $checkBase 'parent'
    $leaf = Split-Path -Leaf $rootFull
    $checkRoot = Join-Path $checkParent $leaf        # same leaf name on purpose
    $checkBackup = Join-Path $checkBase 'dacl.sddl'
    $checkRestore = Join-Path $checkBase 'restore.ps1'
    try {
        New-Item -ItemType Directory -Path $checkParent -Force | Out-Null
        & icacls $checkParent /setintegritylevel '(OI)(CI)L' | Out-Null
        New-Item -ItemType Directory -Path $checkRoot -Force | Out-Null
        $before = Get-DaclSddl $checkRoot
        $labelBefore = Get-LabelText $checkRoot
        Set-Content -LiteralPath $checkBackup -Value $before -Encoding utf8
        Write-RestoreScript $checkRestore $checkRoot $checkBackup
        $account = "$env:USERDOMAIN\$env:USERNAME"
        & icacls $checkRoot /deny '*S-1-1-0:(CI)(DC)' | Out-Null
        & icacls $checkRoot /grant "${account}:(OI)(CI)(M)" | Out-Null
        $changed = Get-DaclSddl $checkRoot
        if ($changed -eq $before) { throw 'isolated validation: the simulated grant did not change the DACL' }
        Invoke-Restore $checkRestore $checkRoot $checkBackup
        $after = Get-DaclSddl $checkRoot
        if ($after -ne $before) { throw 'isolated validation: the DACL was not restored exactly' }
        if ((Get-LabelText $checkRoot) -ne $labelBefore) { throw 'isolated validation: the mandatory label changed' }
        return [ordered]@{
            leaf = $leaf
            changed = ($changed -ne $before)
            restoredExactly = ($after -eq $before)
            labelUnchanged = $true
        }
    } finally {
        Assert-OwnedTemp $checkBase 'pidsbx-restore-validate-'
        if (Test-Path -LiteralPath $checkBase) { Remove-Item -LiteralPath $checkBase -Recurse -Force }
    }
}

# --- runner invocation ------------------------------------------------------------------------
function Invoke-Confined([string]$mode, [string[]]$command, [string]$workingDirectory) {
    $argv = @($runnerFull, '--workspace', $workspaceArg, '--temp', $tempFull, '--mode', $mode, '--') + $command
    Push-Location $workingDirectory
    try {
        $output = (& $node @argv 2>&1 | Out-String)
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output.Trim() }
    } finally {
        Pop-Location
    }
}

# --- plan -------------------------------------------------------------------------------------
$plan = [ordered]@{
    mode = if ($Execute) { 'EXECUTE' } else { 'DRY RUN' }
    root = $rootFull
    rootParent = $parentFull
    runner = $runnerFull
    runnerVersion = $manifest.version
    tempRoot = $tempFull
    backupDir = $backupDir
    keepGrant = [bool]$KeepGrant
    steps = @(
        'validate paths (absolute, no reparse, root == repository, parent read-only)'
        'validate the vendored runner (marker, version, patch, PROVENANCE hashes)'
        'validate the DACL-only restore on an isolated same-name directory'
        'back up DACL (Access section), owner/group, label text and the current ACEs'
        'run confined: Get-Location; git --no-optional-locks status --porcelain; create+delete one probe file'
        'assert DACL delta is only the capability ACE + Everyone delete-child deny, label unchanged, no account ACE'
        if ($KeepGrant) { 'keep the grant (backup + restore.ps1 paths are printed)' } else { 'restore the saved DACL and verify it exactly, label and parent unchanged' }
    )
}
$plan | ConvertTo-Json -Depth 4

if (-not $Execute) {
    Write-Host ''
    Write-Host 'DRY RUN: nothing was created, granted or restored. Review the plan, then rerun with -Execute.'
    return
}

# --- execute ----------------------------------------------------------------------------------
New-Item -ItemType Directory -Path $tempFull -Force | Out-Null
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$evidence = [ordered]@{ plan = $plan; startedAtUtc = [DateTime]::UtcNow.ToString('o') }
$granted = $false
$failure = $null
try {
    $evidence.isolatedRestore = Test-RestoreInIsolation
    Write-Host ("PASS  isolated DACL restore: {0}" -f ($evidence.isolatedRestore | ConvertTo-Json -Compress))

    $expectedSidScript = Join-Path $backupDir 'derive-sid.mjs'
    $sidModuleUrl = ([uri]((Join-Path $rootFull 'vendor\dsh-sandbox-windows-acl\lib\workspace-sid.js'))).AbsoluteUri
    $abiModuleUrl = ([uri]((Join-Path $rootFull 'vendor\dsh-sandbox-windows-acl\lib\win32-abi.js'))).AbsoluteUri
    $sidSource = @"
import { realpathSync } from 'node:fs';
import { workspaceWriteSid } from '$sidModuleUrl';
import { GRANT_MASK } from '$abiModuleUrl';
const root = realpathSync.native(process.argv[2]);
console.log(JSON.stringify({ root, sid: workspaceWriteSid(root), grantMask: GRANT_MASK }));
"@
    Set-Content -LiteralPath $expectedSidScript -Value $sidSource -Encoding utf8
    $derived = (& $node $expectedSidScript $rootFull) | ConvertFrom-Json
    $canonicalRoot = $derived.root
    $workspaceArg = $canonicalRoot
    $capabilitySid = $derived.sid
    $evidence.canonicalRoot = $canonicalRoot
    $evidence.expectedCapabilitySid = $capabilitySid

    $beforeDacl = Get-DaclSddl $rootFull
    $beforeFull = Get-FullSddl $rootFull
    $beforeOwner = (Get-Acl -LiteralPath $rootFull).Owner
    $beforeGroup = (Get-Acl -LiteralPath $rootFull).Group
    $beforeLabel = Get-LabelText $rootFull
    $beforeAces = Get-AceRecords $rootFull
    $sampleFile = Join-Path $rootFull 'package.json'
    $sampleBeforeDacl = Get-DaclSddl $sampleFile
    $parentBeforeDacl = Get-DaclSddl $parentFull
    $parentBeforeFull = Get-FullSddl $parentFull
    Set-Content -LiteralPath $daclBackup -Value $beforeDacl -Encoding utf8
    Write-RestoreScript $restoreScript $rootFull $daclBackup
    $evidence.before = [ordered]@{
        daclSddl = $beforeDacl
        fullSddl = $beforeFull
        owner = $beforeOwner
        group = $beforeGroup
        label = $beforeLabel
        aces = @($beforeAces | ForEach-Object { Format-Ace $_ })
    }
    $evidence.parentBefore = [ordered]@{ daclSddl = $parentBeforeDacl; fullSddl = $parentBeforeFull }
    $evidence.sampleFileBefore = [ordered]@{ path = $sampleFile; daclSddl = $sampleBeforeDacl }
    Write-Host "backup: DACL -> $daclBackup"

    $granted = $true
    $location = Invoke-Confined 'workspace-write' @($pwsh, '-NoProfile', '-NonInteractive', '-Command', 'Get-Location') $canonicalRoot
    $evidence.getLocation = $location
    if ($location.ExitCode -ne 0) { throw "confined Get-Location failed (exit $($location.ExitCode)): $($location.Output)" }

    $gitStatus = Invoke-Confined 'workspace-write' @($git, '--no-optional-locks', 'status', '--porcelain') $canonicalRoot
    $evidence.gitStatus = $gitStatus
    if ($gitStatus.ExitCode -ne 0) { throw "confined git status failed (exit $($gitStatus.ExitCode)): $($gitStatus.Output)" }

    $probeFile = Join-Path $canonicalRoot (".pidsbx-realroot-probe-$stamp.txt")
    if (Test-Path -LiteralPath $probeFile) { throw "probe file already exists: $probeFile" }
    $probeCode = "const fs=require('node:fs');const p=process.argv[1];fs.writeFileSync(p,'pi-dsh-sandbox real-root probe');if(!fs.existsSync(p))process.exit(2);fs.rmSync(p);if(fs.existsSync(p))process.exit(3);"
    $probe = Invoke-Confined 'workspace-write' @($node, '-e', $probeCode, $probeFile) $canonicalRoot
    $evidence.probe = $probe
    if ($probe.ExitCode -ne 0) { throw "confined create+delete probe failed (exit $($probe.ExitCode)): $($probe.Output)" }
    if (Test-Path -LiteralPath $probeFile) { throw "probe file was not removed: $probeFile" }

    $afterDacl = Get-DaclSddl $rootFull
    $afterLabel = Get-LabelText $rootFull
    $afterAces = Get-AceRecords $rootFull
    $sampleAfterDacl = Get-DaclSddl $sampleFile
    $beforeSet = @($beforeAces | ForEach-Object { Format-Ace $_ })
    $afterSet = @($afterAces | ForEach-Object { Format-Ace $_ })
    $added = @($afterSet | Where-Object { $beforeSet -notcontains $_ })
    $removed = @($beforeSet | Where-Object { $afterSet -notcontains $_ })
    $evidence.afterGrant = [ordered]@{
        daclSddl = $afterDacl
        label = $afterLabel
        addedAces = $added
        removedAces = $removed
        capabilityAcePresent = [bool](@($afterAces | Where-Object { $_.Sid -eq $capabilitySid -and $_.Type -eq 'Allow' }).Count)
        everyoneDenyPresent = [bool](@($afterAces | Where-Object { $_.Sid -eq 'S-1-1-0' -and $_.Type -eq 'Deny' }).Count)
        sampleFileInheritedCapability = [bool]($sampleAfterDacl -match [regex]::Escape($capabilitySid))
    }
    $evidence.sampleFileAfter = [ordered]@{ path = $sampleFile; daclSddl = $sampleAfterDacl }
    if ($removed.Count -ne 0) { throw "the grant REMOVED existing ACEs (unexpected):`n$($removed -join "`n")" }
    foreach ($line in $added) {
        $parts = $line -split '\|'
        $isCapability = $parts[0] -eq $capabilitySid -and $parts[1] -eq 'Allow' -and [int]$parts[2] -eq $derived.grantMask -and $parts[3] -eq 'ContainerInherit, ObjectInherit' -and $parts[4] -eq 'None' -and $parts[5] -eq 'False'
        $isAmbientDeny = $parts[0] -eq 'S-1-1-0' -and $parts[1] -eq 'Deny' -and $parts[2] -eq '64' -and $parts[3] -eq 'ContainerInherit' -and $parts[4] -eq 'None' -and $parts[5] -eq 'False'
        if (-not ($isCapability -or $isAmbientDeny)) { throw "unexpected added ACE: $line" }
    }
    if (-not $evidence.afterGrant.capabilityAcePresent) { throw "the capability ACE ($capabilitySid) is missing after the grant" }
    if (-not $evidence.afterGrant.everyoneDenyPresent) { throw 'the Everyone delete-child deny is missing after the grant' }
    if (-not $evidence.afterGrant.sampleFileInheritedCapability) { throw 'the capability ACE did not propagate to a child file' }
    if ($afterLabel -ne $beforeLabel) { throw "the Low integrity label changed:`n$($afterLabel)" }
    $accountSid = (New-Object System.Security.Principal.NTAccount("$env:USERDOMAIN\$env:USERNAME")).Translate([System.Security.Principal.SecurityIdentifier]).Value
    $accountAdded = @($added | Where-Object { ($_ -split '\|')[0] -eq $accountSid })
    if ($accountAdded.Count -ne 0) { throw "the grant added an ACE for the running account (permission repair leaked in):`n$($accountAdded -join "`n")" }
    Write-Host "PASS  real grant: added=$($added.Count) removed=0, label unchanged, no account ACE"
} catch {
    $failure = $_
} finally {
    $restoreResult = $null
    try {
        if ($granted -and (-not $KeepGrant -or $failure) -and (Test-Path -LiteralPath $daclBackup)) {
            Invoke-Restore $restoreScript $rootFull $daclBackup
            $restoredDacl = Get-DaclSddl $rootFull
            $restoreResult = [ordered]@{
                daclMatchesBackup = ($restoredDacl -eq $beforeDacl)
                labelUnchanged = ((Get-LabelText $rootFull) -eq $beforeLabel)
                ownerUnchanged = ((Get-Acl -LiteralPath $rootFull).Owner -eq $beforeOwner)
                groupUnchanged = ((Get-Acl -LiteralPath $rootFull).Group -eq $beforeGroup)
                fullSddlUnchanged = ((Get-FullSddl $rootFull) -eq $beforeFull)
                parentDaclUnchanged = ((Get-DaclSddl $parentFull) -eq $parentBeforeDacl)
                parentFullSddlUnchanged = ((Get-FullSddl $parentFull) -eq $parentBeforeFull)
                sampleFileDaclRestored = ((Get-DaclSddl $sampleFile) -eq $sampleBeforeDacl)
            }
            if ($restoreResult.Values -contains $false) { throw "restore verification failed: $($restoreResult | ConvertTo-Json -Compress)" }
            Write-Host 'PASS  restore: DACL identical to backup, owner/group/label and parent unchanged'
        }
    } finally {
        $evidence.restore = $restoreResult
        if ($failure) { $evidence.error = $failure.Exception.Message }
        $evidence.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
        Set-Content -LiteralPath $evidencePath -Value ($evidence | ConvertTo-Json -Depth 8) -Encoding utf8
        Assert-OwnedTemp $tempFull 'pidsbx-realroot-'
        if (Test-Path -LiteralPath $tempFull) { Remove-Item -LiteralPath $tempFull -Recurse -Force -ErrorAction SilentlyContinue }
        Write-Host "evidence: $evidencePath"
        Write-Host "restore:  $restoreScript"
    }
}
if ($failure) { throw $failure }
Write-Host 'REAL-ROOT VERIFICATION PASSED'
