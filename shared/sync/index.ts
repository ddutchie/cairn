/**
 * Cairn Sync — public API.
 *
 * Portable, driver-agnostic offline-first sync engine shared by the desktop
 * (Electron / better-sqlite3) and mobile (Expo / expo-sqlite) apps. Depends
 * only on the SyncDb adapter interface — no concrete SQLite driver.
 *
 * See docs/plans/mobile-app-viability.md §4 for the protocol design.
 */

export { Hlc, encodeHlc, decodeHlc, compareHlc } from "./hlc";
export type { HlcParts } from "./hlc";
export { SyncEngine } from "./engine";
export type { Op, OplogEntry } from "./engine";
export { SYNCABLE_TABLES } from "./schema";
export type { SyncableTable } from "./schema";
export { writeOplogFile, readPeerOplogs } from "./transport";
export type { SyncDb, SyncStatement } from "./db-adapter";
