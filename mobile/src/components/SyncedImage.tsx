import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Image } from "expo-image";
import { ImageOff } from "lucide-react-native";
import { useTheme } from "@/theme";
import { getActiveSource } from "@/db";
import { requestMissingBlobs, resolveEmbedUri } from "@/sync/blobs";

const POLL_MS = 1500;
const MAX_POLLS = 80; // ~2 minutes, then wait for the next sync/remount

/**
 * Renders a note's `![[image.png]]` from the synced attachment store. While the
 * manifest row or the iCloud file hasn't arrived yet it shows a quiet
 * placeholder and keeps checking (iCloud downloads land asynchronously).
 */
export function SyncedImage({ name }: { name: string }) {
  const t = useTheme();
  const [uri, setUri] = useState<string | null>(() => resolveEmbedUri(name));
  const [ratio, setRatio] = useState(1.5);

  useEffect(() => {
    if (uri) return;
    let polls = 0;
    const ws = getActiveSource();
    if (ws) void requestMissingBlobs(ws);
    const timer = setInterval(() => {
      const next = resolveEmbedUri(name);
      if (next) {
        setUri(next);
        clearInterval(timer);
      } else if (++polls >= MAX_POLLS) {
        clearInterval(timer);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [name, uri]);

  if (!uri) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginVertical: 8 }}>
        <ImageOff size={14} color={t.textTertiary} />
        <Text style={{ color: t.textTertiary, fontStyle: "italic" }}>{name} — waiting to sync</Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri }}
      accessibilityLabel={name}
      contentFit="contain"
      onLoad={(e) => {
        const { width, height } = e.source;
        if (width > 0 && height > 0) setRatio(width / height);
      }}
      style={{ width: "100%", aspectRatio: ratio, borderRadius: 8, marginVertical: 8 }}
    />
  );
}
