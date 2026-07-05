/**
 * Expo config plugin: use a plain UILaunchScreen instead of the generated
 * SplashScreen.storyboard.
 *
 * Why: on some Xcode 26.x setups `ibtool` fails to compile the launch
 * storyboard with "iOS <version> Platform Not Installed" when the matching
 * simulator runtime's cryptex disk image is not fully mounted/registered.
 * The launch storyboard is cosmetic (a solid-colour launch screen), so we
 * replace it with the modern `UILaunchScreen` Info.plist dictionary — which
 * requires no ibtool step — and strip the storyboard from the build resources
 * so prebuild output builds cleanly regardless of runtime mount state.
 *
 * This keeps the workaround durable across `expo prebuild` (which otherwise
 * regenerates the storyboard + Info.plist reference every time).
 */

const {
  withInfoPlist,
  withXcodeProject,
} = require("@expo/config-plugins");

/** Point the launch screen at the plist dict rather than the storyboard. */
const withPlistLaunchScreen = (config) =>
  withInfoPlist(config, (cfg) => {
    delete cfg.modResults.UILaunchStoryboardName;
    cfg.modResults.UILaunchScreen = { UIColorName: "" };
    return cfg;
  });

/** Remove SplashScreen.storyboard from the Resources build phase (no ibtool). */
const withoutStoryboardResource = (config) =>
  withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const resourcesPhase = project.pbxResourcesBuildPhaseObj();
    if (resourcesPhase && Array.isArray(resourcesPhase.files)) {
      resourcesPhase.files = resourcesPhase.files.filter(
        (f) => !(f.comment && f.comment.includes("SplashScreen.storyboard")),
      );
    }
    return cfg;
  });

module.exports = (config) =>
  withoutStoryboardResource(withPlistLaunchScreen(config));
