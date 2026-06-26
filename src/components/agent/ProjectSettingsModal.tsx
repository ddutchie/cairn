"use client";

import React from "react";
import { Settings } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProjectSettingsSection } from "@/components/settings/ProjectSettings";

interface ProjectSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function ProjectSettingsModal({ open, onClose }: ProjectSettingsModalProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent size="lg" className="overflow-y-auto max-h-[85vh] p-5">
        <DialogHeader className="px-0 pt-0 pb-3">
          <DialogTitle className="flex items-center gap-2">
            <Settings size={15} />
            Project Settings
          </DialogTitle>
        </DialogHeader>
        <div className="pt-4">
          <ProjectSettingsSection showHeader={false} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
