import { useEffect, useRef, useState } from "react";

/**
 * Two-click confirm for destructive buttons. The first `fire(key, arg)` arms
 * `key` (show a warning while `armedKey === key`); a second `fire` with the
 * same key within `timeoutMs` runs `action(arg)`. Arming another key or
 * waiting out the timeout disarms.
 */
export function useTwoStepConfirm<A>(action: (arg: A) => void, timeoutMs = 4000) {
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const fire = (key: string, arg: A) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (armedKey === key) {
      setArmedKey(null);
      action(arg);
      return;
    }
    setArmedKey(key);
    timer.current = setTimeout(() => {
      timer.current = null;
      setArmedKey(null);
    }, timeoutMs);
  };

  return { armedKey, fire };
}
