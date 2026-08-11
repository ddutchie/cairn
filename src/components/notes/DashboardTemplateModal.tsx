"use client";

/**
 * DashboardTemplateModal — picker shown when creating a new dashboard.
 *
 * Offers 4 built-in templates plus a "Blank / Ask AI" option.
 * Selecting a template injects working HTML directly; blank opens the
 * empty dashboard so the user can prompt the AI.
 */

import React from "react";
import { LayoutDashboard, BarChart2, Users, CheckSquare, Globe, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// ── Templates ─────────────────────────────────────────────────────────────────

export interface DashboardTemplate {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  html: string;
}

export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [
  {
    id: "blank",
    label: "Blank",
    description: "Start with an empty canvas and prompt the AI",
    icon: <Sparkles size={18} />,
    html: "",
  },
  {
    id: "project-health",
    label: "Project Health",
    description: "Task counts by column with a progress bar",
    icon: <BarChart2 size={18} />,
    html: `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: var(--background); color: var(--text-primary); }
  body { font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif); font-size: 13px; padding: 20px; }
  h2 { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: var(--text-primary); }
  .columns { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; margin-bottom: 20px; }
  .col-card { border: 1px solid var(--border); border-radius: 8px; padding: 12px; text-align: center; background: var(--surface); }
  .col-card .count { font-size: 28px; font-weight: 700; color: var(--text-primary); }
  .col-card .name { font-size: 11px; color: var(--text-tertiary); margin-top: 2px; }
  .progress-bar { height: 6px; border-radius: 3px; background: var(--surface-3); overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 3px; background: var(--accent); transition: width 0.4s; }
  .progress-label { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-tertiary); margin-top: 6px; }
  .error { color: var(--danger); font-size: 12px; padding: 10px; }
</style>
</head>
<body>
<h2>Project Health</h2>
<div class="columns" id="columns"></div>
<div class="progress-bar"><div class="progress-fill" id="fill"></div></div>
<div class="progress-label"><span id="done-label">0 done</span><span id="total-label">0 total</span></div>
<script>
async function load() {
  try {
    const tasks = await window.cairn.listTasks();
    let done = 0, total = 0;
    const cols = document.getElementById('columns');
    cols.innerHTML = '';
    tasks.forEach(col => {
      const n = col.tasks.length;
      total += n;
      if (col.columnType === 'done') done += n;
      const card = document.createElement('div');
      card.className = 'col-card';
      card.innerHTML = '<div class="count">' + n + '</div><div class="name">' + col.columnName + '</div>';
      cols.appendChild(card);
    });
    document.getElementById('fill').style.width = total ? (done/total*100)+'%' : '0%';
    document.getElementById('done-label').textContent = done + ' done';
    document.getElementById('total-label').textContent = total + ' total';
  } catch(e) { document.body.innerHTML = '<div class="error">'+e.message+'</div>'; }
}
load();
window.addEventListener('cairn:refresh', load);
</script>
</body>
</html>`,
  },
  {
    id: "standup",
    label: "Daily Standup",
    description: "In-progress and blocked tasks at a glance",
    icon: <Users size={18} />,
    html: `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: var(--background); color: var(--text-primary); }
  body { font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif); font-size: 13px; padding: 20px; }
  h2 { font-size: 15px; font-weight: 600; margin-bottom: 4px; color: var(--text-primary); }
  .subtitle { font-size: 11px; color: var(--text-tertiary); margin-bottom: 16px; }
  section { margin-bottom: 20px; }
  h3 { font-size: 12px; font-weight: 600; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
  .task { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 6px; background: var(--surface); }
  .dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 3px; flex-shrink: 0; }
  .dot.in-progress { background: var(--accent); }
  .dot.review { background: var(--warning); }
  .task-title { font-size: 13px; color: var(--text-primary); }
  .empty { color: var(--text-tertiary); font-size: 12px; padding: 8px; }
</style>
</head>
<body>
<h2>Daily Standup</h2>
<div class="subtitle" id="date"></div>
<section><h3>In Progress</h3><div id="wip"></div></section>
<section><h3>In Review</h3><div id="review"></div></section>
<script>
document.getElementById('date').textContent = new Date().toLocaleDateString('en-US', {weekday:'long',month:'long',day:'numeric'});
async function load() {
  try {
    const tasks = await window.cairn.listTasks();
    function render(el, items, dotClass) {
      el.innerHTML = '';
      if (!items.length) { el.innerHTML = '<div class="empty">Nothing here</div>'; return; }
      items.forEach(t => {
        el.innerHTML += '<div class="task"><div class="dot ' + dotClass + '"></div><div class="task-title">' + t.title + '</div></div>';
      });
    }
    render(document.getElementById('wip'), (tasks.find(c=>c.columnType==='in_progress')?.tasks||[]), 'in-progress');
    render(document.getElementById('review'), (tasks.find(c=>c.columnType==='review')?.tasks||[]), 'review');
  } catch(e) {}
}
load();
window.addEventListener('cairn:refresh', load);
</script>
</body>
</html>`,
  },
  {
    id: "priority-board",
    label: "Priority Board",
    description: "Open tasks grouped by priority level",
    icon: <CheckSquare size={18} />,
    html: `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: var(--background); color: var(--text-primary); }
  body { font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif); font-size: 13px; padding: 20px; }
  h2 { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: var(--text-primary); }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .group { border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: var(--surface); }
  .group-header { display: flex; align-items: center; margin-bottom: 10px; }
  .badge { display: inline-block; font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.04em; }
  .urgent { background: color-mix(in srgb, var(--danger) 15%, transparent); color: var(--danger); }
  .high { background: color-mix(in srgb, var(--warning) 15%, transparent); color: var(--warning); }
  .medium { background: var(--accent-dim); color: var(--accent); }
  .low { background: var(--surface-3); color: var(--text-secondary); }
  .task { padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-secondary); }
  .task:last-child { border-bottom: none; }
  .empty { color: var(--text-tertiary); font-size: 12px; }
</style>
</head>
<body>
<h2>Priority Board</h2>
<div class="grid" id="grid"></div>
<script>
const PRIORITIES = ['urgent','high','medium','low'];
async function load() {
  try {
    const tasks = await window.cairn.listTasks();
    const open = tasks.filter(c=>c.columnType!=='done').flatMap(c=>c.tasks);
    const grid = document.getElementById('grid');
    grid.innerHTML = '';
    PRIORITIES.forEach(p => {
      const items = open.filter(t=>t.priority===p);
      const div = document.createElement('div');
      div.className = 'group';
      div.innerHTML = '<div class="group-header"><span class="badge '+p+'">'+p+'</span></div>' +
        (items.length ? items.map(t=>'<div class="task">'+t.title+'</div>').join('') : '<div class="empty">None</div>');
      grid.appendChild(div);
    });
  } catch(e) {}
}
load();
window.addEventListener('cairn:refresh', load);
</script>
</body>
</html>`,
  },
  {
    id: "workspace-overview",
    label: "Workspace Overview",
    description: "All projects with task totals and status",
    icon: <Globe size={18} />,
    html: `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: var(--background); color: var(--text-primary); }
  body { font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif); font-size: 13px; padding: 20px; }
  h2 { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: var(--text-primary); }
  .project { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; background: var(--surface); }
  .project-name { font-weight: 500; color: var(--text-primary); }
  .project-status { font-size: 11px; color: var(--text-tertiary); margin-top: 2px; }
  .stats { display: flex; gap: 16px; }
  .stat { text-align: center; }
  .stat .n { font-size: 20px; font-weight: 700; color: var(--accent); }
  .stat .l { font-size: 10px; color: var(--text-tertiary); }
</style>
</head>
<body>
<h2>Workspace Overview</h2>
<div id="projects"></div>
<script>
async function load() {
  try {
    const ctx = await window.cairn.getContext();
    const container = document.getElementById('projects');
    container.innerHTML = '';
    for (const project of (ctx.projects || [])) {
      const tasks = await window.cairn.listTasks(project.id);
      const open = tasks.filter(c=>c.columnType!=='done').reduce((s,c)=>s+c.tasks.length,0);
      const done = (tasks.find(c=>c.columnType==='done')?.tasks||[]).length;
      container.innerHTML += '<div class="project"><div><div class="project-name">'+project.name+'</div><div class="project-status">'+project.status+'</div></div><div class="stats"><div class="stat"><div class="n">'+open+'</div><div class="l">open</div></div><div class="stat"><div class="n">'+done+'</div><div class="l">done</div></div></div></div>';
    }
  } catch(e) {}
}
load();
window.addEventListener('cairn:refresh', load);
</script>
</body>
</html>`,
  },
];

// ── Modal component ────────────────────────────────────────────────────────────

interface Props {
  onSelect: (html: string, title: string) => void;
  onClose: () => void;
}

export function DashboardTemplateModal({ onSelect, onClose }: Props) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        size="md"
        aria-describedby="template-desc"
        className="max-w-xl overflow-hidden p-0 gap-0 border-[var(--border)] bg-[var(--surface)]"
      >
        {/* Header */}
        <DialogHeader className="flex flex-row items-center justify-start gap-2 px-5 py-4 border-b border-[var(--border)]">
          <LayoutDashboard size={14} className="text-[var(--text-tertiary)]" />
          <DialogTitle className="text-sm font-semibold text-[var(--text-primary)]">
            New Dashboard
          </DialogTitle>
        </DialogHeader>

        {/* Accessibility description */}
        <div id="template-desc" className="sr-only">
          Select a template to build a new custom dashboard or start with a blank screen.
        </div>

        {/* Template grid */}
        <div className="p-4 grid grid-cols-2 gap-3">
          {DASHBOARD_TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => onSelect(t.html, t.id === "blank" ? "Untitled Dashboard" : t.label)}
              className={cn(
                "flex flex-col items-start gap-2 p-3.5 rounded-lg border text-left transition-all",
                "border-[var(--border)] hover:border-[var(--accent)] hover:bg-[var(--accent-dim)]",
                t.id === "blank" && "col-span-2 flex-row items-center gap-3"
              )}
            >
              <div className={cn(
                "text-[var(--text-tertiary)]",
                t.id === "blank" && "text-[var(--accent)]"
              )}>
                {t.icon}
              </div>
              <div>
                <div className="text-xs font-semibold text-[var(--text-primary)]">{t.label}</div>
                <div className="text-[0.786rem] text-[var(--text-tertiary)] mt-0.5 leading-snug">{t.description}</div>
              </div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
