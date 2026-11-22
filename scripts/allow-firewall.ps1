﻿﻿﻿<#
  学涯集市 · Windows 防火墙放行脚本
  作用：允许同一局域网内的其他电脑通过 TCP 端口访问本机服务。
  用法（需要管理员权限的 PowerShell）：
    powershell -ExecutionPolicy Bypass -File scripts\allow-firewall.ps1
    powershell -ExecutionPolicy Bypass -File scripts\allow-firewall.ps1 -Port 3301
    powershell -ExecutionPolicy Bypass -File scripts\allow-firewall.ps1 -Remove
#>
param(
  [int]$Port = 3300,
  [switch]$Remove
)

$ruleName = "学涯集市 TCP $Port"

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "需要管理员权限。请右键「Windows PowerShell」选择「以管理员身份运行」后重试。" -ForegroundColor Yellow
  exit 1
}

if ($Remove) {
  $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if ($existing) {
    Remove-NetFirewallRule -DisplayName $ruleName
    Write-Host "已删除防火墙规则：$ruleName" -ForegroundColor Green
  } else {
    Write-Host "未找到防火墙规则：$ruleName" -ForegroundColor Yellow
  }
  exit 0
}

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "防火墙规则已存在：$ruleName" -ForegroundColor Green
} else {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Private, Domain | Out-Null
  Write-Host "已放行入站 TCP $Port（仅专用/域网络）" -ForegroundColor Green
}

$addresses = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -ExpandProperty IPAddress

if ($addresses) {
  Write-Host ""
  Write-Host "同一局域网内的其他电脑可访问：" -ForegroundColor Cyan
  foreach ($ip in $addresses) { Write-Host "  http://${ip}:$Port" }
} else {
  Write-Host "未检测到可用的局域网 IPv4 地址，请检查网络连接。" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "提示：若当前网络被 Windows 识别为「公用网络」，请在「设置 → 网络和 Internet」中改为「专用网络」，否则规则不生效。"
