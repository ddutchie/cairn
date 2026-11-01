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

function isIconOnly(node) {
  const kids = node.children.filter((c) => !(c.type === "JSXText" && !c.value.trim()));
  if (kids.length !== 1 || kids[0].type !== "JSXElement") return false;
  const el = kids[0];
  const name = el.openingElement.name;
  return name.type === "JSXIdentifier" && /^[A-Z]/.test(name.name) && el.children.length === 0;
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
