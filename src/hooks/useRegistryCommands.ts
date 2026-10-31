import { useEffect, useState } from "react";

/**
 * Load the engine registry commands (name + description) for the command palette.
 * These are EXECUTABLE commands — they run through the runtime's command
 * registry (`runtime.executeCommand`) rather than inserting prompt text.
 */
export function useRegistryCommands(cwd?: string): Array<{ name: string; description: string; skill?: boolean }> {
  const [commands, setCommands] = useState<Array<{ name: string; description: string; skill?: boolean }>>([]);

  useEffect(() => {
    let cancelled = false;
    void window.electron?.runtime?.listCommands?.({ cwd }).then((list) => {
      if (!cancelled && Array.isArray(list)) setCommands(list);
    }).catch(() => { /* registry unavailable (non-engine boot) → empty */ });
    return () => { cancelled = true; };
  }, [cwd]);

  return commands;
}
