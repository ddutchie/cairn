import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import * as q from "../db/queries";
import { indexCodebase, parseFile, walkDir } from "./codebase-index";

let tmpDir: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-codebase-test-"));
  db = new BetterSqlite3(":memory:");
  applySchema(db);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Codebase Semantic Indexer", () => {
  describe("Directory Walker", () => {
    it("recursively finds files with supported extensions and ignores ignored directories", () => {
      // Create subdirectories
      fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });

      // Create files
      fs.writeFileSync(path.join(tmpDir, "src", "index.ts"), "const a = 1;");
      fs.writeFileSync(path.join(tmpDir, "src", "utils.js"), "const b = 2;");
      fs.writeFileSync(path.join(tmpDir, "node_modules", "package.ts"), "const c = 3;");
      fs.writeFileSync(path.join(tmpDir, ".git", "config.js"), "const d = 4;");
      fs.writeFileSync(path.join(tmpDir, "README.md"), "# Cairn");

      const files = walkDir(tmpDir).map(f => path.relative(tmpDir, f));
      expect(files).toContain(path.join("src", "index.ts"));
      expect(files).toContain(path.join("src", "utils.js"));
      expect(files).toContain("README.md");
      expect(files).not.toContain(path.join("node_modules", "package.ts"));
      expect(files).not.toContain(path.join(".git", "config.js"));
    });
  });

  describe("File Symbol Parsers", () => {
    it("parses TypeScript symbols and docstrings", () => {
      const tsFile = path.join(tmpDir, "sample.ts");
      fs.writeFileSync(tsFile, `
        /**
         * Enclosing helper class
         */
        export class MyIndexer {
          // A basic property
          private version = 1;

          /**
           * Does some work
           */
          async index(path: string): Promise<boolean> {
            return true;
          }
        }

        // Inline function
        function runLoop() {
          console.log("running");
        }
      `);

      const symbols = parseFile(tsFile);
      expect(symbols).toHaveLength(3);

      const cls = symbols.find(s => s.name === "MyIndexer");
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe("class");
      expect(cls!.docstring).toBe("Enclosing helper class");

      const method = symbols.find(s => s.name === "index");
      expect(method).toBeDefined();
      expect(method!.kind).toBe("method");
      expect(method!.docstring).toBe("Does some work");

      const fn = symbols.find(s => s.name === "runLoop");
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe("function");
    });

    it("parses Python symbols with indentation-based methods", () => {
      const pyFile = path.join(tmpDir, "sample.py");
      fs.writeFileSync(pyFile, `
# Enclosing user module
class UserSession:
    # Constructor
    def __init__(self, name):
        self.name = name

    def get_name(self):
        return self.name

# Top-level helper function
def format_username(user):
    return user.get_name()
      `);

      const symbols = parseFile(pyFile);
      expect(symbols).toHaveLength(4);

      const cls = symbols.find(s => s.name === "UserSession");
      expect(cls!.kind).toBe("class");
      expect(cls!.docstring).toBe("Enclosing user module");

      const init = symbols.find(s => s.name === "__init__");
      expect(init!.kind).toBe("method");

      const getName = symbols.find(s => s.name === "get_name");
      expect(getName!.kind).toBe("method");

      const formatUser = symbols.find(s => s.name === "format_username");
      expect(formatUser!.kind).toBe("function");
    });

    it("parses C++ symbols and docstrings", () => {
      const cppFile = path.join(tmpDir, "sample.cpp");
      fs.writeFileSync(cppFile, `
        // Enclosing parser class
        class CodeIndexer {
          public:
            // Does index work
            void index(std::string path) {
              // implementation
            }
        };

        // Struct definition
        struct Item {
          int id;
        };

        // Top level function
        int main() {
          return 0;
        }
      `);

      const symbols = parseFile(cppFile);
      expect(symbols).toHaveLength(4);

      const cls = symbols.find(s => s.name === "CodeIndexer");
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe("class");
      expect(cls!.docstring).toBe("Enclosing parser class");

      const method = symbols.find(s => s.name === "index");
      expect(method).toBeDefined();
      expect(method!.kind).toBe("method");
      expect(method!.docstring).toBe("Does index work");

      const item = symbols.find(s => s.name === "Item");
      expect(item).toBeDefined();
      expect(item!.kind).toBe("struct");

      const fn = symbols.find(s => s.name === "main");
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe("function");
    });

    it("parses Java/C# symbols and docstrings", () => {
      const javaFile = path.join(tmpDir, "Sample.java");
      fs.writeFileSync(javaFile, `
        /**
         * Enclosing Java Class
         */
        public class SampleClass {
          // Inner helper method
          public void runTask(int count) {
            // work
          }
        }
      `);

      const symbols = parseFile(javaFile);
      expect(symbols).toHaveLength(2);

      const cls = symbols.find(s => s.name === "SampleClass");
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe("class");
      expect(cls!.docstring).toBe("Enclosing Java Class");

      const method = symbols.find(s => s.name === "runTask");
      expect(method).toBeDefined();
      expect(method!.kind).toBe("method");
      expect(method!.docstring).toBe("Inner helper method");
    });

    it("parses Ruby symbols", () => {
      const rbFile = path.join(tmpDir, "sample.rb");
      fs.writeFileSync(rbFile, `
        # Main controller
        class UserController
          def index
            # home
          end
        end
      `);

      const symbols = parseFile(rbFile);
      expect(symbols).toHaveLength(2);

      const cls = symbols.find(s => s.name === "UserController");
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe("class");
      expect(cls!.docstring).toBe("Main controller");

      const method = symbols.find(s => s.name === "index");
      expect(method).toBeDefined();
      expect(method!.kind).toBe("method");
    });

    it("parses Shell symbols", () => {
      const shFile = path.join(tmpDir, "script.sh");
      fs.writeFileSync(shFile, `
        # Helper function
        deploy_app() {
          echo "deploying"
        }
      `);

      const symbols = parseFile(shFile);
      expect(symbols).toHaveLength(1);

      const fn = symbols.find(s => s.name === "deploy_app");
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe("function");
      expect(fn!.docstring).toBe("Helper function");
    });
  });

  describe("Call Graph / Relation Building & Incremental Sync", () => {
    it("populates files, symbols, relations, and performs incremental scanning", async () => {
      fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
      const mainFile = path.join(tmpDir, "src", "main.ts");
      const helperFile = path.join(tmpDir, "src", "helper.ts");

      fs.writeFileSync(mainFile, `
        function main() {
          const res = helper();
          console.log(res);
        }
      `);

      fs.writeFileSync(helperFile, `
        /**
         * Simple helper
         */
        export function helper() {
          return "hello";
        }
      `);

      // 1. Initial Scan
      await indexCodebase(db, tmpDir);

      // Verify files indexed
      const dbFiles = q.getCodebaseFilesByRoot(db, tmpDir);
      expect(dbFiles).toHaveLength(2);

      // Verify symbols indexed
      const mainSyms = q.getCodebaseFileSymbols(db, mainFile);
      expect(mainSyms).toHaveLength(1);
      expect(mainSyms[0].name).toBe("main");

      const helperSyms = q.getCodebaseFileSymbols(db, helperFile);
      expect(helperSyms).toHaveLength(1);
      expect(helperSyms[0].name).toBe("helper");
      expect(helperSyms[0].docstring).toBe("Simple helper");

      // Verify call relations resolved
      const rels = q.getCodebaseRelations(db, "helper", tmpDir);
      expect(rels.incoming).toHaveLength(1);
      expect(rels.incoming[0].source_name).toBe("main");
      expect(rels.incoming[0].source_file).toBe(mainFile);

      // 2. Incremental Scan (no changes)
      // Modify helper file without changing length or mtime significantly, or just run scan again
      const initialIndexedAt = dbFiles[0].indexed_at;
      await indexCodebase(db, tmpDir);

      const dbFilesAfter = q.getCodebaseFilesByRoot(db, tmpDir);
      expect(dbFilesAfter[0].indexed_at).toBe(initialIndexedAt); // unchanged because hash matched

      // 3. File modified scan
      // Let's modify helper.ts
      fs.writeFileSync(helperFile, `
        /**
         * Updated simple helper
         */
        export function helper() {
          return "world";
        }
      `);

      await indexCodebase(db, tmpDir);

      const dbFilesUpdated = q.getCodebaseFilesByRoot(db, tmpDir);
      const helperDbFile = dbFilesUpdated.find(f => f.file_path === helperFile);
      expect(helperDbFile!.indexed_at).not.toBe(initialIndexedAt); // updated!

      const helperSymsUpdated = q.getCodebaseFileSymbols(db, helperFile);
      expect(helperSymsUpdated[0].docstring).toBe("Updated simple helper");
    });
  });
});
