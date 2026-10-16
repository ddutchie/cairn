/**
 * The window width at which Cairn switches from its single-column phone layout to
 * wide layouts (side preview, split view, title-less tabs, rail toolbars).
 *
 * One value for every wide/compact decision, JS and native (`forceCompactBelow`),
 * so a window never counts as wide for one screen and compact for another. The
 * unfolded iPhone Duo is phone idiom and so has no regular size class to key on;
 * its ~669pt portrait inner window is deliberately below this, ~951pt landscape
 * above it.
 */
export const WIDE_MIN_WIDTH = 700;
