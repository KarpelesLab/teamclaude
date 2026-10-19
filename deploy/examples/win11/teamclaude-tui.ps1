# Runs INSIDE WSL tmux session "ykw-tc": the ykw teamclaude gateway (127.0.0.1:3456) WITH its live
# screen (accounts + activity), same as europa's `tc` session. Restarts 2s after any exit (including
# pressing q in the screen). Started by .harness\teamclaude-server.ps1 (task "ykw-teamclaude").
$ErrorActionPreference = 'Continue'
$Host.UI.RawUI.WindowTitle = 'ykw-tc'
$dir = "$env:USERPROFILE\gh\teamclaude"
$log = "$env:USERPROFILE\.teamclaude\logs\server.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
$env:TEAMCLAUDE_DISABLE_AUTOUPDATE = '1'
$env:NODE_OPTIONS = '--dns-result-order=ipv4first'
Set-Location $dir
while ($true) {
  Add-Content $log "[$(Get-Date -AsUTC -Format s)Z] starting teamclaude server (live screen in tmux ykw-tc)"
  & node "$dir\src\index.js" server --auto-fallback --activity-log "$env:USERPROFILE\.teamclaude-activity.log"
  Add-Content $log "[$(Get-Date -AsUTC -Format s)Z] teamclaude server exited rc=$LASTEXITCODE; restarting in 2s"
  Start-Sleep -Seconds 2
}
