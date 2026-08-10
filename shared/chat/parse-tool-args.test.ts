import { describe, it, expect } from "vitest";
import { parseToolArgs } from "./parse-tool-args";

describe("parseToolArgs", () => {
  describe("strict / happy path", () => {
    it("parses well-formed JSON with no repair", () => {
      const r = parseToolArgs('{"title":"Roadmap","content":"line1\\nline2"}');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.repaired).toBe(false);
        expect(r.value).toEqual({ title: "Roadmap", content: "line1\nline2" });
      }
    });

    it("treats empty / whitespace-only args as an empty object (no-arg tool call)", () => {
      for (const raw of ["", "   ", "\n\t", null, undefined]) {
        const r = parseToolArgs(raw);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toEqual({});
      }
    });

    it("rejects a bare non-object JSON value", () => {
      const r = parseToolArgs('"just a string"');
      expect(r.ok).toBe(false);
    });

    it("rejects a top-level array", () => {
      const r = parseToolArgs("[1,2,3]");
      expect(r.ok).toBe(false);
    });
  });

  describe("repair: unescaped control characters (the dominant note-write breakage)", () => {
    it("escapes a literal newline typed inside a string value", () => {
      // Model emitted a REAL newline inside content instead of \n — invalid JSON.
      const raw = '{"title":"Note","content":"line1\nline2"}';
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.repaired).toBe(true);
        expect(r.value.content).toBe("line1\nline2");
      }
    });

    it("escapes literal tabs and carriage returns", () => {
      const raw = '{"content":"a\tb\r\nc"}';
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.content).toBe("a\tb\r\nc");
    });

    it("handles a multi-line markdown body with headings and lists", () => {
      const body = "# Heading\n\n- item one\n- item two\n\n```js\nconst x = 1;\n```";
      const raw = `{"title":"Doc","content":"${body}"}`; // literal newlines → invalid
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.content).toBe(body);
    });

    it("does not corrupt an already-escaped newline (idempotent)", () => {
      const raw = '{"content":"a\\nb"}';
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.repaired).toBe(false);
        expect(r.value.content).toBe("a\nb");
      }
    });
  });

  describe("content preservation — repairs must NEVER mutate string values", () => {
    it("does NOT strip a wrapping code fence — content with fences round-trips as-is when valid JSON", () => {
      const content = "```markdown\nhi\n```";
      const raw = JSON.stringify({ title: "X", content });
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.repaired).toBe(false);
        expect(r.value.content).toBe(content);
      }
    });

    it("does NOT rewrite curly/smart quotes inside content", () => {
      // Curly quotes are legitimate content and must survive verbatim.
      const content = "He said \u201CAI theater\u201D and \u2018hello\u2019";
      const raw = JSON.stringify({ title: "X", content });
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.content).toBe(content);
    });

    it("a broken payload that would need fence-stripping fails loudly rather than mutating content", () => {
      // Fenced, and NOT valid JSON inside → we must NOT strip-and-guess; fail loud.
      const raw = "```json\n{\"title\": \n```";
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(false);
    });

    it("does not touch a literal comma inside a string that precedes a brace", () => {
      // Content ends with ",}" — the trailing-comma repair must not corrupt it.
      const raw = '{"content":"a,}","title":"X"}';
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.content).toBe("a,}");
        expect(r.value.title).toBe("X");
      }
    });
  });

  describe("repair: trailing commas (structural only)", () => {
    it("removes a trailing comma before }", () => {
      const r = parseToolArgs('{"a":1,"b":2,}');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ a: 1, b: 2 });
    });

    it("removes a trailing comma inside a nested array", () => {
      const r = parseToolArgs('{"tags":["a","b",]}');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ tags: ["a", "b"] });
    });
  });

  describe("repair: missing commas (structural only)", () => {
    it("inserts a missing comma between two string properties", () => {
      // The model dropped the `,` between title and spaceId — the classic
      // `Expected "," or "}" after property value` failure.
      const r = parseToolArgs('{"title":"New Page" "spaceId":"TEST","content":"Body"}');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.repaired).toBe(true);
        expect(r.value).toEqual({ title: "New Page", spaceId: "TEST", content: "Body" });
      }
    });

    it("inserts a missing comma when properties are separated by a newline", () => {
      const raw = '{\n"title":"New Page"\n"spaceId":"TEST",\n"content":"Body"\n}';
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ title: "New Page", spaceId: "TEST", content: "Body" });
    });

    it("inserts a missing comma before a number-valued property", () => {
      const r = parseToolArgs('{"a":"x" "b":2}');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ a: "x", b: 2 });
    });

    it("inserts a missing comma before a boolean-valued property", () => {
      const r = parseToolArgs('{"a":"x" "b":true}');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ a: "x", b: true });
    });

    it("inserts a missing comma inside a nested object", () => {
      const r = parseToolArgs('{"meta":{"a":1 "b":2},"title":"X"}');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ meta: { a: 1, b: 2 }, title: "X" });
    });

    it("inserts a missing comma before a nested object value", () => {
      const r = parseToolArgs('{"a": {"b":1} "c":2}');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ a: { b: 1 }, c: 2 });
    });

    it("inserts a missing comma between array elements (strings)", () => {
      const r = parseToolArgs('{"tags":["a" "b"],"title":"X"}');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ tags: ["a", "b"], title: "X" });
    });

    it("inserts a missing comma between array elements (numbers)", () => {
      const r = parseToolArgs('{"tags":[1 2 3],"title":"X"}');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ tags: [1, 2, 3], title: "X" });
    });

    it("inserts a missing comma between consecutive objects in an array", () => {
      const r = parseToolArgs('{"items":[{"a":1} {"b":2}],"title":"X"}');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ items: [{ a: 1 }, { b: 2 }], title: "X" });
    });

    it("fixes a missing comma at the top level (multi-line, mixed values)", () => {
      const raw = '{"projectId":"p1","title":"Doc" "content":"# H\nbody",\n"priority":"high"}';
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.repaired).toBe(true);
        expect(r.value).toEqual({ projectId: "p1", title: "Doc", content: "# H\nbody", priority: "high" });
      }
    });
  });

  describe("combined breakage", () => {
    it("fixes a literal newline and trailing comma at once (both lossless repairs)", () => {
      const raw = '{"title":"Note","content":"one\ntwo",}';
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.repaired).toBe(true);
        expect(r.value).toEqual({ title: "Note", content: "one\ntwo" });
      }
    });

    it("fixes a literal newline AND a missing comma in one pass", () => {
      const raw = '{"title":"Note" "content":"line1\nline2"}';
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.repaired).toBe(true);
        expect(r.value).toEqual({ title: "Note", content: "line1\nline2" });
      }
    });
  });

  describe("missing-comma repair must NEVER guess or merge text", () => {
    it("fails loud (never concatenates) when a value is followed by a bare string that is not a key", () => {
      // {"title":"My" "page"} must NOT become title="My page" — we can't know
      // that intent, so it must fail rather than silently corrupt content.
      const r = parseToolArgs('{"title":"My" "page"}');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/malformed tool-call arguments/i);
    });

    it("fails loud when a value is followed by a stray non-key token", () => {
      const r = parseToolArgs('{"title":"New Page" "More","spaceId":"TEST"}');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/malformed tool-call arguments/i);
    });

    it("fails loud on early-closed quote with leftover text (never rewrites to title=My page)", () => {
      // content is intended to hold `He said "hi"` but the quotes were emitted
      // unescaped → the JSON is irrecoverably ambiguous → must fail, not guess.
      const r = parseToolArgs('{"content":"He said "hi""}');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/malformed tool-call arguments/i);
    });
  });

  describe("repair: dropped closing delimiter (tail repair)", () => {
    it("closes an unterminated trailing string + object (the dropped `\"}` case)", () => {
      const raw = '{"projectId":"p","title":"Doc","content":"full note body that ends here"';
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.repaired).toBe(true);
        expect(r.tailRepaired).toBe(true);
        expect(r.value).toEqual({ projectId: "p", title: "Doc", content: "full note body that ends here" });
      }
    });

    it("preserves content bytes exactly when only the closing delimiter is missing", () => {
      // Mirrors the real incident: the whole note body streamed, the `"}` never arrived.
      const content = "# ADSK OpenAI Router\n\nFor Claude Code, see `docs/claude-code.md`";
      const raw = `{"projectId":"rVAJTw0nH-bX","title":"Project Overview","content":"${content}`;
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.tailRepaired).toBe(true);
        expect(r.value.content).toBe(content);
        expect(r.value.title).toBe("Project Overview");
      }
    });

    it("closes an unterminated trailing string AND nested containers", () => {
      const raw = '{"meta":{"tags":["a","b"],"seen":true,"nested":{"x":"y"}';
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.tailRepaired).toBe(true);
        expect(r.value).toEqual({ meta: { tags: ["a", "b"], seen: true, nested: { x: "y" } } });
      }
    });

    it("closes a simple object missing only its closing brace", () => {
      const r = parseToolArgs('{"a":"b"');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.tailRepaired).toBe(true);
        expect(r.value).toEqual({ a: "b" });
      }
    });

    it("marks tail-repaired output so callers can apply finish_reason policy", () => {
      const ok = parseToolArgs('{"a":"b"');
      expect(ok.ok && ok.tailRepaired).toBe(true);
      const strict = parseToolArgs('{"a":1}');
      expect(strict.ok && strict.tailRepaired === undefined).toBe(true);
      const lossless = parseToolArgs('{"a":1,}');
      expect(lossless.ok && lossless.tailRepaired === undefined).toBe(true);
    });

    it("does NOT tail-repair a trailing numeric literal (the number may be truncated)", () => {
      // `{"a":1` could be the start of `{"a":123}` — appending `}` would silently
      // drop digits the model still intended to emit. Refuse so the structural
      // safety net fails loudly and the model re-issues.
      const r = parseToolArgs('{"a":1');
      expect(r.ok).toBe(false);
      const nested = parseToolArgs('{"meta":{"tags":["a","b"],"seen":true,"depth":{"level":1');
      expect(nested.ok).toBe(false);
    });

    it("does NOT tail-repair mid-structure damage (unterminated key)", () => {
      const r = parseToolArgs('{"t');
      expect(r.ok).toBe(false);
    });

    it("does NOT tail-repair a bare unterminated key after a colon", () => {
      const r = parseToolArgs('{"a":');
      expect(r.ok).toBe(false);
    });

    it("does NOT tail-repair a complete object followed by garbage", () => {
      const r = parseToolArgs('{"a":1} and then some');
      expect(r.ok).toBe(false);
    });

    it("does NOT corrupt content that legitimately ends with a backslash (refuses instead)", () => {
      const r = parseToolArgs('{"a":"path\\');
      expect(r.ok).toBe(false);
    });
  });

  describe("unrecoverable input", () => {
    it("returns an error (never a silent {}) for structurally broken JSON", () => {
      const r = parseToolArgs('{"title": ');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/malformed tool-call arguments/i);
    });
  });

  describe("unconsumed trailing content", () => {
    it("rejects a complete object followed by non-whitespace text", () => {
      const r = parseToolArgs('{"title":"x"} and then some');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/malformed tool-call arguments/i);
    });

    it("rejects a second object appended after the first", () => {
      const r = parseToolArgs('{"a":1}{"b":2}');
      expect(r.ok).toBe(false);
    });

    it("accepts trailing whitespace after a complete object", () => {
      const r = parseToolArgs('{"a":1}   \n ');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ a: 1 });
    });

    it("still accepts a trailing comma (partial-json's documented case)", () => {
      const r = parseToolArgs('{"a":1,}');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ a: 1 });
    });
  });

  describe("repair: value-start placeholder tokens (<arg_value> et al.)", () => {
    it("recovers a placeholder where the model dropped the opening quote of a string value", () => {
      const raw =
        '{"path": "src/app.py", "edits": [{"oldText":<arg_value>from x import (\n    a,\n    b,\n)", "newText": "from x import (\n    a,\n    c,\n)"}]}';
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.repaired).toBe(true);
        const edits = r.value.edits as { oldText: string; newText: string }[];
        expect(edits).toHaveLength(1);
        expect(edits[0].oldText).toBe("from x import (\n    a,\n    b,\n)");
        expect(edits[0].newText).toBe("from x import (\n    a,\n    c,\n)");
      }
    });

    it("recovers the exact <arg_value> edit call captured from an intercepted request", () => {
      const raw =
        '{"path": "src/app/proxy/app.py", "edits": [{"oldText":<arg_value>from app.proxy.routes import (\n    alf,\n    chat,\n    embeddings,\n    images,\n    messages,\n    models,\n    realtime,\n    responses,\n    settings_api,\n    settings_ui,\n    usage_api,\n    usage_ui,\n    log_ui,\n)", "newText": "from app.proxy.routes import (\n    alf,\n    chat,\n    embeddings,\n    images,\n    legacy_completions,\n    messages,\n    models,\n    realtime,\n    responses,\n    settings_api,\n    settings_ui,\n    usage_api,\n    usage_ui,\n    log_ui,\n)"}, {"oldText": "    app.include_router(chat.router)\n    app.include_router(messages.router)", "newText": "    app.include_router(chat.router)\n    app.include_router(legacy_completions.router)\n    app.include_router(messages.router)"}]}';
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.path).toBe("src/app/proxy/app.py");
        const edits = r.value.edits as { oldText: string; newText: string }[];
        expect(edits).toHaveLength(2);
        expect(edits[0].oldText).toContain("from app.proxy.routes import (");
        expect(edits[0].newText).toContain("legacy_completions,");
        expect(edits[1].oldText).toBe(
          "    app.include_router(chat.router)\n    app.include_router(messages.router)",
        );
        expect(edits[1].newText).toBe(
          "    app.include_router(chat.router)\n    app.include_router(legacy_completions.router)\n    app.include_router(messages.router)",
        );
      }
    });

    it("recovers a placeholder as the first property value of an object", () => {
      const r = parseToolArgs('{"title":<arg_value>hello world", "a": 1}');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toEqual({ title: "hello world", a: 1 });
      }
    });

    it("closes a placeholder-opened string with the same token in slash form (</arg_value>)", () => {
      const raw =
        '{"path": "src/app.py", "oldText":<arg_value>from x import (\n    a,\n)</arg_value>, "newText": "y"}';
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.oldText).toBe("from x import (\n    a,\n)");
        expect(r.value.newText).toBe("y");
      }
    });

    it("closes a placeholder-opened string with the same token in bare form (<arg_value>)", () => {
      const raw =
        '{"path": "src/app.py", "oldText":<arg_value>from x import (\n    a,\n)<arg_value>, "newText": "y"}';
      const r = parseToolArgs(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.oldText).toBe("from x import (\n    a,\n)");
        expect(r.value.newText).toBe("y");
      }
    });

    it("a placeholder token inside a normally-quoted string is literal content", () => {
      const r = parseToolArgs('{"content":"see <arg_value> here", "a": 1}');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.repaired).toBe(false);
        expect(r.value.content).toBe("see <arg_value> here");
      }
    });

    it("does NOT substitute the token inside a string (it is literal content there)", () => {
      const r = parseToolArgs('{"content":"docs say <arg_value> here","title":"x"}');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.repaired).toBe(false);
        expect(r.value.content).toBe("docs say <arg_value> here");
      }
    });

    it("does NOT fire at a key position", () => {
      const r = parseToolArgs('{<arg_value>:"v"}');
      expect(r.ok).toBe(false);
    });

    it("does NOT fire for an unrecognised bare token", () => {
      const r = parseToolArgs('{"a":<bogus>1}');
      expect(r.ok).toBe(false);
    });

    it("does NOT repair a standalone placeholder with no content after it (silent wrong value)", () => {
      // `<arg_value>` standing in for the WHOLE value, nothing after → substituting
      // `"` would tail-repair into `""` and silently drop the intended value.
      const r = parseToolArgs('{"a":<arg_value>, "b": 1}');
      expect(r.ok).toBe(false);
      const r2 = parseToolArgs('{"a":<arg_value>}');
      expect(r2.ok).toBe(false);
    });
  });
});
