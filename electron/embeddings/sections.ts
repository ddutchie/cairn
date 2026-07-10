/**
 * Re-export of the shared note section splitter. The implementation lives in
 * `shared/notes/sections.ts` so desktop and mobile chunk notes identically;
 * this thin shim keeps the existing `./sections` relative imports working.
 */
export { splitIntoSections, type NoteSection } from "../../shared/notes/sections";
