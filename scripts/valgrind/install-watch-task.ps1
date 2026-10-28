#Requires -Version 5.1
<#
.SYNOPSIS
  Registers (or removes) the "Nexus Valgrind Watch" Windows scheduled task.

.DESCRIPTION
  The task runs the repo's valgrind merge watcher inside WSL2:
      wsl.exe [-d <Distro>] -e bash -lc "cd <RepoWslPath> && node scripts/valgrind/watch.mjs --once"
  every -EveryHours hours. The watcher itself decides whether origin/main
  moved; when it has not, the run is a fetch and a one-line log. Reports
  land in <RepoWslPath>/valgrind-out/watch/ (see scripts/valgrind/WATCH.md).

  The task runs only while you are logged on (WSL needs your session),
  does not start a second instance while one is running, and catches up
  after the PC was asleep or off (StartWhenAvailable).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\valgrind\install-watch-task.ps1 -RepoWslPath /home/joey/nexus-engine -EveryHours 6

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\valgrind\install-watch-task.ps1 -RepoWslPath /home/joey/nexus-engine -Distro Ubuntu -EveryHours 12

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\valgrind\install-watch-task.ps1 -Remove
#>
param(
    [string]$RepoWslPath,
    [string]$Distro = "",
    [int]$EveryHours = 6,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"
$TaskName = "Nexus Valgrind Watch"

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    } else {
        Write-Host "No scheduled task named '$TaskName' found."
    }
    return
}

if (-not $RepoWslPath) {
    throw "-RepoWslPath is required: the repo's path INSIDE WSL, e.g. /home/joey/nexus-engine"
}
if ($EveryHours -lt 1) { throw "-EveryHours must be at least 1" }

$bashCmd = "cd $RepoWslPath && node scripts/valgrind/watch.mjs --once"
$wslArgs = @()
if ($Distro) { $wslArgs += @("-d", $Distro) }
$wslArgs += @("-e", "bash", "-lc", "`"$bashCmd`"")

$action = New-ScheduledTaskAction -Execute "wsl.exe" -Argument ($wslArgs -join " ")
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
    -RepetitionInterval (New-TimeSpan -Hours $EveryHours)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 12)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Force `
    -Description "Profiles new origin/main merges with the repo's valgrind gate (memcheck + callgrind). Reports: valgrind-out/watch/ in the repo. Managed by scripts/valgrind/install-watch-task.ps1." | Out-Null

Write-Host "Registered '$TaskName': every $EveryHours hour(s), first run in ~5 minutes."
Write-Host "Reports (WSL path): $RepoWslPath/valgrind-out/watch/latest.md"
