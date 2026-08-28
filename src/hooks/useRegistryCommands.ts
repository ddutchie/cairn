import { useEffect, useState } from "react";

/**
 * Load the dsh registry commands (name + description) for the command palette.
 * These are EXECUTABLE commands — they run through the runtime's command
 * registry (`runtime.executeCommand`) rather than inserting prompt text.
 */
export function useRegistryCommands(): Array<{ name: string; description: string }> {
  const [commands, setCommands] = useState<Array<{ name: string; description: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    void window.electron?.runtime?.listCommands?.().then((list) => {
      if (!cancelled && Array.isArray(list)) setCommands(list);
    }).catch(() => { /* registry unavailable (non-cordis boot) → empty */ });
    return () => { cancelled = true; };
  }, []);

  return commands;
}
