/**
 * Cairn's own lint rules.
 *
 * `icon-button-label`: every icon-only `<button>` should be an `IconButton`:
 * its required `label` is the tooltip and the accessible name, and it brings
 * the shared shape and focus ring. Deliberate exceptions (the chat send/stop
 * glow, a drag handle that spreads listeners, a round logo chip) carry an
 * `eslint-disable-next-line cairn/icon-button-label -- <why>` comment.
 */

function isIcon(el) {
  if (!el || el.type !== "JSXElement") return false;
  const name = el.openingElement.name;
  return name.type === "JSXIdentifier" && /^[A-Z]/.test(name.name) && el.children.length === 0;
}

/** An icon, or an expression that only ever renders an icon (or nothing):
 *  `{pinned ? <PinOff /> : <Pin />}`, `{open && <X />}`. */
function rendersOnlyIcon(node) {
  if (isIcon(node)) return true;
  if (node.type === "JSXExpressionContainer") return rendersOnlyIcon(node.expression);
  if (node.type === "ConditionalExpression") {
    const branches = [node.consequent, node.alternate];
    return branches.some(isIcon) && branches.every((b) => isIcon(b) || isEmpty(b) || rendersOnlyIcon(b));
  }
  if (node.type === "LogicalExpression" && node.operator === "&&") return isIcon(node.right);
  return false;
}

function isEmpty(node) {
  return node.type === "Literal" && (node.value === null || node.value === false || node.value === "");
}

function isIconOnly(node) {
  const kids = node.children.filter((c) => !(c.type === "JSXText" && !c.value.trim()));
  return kids.length === 1 && rendersOnlyIcon(kids[0]);
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
