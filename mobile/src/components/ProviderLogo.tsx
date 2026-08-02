import { useEffect, useState } from "react";
import { View } from "react-native";
import { SvgXml } from "react-native-svg";
import { useIsDark } from "@/theme";
import { providerLogoUrl } from "@cairn/shared/models/model-catalog";

/**
 * ProviderLogo (mobile) — renders a models.dev provider logo
 * (https://models.dev/logos/{provider}.svg).
 *
 * models.dev logos are single-colour SVGs drawn with `fill="currentColor"`, so
 * we tint them from the theme (light glyph on dark, dark glyph on light) via
 * SvgXml's `color` prop — no inversion hacks needed. The SVG text is fetched
 * once per provider and cached in memory. Failure renders nothing (rows stay
 * readable without a logo).
 */
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

async function fetchLogo(provider: string): Promise<string | null> {
  const cached = cache.get(provider);
  if (cached) return cached;
  const pending = inflight.get(provider);
  if (pending) return pending;
  const p = (async () => {
    try {
      const res = await fetch(providerLogoUrl(provider));
      if (!res.ok) return null;
      const text = await res.text();
      if (!/^\s*<svg[\s>]/i.test(text) || !/<\/svg>\s*$/i.test(text)) return null;
      cache.set(provider, text);
      return text;
    } catch {
      return null;
    } finally {
      inflight.delete(provider);
    }
  })();
  inflight.set(provider, p);
  return p;
}

export function ProviderLogo({ provider, size = 14 }: { provider: string; size?: number }) {
  const isDark = useIsDark();
  const [xml, setXml] = useState<string | null>(cache.get(provider) ?? null);

  useEffect(() => {
    let alive = true;
    fetchLogo(provider).then((text) => {
      if (alive && text) setXml(text);
    });
    return () => {
      alive = false;
    };
  }, [provider]);

  if (!xml) return <View style={{ width: size, height: size }} />;
  return <SvgXml xml={xml} width={size} height={size} color={isDark ? "#fff" : "#000"} />;
}
