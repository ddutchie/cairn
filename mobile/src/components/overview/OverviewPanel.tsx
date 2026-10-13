import { useCallback, useState, type ReactNode } from "react";
import { View } from "react-native";
import { getProjectOverview, type ProjectOverviewData } from "@/db/queries";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { useTheme } from "@/theme";
import { OverviewTab, type OverviewNav, type OverviewSection } from "./OverviewTab";

/**
 * A few of the Overview's blocks on their own, loading the project's overview data
 * itself — for the Projects split view, which reuses them beside the Board / Calendar
 * (status) and in the detail column next to the Overview (recent notes, activity).
 * The owner re-keys it when a task changes elsewhere so the numbers follow.
 */
export function OverviewPanel({
  projectId,
  show,
  header,
  nav,
}: {
  projectId: string;
  show: OverviewSection[];
  header?: ReactNode;
  nav: OverviewNav;
}) {
  const t = useTheme();
  const [data, setData] = useState<ProjectOverviewData | null>(() => getProjectOverview(projectId));
  const load = useCallback(() => setData(getProjectOverview(projectId)), [projectId]);
  useRefreshOnFocus(load);
  if (!data) return <View style={{ flex: 1, backgroundColor: t.background }} />;
  return <OverviewTab show={show} header={header} data={data} nav={nav} bottomPad={24} />;
}
