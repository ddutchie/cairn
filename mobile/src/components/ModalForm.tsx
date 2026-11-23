import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from "react-native";
import { ModalSafeView } from "@/components/ModalSafeView";
import { ScreenChrome } from "@/components/screen-chrome";
import { ICON_CHECK, ICON_CLOSE } from "@/components/toolbar-icons";
import { toolbarPress, useModalOpenHaptic } from "@/haptics";
import { useTheme } from "@/theme";

/**
 * The frame of a native modal form route (like the project form): title, a Save ✓ when `onSave` is given, and a
 * scrolling body. `onBack` adds a Back control for a picker page inside the same modal; `scroll={false}` is for a body
 * that scrolls itself (a list).
 */
export function ModalForm({ title, onSave, onBack, scroll = true, children }: {
  title: string; onSave?: () => void; onBack?: () => void; scroll?: boolean; children: ReactNode;
}) {
  useModalOpenHaptic();
  const t = useTheme();
  return (
    <ModalSafeView backgroundColor={t.surface}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScreenChrome
          title={title}
          right={[
            ...(onBack ? [{ kind: "button" as const, key: "back", label: "Back", icon: ICON_CLOSE, onPress: toolbarPress(onBack) }] : []),
            ...(onSave ? [{ kind: "button" as const, key: "save", label: "Save", icon: ICON_CHECK, variant: "done" as const, onPress: () => toolbarPress(onSave, "confirm")() }] : []),
          ]}
        />
        {scroll ? (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">{children}</ScrollView>
        ) : children}
      </KeyboardAvoidingView>
    </ModalSafeView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 18, paddingBottom: 60 },
});
