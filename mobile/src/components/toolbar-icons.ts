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
import CalendarXml from "@expo/material-symbols/calendar_month.xml";
import CalendarViewMonthXml from "@expo/material-symbols/calendar_view_month.xml";
import CalendarViewWeekXml from "@expo/material-symbols/calendar_view_week.xml";
import AccountTreeXml from "@expo/material-symbols/account_tree.xml";
import PieChartXml from "@expo/material-symbols/pie_chart.xml";
import NeurologyXml from "@expo/material-symbols/neurology.xml";
import CloudXml from "@expo/material-symbols/cloud.xml";
import CloudOffXml from "@expo/material-symbols/cloud_off.xml";
import CloudSyncXml from "@expo/material-symbols/cloud_sync.xml";
import NoteXml from "@expo/material-symbols/description.xml";
import TaskXml from "@expo/material-symbols/check_box.xml";
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
/** AI / model settings (brain). */
export const ICON_AI: ToolbarIcon = ios ? "brain" : NeurologyXml;
/** iCloud sync — synced/idle. */
export const ICON_ICLOUD: ToolbarIcon = ios ? "icloud" : CloudXml;
/** iCloud sync — offline / unavailable. */
export const ICON_ICLOUD_OFF: ToolbarIcon = ios ? "icloud.slash" : CloudOffXml;
/** iCloud sync — syncing / pending changes. */
export const ICON_ICLOUD_SYNC: ToolbarIcon = ios ? "arrow.triangle.2.circlepath.icloud" : CloudSyncXml;
/** Pin. */
export const ICON_PIN: ToolbarIcon = ios ? "pin" : PinXml;
/** Unpin. */
export const ICON_UNPIN: ToolbarIcon = ios ? "pin.slash" : UnpinXml;
/** Tags / labels. */
export const ICON_TAG: ToolbarIcon = ios ? "tag" : TagXml;
/** Calendar / due dates. */
export const ICON_CALENDAR: ToolbarIcon = ios ? "calendar" : CalendarXml;
/** Month span (grid of days). */
export const ICON_VIEW_MONTH: ToolbarIcon = ios ? "square.grid.2x2" : CalendarViewMonthXml;
/** Week span (single-row timeline). */
export const ICON_VIEW_WEEK: ToolbarIcon = ios ? "calendar.day.timeline.left" : CalendarViewWeekXml;
/** Force-directed graph layout (nodes connected in a web). */
export const ICON_GRAPH_FORCE: ToolbarIcon = ios ? "point.3.connected.trianglepath.dotted" : AccountTreeXml;
/** Radial hierarchy layout (sunburst / pie). */
export const ICON_GRAPH_RADIAL: ToolbarIcon = ios ? "chart.pie" : PieChartXml;
/** Semantic (on-device embedding-similarity) connections toggle. */
export const ICON_SEMANTIC: ToolbarIcon = ios ? "sparkles" : NeurologyXml;
/** Note / document (search scope). */
export const ICON_NOTE: ToolbarIcon = ios ? "doc.text" : NoteXml;
/** Task / checklist item (search scope). */
export const ICON_TASK: ToolbarIcon = ios ? "checklist" : TaskXml;
/**
 * The Cairn logo as a monochrome TEMPLATE icon for the header workspace
 * switcher — a solid-black silhouette (derived from public/icon_tray.png's alpha
 * channel) with transparency, so iOS/Android tint it to the header colour like
 * an SF Symbol. Rendered with `iconRenderingMode="template"` on the toolbar item.
 *
 * Uses a pre-scaled @1x/@2x/@3x set sized for the ~26pt toolbar slot (Metro
 * resolves the density suffix per device) rather than the 512px source, so the
 * OS renders a crisp pre-scaled image instead of downscaling at runtime.
 */
export const ICON_CAIRN: ToolbarIcon =
  require("../../assets/toolbar/cairn-glyph.png") as ImageSourcePropType;
