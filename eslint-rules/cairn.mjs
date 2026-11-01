/**
 * Cairn's own lint rules.
 *
 * `icon-button-label`: every icon-only `<button>` (one icon component, or a
 * conditional between two) should be an `IconButton`: its required `label` is
 * the tooltip and the accessible name, and it brings the shared shape and
 * focus ring. Deliberate exceptions (the chat send/stop glow, a drag handle
 * that spreads listeners, a round logo chip) carry an
 * `eslint-disable-next-line cairn/icon-button-label -- <why>` comment.
 */

function isIcon(node) {
  if (!node) return false;
  if (node.type === "JSXExpressionContainer") return isIcon(node.expression);
  if (node.type === "ConditionalExpression") return isIcon(node.consequent) && isIcon(node.alternate);
  if (node.type !== "JSXElement" || node.children.length !== 0) return false;
  const name = node.openingElement.name;
  return name.type === "JSXIdentifier" && /^[A-Z]/.test(name.name);
}

function isIconOnly(node) {
  const kids = node.children.filter((c) => !(c.type === "JSXText" && !c.value.trim()));
  return kids.length === 1 && isIcon(kids[0]);
}

const iconButtonLabel = {
  meta: {
    type: "suggestion",
    docs: { description: "Use IconButton for icon-only buttons" },
    messages: {
      useIconButton:
        "Icon-only button: use IconButton (ui/icon-button), whose required label is the tooltip and the accessible name. For a deliberate exception, disable this rule on the line and say why.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXElement(node) {
        const open = node.openingElement;
        if (open.name.type !== "JSXIdentifier" || open.name.name !== "button") return;
        if (isIconOnly(node)) context.report({ node: open, messageId: "useIconButton" });
      },
    };
  },
};

const cairn = { rules: { "icon-button-label": iconButtonLabel } };

export default cairn;
