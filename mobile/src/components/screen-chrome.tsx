import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { Stack } from "expo-router";
import { Button, Menu, RNHostView, Toolbar, ToolbarItem } from "@expo/ui/swift-ui";
import { background, navigationBarTitleDisplayMode, navigationTitle, type ViewModifier } from "@expo/ui/swift-ui/modifiers";
import { useTheme } from "@/theme";
import type { SFSymbol } from "sf-symbols-typescript";
import type { ImageSourcePropType } from "react-native";

/**
 * Screen chrome — a screen's title and toolbar, described once as data and
 * rendered wherever the screen lives:
 *
 *   • as a route: the native Stack header (`Stack.Screen` + `Stack.Toolbar`),
 *     exactly as before;
 *   • inside a split-view column (`<ChromeColumn>`): the column's own SwiftUI
 *     navigation bar, since a column has no router header.
 *
 * Callers pass handlers already wrapped in `toolbarPress` where they want the
 * toolbar haptic, as with `Stack.Toolbar.Button`.
 */

type Icon = SFSymbol | ImageSourcePropType;

export interface ChromeAction {
  label: string;
  icon?: Icon;
  onPress: () => void;
  destructive?: boolean;
  isOn?: boolean;
}

export type ChromeItem =
  | {
      kind: "button";
      key: string;
      label: string;
      icon?: Icon;
      onPress: () => void;
      variant?: "done";
      hidden?: boolean;
    }
  | {
      kind: "menu";
      key: string;
      label: string;
      icon?: Icon;
      /** Visible text beside the icon (e.g. the current choice). */
      text?: string;
      actions: ChromeAction[];
    };

export interface ChromeSpec {
  title: string;
  /** Back-button label for route mode (root-stack callers). */
  back?: string;
  left?: ChromeItem[];
  right?: ChromeItem[];
}

type Report = (spec: ChromeSpec) => void;
const ChromeContext = createContext<Report | null>(null);

/** True when the screen is rendered inside a split-view column. */
export function useInColumn(): boolean {
  return useContext(ChromeContext) != null;
}

export function ScreenChrome(spec: ChromeSpec) {
  const report = useContext(ChromeContext);
  // Report every render; the column only re-renders when the visible shape
  // changes (see ChromeColumn), and always calls the latest handlers.
  useEffect(() => {
    report?.(spec);
  });
  if (report) return null;
  return <RouteChrome {...spec} />;
}

function RouteChrome({ title, back, left, right }: ChromeSpec) {
  return (
    <>
      <Stack.Screen options={{ title, ...(back ? { headerBackTitle: back } : {}) }} />
      {left?.length ? <Stack.Toolbar placement="left">{left.map(routeItem)}</Stack.Toolbar> : null}
      {right?.length ? <Stack.Toolbar placement="right">{right.map(routeItem)}</Stack.Toolbar> : null}
    </>
  );
}

function routeItem(item: ChromeItem) {
  if (item.kind === "button") {
    return (
      <Stack.Toolbar.Button
        key={item.key}
        icon={item.icon}
        accessibilityLabel={item.label}
        onPress={item.onPress}
        variant={item.variant}
        hidden={item.hidden}
      >
        {item.label}
      </Stack.Toolbar.Button>
    );
  }
  return (
    <Stack.Toolbar.Menu key={item.key} icon={item.icon} accessibilityLabel={item.label}>
      {item.text ? <Stack.Toolbar.Label>{item.text}</Stack.Toolbar.Label> : null}
      {item.actions.map((a) => (
        <Stack.Toolbar.MenuAction
          key={a.label}
          icon={a.icon}
          isOn={a.isOn}
          destructive={a.destructive}
          onPress={a.onPress}
        >
          {a.label}
        </Stack.Toolbar.MenuAction>
      ))}
    </Stack.Toolbar.Menu>
  );
}

/** Everything about a spec that affects what's drawn — not the handlers. */
function shape(spec: ChromeSpec | null): string {
  if (!spec) return "";
  const items = (list?: ChromeItem[]) =>
    (list ?? []).map((i) =>
      i.kind === "button"
        ? [i.key, i.label, String(i.icon), i.variant, i.hidden]
        : [i.key, i.label, String(i.icon), i.text, i.actions.map((a) => [a.label, String(a.icon), a.destructive, a.isOn])],
    );
  return JSON.stringify([spec.title, items(spec.left), items(spec.right)]);
}

const symbol = (icon?: Icon) => (typeof icon === "string" ? (icon as SFSymbol) : undefined);

/**
 * Hosts a React Native screen in a split-view column and draws the chrome the
 * screen reports as the column's native navigation bar.
 */
export function ChromeColumn({
  children,
  modifiers = [],
  leading = [],
}: {
  children: ReactElement;
  /** Extra column modifiers, e.g. `navigationSplitViewColumnWidth`. */
  modifiers?: ViewModifier[];
  /** Column-owned buttons placed before the screen's own leading items. */
  leading?: { key: string; label: string; icon: SFSymbol; onPress: () => void }[];
}) {
  const t = useTheme();
  const [spec, setSpec] = useState<ChromeSpec | null>(null);
  const latest = useRef<ChromeSpec | null>(null);

  const report = useCallback<Report>((next) => {
    latest.current = next;
    setSpec((prev) => (shape(prev) === shape(next) ? prev : next));
  }, []);

  // Look handlers up at press time so a stale render never runs an old closure.
  const find = (side: "left" | "right", key: string) =>
    latest.current?.[side]?.find((i) => i.key === key);
  const press = (side: "left" | "right", key: string, action?: number) => () => {
    const item = find(side, key);
    if (!item) return;
    if (item.kind === "button") item.onPress();
    else if (action != null) item.actions[action]?.onPress();
  };

  function columnItem(side: "left" | "right", item: ChromeItem) {
    if (item.kind === "button" && item.hidden) return null;
    return (
      <ToolbarItem key={item.key} placement={side === "left" ? "topBarLeading" : "topBarTrailing"}>
        {item.kind === "button" ? (
          <Button label={item.label} systemImage={symbol(item.icon)} onPress={press(side, item.key)} />
        ) : (
          <Menu label={item.label} systemImage={symbol(item.icon)}>
            {item.actions.map((a, i) => (
              <Button
                key={a.label}
                label={a.label}
                systemImage={symbol(a.icon)}
                role={a.destructive ? "destructive" : undefined}
                onPress={press(side, item.key, i)}
              />
            ))}
          </Menu>
        )}
      </ToolbarItem>
    );
  }

  return (
    // Inline titles: a large title costs too much height in a narrow column.
    <Toolbar
      modifiers={[
        navigationTitle(spec?.title ?? ""),
        navigationBarTitleDisplayMode("inline"),
        // Caller modifiers (column width, a hinge inset) come first so the
        // background below also paints any padding they add.
        ...modifiers,
        // Fill the column, safe areas included (the Duo's hinge reserves one),
        // with the page colour so no white band shows around the hosted screen.
        background(t.background),
      ]}
    >
      <RNHostView>
        <ChromeContext.Provider value={report}>{children}</ChromeContext.Provider>
      </RNHostView>
      <Toolbar.Content>
        {leading.map((b) => (
          <ToolbarItem key={b.key} placement="topBarLeading">
            <Button label={b.label} systemImage={b.icon} onPress={b.onPress} />
          </ToolbarItem>
        ))}
        {(spec?.left ?? []).map((i) => columnItem("left", i))}
        {/* Trailing items render right to left, so reverse to keep the
            route order reading left to right. */}
        {[...(spec?.right ?? [])].reverse().map((i) => columnItem("right", i))}
      </Toolbar.Content>
    </Toolbar>
  );
}
