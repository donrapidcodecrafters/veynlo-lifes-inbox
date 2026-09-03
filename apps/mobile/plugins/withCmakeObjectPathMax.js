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
const MARKER = "CMAKE_OBJECT_PATH_MAX";

const SNIPPET = `
subprojects { sp ->
  ["com.android.library", "com.android.application"].each { pid ->
    sp.plugins.withId(pid) {
      sp.android.defaultConfig.externalNativeBuild.cmake.arguments "-DCMAKE_OBJECT_PATH_MAX=4096"
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
