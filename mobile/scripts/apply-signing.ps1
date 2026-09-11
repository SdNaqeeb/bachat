# Points the generated android/ project at the persistent Bachat release keystore.
#
# android/ is gitignored and rewritten by `expo prebuild`, so this runs after
# every prebuild. It appends the signing properties to android/gradle.properties;
# app/build.gradle reads them (see the `release` signingConfig).
#
# WARNING - fragile by nature: the build.gradle patch below matches literal
# text from Expo's generated template. If Expo changes that template in a
# future SDK version, the match will stop and this script throws instead of
# silently leaving a debug-signed APK. If you hit one of the "could not find"
# errors below after an Expo/SDK upgrade, open android/app/build.gradle,
# find the current debug signingConfigs block and release signingConfig line,
# and update $debugBlock / $oldReleaseLine to match.

$ErrorActionPreference = 'Stop'

$mobile = Split-Path $PSScriptRoot -Parent
$props = Join-Path $mobile 'android\gradle.properties'
$keystore = Join-Path $mobile 'credentials\bachat-release.keystore'
$envFile = Join-Path $mobile 'credentials\keystore.env.json'

if (-not (Test-Path $props)) { throw 'android/gradle.properties not found - run: npx expo prebuild --platform android' }
if (-not (Test-Path $keystore)) { throw "Keystore not found at $keystore - run scripts/setup-toolchain.ps1 first." }
if (-not (Test-Path $envFile)) { throw "Keystore credentials not found at $envFile - run scripts/setup-toolchain.ps1 first." }

$creds = Get-Content $envFile -Raw | ConvertFrom-Json

$existing = Get-Content $props -Raw
if ($existing -notmatch 'BACHAT_UPLOAD_STORE_FILE') {
  $block = @"

# --- Bachat release signing (added by scripts/apply-signing.ps1) ---
BACHAT_UPLOAD_STORE_FILE=$($keystore -replace '\\', '/')
BACHAT_UPLOAD_STORE_PASSWORD=$($creds.storePassword)
BACHAT_UPLOAD_KEY_ALIAS=$($creds.keyAlias)
BACHAT_UPLOAD_KEY_PASSWORD=$($creds.keyPassword)
"@

  Add-Content -Path $props -Value $block -Encoding utf8
  Write-Host 'Release signing properties wired into android/gradle.properties.'
} else {
  Write-Host 'Signing properties already present in android/gradle.properties.'
}

# The generated app/build.gradle ships with only a debug signingConfig and the
# release buildType falls back to it. Patch a real `release` signingConfig that
# reads the four BACHAT_UPLOAD_* props (falling back to the debug key when
# they are absent). Idempotent: prebuild reapplies the template every run, so
# this re-patches each time.
$gradle = Join-Path $mobile 'android\app\build.gradle'
if (-not (Test-Path $gradle)) { throw 'android/app/build.gradle not found - run: npx expo prebuild --platform android' }

$app = Get-Content $gradle -Raw
# Windows PowerShell splits a BOM into the first content char; Gradle chokes on
# it, so strip it and always write back without a BOM.
$app = $app -replace ('^' + [regex]::Escape([char]0xFEFF)), ''

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if ($app -match 'BACHAT_UPLOAD_STORE_FILE') {
  [System.IO.File]::WriteAllText($gradle, $app, $utf8NoBom)
  Write-Host 'Release signingConfig already wired into android/app/build.gradle.'
  exit 0
}

$debugBlock = @"
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
"@
$releaseBlock = @"
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        release {
            if (project.hasProperty('BACHAT_UPLOAD_STORE_FILE')) {
                storeFile file(BACHAT_UPLOAD_STORE_FILE)
                storePassword BACHAT_UPLOAD_STORE_PASSWORD
                keyAlias BACHAT_UPLOAD_KEY_ALIAS
                keyPassword BACHAT_UPLOAD_KEY_PASSWORD
            } else {
                storeFile file('debug.keystore')
                storePassword 'android'
                keyAlias 'androiddebugkey'
                keyPassword 'android'
            }
        }
    }
"@
if (-not $app.Contains($debugBlock)) {
  throw @"
FAILED to patch android/app/build.gradle: the expected signingConfigs debug
block was not found (this script matches Expo's generated template literally,
and it may have changed). Refusing to continue rather than risk shipping a
debug-signed release APK.

Open android\app\build.gradle, locate the current 'signingConfigs { debug { ... } }'
block inside android { }, and update the `debugBlock` variable in
scripts\apply-signing.ps1 to match it exactly, then re-run.
"@
}
$app = $app.Replace($debugBlock, $releaseBlock)

$oldReleaseLine = @"
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
"@
$newReleaseLine = @"
            signingConfig signingConfigs.release
"@
if (-not $app.Contains($oldReleaseLine)) {
  throw @"
FAILED to patch android/app/build.gradle: the expected 'signingConfig
signingConfigs.debug' line under buildTypes.release was not found (this
script matches Expo's generated template literally, and it may have changed).
Refusing to continue rather than risk shipping a debug-signed release APK.

Open android\app\build.gradle, find the release buildType's signingConfig
line, and update the `oldReleaseLine` variable in scripts\apply-signing.ps1
to match it exactly, then re-run.
"@
}
$app = $app.Replace($oldReleaseLine, $newReleaseLine)

[System.IO.File]::WriteAllText($gradle, $app, $utf8NoBom)
Write-Host 'Release signingConfig wired into android/app/build.gradle.'
