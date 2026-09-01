import { Pressable, StyleSheet, Text, View } from "react-native";
import { Camera, Images, Paperclip } from "lucide-react-native";
import { MENU, MENU_HEIGHT } from "./constants";
import { useTheme, withAlpha, useIsDark } from "@/theme";
import { LIQUID_GLASS } from "./glass";

export type MenuAction = "camera" | "photos" | "files";

interface MenuItem {
  action: MenuAction;
  label: string;
  Icon: typeof Camera;
}

const ITEMS: MenuItem[] = [
  { action: "camera", label: "Camera", Icon: Camera },
  { action: "photos", label: "Photos", Icon: Images },
  { action: "files", label: "Files", Icon: Paperclip },
];

export function AttachmentMenu({ onSelect }: { onSelect: (action: MenuAction) => void }) {
  const t = useTheme();
  const isLight = !useIsDark();
  // Panel is dark fallback when liquid glass unavailable, but light-translucent when available on iOS 26
  const useDarkText = isLight && LIQUID_GLASS;
  const iconColor = useDarkText ? t.textPrimary : "#FFFFFF";
  const labelColor = useDarkText ? t.textPrimary : "#FFFFFF";
  const wellBg = useDarkText ? withAlpha(t.textPrimary, 0.08) : withAlpha("#FFFFFF", 0.09);
  return (
    <View style={styles.root}>
      {ITEMS.map((item) => (
        <Pressable
          key={item.action}
          accessibilityRole="button"
          accessibilityLabel={item.label}
          onPress={() => onSelect(item.action)}
          style={styles.row}
        >
          <View style={[styles.well, { backgroundColor: wellBg }]}>
            <item.Icon size={MENU.iconSize} color={iconColor} />
          </View>
          <Text style={[styles.label, { color: labelColor }]}>{item.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    left: 0,
    top: 0,
    width: MENU.width,
    height: MENU_HEIGHT,
    paddingVertical: MENU.paddingVertical,
  },
  row: {
    height: MENU.itemHeight,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: MENU.iconInset,
  },
  well: {
    width: MENU.iconWell,
    height: MENU.iconWell,
    borderRadius: MENU.iconWell / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    marginLeft: MENU.labelGap,
    fontSize: MENU.labelSize,
    letterSpacing: -0.2,
    fontWeight: "500",
  },
});
