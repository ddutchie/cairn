import { describe, it, expect, beforeEach } from "vitest";
import { enforceLabelContrast, parseColor, colorLuminance, contrastRatio } from "./MermaidDiagram";

/**
 * Contrast-enforcement tests for rendered Mermaid SVG. The component renders
 * mermaid output into a container and then pins node/cluster labels to a
 * contrasting dark/light colour whenever the shape's fill would clash with the
 * theme's label colour (LLM-generated charts often pick light pastels that are
 * unreadable with dark-mode's light text).
 *
 * jsdom can't run mermaid itself (no CSSStyleSheet/SVG layout), so these tests
 * hand-build the exact SVG structure mermaid 11 emits and exercise the
 * DOM-post-processing function against it.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

function makeSvg(tag: string, attrs: Record<string, string> = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** Builds a `g.node` like mermaid's renderer: shape (direct child) + `.label`. */
function makeNode(
  id: string,
  shapeTag: "rect" | "polygon" | "path" | "circle",
  fill: string | null,
  opts: { htmlLabel?: boolean; labelColor?: string } = {},
) {
  const node = makeSvg("g", { class: "node default", id });
  const shape = makeSvg(shapeTag);
  if (fill !== null) shape.setAttribute("fill", fill);
  node.appendChild(shape);

  const labelGroup = makeSvg("g", { class: "label" });
  labelGroup.appendChild(makeSvg("rect", { fill: "none" })); // label bg
  if (opts.htmlLabel) {
    const fo = makeSvg("foreignObject");
    const div = document.createElementNS(XHTML_NS, "div");
    const span = document.createElementNS(XHTML_NS, "span");
    span.setAttribute("class", "nodeLabel");
    if (opts.labelColor) span.setAttribute("style", `color: ${opts.labelColor}`);
    div.appendChild(span);
    fo.appendChild(div);
    labelGroup.appendChild(fo);
  } else {
    const text = makeSvg("text");
    if (opts.labelColor) text.setAttribute("style", `fill: ${opts.labelColor}`);
    labelGroup.appendChild(text);
  }
  node.appendChild(labelGroup);
  return { node, shape, labelGroup };
}

function makeCluster(id: string, fill: string, opts: { labelColor?: string } = {}) {
  const cluster = makeSvg("g", { class: "cluster", id });
  const rect = makeSvg("rect");
  rect.setAttribute("fill", fill);
  cluster.appendChild(rect);
  const labelGroup = makeSvg("g", { class: "cluster-label" });
  const span = document.createElementNS(XHTML_NS, "span");
  span.setAttribute("class", "nodeLabel");
  if (opts.labelColor) span.setAttribute("style", `color: ${opts.labelColor}`);
  labelGroup.appendChild(span);
  cluster.appendChild(labelGroup);
  return { cluster, rect, span };
}

describe("color helpers", () => {
  it("parses hex and rgb", () => {
    expect(parseColor("#1a1917")).toEqual([26, 25, 23]);
    expect(parseColor("rgb(240, 230, 255)")).toEqual([240, 230, 255]);
  });

  it("computes WCAG luminance", () => {
    expect(colorLuminance("#1a1917")!).toBeLessThan(0.1);
    expect(colorLuminance("#f0e6ff")!).toBeGreaterThan(0.8);
  });

  it("computes contrast ratios", () => {
    expect(contrastRatio(0.9, 0.01)).toBeGreaterThan(10);
    expect(contrastRatio(0.9, 0.9)).toBe(1);
  });
});

describe("enforceLabelContrast", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    // jsdom can't resolve custom properties from <style>, so set them inline so
    // getComputedStyle(container).getPropertyValue picks them up.
    container.style.setProperty("--mermaid-label-dark", "#1a1917");
    container.style.setProperty("--mermaid-label-light", "#e8e4dc");
    document.body.appendChild(container);
  });

  it("flips a light-filled node's label to the dark candidate in dark mode", () => {
    const { node, labelGroup } = makeNode("n1", "rect", "#f0e6ff", { htmlLabel: true });
    container.appendChild(node);
    enforceLabelContrast(container);
    const span = labelGroup.querySelector("span") as HTMLElement;
    expect(span.style.color).toBe("rgb(26, 25, 23)");
  });

  it("keeps a dark-filled node's label light", () => {
    const { node, labelGroup } = makeNode("n2", "rect", "#1a1a1a", { htmlLabel: true });
    container.appendChild(node);
    enforceLabelContrast(container);
    const span = labelGroup.querySelector("span") as HTMLElement;
    expect(span.style.color).toBe("rgb(232, 228, 220)");
  });

  it("handles SVG text labels on diamond (polygon) nodes", () => {
    const { node, labelGroup } = makeNode("n3", "polygon", "#fff5cc");
    container.appendChild(node);
    enforceLabelContrast(container);
    const text = labelGroup.querySelector("text") as SVGTextElement;
    expect(text.style.fill).toBe("rgb(26, 25, 23)");
  });

  it("respects an explicit author-set label colour", () => {
    const { node, labelGroup } = makeNode("n4", "rect", "#fff5cc", {
      htmlLabel: true,
      labelColor: "#123456",
    });
    container.appendChild(node);
    enforceLabelContrast(container);
    const span = labelGroup.querySelector("span") as HTMLElement;
    expect(span.style.color).toBe("rgb(18, 52, 86)");
  });

  it("flips a light-filled cluster label to the dark candidate", () => {
    const { cluster, span } = makeCluster("sub", "#fff5cc");
    container.appendChild(cluster);
    enforceLabelContrast(container);
    expect(span.style.color).toBe("rgb(26, 25, 23)");
  });

  it("leaves a dark cluster label light", () => {
    const { cluster, span } = makeCluster("sub", "#1a1a1a");
    container.appendChild(cluster);
    enforceLabelContrast(container);
    expect(span.style.color).toBe("rgb(232, 228, 220)");
  });
});