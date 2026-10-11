import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Stack } from "expo-router";
import { navigationBarHidden } from "@modules/swiftui-modifiers";
import { Button, Menu, RNHostView, Toolbar, ToolbarItem, type ToolbarItemPlacement } from "@expo/ui/swift-ui";
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
      /** Keeps the item out of overflow longest (Compose-style actions). */
      priority?: "high" | "low";
    }
  | {
      kind: "menu";
      key: string;
      label: string;
      icon?: Icon;
      /** Visible text beside the icon (e.g. the current choice). */
      text?: string;
      actions: ChromeAction[];
      priority?: "high" | "low";
      /**
       * An "actions" (⋯) menu: in a column its actions go into the system
       * overflow menu instead (Apple reserves the ellipsis for it), so the
       * side rail keeps Close → Done → the rest.
       */
      overflow?: boolean;
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

/** A column-owned button (e.g. ✕ to close the column's item). */
export interface LeadingButton {
  key: string;
  label: string;
  icon: SFSymbol;
  onPress: () => void;
}

/**
 * Header bridge — on iPad the floating tab bar sits in the window's top row and
 * SwiftUI columns put their own bars *below* it, wasting a band of height. So
 * a split view can provide a bridge instead: each bridged column hides its bar
 * and reports its items here, and the split view draws them in the native
 * stack header, which shares the tab bar's row.
 *
 *   primary   — the left / list column (drawn left of the tab bar)
 *   secondary — the open item (drawn right of it)
 */
export type ChromeSlot = "primary" | "secondary";

export interface BridgedChrome {
  /** Current handlers, for press-time lookup. */
  latest: { spec: ChromeSpec | null; leading: LeadingButton[] };
  spec: ChromeSpec | null;
  leading: LeadingButton[];
}

type Bridge = (slot: ChromeSlot, chrome: BridgedChrome | null) => void;
const ChromeBridgeContext = createContext<Bridge | null>(null);
/**
 * Keep bridged columns' own bars (title only) instead of hiding them — used on
 * the iPhone Duo, where a column's buttons move to another column's bar (the
 * one that docks into the tab rail) rather than into the stack header.
 */
const ChromeBridgeOptionsContext = createContext<{ keepBars: boolean; slots: readonly ChromeSlot[] }>({
  keepBars: false,
  slots: ["primary", "secondary"],
});
export function ChromeBridgeProvider({
  value,
  keepBars = false,
  slots = ["primary", "secondary"],
  children,
}: {
  value: Bridge;
  keepBars?: boolean;
  /** The slots this bridge takes; columns in other slots keep their own buttons. */
  slots?: readonly ChromeSlot[];
  children: ReactNode;
}) {
  const options = useMemo(() => ({ keepBars, slots }), [keepBars, slots]);
  return (
    <ChromeBridgeContext.Provider value={value}>
      <ChromeBridgeOptionsContext.Provider value={options}>{children}</ChromeBridgeOptionsContext.Provider>
    </ChromeBridgeContext.Provider>
  );
}

/** Flattens a bridged column into stack-header items: its buttons, then its own. */
export function bridgedItems(chrome: BridgedChrome | null | undefined): ChromeItem[] {
  if (!chrome) return [];
  const pressLeading = (key: string) => () => chrome.latest.leading.find((b) => b.key === key)?.onPress();
  const pressItem = (side: "left" | "right", key: string, action?: number) => () => {
    const item = chrome.latest.spec?.[side]?.find((i) => i.key === key);
    if (!item) return;
    if (item.kind === "button") item.onPress();
    else if (action != null) item.actions[action]?.onPress();
  };
  const own = (side: "left" | "right") =>
    (chrome.spec?.[side] ?? []).map<ChromeItem>((i) =>
      i.kind === "button"
        ? { ...i, onPress: pressItem(side, i.key) }
        : { ...i, actions: i.actions.map((a, n) => ({ ...a, onPress: pressItem(side, i.key, n) })) },
    );
  return [
    ...chrome.leading.map<ChromeItem>((b) => ({ kind: "button", key: b.key, label: b.label, icon: b.icon, onPress: pressLeading(b.key) })),
    ...own("left"),
    ...own("right"),
  ];
}

/** Renders bridged items as `Stack.Toolbar` children. */
export const routeItems = (items: ChromeItem[]) => items.map(routeItem);

/** Everything about a spec that affects what's drawn — not the handlers. */
function shape(spec: ChromeSpec | null): string {
  if (!spec) return "";
  const items = (list?: ChromeItem[]) =>
    (list ?? []).map((i) =>
      i.kind === "button"
        ? [i.key, i.label, String(i.icon), i.variant, i.hidden, i.priority]
        : [i.key, i.label, String(i.icon), i.text, i.priority, i.overflow, i.actions.map((a) => [a.label, String(a.icon), a.destructive, a.isOn])],
    );
  return JSON.stringify([spec.title, items(spec.left), items(spec.right)]);
}

const leadingShape = (leading: LeadingButton[]) => JSON.stringify(leading.map((b) => [b.key, b.label, b.icon]));

/**
 * A screen's own Cancel item (e.g. the note editor's). In a column it replaces
 * the column's ✕ — one dismiss at the top of the side rail, never two.
 */
export const CANCEL_KEY = "cancel";

/**
 * Semantic placement + overflow priority for a column item. On the Duo the
 * detail column's bar docks into the side rail, where Apple orders it top to
 * bottom: Close (cancellationAction), then the prominent action
 * (confirmationAction — keeps the prominent style; topBarPinnedTrailing put
 * it above Close and plain), then the rest. Done items overflow last.
 */
function itemPlacement(side: "left" | "right", item: ChromeItem) {
  const done = item.kind === "button" && item.variant === "done";
  const placement: ToolbarItemPlacement =
    item.key === CANCEL_KEY ? "cancellationAction" : done ? "confirmationAction" : side === "left" ? "topBarLeading" : "topBarTrailing";
  const visibilityPriority = item.priority ?? (done ? "high" : undefined);
  return { placement, visibilityPriority };
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
  titleMenu,
  slot,
  hideItems = false,
  extra = [],
}: {
  children: ReactElement;
  /** Extra column modifiers, e.g. `navigationSplitViewColumnWidth`. */
  modifiers?: ViewModifier[];
  /** Column-owned buttons placed before the screen's own leading items. */
  leading?: LeadingButton[];
  /** Replaces the column title with a menu (e.g. the project's views). */
  titleMenu?: ReactElement;
  /** Where this column's items go when a header bridge is provided (iPad). */
  slot?: ChromeSlot;
  /** Hide the screen's own items (e.g. while a panel beside it has its own). */
  hideItems?: boolean;
  /** Items from another column (see `bridgedItems`), drawn after this one's. */
  extra?: ChromeItem[];
}) {
  const t = useTheme();
  const [spec, setSpec] = useState<ChromeSpec | null>(null);
  const latest = useRef<ChromeSpec | null>(null);
  const bridge = useContext(ChromeBridgeContext);
  const { keepBars: keepBar, slots } = useContext(ChromeBridgeOptionsContext);
  const bridged = bridge != null && slot != null && slots.includes(slot);

  // Bridged: hand the items to the stack header whenever what's drawn changes.
  // One stable object carries the current handlers for press-time lookup.
  const bridgeLatest = useRef<BridgedChrome["latest"]>({ spec: null, leading });
  useEffect(() => {
    bridgeLatest.current.leading = leading;
  });
  // The items actually drawn: the title stays, the screen's buttons may not.
  const shown = hideItems && spec ? { ...spec, left: [], right: [] } : spec;
  // The screen's own Cancel supersedes the column's ✕ (one dismiss).
  if (shown?.left?.some((i) => i.key === CANCEL_KEY)) leading = leading.filter((b) => b.key !== "close");
  const drawn = `${shape(shown)}|${leadingShape(leading)}`;
  useEffect(() => {
    if (!bridged) return;
    bridge(slot, { latest: bridgeLatest.current, spec: shown, leading: bridgeLatest.current.leading });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `drawn` captures spec + leading
  }, [bridged, drawn]);
  useEffect(() => {
    if (!bridged) return;
    return () => bridge(slot, null);
  }, [bridged, bridge, slot]);

  const report = useCallback<Report>((next) => {
    latest.current = next;
    bridgeLatest.current.spec = next;
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
    if (item.kind === "menu" && item.overflow) {
      return item.actions.map((a, i) => (
        <ToolbarItem key={`${item.key}:${a.label}`} placement="secondaryAction">
          <Button
            label={a.label}
            systemImage={symbol(a.icon)}
            role={a.destructive ? "destructive" : undefined}
            onPress={press(side, item.key, i)}
          />
        </ToolbarItem>
      ));
    }
    return (
      <ToolbarItem key={item.key} {...itemPlacement(side, item)}>
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

  // Another column's item: its handlers already look themselves up at press time.
  function extraItem(item: ChromeItem) {
    if (item.kind === "button" && item.hidden) return null;
    return (
      <ToolbarItem key={`extra:${item.key}`} {...itemPlacement("right", item)}>
        {item.kind === "button" ? (
          <Button label={item.label} systemImage={symbol(item.icon)} onPress={item.onPress} />
        ) : (
          <Menu label={item.label} systemImage={symbol(item.icon)}>
            {item.actions.map((a) => (
              <Button
                key={a.label}
                label={a.label}
                systemImage={symbol(a.icon)}
                role={a.destructive ? "destructive" : undefined}
                onPress={a.onPress}
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
        ...(bridged && !keepBar ? [navigationBarHidden()] : []),
        // Fill the column, safe areas included (the Duo's hinge reserves one),
        // with the page colour so no white band shows around the hosted screen.
        background(t.background),
      ]}
    >
      <RNHostView>
        <ChromeContext.Provider value={report}>{children}</ChromeContext.Provider>
      </RNHostView>
      {bridged && !keepBar ? null : <Toolbar.Content>
        {titleMenu ? <ToolbarItem placement="principal">{titleMenu}</ToolbarItem> : null}
        {/* Bridged with its bar kept: the title stays, the buttons went elsewhere. */}
        {/* Column-owned dismiss: cancellationAction, so the side rail puts it on top. */}
        {bridged ? null : leading.map((b) => (
          <ToolbarItem key={b.key} placement={b.key === "close" ? "cancellationAction" : "topBarLeading"}>
            <Button label={b.label} systemImage={b.icon} onPress={b.onPress} />
          </ToolbarItem>
        ))}
        {bridged ? null : (shown?.left ?? []).map((i) => columnItem("left", i))}
        {/* Trailing items render right to left, so reverse to keep the
            route order reading left to right. */}
        {bridged ? null : [...(shown?.right ?? [])].reverse().map((i) => columnItem("right", i))}
        {[...extra].reverse().map((i) => extraItem(i))}
      </Toolbar.Content>}
    </Toolbar>
  );
}
