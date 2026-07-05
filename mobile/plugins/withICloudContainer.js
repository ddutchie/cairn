/**
 * Expo config plugin: enable the iCloud (CloudDocuments) capability so the app
 * has its own ubiquity container. Its Documents folder surfaces in iCloud Drive
 * as a "Cairn" app folder — the durable, no-picker sync rendezvous shared with
 * the desktop.
 *
 * Adds:
 *  - Entitlements: com.apple.developer.icloud-container-identifiers,
 *    com.apple.developer.icloud-services (CloudDocuments),
 *    com.apple.developer.ubiquity-container-identifiers.
 *  - Info.plist NSUbiquitousContainers so the container is user-visible in the
 *    Files app / iCloud Drive with a friendly name.
 *
 * Container id: iCloud.<bundleId>. Requires a PAID Apple Developer account with
 * the iCloud capability enabled for the App ID (automatic signing will add it).
 */

const { withEntitlementsPlist, withInfoPlist } = require("@expo/config-plugins");

module.exports = (config) => {
  const bundleId = config.ios?.bundleIdentifier || "com.gerardslee.cairn";
  const container = `iCloud.${bundleId}`;

  config = withEntitlementsPlist(config, (cfg) => {
    cfg.modResults["com.apple.developer.icloud-container-identifiers"] = [container];
    cfg.modResults["com.apple.developer.ubiquity-container-identifiers"] = [container];
    cfg.modResults["com.apple.developer.icloud-services"] = ["CloudDocuments"];
    return cfg;
  });

  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.NSUbiquitousContainers = {
      [container]: {
        NSUbiquitousContainerIsDocumentScopePublic: true,
        NSUbiquitousContainerName: "Cairn",
        NSUbiquitousContainerSupportedFolderLevels: "Any",
      },
    };
    return cfg;
  });

  return config;
};
