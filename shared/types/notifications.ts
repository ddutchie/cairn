/** In-app notification center rows (`mcp_notifications`), shared by main, preload and the renderer. */

/** The complete set of notification navigation-target types. */
export const NOTIFICATION_TARGET_TYPES = ["note", "task", "automation", "approval", "session"] as const;
export type NotificationTargetType = (typeof NOTIFICATION_TARGET_TYPES)[number];

export interface McpNotification {
  id: string;
  tool: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
  /** Optional navigation target (note/task/automation/approval/session) the notification links to. */
  targetType: NotificationTargetType | null;
  targetId: string | null;
}
