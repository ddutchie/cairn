/**
 * Example Cairn BACKEND plugin: a `roll_dice` agent tool.
 *
 *   # plugins.yml
 *   - id: dice
 *     name: ./roll-dice.mjs
 *     config: { defaultSides: 6 }
 *
 * A backend plugin exports `apply(ctx, config)` and runs on the shared agent
 * context. `inject: ['tools']` waits for the tool registry; `ctx.cairn.defineTool`
 * is Cairn's tool factory (a plugin never imports app internals). Ask the agent:
 * "roll 2 d20" and it calls this tool.
 */
export const name = "cairn-example-dice";
export const inject = ["tools"];

export async function apply(ctx, config) {
  const defaultSides = Number(config?.defaultSides ?? 6);
  const { defineTool } = ctx.cairn;

  const tool = defineTool({
    name: "roll_dice",
    description: "Roll dice. Returns each die and the total.",
    // dsh parameters = a flat map of param -> ValueSchemaSpec (NOT JSON-Schema).
    parameters: {
      count: { type: "integer", description: "how many dice (default 1)" },
      sides: { type: "integer", description: `sides per die (default ${defaultSides})` },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    async execute(args) {
      const count = Math.max(1, Math.min(100, Number(args?.count ?? 1)));
      const sides = Math.max(2, Math.min(1000, Number(args?.sides ?? defaultSides)));
      const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
      const total = rolls.reduce((a, b) => a + b, 0);
      return `Rolled ${count}d${sides}: [${rolls.join(", ")}] = ${total}`;
    },
  });

  ctx.tools.register(tool);
}
