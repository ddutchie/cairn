/**
 * Cairn's own lint rules.
 *
 * `icon-button-label`: a plain `<button>` whose only content is an icon
 * component has no accessible name unless it carries one. Use `IconButton`
 * (its required `label` is the tooltip and the name), or give the button an
 * `aria-label`. Buttons that spread props are skipped, since the name may
 * arrive through the spread.
 */

const NAME_ATTRS = new Set(["aria-label", "aria-labelledby", "title"]);

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
    type: "problem",
    docs: { description: "Require an accessible name on icon-only buttons" },
    messages: {
      missing: "Icon-only button has no accessible name. Use IconButton (ui/icon-button) with a label, or add aria-label.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXElement(node) {
        const open = node.openingElement;
        if (open.name.type !== "JSXIdentifier" || open.name.name !== "button") return;
        if (open.attributes.some((a) => a.type === "JSXSpreadAttribute")) return;
        if (open.attributes.some((a) => a.type === "JSXAttribute" && NAME_ATTRS.has(a.name.name))) return;
        if (isIconOnly(node)) context.report({ node: open, messageId: "missing" });
      },
    };
  },
};

const cairn = { rules: { "icon-button-label": iconButtonLabel } };

export default cairn;
