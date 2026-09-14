#!/usr/bin/env bash
# Builds apps/mobile's Android APK inside the Linux container (see the Dockerfile for why this cannot run
# natively on Windows). Run by build-android.ps1; not usually invoked by hand.
#
# The repo is mounted READ-ONLY at /src and copied to /work. That matters: the host's node_modules holds
# Windows-native binaries and the host's android/ holds Windows paths, so installing over them would both
# corrupt the Windows checkout and poison this build. Nothing here writes to /src.
set -euo pipefail

VARIANT="${1:-assembleDebug}"

echo "==> Copying source (excluding node_modules and generated native dirs)"
rsync -a \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'apps/mobile/android' \
  --exclude 'apps/mobile/ios' \
  --exclude '**/.next' \
  --exclude '**/dist' \
  --exclude '**/target' \
  --exclude 'infrastructure/docker/volumes' \
  /src/ /work/

cd /work

echo "==> pnpm install (Linux binaries, isolated from the host tree)"
pnpm install --frozen-lockfile

echo "==> Building shared workspace packages"
pnpm --filter "./packages/*" run build

echo "==> expo prebuild (generates a fresh android/ for Linux paths)"
cd /work/apps/mobile
npx expo prebuild --platform android --no-install --clean

echo "==> gradle $VARIANT"
cd /work/apps/mobile/android
chmod +x ./gradlew
./gradlew "$VARIANT" --console=plain --no-daemon

echo "==> Collecting APKs"
mkdir -p /out
find /work/apps/mobile/android/app/build/outputs/apk -name '*.apk' -print -exec cp {} /out/ \;
ls -la /out
echo "==> Done"
