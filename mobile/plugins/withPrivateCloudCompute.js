/**
 * Expo config plugin: add the Private Cloud Compute entitlement so the app can
 * route Apple Foundation Models sessions through PCC (server model, iOS 27+).
 *
 * Adds entitlement: com.apple.developer.private-cloud-compute = true, plus the
 * CairnPrivateCloudCompute Info.plist marker the native module checks.
 *
 * ON by default: the managed entitlement is granted for com.gerardslee.cairn,
 * so EAS's distribution profile carries it. Set EXPO_PUBLIC_PCC=0 to leave both
 * out — for a fork or App ID without the grant, where requesting a managed
 * entitlement fails code signing.
 *
 * Why the marker: PCC reports `.available` even when the app lacks the
 * entitlement, and a request from an unentitled build then traps inside
 * FoundationModels' error mapping (the 0.1.10 TestFlight crash, built before
 * this was on by default). The marker travels with the entitlement, so the
 * native side only offers PCC when the entitlement is really there.
 *
 * The native code is also SDK-gated (CAIRN_PCC_SDK in AppleLlm.podspec) and
 * runtime-gated (#available(iOS 27) + availability check).
 *
 * See: https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.developer.private-cloud-compute
 */

const { withEntitlementsPlist, withInfoPlist } = require("@expo/config-plugins");

const ENTITLEMENT = "com.apple.developer.private-cloud-compute";
const INFO_KEY = "CairnPrivateCloudCompute";

module.exports = (config) => {
  const flag = process.env.EXPO_PUBLIC_PCC;
  if (flag === "0" || flag === "false") return config;

  config = withEntitlementsPlist(config, (cfg) => {
    cfg.modResults[ENTITLEMENT] = true;
    return cfg;
  });
  return withInfoPlist(config, (cfg) => {
    cfg.modResults[INFO_KEY] = true;
    return cfg;
  });
};
