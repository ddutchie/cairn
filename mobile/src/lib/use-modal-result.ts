import { useCallback, useEffect } from "react";
import { useRouter } from "expo-router";
import { discardSheetResult, resolveSheetResult } from "@/lib/sheet-result";

/**
 * For a native modal route opened with a `resultKey`: returns `finish(result)`, which closes the modal and hands the
 * result to whoever opened it. Swiping the modal down (never finishing) drops the opener's pending handler.
 */
export function useModalResult(resultKey?: string) {
  const router = useRouter();
  useEffect(() => {
    return () => {
      if (resultKey) discardSheetResult(resultKey);
    };
  }, [resultKey]);
  return useCallback(
    (result: unknown = "done") => {
      router.back();
      if (resultKey) resolveSheetResult(resultKey, result);
    },
    [router, resultKey],
  );
}
