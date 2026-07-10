/**
 * Expo config plugin: add the Private Cloud Compute entitlement so the app can
 * route Apple Foundation Models sessions through PCC (server model, iOS 27+).
 *
 * Adds entitlement: com.apple.developer.private-cloud-compute = true.
 *
 * GATED behind the EXPO_PUBLIC_PCC env flag (opt-in), because this is a MANAGED
 * entitlement: it must be granted for the App ID (applied for separately) and
 * present in the provisioning profile, or code-signing FAILS. Standard EAS /
 * shipped builds must NOT carry it until it's provisioned — otherwise every
 * build breaks. When the entitlement is granted and you build the iOS 27 SDK
 * variant locally (or on a future EAS image), set EXPO_PUBLIC_PCC=1 to inject it.
 *
 * The native code is already SDK-gated (CAIRN_PCC_SDK in AppleLlm.podspec) and
 * runtime-gated (#available(iOS 27) + availability check), so the app runs fine
 * without this entitlement — PCC just reports unavailable. This plugin only
 * flips on the capability once you're entitled.
 *
 * See: https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.developer.private-cloud-compute
 */

const { withEntitlementsPlist } = require("@expo/config-plugins");

const ENTITLEMENT = "com.apple.developer.private-cloud-compute";

module.exports = (config) => {
  const enabled = process.env.EXPO_PUBLIC_PCC === "1" || process.env.EXPO_PUBLIC_PCC === "true";
  if (!enabled) {
    // Opt-in only: without the flag, don't touch entitlements so unprovisioned
    // builds (EAS, shipped) keep signing successfully.
    return config;
  }

  return withEntitlementsPlist(config, (cfg) => {
    cfg.modResults[ENTITLEMENT] = true;
    return cfg;
  });
};
