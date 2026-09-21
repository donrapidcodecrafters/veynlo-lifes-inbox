# Android build image — exists so apps/mobile can be built for Android FROM A WINDOWS HOST.
#
# Why this is needed: React Native compiles native C++ through CMake + ninja. CMake mirrors each module's
# full path *inside its own build directory*, so an object path is roughly (build dir + that module path
# again). pnpm's store layout makes the module path ~118 characters, and doubled that exceeds Windows'
# 260-character limit. The Android SDK's bundled ninja.exe is not long-path aware, so its mkdir() fails
# outright — enabling LongPathsEnabled does not rescue it (verified with the registry key set to 1), a
# hoisted node_modules layout does not either (Expo's autolinking resolves back through to the .pnpm store
# regardless of expo.autolinking.searchPaths), and neither does relocating the repo to a short root.
#
# Linux has no such limit, so the build runs here and only the APK crosses back to Windows. The emulator
# still runs natively on Windows; `adb install` puts this artifact onto it.
FROM eclipse-temurin:17-jdk-jammy

ENV ANDROID_SDK_ROOT=/opt/android-sdk \
    ANDROID_HOME=/opt/android-sdk \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip git ca-certificates python3 rsync \
 && rm -rf /var/lib/apt/lists/*

# Node 20 (the repo's engines floor) + the exact pnpm the repo pins.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g pnpm@10.26.2 \
 && rm -rf /var/lib/apt/lists/*

# Android command-line tools.
RUN mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools" \
 && cd /tmp \
 && curl -fsSLo cmdline.zip https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip \
 && unzip -q cmdline.zip \
 && mv cmdline-tools "$ANDROID_SDK_ROOT/cmdline-tools/latest" \
 && rm cmdline.zip

ENV PATH="${PATH}:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools"

# Versions match what apps/mobile actually resolves (expo-root-project's defaults for Expo SDK 57 /
# React Native 0.86): NDK 27.1.12297006, build-tools 36.0.0, CMake 3.22.1.
RUN yes | sdkmanager --licenses > /dev/null \
 && sdkmanager --install \
      "platform-tools" \
      "platforms;android-36" \
      "platforms;android-35" \
      "build-tools;36.0.0" \
      "ndk;27.1.12297006" \
      "cmake;3.22.1" \
 && rm -rf "$ANDROID_SDK_ROOT/.temp" /root/.android

WORKDIR /work
