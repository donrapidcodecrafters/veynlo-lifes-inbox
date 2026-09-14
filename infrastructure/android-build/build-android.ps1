# Builds apps/mobile's Android APK on a Windows host, by doing the actual compilation inside a Linux
# container. See Dockerfile for the full reasoning; the short version is that CMake mirrors module paths
# inside its own build directory, doubling them past Windows' 260-character limit, and the Android SDK's
# ninja.exe is not long-path aware.
#
#   .\build-android.ps1                 # debug APK
#   .\build-android.ps1 assembleRelease # release APK (unsigned)
#   .\build-android.ps1 -Install        # build a debug APK and adb install it to a running emulator
[CmdletBinding()]
param(
  [string]$Variant = "assembleDebug",
  [switch]$Install
)

# Deliberately NOT "Stop": docker writes ordinary build progress to stderr, and Windows PowerShell wraps
# every native-command stderr line in an ErrorRecord — with ErrorActionPreference=Stop that aborts the
# script on output that isn't an error at all. Correctness comes from checking $LASTEXITCODE below.
$ErrorActionPreference = "Continue"
$repoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$outDir = Join-Path $repoRoot "apps\mobile\build-output"
$image = "veynlo-android-build:latest"

Write-Host "Repo root : $repoRoot"
Write-Host "Output    : $outDir"

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Write-Host "`n=== Building the image (cached after the first run) ==="
docker build -t $image $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

Write-Host "`n=== Building $Variant in the container ==="
# /src is read-only on purpose: the host checkout must not be modified by the Linux build.
docker run --rm `
  -v "${repoRoot}:/src:ro" `
  -v "${outDir}:/out" `
  $image bash /src/infrastructure/android-build/build-apk.sh $Variant
if ($LASTEXITCODE -ne 0) { throw "android build failed" }

Write-Host "`n=== APKs ==="
Get-ChildItem $outDir -Filter *.apk | ForEach-Object {
  "{0}  {1:N1} MB" -f $_.Name, ($_.Length / 1MB)
}

if ($Install) {
  $adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
  $apk = Get-ChildItem $outDir -Filter "*debug*.apk" | Select-Object -First 1
  if (-not $apk) { $apk = Get-ChildItem $outDir -Filter *.apk | Select-Object -First 1 }
  if (-not $apk) { throw "no APK produced" }
  Write-Host "`n=== Installing $($apk.Name) to the running emulator ==="
  & $adb install -r $apk.FullName
}
