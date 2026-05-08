/**
 * Settings tab — AI provider config, workspace info, reset.
 */
import { View, Text, ScrollView, TextInput, Pressable, Alert } from "react-native";
import { useState, useEffect } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { closeDb } from "../../db/client";
import { useStore } from "../../store/index";

const AI_CONFIG_KEY = "cairn:mobile:aiConfig";

interface AIConfig {
  provider: "openai" | "anthropic" | "groq";
  apiKey: string;
  model: string;
}

const PROVIDER_MODELS: Record<AIConfig["provider"], string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  anthropic: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
};

export default function SettingsTab() {
  const router = useRouter();
  const dbPath = useStore((s) => s.dbPath);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);

  const [aiConfig, setAIConfig] = useState<AIConfig>({
    provider: "anthropic",
    apiKey: "",
    model: "claude-sonnet-4-5",
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(AI_CONFIG_KEY).then((raw) => {
      if (raw) setAIConfig(JSON.parse(raw));
    });
  }, []);

  async function saveAIConfig() {
    await AsyncStorage.setItem(AI_CONFIG_KEY, JSON.stringify(aiConfig));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function resetWorkspace() {
    Alert.alert(
      "Disconnect workspace",
      "This removes the database connection from this device. Your data is not deleted.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: async () => {
            await closeDb();
            await AsyncStorage.removeItem("cairn:mobile:dbPath");
            await AsyncStorage.removeItem("cairn:mobile:workspaceId");
            router.replace("/onboarding");
          },
        },
      ]
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-zinc-950" edges={["top"]}>
      <ScrollView contentContainerClassName="px-5 pt-4 pb-12 gap-6">
        <Text className="text-white text-2xl font-bold tracking-tight">Settings</Text>

        {/* Workspace info */}
        <Section title="Workspace">
          <InfoRow label="Name" value={workspace?.name ?? "—"} />
          <InfoRow
            label="Database"
            value={dbPath ? dbPath.split("/").slice(-3).join("/") : "Not connected"}
            small
          />
        </Section>

        {/* AI config */}
        <Section title="AI Provider">
          {/* Provider picker */}
          <Text className="text-zinc-400 text-xs mb-1">Provider</Text>
          <View className="flex-row gap-2 mb-3">
            {(["openai", "anthropic", "groq"] as AIConfig["provider"][]).map((p) => (
              <Pressable
                key={p}
                onPress={() =>
                  setAIConfig((c) => ({
                    ...c,
                    provider: p,
                    model: PROVIDER_MODELS[p][0],
                  }))
                }
                className={`flex-1 py-2 rounded-lg items-center ${
                  aiConfig.provider === p ? "bg-indigo-600" : "bg-zinc-800"
                }`}
              >
                <Text
                  className={`text-xs font-semibold capitalize ${
                    aiConfig.provider === p ? "text-white" : "text-zinc-400"
                  }`}
                >
                  {p}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Model picker */}
          <Text className="text-zinc-400 text-xs mb-1">Model</Text>
          <View className="gap-1.5 mb-3">
            {PROVIDER_MODELS[aiConfig.provider].map((m) => (
              <Pressable
                key={m}
                onPress={() => setAIConfig((c) => ({ ...c, model: m }))}
                className={`px-3 py-2 rounded-lg ${
                  aiConfig.model === m ? "bg-indigo-600/20 border border-indigo-500" : "bg-zinc-800"
                }`}
              >
                <Text
                  className={`text-sm ${aiConfig.model === m ? "text-indigo-300" : "text-zinc-300"}`}
                >
                  {m}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* API Key */}
          <Text className="text-zinc-400 text-xs mb-1">API Key</Text>
          <TextInput
            className="bg-zinc-800 rounded-xl px-4 py-3 text-white text-sm font-mono mb-4"
            placeholder="sk-..."
            placeholderTextColor="#52525b"
            value={aiConfig.apiKey}
            onChangeText={(v) => setAIConfig((c) => ({ ...c, apiKey: v }))}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Pressable
            onPress={saveAIConfig}
            className="bg-indigo-600 rounded-xl py-3 items-center active:opacity-80"
          >
            <Text className="text-white font-semibold text-sm">
              {saved ? "Saved!" : "Save AI Config"}
            </Text>
          </Pressable>
        </Section>

        {/* Danger zone */}
        <Section title="Workspace">
          <Pressable
            onPress={resetWorkspace}
            className="bg-red-900/30 border border-red-800 rounded-xl py-3 items-center active:opacity-80"
          >
            <Text className="text-red-400 font-semibold text-sm">Disconnect workspace</Text>
          </Pressable>
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View>
      <Text className="text-zinc-500 text-xs font-semibold uppercase tracking-wider mb-2">
        {title}
      </Text>
      <View className="bg-zinc-900 rounded-xl p-4 gap-2">{children}</View>
    </View>
  );
}

function InfoRow({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <View className="flex-row justify-between items-start gap-4">
      <Text className="text-zinc-500 text-sm shrink-0">{label}</Text>
      <Text
        className={`text-white ${small ? "text-xs font-mono" : "text-sm"} text-right flex-1`}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}
