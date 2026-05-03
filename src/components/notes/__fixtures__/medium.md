# Medium Note — Feature Coverage

## Text Formatting

Paragraph with **bold**, *italic*, ~~strikethrough~~, and `inline code`.
A sentence with ==highlighted text== and another ==second highlight==.

Link to [example](https://example.com) and a footnote reference[^1].

[^1]: Footnote definition here.

## GFM Tables

| Name    | Type     | Default | Description          |
|---------|----------|---------|----------------------|
| title   | string   | —       | Note title           |
| content | string   | ""      | Markdown body        |
| folder  | string   | ""      | Subfolder path       |
| tags    | string[] | []      | Associated tag IDs   |

## Task List

- [x] Implement remark-gfm
- [x] Add callout support
- [ ] Write benchmarks
- [ ] Ship v0.9.0

## Callouts

> [!note]
> A simple note callout with **formatted** content.

> [!warning]+ Collapsible Warning
> This is a collapsible warning. It contains a list:
> - First item
> - Second item

> [!tip] Tip with Title
> Use `Cmd+P` to open the command palette.

> [!danger] Danger Zone
> Irreversible action ahead.

## Math — Inline

Euler's identity: $e^{i\pi} + 1 = 0$ is beautiful.

The derivative: $\frac{d}{dx}[x^n] = nx^{n-1}$.

## Math — Display (single-line)

$$\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}$$

$$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$

## Math — Display (multi-line)

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$

## Code Blocks

```typescript
function greet(name: string): string {
  return `Hello, ${name}!`;
}
```

```python
def fibonacci(n: int) -> int:
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)
```

## Highlights and Mixed Content

This paragraph has ==multiple== highlighted ==words== spread ==throughout== it,
which exercises the text-splitting logic in rehypeHighlight.

## Blockquotes

> A plain blockquote without callout syntax.
> It spans multiple lines.

## Headings

### H3 Section
#### H4 Section
##### H5 Section
