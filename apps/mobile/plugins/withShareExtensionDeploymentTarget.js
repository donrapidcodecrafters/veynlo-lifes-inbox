const { withXcodeProject } = require("@expo/config-plugins");

// expo-share-extension's own generated Xcode target pins its Debug/Release build settings to
// IPHONEOS_DEPLOYMENT_TARGET 15.1 (the plugin has no option to configure this). That's lower than
// ExpoDomWebView's real minimum (16.4, pulled in transitively via @expo/ui, which every target that
// autolinks Expo modules gets a shared ExpoModulesProvider.swift for) — so the extension target fails to
// compile with "compiling for iOS 15.1, but module 'ExpoDomWebView' has a minimum deployment target of
// iOS 16.4". Runs after expo-share-extension in app.json's plugin list specifically to correct this.
const TARGET_NAME = "VeynloShareExtension";
const MIN_DEPLOYMENT_TARGET = "16.4";

module.exports = function withShareExtensionDeploymentTarget(config) {
  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    const target = project.pbxTargetByName(TARGET_NAME) || project.pbxTargetByName(`"${TARGET_NAME}"`);
    if (!target) {
      throw new Error(`withShareExtensionDeploymentTarget: could not find Xcode target "${TARGET_NAME}" — check plugin order in app.json.`);
    }
    const configListRef = target.buildConfigurationList;
    const configLists = project.hash.project.objects["XCConfigurationList"];
    const buildConfigurations = project.hash.project.objects["XCBuildConfiguration"];
    const configList = configLists[configListRef];
    let patched = 0;
    for (const { value: buildConfigRef } of configList.buildConfigurations) {
      const buildConfig = buildConfigurations[buildConfigRef];
      if (buildConfig?.buildSettings) {
        buildConfig.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = MIN_DEPLOYMENT_TARGET;
        patched++;
      }
    }
    if (patched === 0) {
      throw new Error(`withShareExtensionDeploymentTarget: found target "${TARGET_NAME}" but patched zero build configurations.`);
    }
    console.log(`[withShareExtensionDeploymentTarget] patched ${patched} build configuration(s) for ${TARGET_NAME} to iOS ${MIN_DEPLOYMENT_TARGET}`);
    return config;
  });
};
