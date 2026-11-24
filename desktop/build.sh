#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/../E Console.app"
STAGE="$(mktemp -d /tmp/e-console-desktop.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/E Console.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/console" "$STAGE/module-cache"
SDK_PATH="$(xcrun --show-sdk-path)"
MODULE_CACHE="${ECONSOLE_SWIFT_CACHE:-$STAGE/module-cache}"
mkdir -p "$MODULE_CACHE"
for ARCH in arm64 x86_64; do
  xcrun swiftc desktop/EConsoleDesktop.swift desktop/ConsoleResourceServer.swift -O -target "$ARCH-apple-macos11.0" \
    -sdk "$SDK_PATH" -module-cache-path "$MODULE_CACHE" \
    -framework AppKit -framework WebKit -framework Network -o "$STAGE/EConsole-$ARCH"
done
lipo -create "$STAGE/EConsole-arm64" "$STAGE/EConsole-x86_64" -output "$APP/Contents/MacOS/EConsole"
for FILE in console.html console.css console.js logic.js companion.js demo.js; do
  cp "$FILE" "$APP/Contents/Resources/console/$FILE"
done
mkdir -p "$APP/Contents/Resources/console/vendor"
for FILE in luna.global.js LUNA-SDK-LICENSE LUNA-SDK-NOTICE; do
  cat "vendor/$FILE" > "$APP/Contents/Resources/console/vendor/$FILE"
done
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>EConsole</string>
<key>CFBundleIdentifier</key><string>com.econsole.desktop</string>
<key>CFBundleName</key><string>E Console</string>
<key>CFBundleDisplayName</key><string>E Console</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.1</string>
<key>CFBundleVersion</key><string>21</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
plutil -lint "$APP/Contents/Info.plist"
xattr -cr "$APP"
codesign --force --sign - "$APP"
if [ -d "$OUT" ]; then rm -rf "$OUT"; fi
ditto --norsrc "$APP" "$OUT"
ditto --norsrc -c -k --keepParent "$APP" "$ROOT/../E Console Desktop.zip"
codesign --verify --deep --strict "$APP"
printf '%s\n' 'Built universal E Console.app and E Console Desktop.zip.'
