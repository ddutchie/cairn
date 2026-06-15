import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import * as q from "../db/queries";
import { indexCodebase } from "./codebase-index";
import { grepTool } from "./coding-tools/grep";

describe("Grep vs Semantic Search - Context Improvements", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-grep-vs-semantic-"));
    db = new BetterSqlite3(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("filters out binary files and virtual environment dependencies in grep", async () => {
    // Setup directory structure
    const srcDir = path.join(tmpDir, "src");
    const venvDir = path.join(tmpDir, ".venv");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(venvDir, { recursive: true });

    // Write source files
    fs.writeFileSync(path.join(srcDir, "router.py"), `
      def my_project_router():
          return "router handler"
    `);

    // Write virtual environment files (should be ignored)
    fs.writeFileSync(path.join(venvDir, "library_router.py"), `
      def library_router():
          return "library handler"
    `);

    // Write binary pyc file
    fs.writeFileSync(path.join(srcDir, "compiled.pyc"), "binary garbage with word router");

    // Execute grep search for "router"
    const result = await grepTool({ pattern: "router" }, tmpDir);

    // Assertions for grep exclusions
    expect(result).toContain("my_project_router");
    expect(result).not.toContain("library_router");
    expect(result).not.toContain("compiled.pyc");
  });

  it("filters keyword and built-in noise from codebase call graph relations", async () => {
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, "main.py"), `
      def main_handler():
          for x in list():
              if isinstance(x, str):
                  helper_call()
                  
      def helper_call():
          pass
    `);

    // Index the codebase
    await indexCodebase(db, tmpDir);

    // Get relations for main_handler
    const mainHandlerSym = q.searchCodebaseSymbols(db, { query: "main_handler", folder: tmpDir });
    expect(mainHandlerSym).toHaveLength(1);

    const rels = q.getCodebaseRelations(db, "helper_call", tmpDir);

    // Target names should contain helper_call but exclude Python keywords/built-ins
    const targets = rels.incoming.map(r => r.source_name);
    
    expect(targets).toContain("main_handler");
    expect(targets).not.toContain("for");
    expect(targets).not.toContain("if");
    expect(targets).not.toContain("list");
    expect(targets).not.toContain("isinstance");
    expect(targets).not.toContain("str");
  });

  it("limits symbol search scope using prefix subpath matching for folder parameter", async () => {
    const srcDir = path.join(tmpDir, "src");
    const otherDir = path.join(tmpDir, "other");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, "app.py"), `
      def api_endpoint():
          pass
    `);

    fs.writeFileSync(path.join(otherDir, "tool.py"), `
      def api_endpoint():
          pass
    `);

    // Index the codebase
    await indexCodebase(db, tmpDir);

    // 1. Search without folder limits
    const allHits = q.searchCodebaseSymbols(db, { query: "api_endpoint" });
    expect(allHits).toHaveLength(2);

    // 2. Search scoped to index root_path
    const rootHits = q.searchCodebaseSymbols(db, { query: "api_endpoint", folder: tmpDir });
    expect(rootHits).toHaveLength(2);

    // 3. Search scoped to subpath folder (prefix match)
    const srcHits = q.searchCodebaseSymbols(db, { query: "api_endpoint", folder: srcDir });
    expect(srcHits).toHaveLength(1);
    expect(srcHits[0].file_path).toContain(path.join("src", "app.py"));

    const otherHits = q.searchCodebaseSymbols(db, { query: "api_endpoint", folder: otherDir });
    expect(otherHits).toHaveLength(1);
    expect(otherHits[0].file_path).toContain(path.join("other", "tool.py"));
  });

  it("yields significantly smaller context footprint for structural symbol queries on large files compared to grep + read cycle", async () => {
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    // Generate a large file (~2000 lines) with multiple functions matching "handler"
    const fileLines: string[] = [];
    for (let i = 1; i <= 2000; i++) {
      if (i % 40 === 0) {
        fileLines.push(`def handler_function_${i}():`);
        fileLines.push(`    """Docstring for handler function ${i}."""`);
        fileLines.push(`    return "handler payload ${i}"`);
      } else {
        fileLines.push(`def other_logic_line_${i}():`);
        fileLines.push(`    pass`);
      }
    }
    const largeFilePath = path.join(srcDir, "large_service.py");
    fs.writeFileSync(largeFilePath, fileLines.join("\n"));

    // Index the codebase
    await indexCodebase(db, tmpDir);

    // Scenario: The agent needs to inspect the signature, docstring, and line of a specific function "handler_function_120"
    
    // Traditional approach:
    // 1. Run grep search for "handler_function_120" (returns the matching line)
    const grepResult = await grepTool({ pattern: "handler_function_120" }, tmpDir);
    // 2. Read the entire file to read the surrounding docstring and lines
    const fullFileContent = fs.readFileSync(largeFilePath, "utf8");
    const traditionalTotalSize = grepResult.length + fullFileContent.length;

    // Structural semantic approach:
    // Call getCodebaseSymbolDefinition directly to get the structured definition
    const symbolDefs = q.getCodebaseSymbolDefinition(db, "handler_function_120", tmpDir);
    const semanticResultJson = JSON.stringify(symbolDefs, null, 2);

    // Output metrics comparison
    console.log(`[Large File Test Metrics]`);
    console.log(`Grep Search Result Size: ${grepResult.length} chars`);
    console.log(`Full File Read Size: ${fullFileContent.length} chars`);
    console.log(`Traditional Cycle (Grep + Read) Total: ${traditionalTotalSize} chars`);
    console.log(`Semantic Symbol Definition Size: ${semanticResultJson.length} chars`);

    // Verify codebase semantic lookup is orders of magnitude smaller
    expect(symbolDefs).toHaveLength(1);
    expect(symbolDefs[0].name).toBe("handler_function_120");
    expect(symbolDefs[0].line).toBe(241);

    // The semantic lookup is extremely compact (around 200-300 characters), which is ~200-300x smaller than the file read
    expect(semanticResultJson.length).toBeLessThan(500);
    expect(semanticResultJson.length).toBeLessThan(traditionalTotalSize / 100);
  });
});

