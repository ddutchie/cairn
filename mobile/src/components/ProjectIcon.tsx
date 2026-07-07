import React from "react";
import {
  Layers,
  Folder,
  BookOpen,
  Briefcase,
  Code2,
  Cpu,
  Globe,
  House,
  Inbox,
  Lightbulb,
  Map as MapIcon,
  Mountain,
  Pencil,
  Rocket,
  Star,
  Target,
  TreePine,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react-native";
import { resolveProjectIconName } from "@cairn/shared/ui/constants";

// Maps the shared Lucide icon NAMES (shared/ui/constants) to lucide-react-native
// components, so mobile project icons match the desktop set exactly.
const ICON_MAP: Record<string, LucideIcon> = {
  Layers,
  Folder,
  BookOpen,
  Briefcase,
  Code2,
  Cpu,
  Globe,
  Home: House, // lucide-react-native renamed Home -> House
  Inbox,
  Lightbulb,
  Map: MapIcon,
  Mountain,
  Pencil,
  Rocket,
  Star,
  Target,
  TreePine,
  Waves,
  Zap,
};

export function ProjectIcon({
  name,
  size = 18,
  color,
}: {
  name?: string | null;
  size?: number;
  color: string;
}) {
  const Icon = ICON_MAP[resolveProjectIconName(name)] ?? Folder;
  return <Icon size={size} color={color} />;
}
