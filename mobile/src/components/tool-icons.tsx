import { BarChart3, Gamepad2, Network, RefreshCw, Sun, Users } from "lucide-react-native";
import { isArcadeTool, type ToolId } from "@/lib/workspace-tools";

const ICONS: Partial<Record<ToolId, typeof Users>> = { today: Sun, people: Users, graph: Network, usage: BarChart3, sync: RefreshCw };

/** A Workspace tool's icon component; the arcade and its games share a controller. */
export function toolIcon(id: ToolId): typeof Users {
  return ICONS[id] ?? (isArcadeTool(id) ? Gamepad2 : Sun);
}

/** A Workspace tool's icon. */
export function ToolIcon({ tool, size, color }: { tool: ToolId; size: number; color: string }) {
  const own = ICONS[tool];
  if (own === Sun) return <Sun size={size} color={color} />;
  if (own === Users) return <Users size={size} color={color} />;
  if (own === Network) return <Network size={size} color={color} />;
  if (own === BarChart3) return <BarChart3 size={size} color={color} />;
  if (own === RefreshCw) return <RefreshCw size={size} color={color} />;
  return <Gamepad2 size={size} color={color} />;
}
