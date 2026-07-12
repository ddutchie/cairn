import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import * as q from "../db/queries";
import { newId } from "../db/utils";

// Supported file extensions for codebase indexing
const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx",
  ".py", ".rs", ".go", ".rb",
  ".java", ".cpp", ".hpp", ".h",
  ".cs", ".sh", ".md"
]);

// Ignored directory names (exact match). Covers VCS, dependency, build/output,
// cache and editor/tool dirs across the ecosystems we index.
const IGNORED_DIRS = new Set([
  // VCS / editor / tooling
  ".git", ".hg", ".svn", ".idea", ".vscode", ".vs",
  // JS/TS deps + build output + caches
  "node_modules", ".next", "out", "build", ".turbo", ".cache",
  ".parcel-cache", ".svelte-kit", ".nuxt", ".expo", ".vercel", ".output",
  "coverage", ".nyc_output", "storybook-static",
  // Native / packaging
  "Pods", ".gradle", "DerivedData",
  // Python
  ".venv", "venv", "env", ".env", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".ruff_cache", ".tox", "site-packages",
  // Rust / Go / JVM / C#
  "target", "bin", "obj", "vendor",
]);

// Ignored directory PREFIXES. Packaged/build output in this repo (and many
// others) lives in dist-prefixed folders — `dist`, `dist-app` (a full .app
// bundle with thousands of minified JS files), `dist-electron`, `dist-mcp`,
// `dist-web`, etc. Exact-name matching missed those, so the walker descended
// into the packaged app and indexed its bundles. Prefix-match `dist` to catch
// them all while still allowing legitimately-named source dirs.
const IGNORED_DIR_PREFIXES = ["dist"];

/** True if a directory entry name should be skipped by the walker. */
export function isIgnoredDir(name: string): boolean {
  if (IGNORED_DIRS.has(name)) return true;
  // Any macOS/iOS app bundle (packaged output) — never source.
  if (name.endsWith(".app") || name.endsWith(".framework") || name.endsWith(".xcarchive")) return true;
  return IGNORED_DIR_PREFIXES.some((p) => name === p || name.startsWith(`${p}-`));
}

// Keywords and built-ins to ignore in relation extraction
const REJECTED_RELATION_TARGETS = new Set([
  "if", "for", "while", "switch", "catch", "try", "using", "lock", "synchronized",
  "with", "function", "class", "def", "struct", "interface", "module", "import", "export",
  "return", "break", "continue", "default", "else", "elif", "except", "finally", "let", "var",
  "const", "print", "console", "log", "error", "warn", "info", "debug", "int", "float",
  "str", "bool", "list", "dict", "set", "tuple", "len", "range", "isinstance", "type",
  "true", "false", "null", "undefined", "nil", "none", "self", "this", "super",
  "new", "delete", "throw", "void", "yield", "await", "async"
]);

export interface ExtractedSymbol {
  name: string;
  kind: "class" | "function" | "method" | "struct" | "interface" | "module";
  line: number;
  signature: string;
  docstring: string | null;
}

export async function walkDir(dir: string, fileList: string[] = []): Promise<string[]> {
  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return fileList;
  }
  for (const file of files) {
    if (isIgnoredDir(file)) continue;
    const filePath = path.join(dir, file);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      await walkDir(filePath, fileList);
    } else if (stat.isFile()) {
      const ext = path.extname(file).toLowerCase();
      if (SUPPORTED_EXTENSIONS.has(ext)) {
        fileList.push(filePath);
      }
    }
  }
  return fileList;
}

export function parseFile(filePath: string): ExtractedSymbol[] {
  const content = fs.readFileSync(filePath, "utf-8");
  return parseFileContent(content, path.extname(filePath).toLowerCase());
}

export function parseFileContent(content: string, ext: string): ExtractedSymbol[] {
  const lines = content.split(/\r?\n/);
  
  const symbols: ExtractedSymbol[] = [];
  let commentBuffer: string[] = [];
  let inBlockComment = false;
  let currentClass: string | null = null;
  let braceDepth = 0;
  let classStartDepth: number | null = null;
  
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];
    const trimmed = line.trim();
    
    // Comment parsing
    if (ext === ".py" || ext === ".rb" || ext === ".sh") {
      if (trimmed.startsWith("#")) {
        commentBuffer.push(trimmed.slice(1).trim());
        continue;
      }
    } else if (ext === ".go" || ext === ".rs" || ext === ".cpp" || ext === ".hpp" || ext === ".h" || ext === ".cs" || ext === ".java" || ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
      if (trimmed.startsWith("//")) {
        commentBuffer.push(trimmed.slice(2).trim());
        continue;
      }
      if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".java" || ext === ".cs") {
        if (trimmed.startsWith("/**") || trimmed.startsWith("/*")) {
          inBlockComment = true;
          const c = trimmed.replace(/^\/\*\*?/, "").replace(/\*\/$/, "").trim();
          if (c) commentBuffer.push(c);
          if (trimmed.endsWith("*/")) inBlockComment = false;
          continue;
        }
        if (inBlockComment) {
          if (trimmed.endsWith("*/")) {
            inBlockComment = false;
            const c = trimmed.replace(/\*\/$/, "").replace(/^\s*\*\s?/, "").trim();
            if (c) commentBuffer.push(c);
          } else {
            const c = trimmed.replace(/^\s*\*\s?/, "").trim();
            commentBuffer.push(c);
          }
          continue;
        }
      }
    }
    
    if (!trimmed) {
      continue;
    }
    
    let matched = false;
    let name = "";
    let kind: ExtractedSymbol["kind"] = "function";
    const signature = trimmed;
    
    // TS/JS Parsing
    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
      const classMatch = trimmed.match(/(?:export\s+)?(?:default\s+)?class\s+([a-zA-Z0-9_$]+)/);
      if (classMatch) {
        name = classMatch[1];
        kind = "class";
        matched = true;
      } else {
        const funcMatch = trimmed.match(/(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(/);
        if (funcMatch) {
          name = funcMatch[1];
          kind = "function";
          matched = true;
        } else {
          const arrowMatch = trimmed.match(/(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/);
          if (arrowMatch) {
            name = arrowMatch[1];
            kind = "function";
            matched = true;
          } else {
            const intMatch = trimmed.match(/(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/);
            if (intMatch) {
              name = intMatch[1];
              kind = "interface";
              matched = true;
            } else {
              const methodMatch = trimmed.match(/^\s*(?:public|private|protected|async|static|get|set)*\s*([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*[:{]/);
              if (methodMatch) {
                const possibleName = methodMatch[1];
                const keywords = new Set(["if", "for", "while", "switch", "catch", "with", "function"]);
                if (!keywords.has(possibleName)) {
                  name = possibleName;
                  kind = "method";
                  matched = true;
                }
              }
            }
          }
        }
      }
    }
    
    // Python Parsing
    if (ext === ".py") {
      const classMatch = trimmed.match(/^class\s+([a-zA-Z0-9_]+)/);
      if (classMatch) {
        name = classMatch[1];
        kind = "class";
        matched = true;
      } else {
        const defMatch = line.match(/^(\s*)def\s+([a-zA-Z0-9_]+)\s*\(/);
        if (defMatch) {
          name = defMatch[2];
          const indent = defMatch[1].length;
          kind = indent > 0 ? "method" : "function";
          matched = true;
        }
      }
    }
    
    // Go Parsing
    if (ext === ".go") {
      const structMatch = trimmed.match(/^type\s+([a-zA-Z0-9_]+)\s+struct/);
      if (structMatch) {
        name = structMatch[1];
        kind = "struct";
        matched = true;
      } else {
        const intMatch = trimmed.match(/^type\s+([a-zA-Z0-9_]+)\s+interface/);
        if (intMatch) {
          name = intMatch[1];
          kind = "interface";
          matched = true;
        } else {
          const methodMatch = trimmed.match(/^func\s*\([^)]+\)\s*([a-zA-Z0-9_]+)\s*\(/);
          if (methodMatch) {
            name = methodMatch[1];
            kind = "method";
            matched = true;
          } else {
            const funcMatch = trimmed.match(/^func\s+([a-zA-Z0-9_]+)\s*\(/);
            if (funcMatch) {
              name = funcMatch[1];
              kind = "function";
              matched = true;
            }
          }
        }
      }
    }
    
    // Rust Parsing
    if (ext === ".rs") {
      const structMatch = trimmed.match(/^(?:pub\s+)?struct\s+([a-zA-Z0-9_]+)/);
      if (structMatch) {
        name = structMatch[1];
        kind = "struct";
        matched = true;
      } else {
        const enumMatch = trimmed.match(/^(?:pub\s+)?enum\s+([a-zA-Z0-9_]+)/);
        if (enumMatch) {
          name = enumMatch[1];
          kind = "struct";
          matched = true;
        } else {
          const traitMatch = trimmed.match(/^(?:pub\s+)?trait\s+([a-zA-Z0-9_]+)/);
          if (traitMatch) {
            name = traitMatch[1];
            kind = "interface";
            matched = true;
          } else {
            const fnMatch = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)/);
            if (fnMatch) {
              name = fnMatch[1];
              kind = "function";
              matched = true;
            }
          }
        }
      }
    }
    
    // C++ Parsing
    if (ext === ".cpp" || ext === ".hpp" || ext === ".h") {
      const classMatch = trimmed.match(/^(?:class|struct)\s+([a-zA-Z0-9_]+)/);
      if (classMatch) {
        name = classMatch[1];
        kind = trimmed.startsWith("struct") ? "struct" : "class";
        currentClass = name;
        matched = true;
      } else {
        if (trimmed.includes("};")) {
          currentClass = null;
        }
        const fnMatch = trimmed.match(/^(?:[a-zA-Z0-9_::<>*&]+\s+)+([a-zA-Z0-9_]+(?:::[a-zA-Z0-9_]+)?)\s*\([^)]*\)\s*(?:const\s*)?{/);
        if (fnMatch) {
          const possibleName = fnMatch[1];
          const baseName = possibleName.includes("::") ? possibleName.split("::").pop() : possibleName;
          const keywords = new Set(["if", "for", "while", "switch", "catch"]);
          if (baseName && !keywords.has(baseName)) {
            name = possibleName;
            kind = (possibleName.includes("::") || currentClass !== null) ? "method" : "function";
            matched = true;
          }
        }
      }
    }

    // Java and C# Parsing
    if (ext === ".java" || ext === ".cs") {
      const openBraces = (line.match(/{/g) || []).length;
      const closeBraces = (line.match(/}/g) || []).length;
      if (classStartDepth !== null && braceDepth - closeBraces < classStartDepth) {
        currentClass = null;
        classStartDepth = null;
      }
      
      const classMatch = trimmed.match(/^(?:public|private|protected|internal|static|abstract|final|sealed|partial)*\s*(class|interface|struct|record)\s+([a-zA-Z0-9_]+)/);
      if (classMatch) {
        name = classMatch[2];
        const matchKind = classMatch[1];
        kind = matchKind === "interface" ? "interface" : matchKind === "struct" ? "struct" : "class";
        currentClass = name;
        classStartDepth = braceDepth + openBraces;
        matched = true;
      } else {
        const fnMatch = trimmed.match(/^(?:[a-zA-Z0-9_::<>*&\[\]]+\s+)+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*(?:throws\s+[a-zA-Z0-9_,\s]+)?\s*{/);
        if (fnMatch) {
          const possibleName = fnMatch[1];
          const keywords = new Set(["if", "for", "while", "switch", "catch", "try", "using", "lock", "synchronized"]);
          if (possibleName && !keywords.has(possibleName)) {
            name = possibleName;
            kind = currentClass !== null ? "method" : "function";
            matched = true;
          }
        }
      }
      
      braceDepth += openBraces - closeBraces;
    }

    // Ruby Parsing
    if (ext === ".rb") {
      const classMatch = trimmed.match(/^(?:class|module)\s+([a-zA-Z0-9_::]+)/);
      if (classMatch) {
        name = classMatch[1];
        kind = trimmed.startsWith("module") ? "module" : "class";
        currentClass = name;
        matched = true;
      } else {
        const defMatch = trimmed.match(/^def\s+([a-zA-Z0-9_!?=.]+)/);
        if (defMatch) {
          name = defMatch[1];
          kind = "method";
          matched = true;
        }
      }
    }

    // Shell Parsing
    if (ext === ".sh") {
      const fnMatch = trimmed.match(/^(?:function\s+)?([a-zA-Z0-9_-]+)\s*(?:\(\s*\))?\s*{/);
      if (fnMatch) {
        name = fnMatch[1];
        kind = "function";
        matched = true;
      }
    }
    
    if (matched && name) {
      const docstring = commentBuffer.length > 0 ? commentBuffer.join("\n").trim() : null;
      symbols.push({
        name,
        kind,
        line: lineNum,
        signature: signature.slice(0, 300),
        docstring
      });
      commentBuffer = [];
    } else {
      if (trimmed.length > 3 && !trimmed.startsWith("}") && !trimmed.startsWith("]")) {
        commentBuffer = [];
      }
    }
  }
  
  return symbols;
}

export async function indexCodebase(db: Database.Database, rootPath: string): Promise<void> {
  const absoluteRoot = path.resolve(rootPath);
  
  // 1. Walk files
  const files = await walkDir(absoluteRoot);
  const filePathsSet = new Set(files);
  
  // 2. Fetch existing files in DB
  const dbFiles = q.getCodebaseFilesByRoot(db, absoluteRoot);
  const dbFilesMap = new Map(dbFiles.map(f => [f.file_path, f]));
  
  // Clean up any files that no longer exist on disk (wrapped in transaction)
  db.transaction(() => {
    for (const dbFile of dbFiles) {
      if (!filePathsSet.has(dbFile.file_path)) {
        q.deleteCodebaseFile(db, dbFile.id);
      }
    }
  })();
  
  const parsedFileIds: string[] = [];
  const filesToScan: string[] = [];
  
  const saveFileSymbolsTx = db.transaction((fileId: string, filePath: string, hash: string, symbols: ExtractedSymbol[]) => {
    q.upsertCodebaseFile(db, { id: fileId, rootPath: absoluteRoot, filePath, hash });
    q.clearCodebaseFileData(db, fileId);
    for (const sym of symbols) {
      q.insertCodebaseSymbol(db, {
        id: newId(),
        fileId,
        name: sym.name,
        kind: sym.kind,
        line: sym.line,
        signature: sym.signature,
        docstring: sym.docstring
      });
    }
  });
  
  // 3. Process each file on disk
  for (const filePath of files) {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      continue;
    }
    
    const hash = `${stat.size}-${stat.mtimeMs}`;
    const dbFile = dbFilesMap.get(filePath);
    
    let fileId: string;
    
    if (dbFile && dbFile.hash === hash) {
      fileId = dbFile.id;
    } else {
      fileId = dbFile ? dbFile.id : newId();
      filesToScan.push(filePath);
      
      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        const symbols = parseFileContent(content, path.extname(filePath).toLowerCase());
        saveFileSymbolsTx(fileId, filePath, hash, symbols);
      } catch (err) {
        console.error(`[codebase-indexer] Failed to parse file ${filePath}:`, err);
      }
      
      parsedFileIds.push(fileId);
    }
    
    // Yield to the event loop after every single file to guarantee Electron responsiveness
    await new Promise(resolve => setImmediate(resolve));
  }
  
  // 4. Resolve Relations (Call Graph)
  const allSymbols = db.prepare(`
    SELECT s.id, s.name, s.file_id, s.line
    FROM codebase_symbols s
    JOIN codebase_files f ON s.file_id = f.id
    WHERE f.root_path = ?
  `).all(absoluteRoot) as Array<{ id: string; name: string; file_id: string; line: number }>;
  
  const knownSymbolNames = new Set(allSymbols.map(s => s.name));
  
  const saveFileRelationsTx = db.transaction((relations: Array<{ sourceId: string; targetName: string }>) => {
    for (const rel of relations) {
      q.insertCodebaseRelation(db, {
        sourceId: rel.sourceId,
        targetName: rel.targetName,
        type: "calls"
      });
    }
  });
  
  for (const filePath of filesToScan) {
    const dbFile = q.getCodebaseFileByPath(db, filePath);
    if (!dbFile) continue;
    
    const fileSymbols = q.getCodebaseFileSymbols(db, filePath);
    if (fileSymbols.length === 0) continue;
    
    let content: string;
    try {
      content = await fs.promises.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    
    const lines = content.split(/\r?\n/);
    const fileRelations: Array<{ sourceId: string; targetName: string }> = [];
    
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      
      let enclosingSymbol: typeof fileSymbols[0] | null = null;
      for (const sym of fileSymbols) {
        if (sym.line <= lineNum) {
          if (!enclosingSymbol || sym.line > enclosingSymbol.line) {
            enclosingSymbol = sym;
          }
        }
      }
      
      if (!enclosingSymbol) continue;
      
      const tokens = line.split(/[^a-zA-Z0-9_$]+/);
      for (const token of tokens) {
        if (!token) continue;
        if (REJECTED_RELATION_TARGETS.has(token)) continue;
        if (knownSymbolNames.has(token) && token !== enclosingSymbol.name) {
          fileRelations.push({
            sourceId: enclosingSymbol.id,
            targetName: token
          });
        }
      }
    }
    
    if (fileRelations.length > 0) {
      try {
        saveFileRelationsTx(fileRelations);
      } catch (err) {
        console.error(`[codebase-indexer] Failed to save relations for ${filePath}:`, err);
      }
    }
    
    // Yield to the event loop after every single relation file scanned
    await new Promise(resolve => setImmediate(resolve));
  }
}
