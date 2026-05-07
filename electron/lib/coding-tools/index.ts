/**
 * Cairn coding tools — barrel export.
 *
 * All 7 tools ported from pi packages/coding-agent/src/core/tools/
 * adapted for direct Node.js use in the Electron main process.
 * No external dependencies beyond Node.js built-ins.
 */

export { readTool,  readToolDefinition  } from "./read";
export { writeTool, writeToolDefinition } from "./write";
export { editTool,  editToolDefinition  } from "./edit";
export { bashTool,  bashToolDefinition  } from "./bash";
export { grepTool,  grepToolDefinition  } from "./grep";
export { findTool,  findToolDefinition  } from "./find";
export { lsTool,    lsToolDefinition    } from "./ls";

export type { ReadArgs  } from "./read";
export type { WriteArgs } from "./write";
export type { EditArgs, EditEntry } from "./edit";
export type { BashArgs, BashOptions } from "./bash";
export type { GrepArgs  } from "./grep";
export type { FindArgs  } from "./find";
export type { LsArgs    } from "./ls";

import { readToolDefinition  } from "./read";
import { writeToolDefinition } from "./write";
import { editToolDefinition  } from "./edit";
import { bashToolDefinition  } from "./bash";
import { grepToolDefinition  } from "./grep";
import { findToolDefinition  } from "./find";
import { lsToolDefinition    } from "./ls";

/** All coding tool definitions in OpenAI function-calling format. */
export const CODING_TOOL_DEFINITIONS = [
  readToolDefinition,
  writeToolDefinition,
  editToolDefinition,
  bashToolDefinition,
  grepToolDefinition,
  findToolDefinition,
  lsToolDefinition,
] as const;
