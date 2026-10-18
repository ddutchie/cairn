import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { Calendar, Check, ClipboardPaste, FolderOpen, Link2, Square, Tag } from "lucide-react-native";
import { buildCaptureContext, captureExtract } from "@/capture/extract";
import { commitProposal, undoCommit } from "@/capture/commit";
import { fallbackProposal } from "@/capture/proposal";
import type { CaptureProposal } from "@/capture/types";
import { listProjects } from "@/db/queries";
import { DictationMic } from "@/components/DictationMic";
import { useDictation } from "@/dictation/useDictation";
import { ScreenChrome } from "@/components/screen-chrome";
import { ICON_CLOSE } from "@/components/toolbar-icons";
import { toast } from "@/components/Toast";
import { haptics, toolbarPress } from "@/haptics";
import { useTheme, withAlpha, type as typeScale, type Theme } from "@/theme";

type Stage = "input" | "thinking" | "proposal";

/**
 * Capture: drop something in (typed, pasted, dictated, or handed over by a deep
 * link / App Intent) and Cairn proposes where it goes — project, note vs tasks,
 * tags, links, due dates — for a one-tap confirm. Every failure path (no AI,
 * offline, slow) still ends in a usable proposal, never a dead end.
 */
export function CaptureSheet({
  initialText = "",
  autostart = false,
  onClose,
}: {
  initialText?: string;
  autostart?: boolean;
  onClose: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(t), [t]);

  const [stage, setStage] = useState<Stage>("input");
  const [text, setText] = useState(initialText);
  const dictation = useDictation({ text, setText });
  const [proposal, setProposal] = useState<CaptureProposal | null>(null);
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(new Set());
  const [pickingProject, setPickingProject] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const autostarted = useRef(false);

  const projects = useMemo(() => listProjects(), []);
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "Project";
  // Not while listening: words still being recognised would be missing from what gets filed.
  const canFile = text.trim().length > 0 && !dictation.listening;

  useEffect(() => () => abortRef.current?.abort(), []);

  const file = async () => {
    if (!canFile) return;
    setStage("thinking");
    haptics.selection();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await captureExtract(text, controller.signal);
      if (controller.signal.aborted) return;
      if (!result) {
        setStage("input");
        Alert.alert("No project yet", "Create a project first, then capture into it.");
        return;
      }
      setProposal(result);
      setSkipped(new Set());
      setPickingProject(false);
      setStage("proposal");
    } catch {
      if (!controller.signal.aborted) setStage("input");
    }
  };

  useEffect(() => {
    if (autostart && initialText.trim() && !autostarted.current) {
      autostarted.current = true;
      void file();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancelThinking = () => {
    abortRef.current?.abort();
    setStage("input");
  };

  // Set once a write succeeds: the modal stays interactive while it animates closed.
  const committed = useRef(false);
  const finish = (p: CaptureProposal) => {
    if (committed.current) return;
    try {
      const result = commitProposal(p);
      committed.current = true;
      haptics.success();
      const parts = [result.noteId ? "1 note" : null, result.taskIds.length > 0 ? `${result.taskIds.length} task${result.taskIds.length === 1 ? "" : "s"}` : null].filter(Boolean);
      toast.success(`Filed to ${result.projectName}`, {
        detail: parts.join(" · ") || undefined,
        actionText: "Undo",
        onActionPress: () => undoCommit(result),
        durationMs: 5000,
        haptic: false,
      });
      onClose();
    } catch (e) {
      haptics.error();
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Something went wrong.");
    }
  };

  const confirm = () => {
    if (!proposal) return;
    const tasks = proposal.tasks.filter((_, i) => !skipped.has(i));
    // Only tasks were proposed and all were unticked: filing would write nothing and drop the text.
    if (!proposal.note && tasks.length === 0) {
      Alert.alert("Nothing to file", "Keep at least one task, or go back and save it as a note.");
      return;
    }
    finish({ ...proposal, tasks });
  };

  const [saving, setSaving] = useState(false);
  const saveAsNote = async () => {
    if (!canFile || saving || committed.current) return;
    setSaving(true);
    try {
      const p = fallbackProposal(text, await buildCaptureContext(text.trim()));
      if (!p) {
        Alert.alert("No project yet", "Create a project first, then capture into it.");
        return;
      }
      finish(p);
    } catch (e) {
      haptics.error();
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  };

  const toggleTask = (i: number) => {
    haptics.selection();
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const linkedTitles = (proposal?.linkNoteIds ?? []).length;

  return (
    <View style={styles.container}>
      <ScreenChrome
        title="Capture"
        back="Back"
        left={[{ kind: "button", key: "close", label: "Cancel", icon: ICON_CLOSE, onPress: toolbarPress(onClose) }]}
      />

      {stage === "input" && (
        <View style={styles.flex}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder={dictation.listening ? "Listening… slide left to cancel" : "Drop a thought, a to-do, a link…"}
            editable={!dictation.listening}
            placeholderTextColor={t.textTertiary}
            multiline
            autoFocus
            textAlignVertical="top"
            accessibilityLabel="Capture text"
          />
          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            {dictation.available && <DictationMic dictation={dictation} size={36} />}
            <Pressable
              style={styles.ghostBtn}
              onPress={async () => {
                const pasted = await Clipboard.getStringAsync();
                if (pasted) setText((prev) => (prev ? `${prev}\n${pasted}` : pasted));
              }}
              accessibilityRole="button"
              accessibilityLabel="Paste from clipboard"
            >
              <ClipboardPaste size={16} color={t.textSecondary} />
              <Text style={styles.ghostText}>Paste</Text>
            </Pressable>
            <View style={styles.flex} />
            <Pressable style={styles.ghostBtn} onPress={saveAsNote} disabled={!canFile || saving} accessibilityRole="button">
              <Text style={[styles.ghostText, (!canFile || saving) && styles.disabled]}>Save as note</Text>
            </Pressable>
            <Pressable style={[styles.primaryBtn, !canFile && styles.primaryDisabled]} onPress={file} disabled={!canFile} accessibilityRole="button">
              <Text style={styles.primaryText}>File it</Text>
            </Pressable>
          </View>
        </View>
      )}

      {stage === "thinking" && (
        <View style={styles.center}>
          <ActivityIndicator color={t.accent} />
          <Text style={styles.thinking}>Finding where this belongs…</Text>
          <Text style={styles.preview} numberOfLines={3}>{text.trim()}</Text>
          <Pressable onPress={cancelThinking} hitSlop={10} accessibilityRole="button">
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {stage === "proposal" && proposal && (
        <View style={styles.flex}>
          <ScrollView contentContainerStyle={styles.proposalBody} keyboardShouldPersistTaps="handled">
            <Pressable style={styles.chipRow} onPress={() => setPickingProject((v) => !v)} accessibilityRole="button">
              <FolderOpen size={16} color={t.accent} />
              <Text style={styles.projectName}>{projectName(proposal.projectId)}</Text>
              <Text style={styles.change}>{pickingProject ? "Done" : "Change"}</Text>
            </Pressable>
            {pickingProject && (
              <View style={styles.pickList}>
                {projects.map((p) => (
                  <Pressable
                    key={p.id}
                    style={styles.pickRow}
                    onPress={() => {
                      haptics.selection();
                      setProposal({ ...proposal, projectId: p.id });
                      setPickingProject(false);
                    }}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.pickText, p.id === proposal.projectId && { color: t.accent }]}>{p.name}</Text>
                    {p.id === proposal.projectId && <Check size={16} color={t.accent} />}
                  </Pressable>
                ))}
              </View>
            )}
            <Text style={styles.reason}>{proposal.reason}</Text>

            {proposal.note && (
              <View style={styles.card}>
                <Text style={styles.cardLabel}>Note</Text>
                <TextInput
                  style={styles.noteTitle}
                  value={proposal.note.title}
                  onChangeText={(title) => setProposal({ ...proposal, note: { ...proposal.note!, title } })}
                  accessibilityLabel="Note title"
                />
                <Text style={styles.noteBody} numberOfLines={5}>{proposal.note.body}</Text>
              </View>
            )}

            {proposal.tasks.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardLabel}>Tasks</Text>
                {proposal.tasks.map((task, i) => {
                  const off = skipped.has(i);
                  return (
                    <Pressable key={i} style={styles.taskRow} onPress={() => toggleTask(i)} accessibilityRole="checkbox" accessibilityState={{ checked: !off }}>
                      {off ? <Square size={18} color={t.textTertiary} /> : <Check size={18} color={t.accent} />}
                      <View style={styles.flex}>
                        <Text style={[styles.taskTitle, off && styles.struck]}>{task.title}</Text>
                        {(task.dueDate || task.priority) && (
                          <View style={styles.metaRow}>
                            {task.dueDate && (
                              <View style={styles.meta}>
                                <Calendar size={12} color={t.textSecondary} />
                                <Text style={styles.metaText}>{task.dueDate}</Text>
                              </View>
                            )}
                            {task.priority && <Text style={styles.metaText}>{task.priority}</Text>}
                          </View>
                        )}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}

            {(proposal.tagNames.length > 0 || linkedTitles > 0) && (
              <View style={styles.metaRow}>
                {proposal.tagNames.map((tag) => (
                  <View key={tag} style={styles.pill}>
                    <Tag size={12} color={t.textSecondary} />
                    <Text style={styles.metaText}>{tag}</Text>
                  </View>
                ))}
                {linkedTitles > 0 && (
                  <View style={styles.pill}>
                    <Link2 size={12} color={t.textSecondary} />
                    <Text style={styles.metaText}>{linkedTitles} linked note{linkedTitles === 1 ? "" : "s"}</Text>
                  </View>
                )}
              </View>
            )}
          </ScrollView>
          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            <Pressable style={styles.ghostBtn} onPress={() => setStage("input")} accessibilityRole="button">
              <Text style={styles.ghostText}>Back</Text>
            </Pressable>
            <View style={styles.flex} />
            <Pressable style={styles.primaryBtn} onPress={confirm} accessibilityRole="button">
              <Text style={styles.primaryText}>Confirm</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.background },
    flex: { flex: 1 },
    input: { flex: 1, ...typeScale.body, color: t.textPrimary, paddingHorizontal: 20, paddingTop: 12 },
    footer: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border },
    ghostBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 10 },
    ghostText: { ...typeScale.control, color: t.textSecondary },
    disabled: { opacity: 0.4 },
    primaryBtn: { backgroundColor: t.accent, paddingHorizontal: 20, paddingVertical: 11, borderRadius: 22, borderCurve: "continuous" },
    primaryDisabled: { opacity: 0.4 },
    primaryText: { ...typeScale.control, color: t.accentFg },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, paddingHorizontal: 32 },
    thinking: { ...typeScale.title, color: t.textPrimary },
    preview: { ...typeScale.caption, color: t.textTertiary, textAlign: "center" },
    link: { ...typeScale.control, color: t.accent, paddingTop: 6 },
    proposalBody: { padding: 16, gap: 12 },
    chipRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: t.accentDim, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14, borderCurve: "continuous" },
    projectName: { ...typeScale.subtitle, color: t.textPrimary, flex: 1 },
    change: { ...typeScale.control, color: t.accent },
    pickList: { backgroundColor: t.surface2, borderRadius: 14, borderCurve: "continuous", overflow: "hidden" },
    pickRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.border },
    pickText: { ...typeScale.body, color: t.textPrimary },
    reason: { ...typeScale.caption, color: t.textTertiary, paddingHorizontal: 4 },
    card: { backgroundColor: t.surface2, borderRadius: 14, borderCurve: "continuous", padding: 14, gap: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: withAlpha(t.border, 0.6) },
    cardLabel: { ...typeScale.overline, color: t.textTertiary },
    noteTitle: { ...typeScale.title, color: t.textPrimary, padding: 0 },
    noteBody: { ...typeScale.body, color: t.textSecondary },
    taskRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 4 },
    taskTitle: { ...typeScale.body, color: t.textPrimary },
    struck: { color: t.textTertiary, textDecorationLine: "line-through" },
    metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 2 },
    meta: { flexDirection: "row", alignItems: "center", gap: 4 },
    metaText: { ...typeScale.caption, color: t.textSecondary },
    pill: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: t.surface3, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12 },
  });
}
