import type Database from "better-sqlite3";
import * as q from "../../db/queries";
import { indexCodebase } from "../../lib/codebase-index";

export async function codebase_reindex(db: Database.Database, args: { folder: string }) {
  try {
    await indexCodebase(db, args.folder);
    return { success: true, folder: args.folder };
  } catch (err) {
    return { error: `Failed to index codebase: ${(err as Error).message}` };
  }
}

export function codebase_search_symbols(db: Database.Database, args: { query: string; folder?: string; limit?: number }) {
  try {
    const results = q.searchCodebaseSymbols(db, {
      query: args.query,
      folder: args.folder,
      limit: args.limit
    });
    return results;
  } catch (err) {
    return { error: `Failed to search codebase symbols: ${(err as Error).message}` };
  }
}

export function codebase_get_symbol_definition(db: Database.Database, args: { name: string; folder?: string }) {
  try {
    const results = q.getCodebaseSymbolDefinition(db, args.name, args.folder);
    if (results.length === 0) {
      return { error: `Symbol "${args.name}" not found` };
    }
    return results;
  } catch (err) {
    return { error: `Failed to get symbol definition: ${(err as Error).message}` };
  }
}

export function codebase_get_references(db: Database.Database, args: { name: string; folder?: string }) {
  try {
    const relations = q.getCodebaseRelations(db, args.name, args.folder);
    return relations;
  } catch (err) {
    return { error: `Failed to get references: ${(err as Error).message}` };
  }
}

export function codebase_get_file_symbols(db: Database.Database, args: { filePath: string }) {
  try {
    const results = q.getCodebaseFileSymbols(db, args.filePath);
    return results;
  } catch (err) {
    return { error: `Failed to get file symbols: ${(err as Error).message}` };
  }
}
