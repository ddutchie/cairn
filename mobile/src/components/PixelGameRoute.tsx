import type { ReactNode } from "react";
import { Stack, useRouter } from "expo-router";
import { ICON_CLOSE } from "@/components/toolbar-icons";

/**
 * Chrome for a hidden pixel game's full-screen route: Close is a real toolbar
 * item, so it floats top-right over the game on a phone and sits in the side
 * rail on the iPhone Duo. Opened from the EmptyState secret menu.
 */
export function PixelGameRoute({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon={ICON_CLOSE} accessibilityLabel="Close game" onPress={() => router.back()}>
          Close
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      {children}
    </>
  );
}
