"use client";

import React from "react";
import { Settings } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { ProjectSettingsSection } from "@/components/settings/ProjectSettings";
import { useCairnStore } from "@/store";

interface ProjectSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function ProjectSettingsModal({ open, onClose }: ProjectSettingsModalProps) {
  const activeProjectId = useCairnStore((s) => s.activeProjectId);

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      size="lg"
      scrollable
      title={<><Settings size={15} /> Project Settings</>}
    >
      <ProjectSettingsSection key={activeProjectId ?? "none"} showHeader={false} />
    </ModalShell>
  );
}
