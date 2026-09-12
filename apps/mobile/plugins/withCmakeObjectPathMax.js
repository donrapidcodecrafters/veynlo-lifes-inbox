const { withProjectBuildGradle } = require("@expo/config-plugins");

// CMake refuses to emit an object file whose full path exceeds CMAKE_OBJECT_PATH_MAX, which defaults to
// 250 on Windows. pnpm's store layout puts native modules at
// node_modules/.pnpm/<pkg>@<version>_<hash>/node_modules/<pkg>/..., which alone costs 74 characters —
// react-native-worklets' object directory lands at 215 characters before any object filename is appended.
// The build then fails with a wall of "cannot be safely placed under this directory" warnings followed by
// `ninja: error: manifest 'build.ninja' still dirty after 100 tries`.
//
// This is CMake's OWN ceiling and is unrelated to Windows' MAX_PATH: enabling LongPathsEnabled in the
// registry does not change it (verified — the identical failure persisted with long paths on).
//
// Applied as a config plugin rather than by editing android/build.gradle directly because android/ is
// generated and gitignored (Expo CNG), so a direct edit is destroyed by the next `expo prebuild`.
//
// Uses `plugins.withId` rather than `afterEvaluate`: expo-root-project and com.facebook.react.rootproject
// have already evaluated the subprojects by the time this block runs, so an afterEvaluate hook throws
// "Cannot run Project.afterEvaluate(Closure) when the project is already evaluated".
// CMAKE_OBJECT_PATH_MAX alone was NOT sufficient — it governs how CMake names object files, not the
// directories ninja creates, so the build still failed with:
//   ninja: error: Stat(.../RNCSafeAreaViewShadowNode.cpp.o): Filename longer than 260 characters
// CMake mirrors every source file's ABSOLUTE path underneath the build directory, and by default that
// build directory sits INSIDE the already-deep node_modules tree, so the long path is paid twice.
// Relocating only the staging directory to a very short root buys back ~240 characters of headroom.
//
// The root must be genuinely short, not short-ish. Measured on this project: reanimated's deepest source
// file is 207 characters and the mirror adds ~232 on top of the staging root, so anything at or above 28
// characters overflows — "C:/cx/react-native-reanimated" is 29 and failed by a single character. A hex
// hash of the module name keeps every root at ~13 characters and stays deterministic between builds.
//
// This is necessary but still not sufficient on its own: the workspace also needs `node-linker=hoisted`
// (see the repo-root .npmrc), because pnpm's default .pnpm/<pkg>@<ver>_<32-char-hash>/ layout wastes a
// further ~85 characters inside every mirrored path.
const MARKER = "CMAKE_OBJECT_PATH_MAX";

const SNIPPET = `
subprojects { sp ->
  ["com.android.library", "com.android.application"].each { pid ->
    sp.plugins.withId(pid) {
      sp.android.defaultConfig.externalNativeBuild.cmake.arguments "-DCMAKE_OBJECT_PATH_MAX=4096"
      if (System.getProperty("os.name").toLowerCase().contains("windows")) {
        sp.android.externalNativeBuild.cmake.buildStagingDirectory =
            new File("C:/x/" + Integer.toHexString(sp.name.hashCode()))
      }
    }
  }
}
`;

module.exports = function withCmakeObjectPathMax(config) {
  return withProjectBuildGradle(config, (config) => {
    if (config.modResults.language !== "groovy") {
      throw new Error("withCmakeObjectPathMax: expected a Groovy android/build.gradle.");
    }
    if (config.modResults.contents.includes(MARKER)) return config;

    // Must be inserted BEFORE the root plugins are applied — see the afterEvaluate note above.
    const anchor = 'apply plugin: "expo-root-project"';
    if (!config.modResults.contents.includes(anchor)) {
      throw new Error(`withCmakeObjectPathMax: could not find '${anchor}' in android/build.gradle.`);
    }
    config.modResults.contents = config.modResults.contents.replace(anchor, `${SNIPPET}\n${anchor}`);
    return config;
  });
};
