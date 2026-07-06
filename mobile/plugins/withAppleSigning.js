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
 *
 * The team is read from the APPLE_TEAM_ID env var (see .env.example). It is
 * intentionally NOT hardcoded so the developer account isn't committed to the
 * repo. If it's unset we skip the plugin with a warning — Xcode's manual
 * signing UI (or a CI without the secret) can still prebuild; only automatic
 * on-device signing needs the team set.
 */

const { withXcodeProject } = require("@expo/config-plugins");

const TEAM_ID = process.env.APPLE_TEAM_ID;

module.exports = (config) => {
  if (!TEAM_ID) {
    console.warn(
      "[withAppleSigning] APPLE_TEAM_ID not set — skipping automatic code signing. " +
        "Set it (see mobile/.env.example) to auto-manage the provisioning profile.",
    );
    return config;
  }
  return withXcodeProject(config, (cfg) => {
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
};
