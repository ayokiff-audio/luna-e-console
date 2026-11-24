#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
SOURCE_BUNDLE='native/build/E Console Analog.component'
TARGET_FOLDER="${ECONSOLE_COMPONENTS_DIR:-$HOME/Library/Audio/Plug-Ins/Components}"
TARGET_BUNDLE="$TARGET_FOLDER/E Console Analog.component"
if [ ! -d "$SOURCE_BUNDLE" ]; then printf '%s\n' 'The compiled companion is missing. Run bash native/build.sh first.'; exit 1; fi
CLEAN_TEMP="$(mktemp -d /tmp/e-console-install.XXXXXX)"
trap 'rm -rf "$CLEAN_TEMP"' EXIT
ditto --norsrc "$SOURCE_BUNDLE" "$CLEAN_TEMP/E Console Analog.component"
codesign --verify --deep --strict "$CLEAN_TEMP/E Console Analog.component"
mkdir -p "$TARGET_FOLDER"
if [ -e "$TARGET_BUNDLE" ]; then mv "$TARGET_BUNDLE" "$TARGET_BUNDLE.backup-$(date +%Y%m%d-%H%M%S)-$$"; fi
ditto --norsrc "$CLEAN_TEMP/E Console Analog.component" "$TARGET_BUNDLE"
codesign --verify --deep --strict "$TARGET_BUNDLE"
printf '%s\n' 'E Console Analog is installed. Restart LUNA and rescan Audio Units.'
printf '%s\n' 'Development preview: verify latency compensation and offline bounce in a test session.'
