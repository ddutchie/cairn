"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { ChevronLeft, ChevronRight, X, Sparkles } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { isView } from "@/lib/views";
import { IconButton } from "@/components/ui/icon-button";

interface TutorialStep {
  selector: string;
  view: "overview" | "notes" | "board" | "flow" | "graph" | "insights" | "settings" | "agent" | "automations" | "chat";
  title: string;
  content: string;
  placement: "top" | "bottom" | "left" | "right";
  action?: () => void;
}

/**
 * The sidebar renders a collapsed and an expanded copy of some controls, and the
 * hidden copy comes first in the DOM. Pick the first copy the user can see, so the
 * highlight lands on the control instead of an empty spot.
 */
function findTutorialTarget(selector: string): Element | null {
  for (const el of Array.from(document.querySelectorAll(selector))) {
    if (el.closest("[inert], [aria-hidden='true']")) continue;
    if (el.getBoundingClientRect().width === 0) continue;
    return el;
  }
  return null;
}

const TUTORIAL_STEPS: TutorialStep[] = [
  {
    selector: '[data-tutorial="workspace-switcher"]',
    view: "overview",
    title: "Workspace Switcher",
    content: "Jump between different local workspaces. Each workspace acts as a self-contained vault for your project groups.",
    placement: "right"
  },
  {
    selector: '[data-tutorial="projects-list"]',
    view: "overview",
    title: "Projects & Navigation",
    content: "Here are all the projects inside your active workspace. Select a project to view its overview, notes, tasks, or flows.",
    placement: "right"
  },
  {
    selector: '[data-tutorial="view-tabs"]',
    view: "overview",
    title: "Project Sections",
    content: "Navigate through the sections of your active project: view summaries, write markdown notes, manage tasks, or run terminal agents.",
    placement: "bottom"
  },
  {
    selector: '[data-tutorial="notes-editor"]',
    view: "notes",
    title: "Local Markdown Notes",
    content: "Create and edit notes. Notes are saved directly as standard .md files on your disk. Features syntax highlights and AI editing controls.",
    placement: "left"
  },
  {
    selector: '[data-tutorial="kanban-columns"]',
    view: "board",
    title: "Kanban Task Board",
    content: "Organize project execution. Drag and drop task cards, filter by tags, and set priority levels to keep execution structured.",
    placement: "top"
  },
  {
    selector: '[data-tutorial="flow-canvas"]',
    view: "flow",
    title: "Idea Flow Canvas",
    content: "Visually connect ideas, notes, and task cards in a freeform coordinate graph before building them.",
    placement: "top"
  },
  {
    selector: '[data-tutorial="search-bar"]',
    view: "overview",
    title: "Search and ask",
    content: "Find notes, tasks and projects from anywhere with the search bar. You can also ask the AI a question here, and it answers from your workspace.",
    placement: "bottom"
  },
  {
    selector: '[data-tutorial="agent-view"]',
    view: "agent",
    title: "Agent for code",
    content: "Work on a project's code. The agent reads and edits files and runs commands in a sandbox, and asks before anything risky.",
    placement: "right"
  },
  {
    selector: '[data-tutorial="automations-view"]',
    view: "automations",
    title: "Automations",
    content: "Run recurring jobs on a schedule, such as a weekly summary. Each run and its result shows up here.",
    placement: "right"
  },
  {
    selector: '[data-tutorial="insights-view"]',
    view: "insights",
    title: "Insights and graph",
    content: "See how your notes, tasks and ideas connect. Insights has the charts, and the Knowledge Graph shows the links between items.",
    placement: "right"
  },
  {
    selector: '[data-tutorial="settings-view"]',
    view: "settings",
    title: "Settings",
    content: "Add AI providers, connect tools and MCP servers, and choose the theme. Most options live here.",
    placement: "right"
  },
  {
    selector: '[data-tutorial="chat-toggle"]',
    view: "overview",
    title: "AI Chat & Copilot",
    content: "Open the Chat drawer to ask questions, search notes, write documentation, or execute codebase changes via the terminal agent.",
    placement: "left"
  }
];

export function AppTutorial() {
  const { tutorialActive, tutorialStepIndex, setTutorialActive, setTutorialStepIndex, activeView, setView, chatOpen, toggleChat } = useCairnStore(
    useShallow((s) => ({
      tutorialActive: s.tutorialActive,
      tutorialStepIndex: s.tutorialStepIndex,
      setTutorialActive: s.setTutorialActive,
      setTutorialStepIndex: s.setTutorialStepIndex,
      activeView: s.activeView,
      setView: s.setView,
      chatOpen: s.chatOpen,
      toggleChat: s.toggleChat,
    }))
  );

  const currentStep = TUTORIAL_STEPS[tutorialStepIndex];

  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 });
  const [tutorialOpenedChat, setTutorialOpenedChat] = useState(false);
  const prevIndexRef = useRef(tutorialStepIndex);
  const [prevTutorialActive, setPrevTutorialActive] = useState(tutorialActive);
  const [prevStepKey, setPrevStepKey] = useState<{ tutorialActive: boolean; stepKey: string }>({
    tutorialActive,
    stepKey: currentStep?.selector ?? "",
  });

  const goToStep = useCallback((next: number) => {
    prevIndexRef.current = tutorialStepIndex;
    setTutorialStepIndex(next);
  }, [tutorialStepIndex, setTutorialStepIndex]);

  const handleFinish = useCallback(() => {
    setTutorialActive(false);
    // Close chat if we opened it for the tutorial
    if (chatOpen && tutorialOpenedChat) {
      toggleChat();
    }
    setTutorialOpenedChat(false);
  }, [chatOpen, tutorialOpenedChat, toggleChat, setTutorialActive]);

  const handleNext = () => {
    // Custom trigger action for final steps (e.g. toggle chat panel to show toggle element)
    if (tutorialStepIndex === TUTORIAL_STEPS.length - 2 && !chatOpen) {
      setTutorialOpenedChat(true);
      toggleChat();
    }

    if (tutorialStepIndex < TUTORIAL_STEPS.length - 1) {
      goToStep(tutorialStepIndex + 1);
    } else {
      handleFinish();
    }
  };

  const handleBack = () => {
    if (tutorialStepIndex > 0) {
      goToStep(tutorialStepIndex - 1);
    }
  };

  // Reset chat opening flag when tutorial concludes (adjust during render to avoid cascading renders in an effect)
  if (prevTutorialActive !== tutorialActive) {
    setPrevTutorialActive(tutorialActive);
    if (!tutorialActive && tutorialOpenedChat) {
      setTutorialOpenedChat(false);
    }
  }

  // Automations and Insights sit in the Workspace group. Open it for this run
  // without saving that, so a restart brings back the user's own choice.
  useEffect(() => {
    if (tutorialActive) useCairnStore.setState({ workspaceToolsCollapsed: false });
  }, [tutorialActive]);

  // Skip steps dynamically if the target elements aren't present in the DOM
  useEffect(() => {
    if (!tutorialActive || !currentStep) return;

    let checkAttempts = 0;
    let timeoutId: number;

    const checkAvailability = () => {
      const element = findTutorialTarget(currentStep.selector);
      if (!element) {
        // Views mount after a step starts, so wait a few seconds before treating
        // a target as missing. Skipping too early made the tour fly through steps.
        if (checkAttempts < 40) {
          checkAttempts++;
          timeoutId = window.setTimeout(checkAvailability, 100);
        } else {
          const goingBack = tutorialStepIndex < prevIndexRef.current;
          if (goingBack) {
            if (tutorialStepIndex > 0) {
              goToStep(tutorialStepIndex - 1);
            } else {
              handleFinish();
            }
          } else {
            if (tutorialStepIndex < TUTORIAL_STEPS.length - 1) {
              goToStep(tutorialStepIndex + 1);
            } else {
              handleFinish();
            }
          }
        }
      }
    };

    timeoutId = window.setTimeout(checkAvailability, 250);
    return () => clearTimeout(timeoutId);
  }, [tutorialActive, tutorialStepIndex, currentStep, handleFinish, goToStep]);

  // Effect to handle switching views on step changes
  useEffect(() => {
    if (!tutorialActive || !currentStep) return;

    if (!isView(activeView, currentStep.view)) {
      setView(currentStep.view);
    }
  }, [tutorialActive, tutorialStepIndex, activeView, setView, currentStep]);

  // Clear the target rect when the tutorial becomes inactive or the step changes
  // (adjust during render to avoid cascading renders from setState in an effect)
  const stepKey = currentStep?.selector ?? "";
  if (
    prevStepKey.tutorialActive !== tutorialActive ||
    prevStepKey.stepKey !== stepKey
  ) {
    setPrevStepKey({ tutorialActive, stepKey });
    if (targetRect !== null) {
      setTargetRect(null);
    }
  }

  // Effect to handle real-time position tracking of the target element
  useEffect(() => {
    if (!tutorialActive || !currentStep) {
      return;
    }

    let frameId: number;
    let checkAttempts = 0;

    const update = () => {
      const element = findTutorialTarget(currentStep.selector);
      if (element) {
        const rect = element.getBoundingClientRect();
        
        // If element is currently zero-sized, it might be mounting. Wait.
        if (rect.width === 0 && rect.height === 0 && checkAttempts < 5) {
          checkAttempts++;
          frameId = requestAnimationFrame(update);
          return;
        }

        setTargetRect((prev) => {
          if (
            prev &&
            prev.top === rect.top &&
            prev.left === rect.left &&
            prev.width === rect.width &&
            prev.height === rect.height
          ) {
            return prev;
          }
          return rect;
        });
      } else {
        // Element not in DOM yet. Wait and retry.
        if (checkAttempts < 5) {
          checkAttempts++;
        } else {
          setTargetRect(null);
        }
      }
      frameId = requestAnimationFrame(update);
    };

    frameId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frameId);
  }, [tutorialActive, tutorialStepIndex, currentStep]);

  // Adjust tooltip positioning relative to target rect
  useEffect(() => {
    if (!targetRect || !tooltipRef.current || !currentStep) return;

    const tooltipEl = tooltipRef.current;
    const tooltipWidth = tooltipEl.offsetWidth || 320;
    const tooltipHeight = tooltipEl.offsetHeight || 150;
    const gap = 12;

    let top = 0;
    let left = 0;

    switch (currentStep.placement) {
      case "top":
        top = targetRect.top - tooltipHeight - gap;
        left = targetRect.left + (targetRect.width - tooltipWidth) / 2;
        break;
      case "bottom":
        top = targetRect.bottom + gap;
        left = targetRect.left + (targetRect.width - tooltipWidth) / 2;
        break;
      case "left":
        top = targetRect.top + (targetRect.height - tooltipHeight) / 2;
        left = targetRect.left - tooltipWidth - gap;
        break;
      case "right":
        top = targetRect.top + (targetRect.height - tooltipHeight) / 2;
        left = targetRect.right + gap;
        break;
    }

    // Boundary constraints check (clamping within viewport edges)
    const padding = 16;
    const maxLeft = window.innerWidth - tooltipWidth - padding;
    const maxTop = window.innerHeight - tooltipHeight - padding;

    left = Math.max(padding, Math.min(maxLeft, left));
    top = Math.max(padding, Math.min(maxTop, top));

    setTooltipPos({ top, left });
  }, [targetRect, currentStep]);

  if (!tutorialActive || !currentStep) return null;

  // Build the clip-path cutout polygon.
  // We create a cutout hole at targetRect coordinates.
  const clipPathStyle = targetRect
    ? {
        clipPath: `polygon(
          0% 0%, 0% 100%, 
          ${targetRect.left}px 100%, 
          ${targetRect.left}px ${targetRect.top}px, 
          ${targetRect.right}px ${targetRect.top}px, 
          ${targetRect.right}px ${targetRect.bottom}px, 
          ${targetRect.left}px ${targetRect.bottom}px, 
          ${targetRect.left}px 100%, 
          100% 100%, 100% 0%
        )`,
        transition: "clip-path 0.3s ease-in-out",
      }
    : undefined;

  return (
    <div className="fixed inset-0 z-[9999] pointer-events-none select-none">
      {/* Backdrop with cutout mask portal */}
      <div
        className="absolute inset-0 bg-[color-mix(in_srgb,var(--background)_60%,transparent)] pointer-events-auto transition-all duration-300"
        style={clipPathStyle}
        onClick={handleFinish}
      />

      {/* High-visibility glowing target boundary indicator */}
      {targetRect && (
        <div
          className="absolute border-2 border-[var(--accent)] rounded-lg pointer-events-none transition-all duration-300"
          style={{
            top: targetRect.top - 2,
            left: targetRect.left - 2,
            width: targetRect.width + 4,
            height: targetRect.height + 4,
            boxShadow: "0 0 15px color-mix(in srgb, var(--accent) 50%, transparent)",
          }}
        />
      )}

      {/* Descriptive floating tooltip card */}
      <div
        ref={tooltipRef}
        className="absolute w-80 rounded-xl border border-[var(--border)] p-4 shadow-elev-3 transition-all duration-300 pointer-events-auto flex flex-col gap-3"
        style={{
          top: tooltipPos.top,
          left: tooltipPos.left,
          background: "var(--surface)",
        }}
      >
        {/* Tooltip Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[var(--accent)] font-semibold">
            <Sparkles size={13} className="animate-pulse" />
            <span className="text-xs">Quick tour</span>
          </div>
          <IconButton
            label="End tour"
            onClick={handleFinish}
            className="size-auto p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
          >
            <X size={12} />
          </IconButton>
        </div>

        {/* Content text */}
        <div>
          <h3 className="text-xs font-bold text-[var(--text-primary)]">{currentStep.title}</h3>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed mt-1">
            {currentStep.content}
          </p>
        </div>

        {/* Navigation Actions Footer */}
        <div className="flex items-center justify-between mt-1 pt-3 border-t border-[var(--border-subtle)]">
          <span className="text-2xs font-medium text-[var(--text-tertiary)]">
            Step {tutorialStepIndex + 1} of {TUTORIAL_STEPS.length}
          </span>

          <div className="flex items-center gap-1.5">
            {tutorialStepIndex > 0 && (
              <button
                onClick={handleBack}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-[var(--text-secondary)] border border-[var(--border)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
              >
                <ChevronLeft size={11} />
                <span>Back</span>
              </button>
            )}
            <Button variant="accent" size="sm" onClick={handleNext}>
              <span>{tutorialStepIndex === TUTORIAL_STEPS.length - 1 ? "Finish" : "Next"}</span>
              <ChevronRight size={11} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
