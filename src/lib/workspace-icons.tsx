"use client";

import React from "react";
import {
  Layers,
  Folder,
  BookOpen,
  Briefcase,
  Code2,
  Cpu,
  Globe,
  Home,
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
} from "lucide-react";

export const WORKSPACE_ICONS: { name: string; icon: LucideIcon }[] = [
  { name: "Layers", icon: Layers },
  { name: "Folder", icon: Folder },
  { name: "BookOpen", icon: BookOpen },
  { name: "Briefcase", icon: Briefcase },
  { name: "Code2", icon: Code2 },
  { name: "Cpu", icon: Cpu },
  { name: "Globe", icon: Globe },
  { name: "Home", icon: Home },
  { name: "Inbox", icon: Inbox },
  { name: "Lightbulb", icon: Lightbulb },
  { name: "Map", icon: MapIcon },
  { name: "Mountain", icon: Mountain },
  { name: "Pencil", icon: Pencil },
  { name: "Rocket", icon: Rocket },
  { name: "Star", icon: Star },
  { name: "Target", icon: Target },
  { name: "TreePine", icon: TreePine },
  { name: "Waves", icon: Waves },
  { name: "Zap", icon: Zap },
];

const iconMap = new globalThis.Map<string, LucideIcon>(WORKSPACE_ICONS.map(({ name, icon }) => [name, icon]));

export const DEFAULT_WORKSPACE_ICON = "Layers";
export const DEFAULT_PROJECT_ICON = "Folder";

interface WorkspaceIconProps {
  name?: string | null;
  size?: number;
  className?: string;
}

/**
 * Renders a Lucide icon by stored name string.
 * Falls back to Layers for workspace, Folder for project contexts.
 */
export function WorkspaceIcon({ name, size = 14, className }: WorkspaceIconProps) {
  const Icon: LucideIcon = (name ? iconMap.get(name) : undefined) ?? Layers;
  return React.createElement(Icon, { size, className });
}

export function ProjectIcon({ name, size = 14, className }: WorkspaceIconProps) {
  const Icon: LucideIcon = (name ? iconMap.get(name) : undefined) ?? Folder;
  return React.createElement(Icon, { size, className });
}
