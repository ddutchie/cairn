/**
 * Calendar drop-resolution — now lives in shared/ so desktop and mobile share
 * one implementation. This module re-exports it to preserve existing desktop
 * imports (`./calendar-dnd`).
 */

export { resolveDateDrop, UNSCHEDULED_DROP_ID, type DateDropResult } from "../../../shared/calendar/dnd";
