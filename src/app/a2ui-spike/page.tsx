"use client";

import { useState } from "react";
import { A2uiPlayground } from "@/components/a2ui/A2uiPlayground";
import { A2uiActionProvider } from "@/components/a2ui/a2ui-action-context";
import { ConversationMessageBubble } from "@/components/conversation/ConversationMessageBubble";
import type { ConversationMessage } from "@/lib/conversation/message";

const CATALOG = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";
const message: ConversationMessage = {
  id: "m1",
  createdAt: new Date().toISOString(),
  role: "assistant",
  content: "Here's a quick form — fill it in and I'll create the card.",
  toolCalls: [{
    name: "render_ui", label: "Showing UI", ok: true, callId: "c1",
    args: {
      title: "New task",
      messages: [
        { version: "v0.9", createSurface: { surfaceId: "t", catalogId: CATALOG } },
        { version: "v0.9", updateComponents: { surfaceId: "t", components: [
          { id: "root", component: "Column", children: ["name", "prio", "started", "go"] },
          { id: "name", component: "TextField", label: "Title", value: { path: "/title" } },
          { id: "prio", component: "ChoicePicker", label: "Priority", options: [{ label: "Low", value: "low" }, { label: "Medium", value: "medium" }, { label: "High", value: "high" }], value: { path: "/prio" } },
          { id: "started", component: "CheckBox", label: "Start in progress", value: { path: "/started" } },
          { id: "gl", component: "Text", text: "Create card" },
          { id: "go", component: "Button", child: "gl", action: { event: { name: "create_card", context: { title: { path: "/title" }, priority: { path: "/prio" }, started: { path: "/started" } } } } },
        ] } },
        { version: "v0.9", updateDataModel: { surfaceId: "t", path: "/", value: { title: "", prio: ["medium"], started: false } } },
      ],
    },
  }],
};

export default function Page() {
  const [sent, setSent] = useState<string[]>([]);
  return (
    <div className="h-screen overflow-auto">
      <div className="p-4 max-w-2xl">
        <h2 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">Chat bubble with render_ui</h2>
        <A2uiActionProvider value={(t) => setSent((s) => [t, ...s])}>
          <ConversationMessageBubble message={message} />
        </A2uiActionProvider>
        <pre data-testid="sent" className="mt-2 text-[0.643rem] text-[var(--accent)]">{sent.join("\n") || "(no user message sent yet)"}</pre>
      </div>
      <A2uiPlayground />
    </div>
  );
}
