<#
  Xueya Market - upload and deploy from Windows to a Linux host.

  Usage:
    powershell -ExecutionPolicy Bypass -File deploy\upload.ps1 -Server 1.2.3.4 -SshUser root
    powershell -ExecutionPolicy Bypass -File deploy\upload.ps1 -Server example.com -SshUser ubuntu -KeyPath $HOME\.ssh\id_ed25519
    powershell -ExecutionPolicy Bypass -File deploy\upload.ps1 -Server 1.2.3.4 -SshUser root -PackOnly

  What it does:
    1. Pack the project (excluding node_modules / data / .git / logs) into a .tar.gz
    2. scp the archive to the remote home directory
    3. ssh: extract into RemoteDir, then run deploy/install.sh (Docker Compose)
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$SshUser = 'root',
  [int]$SshPort = 22,
  [string]$KeyPath = '',
  [string]$RemoteDir = '/opt/xueya',
  [switch]$PackOnly,
  [switch]$SkipDeploy
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Archive = Join-Path ([System.IO.Path]::GetTempPath()) "xueya-$Stamp.tar.gz"
$RemoteArchive = "xueya-deploy.tar.gz"

function Write-Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

foreach ($cmd in 'tar', 'scp', 'ssh') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Fail "missing command: $cmd (install OpenSSH Client)" }
}
foreach ($file in 'docker-compose.yml', 'Dockerfile', 'deploy/public-demo.env') {
  if (-not (Test-Path (Join-Path $ProjectRoot $file))) { Fail "missing required file: $file" }
}

Write-Step "packing $ProjectRoot"
tar -czf $Archive `
  --exclude=node_modules `
  --exclude=data `
  --exclude=.git `
  --exclude=.vscode `
  --exclude=deploy/backups `
  --exclude='*.log' `
  --exclude='tests/artifacts' `
  -C $ProjectRoot .
if ($LASTEXITCODE -ne 0) { Fail "tar failed" }
$sizeMb = [math]::Round((Get-Item $Archive).Length / 1MB, 2)
Write-Host "archive: $Archive ($sizeMb MB)"

if ($PackOnly) { Write-Host "PackOnly set, stop here."; exit 0 }

$commonOpts = @('-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30')
if ($KeyPath) {
  if (-not (Test-Path $KeyPath)) { Fail "key not found: $KeyPath" }
  $commonOpts += @('-i', $KeyPath)
}
$sshOpts = $commonOpts + @('-p', "$SshPort")
$scpOpts = $commonOpts + @('-P', "$SshPort")
$target = "$SshUser@$Server"

Write-Step "uploading to ${target}:~/$RemoteArchive"
& scp @scpOpts $Archive "${target}:~/$RemoteArchive"
if ($LASTEXITCODE -ne 0) { Fail "scp failed (check host, user, port, key or password)" }

if ($SkipDeploy) { Write-Host "SkipDeploy set, archive uploaded only."; exit 0 }

Write-Step "deploying on $Server"
$remote = "set -e; sudo mkdir -p $RemoteDir; sudo tar -xzf ~/$RemoteArchive -C $RemoteDir; sudo chown -R `$USER:`$USER $RemoteDir; cd $RemoteDir; sudo bash deploy/install.sh"
& ssh @sshOpts -t $target $remote
$code = $LASTEXITCODE
Remove-Item $Archive -Force -ErrorAction SilentlyContinue
if ($code -ne 0) { Fail "remote deploy failed (exit $code)" }

Write-Step "done"
Write-Host "access: http://$Server/ (or mapped port, see deploy/install.sh output)"
