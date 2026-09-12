# Builds a signed release APK locally - no EAS, no credits, no expiry.
#
# Requires (installed once by scripts/setup-toolchain.ps1):
#   JDK 17           D:\toolchain\jdk-17*      (shared with other projects)
#   Android SDK      D:\android-sdk            (shared with other projects)
#   Release keystore mobile\credentials\bachat-release.keystore  (Bachat-only, irreplaceable)
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/build-apk.ps1
#         (or: npm run apk)
#
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 files as ANSI, so a
# stray unicode dash or quote turns the whole script into a parser error.

$ErrorActionPreference = 'Stop'

$mobile = Split-Path $PSScriptRoot -Parent
$jdk = (Get-ChildItem 'D:\toolchain' -Directory -Filter 'jdk-17*' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
if (-not $jdk) { throw 'JDK 17 not found in D:\toolchain. Run scripts/setup-toolchain.ps1 first.' }

$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = 'D:\android-sdk'
$env:ANDROID_SDK_ROOT = 'D:\android-sdk'
$env:PATH = "$jdk\bin;$env:PATH"

$keystore = Join-Path $mobile 'credentials\bachat-release.keystore'
if (-not (Test-Path $keystore)) {
  throw "Release keystore missing at $keystore. Run scripts/setup-toolchain.ps1 to create it. Never delete it: updates must be signed with the same key."
}

# The native project is generated (android/ is gitignored). Prebuild on every
# run so app.json config (orientation, icons, permissions) always reaches the
# manifest -- a stale android/ silently ignored those edits. --clean only when
# the directory is absent, so incremental Gradle caches survive.
Push-Location $mobile
if (Test-Path (Join-Path $mobile 'android\gradlew.bat')) {
  npx expo prebuild --platform android
} else {
  npx expo prebuild --platform android --clean
}
$prebuildExit = $LASTEXITCODE
Pop-Location
if ($prebuildExit -ne 0) { throw "expo prebuild failed with exit code $prebuildExit" }

& (Join-Path $PSScriptRoot 'apply-signing.ps1')

$androidDir = Join-Path $mobile 'android'
$gradlew = Join-Path $androidDir 'gradlew.bat'
# Push-Location does not move the process working directory, so gradle gets the
# project directory explicitly.
& $gradlew '-p' $androidDir ':app:assembleRelease' '--no-daemon'
if ($LASTEXITCODE -ne 0) { throw "Gradle failed with exit code $LASTEXITCODE" }

$apk = Join-Path $mobile 'android\app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path $apk)) { throw 'Build reported success but no APK was produced.' }

$out = Join-Path $mobile 'build\Bachat-release.apk'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
Copy-Item $apk $out -Force

# ---------------------------------------------------------- Verify signature
# Silently shipping a debug-signed APK is the single worst failure mode of
# this pipeline: it installs fine, looks fine, and simply can never update an
# existing Bachat install (or gets rejected outright once one does exist).
# Verify automatically rather than relying on the developer remembering to
# check by hand.
$buildTools = Get-ChildItem 'D:\android-sdk\build-tools' -Directory -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending | Select-Object -First 1
if (-not $buildTools) { throw 'No Android build-tools found under D:\android-sdk\build-tools - run scripts/setup-toolchain.ps1.' }

$apksigner = Join-Path $buildTools.FullName 'apksigner.bat'
if (-not (Test-Path $apksigner)) { throw "apksigner.bat not found at $apksigner" }

$verifyOutput = & $apksigner 'verify' '--print-certs' $out 2>&1
$verifyExit = $LASTEXITCODE
Write-Host ''
Write-Host '--- apksigner verify --print-certs ---'
$verifyOutput | ForEach-Object { Write-Host $_ }
Write-Host '---------------------------------------'

# Flatten to ONE string before matching. `2>&1` makes $verifyOutput an array,
# and on an array `-match`/`-notmatch` are FILTERS returning the matching
# elements, not booleans -- so `if ($verifyOutput -notmatch 'CN=Bachat')` was
# true for any output containing at least one line without that substring
# (every digest line), and rejected correctly signed APKs every time.
$verifyText = ($verifyOutput | Out-String)

if ($verifyExit -ne 0) {
  throw "apksigner could not verify the signature on $out (exit code $verifyExit). The APK is not safely installable."
}
if ($verifyText -match 'CN=Android Debug') {
  throw "REFUSING TO SHIP: $out is signed with the Android DEBUG key, not the Bachat release key. This build cannot update an existing Bachat install. Check that scripts/apply-signing.ps1 ran and found the BACHAT_UPLOAD_* properties -- see its output above the Gradle build."
}
if ($verifyText -notmatch 'CN=Bachat') {
  throw "REFUSING TO SHIP: $out was not signed with the expected Bachat release certificate (no 'CN=Bachat' in apksigner output above). Verify credentials\keystore.env.json matches credentials\bachat-release.keystore."
}

$size = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host ''
Write-Host ('APK: ' + $out + ' (' + $size + ' MB)')
Write-Host 'Signature verified: Bachat release key.'
Write-Host ('Install with: adb install -r "' + $out + '"')
