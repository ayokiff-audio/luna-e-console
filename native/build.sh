#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
SDK_PATH="$(xcrun --show-sdk-path)"
CXX="$(xcrun --find clang++)"
TEMP_BUILD="$(mktemp -d /tmp/e-console-native.XXXXXX)"
trap 'rm -rf "$TEMP_BUILD"' EXIT
BUNDLE="$TEMP_BUILD/E Console Analog.component"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
"$CXX" -std=c++17 -O2 -fvisibility=hidden -Wall -Wextra -Wpedantic \
  -Wno-multichar -Wno-deprecated-declarations \
  -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 -isysroot "$SDK_PATH" \
  -bundle -framework AudioToolbox -framework CoreFoundation \
  src/EConsoleAU.cpp -o "$BUNDLE/Contents/MacOS/EConsoleAnalog"
cat > "$BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>EConsoleAnalog</string>
<key>CFBundleIdentifier</key><string>com.econsole.analog.au</string>
<key>CFBundleName</key><string>E Console Analog</string>
<key>CFBundleDisplayName</key><string>E Console Analog</string>
<key>CFBundlePackageType</key><string>BNDL</string>
<key>CFBundleShortVersionString</key><string>0.1.1</string>
<key>CFBundleVersion</key><string>2</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>AudioComponents</key><array><dict>
<key>name</key><string>E Console: E Console Analog</string>
<key>description</key><string>Original console-inspired color, seeded variation, and optional delayed inter-instance crosstalk</string>
<key>manufacturer</key><string>ECns</string>
<key>subtype</key><string>ECA1</string>
<key>type</key><string>aufx</string>
<key>version</key><integer>257</integer>
<key>factoryFunction</key><string>EConsoleFactory</string>
<key>sandboxSafe</key><true/>
<key>resourceUsage</key><dict><key>network.client</key><false/><key>temporary-exception.files.all.read-write</key><false/></dict>
</dict></array>
</dict></plist>
PLIST
xattr -cr "$BUNDLE"
codesign --force --sign - "$BUNDLE"
plutil -lint "$BUNDLE/Contents/Info.plist"
mkdir -p build
rm -rf "build/E Console Analog.component"
ditto --norsrc "$BUNDLE" "build/E Console Analog.component"
"$CXX" -std=c++17 -O2 -Wall -Wextra -Wpedantic -Wno-multichar -Wno-deprecated-declarations \
  -isysroot "$SDK_PATH" tests/dsp_tests.cpp -o build/dsp_tests
"$CXX" -std=c++17 -O2 -Wall -Wextra -Wno-multichar -Wno-deprecated-declarations \
  -isysroot "$SDK_PATH" -framework AudioToolbox -framework CoreFoundation tests/au_host_tests.cpp -o build/au_host_tests
./build/dsp_tests
./build/au_host_tests "build/E Console Analog.component"
