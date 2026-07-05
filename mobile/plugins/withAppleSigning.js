/**
 * Expo config plugin: set the Apple development team + automatic code signing
 * on the generated Xcode project.
 *
 * A fresh bundle identifier (com.gerardslee.cairn) needs a provisioning profile
 * to install on a physical device; without a team set, an Xcode "Run on device"
 * install produces an instant __abort_with_payload launch crash. Setting the
 * team + CODE_SIGN_STYLE=Automatic lets Xcode auto-manage the profile.
 *
 * Durable: applied on every `expo prebuild` so it survives native regeneration.
 * Override the team via the APPLE_TEAM_ID env var if needed.
 */

const { withXcodeProject } = require("@expo/config-plugins");

const TEAM_ID = process.env.APPLE_TEAM_ID || "DA48HNTSEZ";

module.exports = (config) =>
  withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const configs = project.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configs)) {
      const buildConfig = configs[key];
      if (typeof buildConfig !== "object" || !buildConfig.buildSettings) continue;
      const settings = buildConfig.buildSettings;
      // Only touch the app target configs (they carry the bundle id).
      if (settings.PRODUCT_BUNDLE_IDENTIFIER == null) continue;
      settings.DEVELOPMENT_TEAM = TEAM_ID;
      settings.CODE_SIGN_STYLE = "Automatic";
    }

    // Also set the team on the native-target attributes so Xcode's signing UI
    // reflects automatic management.
    const attrs =
      project.getFirstProject().firstProject.attributes.TargetAttributes || {};
    for (const targetId of Object.keys(attrs)) {
      attrs[targetId].DevelopmentTeam = TEAM_ID;
      attrs[targetId].ProvisioningStyle = "Automatic";
    }

    return cfg;
  });
