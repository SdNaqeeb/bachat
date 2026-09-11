# One-time setup for building release APKs locally (no Android Studio, no admin).
#
# Reuses machine-wide toolchain shared with other projects (e.g. IntelliVault):
#   D:\toolchain\jdk-17*   Temurin JDK 17 (zip, no installer) - globbed, not version-pinned
#   D:\android-sdk         Android SDK: platform-tools, platforms;android-36, build-tools;36.0.0
# Creates Bachat-specific state:
#   mobile\credentials\    Bachat release keystore + its passwords (gitignored, irreplaceable)
#
# Safe to re-run: every step is skipped when already present. Never regenerates
# an existing keystore - doing so would make future builds unable to update an
# already-installed Bachat APK.

$ErrorActionPreference = 'Stop'

$mobile = Split-Path $PSScriptRoot -Parent
$toolchain = 'D:\toolchain'
$sdk = 'D:\android-sdk'

# ---------------------------------------------------------------- JDK 17
# Shared with other projects on this machine - reuse if present, do not
# reinstall or duplicate.
$jdk = (Get-ChildItem $toolchain -Directory -Filter 'jdk-17*' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
if (-not $jdk) {
  New-Item -ItemType Directory -Force $toolchain | Out-Null
  $zip = "$env:TEMP\jdk17.zip"
  Invoke-WebRequest -UseBasicParsing -OutFile $zip `
    -Uri 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse'
  Expand-Archive -Path $zip -DestinationPath $toolchain -Force
  $jdk = (Get-ChildItem $toolchain -Directory -Filter 'jdk-17*' | Select-Object -First 1).FullName
}
$env:JAVA_HOME = $jdk
$env:PATH = "$jdk\bin;$env:PATH"
Write-Host "JDK (shared): $jdk"

# ------------------------------------------------------------ Android SDK
# Also shared with other projects - reuse if present, do not reinstall.
if (-not (Test-Path "$sdk\cmdline-tools\latest\bin\sdkmanager.bat")) {
  New-Item -ItemType Directory -Force "$sdk\cmdline-tools" | Out-Null
  $zip = "$env:TEMP\cmdline-tools.zip"
  Invoke-WebRequest -UseBasicParsing -OutFile $zip `
    -Uri 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'
  Expand-Archive -Path $zip -DestinationPath "$sdk\tmp" -Force
  Move-Item "$sdk\tmp\cmdline-tools" "$sdk\cmdline-tools\latest"
  Remove-Item -Recurse -Force "$sdk\tmp"
}
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk

# Accept the SDK licences by writing their hashes: sdkmanager --licenses is
# interactive and its .bat wrapper does not read piped stdin reliably on
# Windows. Safe to rewrite even if the SDK is already shared with another
# project - same licence hashes, idempotent.
$licenses = Join-Path $sdk 'licenses'
New-Item -ItemType Directory -Force $licenses | Out-Null
@{
  'android-sdk-license' = "8933bad161af4178b1185d1a37fbf41ea5269c55`nd56f5187479451eabf01fb78af6dfcb131a6481e`n24333f8a63b6825ea9c5514f83c2829b004d1fee"
  'android-sdk-preview-license' = '84831b9409646a918e30573bab4c9c91346d8abd'
  'android-sdk-arm-dbt-license' = '859f317696f67ef3d7f30a50a5560e7834b43903'
  'android-googletv-license' = '601085b94cd77f0b54ff86406957099ebe79c4d6'
  'google-gdk-license' = '33b6a2b64607f11b759f320ef9dff4ae5c47d97a'
  'mips-android-sysimage-license' = 'e9acab5b5fbb560a72cfaecce8946896ff6aab9d'
}.GetEnumerator() | ForEach-Object {
  Set-Content -Path (Join-Path $licenses $_.Key) -Value $_.Value -NoNewline -Encoding ascii
}

& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --install "platform-tools" "platforms;android-36" "build-tools;36.0.0" "platforms;android-35" "build-tools;35.0.0"
Write-Host "Android SDK (shared): $sdk"

if (-not (Test-Path "$sdk\platforms\android-36")) {
  throw "Android SDK licences were not accepted - sdkmanager exits 0 but installs nothing in that case. Check $licenses and re-run."
}

# ------------------------------------------------------------- Keystore
# THE KEYSTORE IS IRREPLACEABLE. Bachat gets its own keystore and alias -
# never reuse another project's. An update signed with a different key can
# never install over an existing Bachat install; only uninstall/reinstall
# would work, and the user would lose all local app data.
$credentials = Join-Path $mobile 'credentials'
$keystore = Join-Path $credentials 'bachat-release.keystore'
$envFile = Join-Path $credentials 'keystore.env.json'

if (-not (Test-Path $keystore)) {
  New-Item -ItemType Directory -Force $credentials | Out-Null
  $password = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 28 | ForEach-Object { [char]$_ })
  & "$jdk\bin\keytool.exe" -genkeypair -v `
    -keystore $keystore -alias bachat -keyalg RSA -keysize 2048 -validity 10000 `
    -storepass $password -keypass $password `
    -dname "CN=Bachat, OU=SmartLearners, O=SmartLearners.ai, L=Hyderabad, S=Telangana, C=IN"
  @{ keyAlias = 'bachat'; storePassword = $password; keyPassword = $password } |
    ConvertTo-Json | Set-Content -Path $envFile -Encoding utf8
  Write-Host "Keystore created: $keystore"
  Write-Host ""
  Write-Host "BACK THIS UP NOW: $credentials"
  Write-Host "It is gitignored and irreplaceable. Copy it outside the repo (external drive, password manager) before you forget."
} else {
  Write-Host "Keystore already present: $keystore"
}

Write-Host ""
Write-Host "Toolchain ready. Build with: npm run apk"
