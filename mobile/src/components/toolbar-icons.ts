/**
 * Cross-platform toolbar icons for `Stack.Toolbar.Button` / `.Menu` / `.MenuAction`.
 *
 * The `icon` prop takes an SF Symbol name (iOS) or an ImageSourcePropType
 * (Android). Following the Expo Stack Toolbar guide, we branch on
 * `process.env.EXPO_OS` — Metro replaces it with a string literal at build time
 * and tree-shakes the unused branch, so the Material Symbols XML drawable never
 * ships in the iOS bundle and the SF Symbol string never ships on Android.
 *
 * Each export is ready to spread straight onto the `icon` prop.
 */

import type { ImageSourcePropType } from "react-native";
import type { SFSymbol } from "sf-symbols-typescript";

// Android vector drawables (Material Symbols). Import per-subpath so Metro only
// bundles the icons we use.
import AddXml from "@expo/material-symbols/add.xml";
import CheckXml from "@expo/material-symbols/check.xml";
import CloseXml from "@expo/material-symbols/close.xml";
import EditXml from "@expo/material-symbols/edit.xml";
import MoreVertXml from "@expo/material-symbols/more_vert.xml";
import DeleteXml from "@expo/material-symbols/delete.xml";
import ArchiveXml from "@expo/material-symbols/archive.xml";
import UnarchiveXml from "@expo/material-symbols/inventory_2.xml";
import SettingsXml from "@expo/material-symbols/settings.xml";
import PinXml from "@expo/material-symbols/keep.xml";
import UnpinXml from "@expo/material-symbols/keep_off.xml";
import TagXml from "@expo/material-symbols/sell.xml";

/** An icon usable by both platforms via the toolbar `icon` prop. */
export type ToolbarIcon = SFSymbol | ImageSourcePropType;

const ios = process.env.EXPO_OS === "ios";

/** Add / new item (Plus). */
export const ICON_ADD: ToolbarIcon = ios ? "plus" : AddXml;
/** Confirm / save (checkmark). */
export const ICON_CHECK: ToolbarIcon = ios ? "checkmark" : CheckXml;
/** Cancel / close. */
export const ICON_CLOSE: ToolbarIcon = ios ? "xmark" : CloseXml;
/** Edit (pencil). */
export const ICON_EDIT: ToolbarIcon = ios ? "pencil" : EditXml;
/** Overflow / more actions (ellipsis). */
export const ICON_MORE: ToolbarIcon = ios ? "ellipsis.circle" : MoreVertXml;
/** Delete / clear (trash). */
export const ICON_DELETE: ToolbarIcon = ios ? "trash" : DeleteXml;
/** Archive. */
export const ICON_ARCHIVE: ToolbarIcon = ios ? "archivebox" : ArchiveXml;
/** Unarchive / restore. */
export const ICON_UNARCHIVE: ToolbarIcon = ios ? "tray.and.arrow.up" : UnarchiveXml;
/** Settings (gear). */
export const ICON_SETTINGS: ToolbarIcon = ios ? "gearshape" : SettingsXml;
/** Pin. */
export const ICON_PIN: ToolbarIcon = ios ? "pin" : PinXml;
/** Unpin. */
export const ICON_UNPIN: ToolbarIcon = ios ? "pin.slash" : UnpinXml;
/** Tags / labels. */
export const ICON_TAG: ToolbarIcon = ios ? "tag" : TagXml;
