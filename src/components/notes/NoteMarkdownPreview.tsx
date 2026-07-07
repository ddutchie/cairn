"use client";

/**
 * NoteMarkdownPreview — stateless markdown renderer using the same pipeline
 * as the NoteEditor read mode. Takes a plain `content` string and renders it.
 *
 * Used by AgentEditor to preview .md files without duplicating the plugin stack.
 * No note mutation, no TOC, no scroll-container ref dependency.
 */

import React, { useMemo, useState, useEffect } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import { urlTransform } from "@/lib/utils";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import "katex/dist/katex.min.css";
import { renderCodeFence } from "./markdown-code-fence";
import { Callout } from "./Callout";
import { MathBlock } from "./MathBlock";
import { remarkCallout, remarkObsidianEmbeds, remarkPromoteDisplayMath, makeLatexPlugins, InlineCode, rehypeEscapeUnknownTags } from "@/lib/markdown/pipeline";

// ── NoteMarkdownPreview ───────────────────────────────────────────────────────

interface NoteMarkdownPreviewProps {
  content: string;
  className?: string;
  filePath?: string;
  projectRoot?: string;
}

interface MarkdownImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> {
  src?: string;
  filePath?: string;
  projectRoot?: string;
}

function safeDecodeURIComponent(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

function MarkdownImage({ src, alt, title, filePath, projectRoot, ...props }: MarkdownImageProps) {
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(undefined);
  const [error, setError] = useState<boolean>(false);

  useEffect(() => {
    let active = true;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResolvedSrc(undefined);

    if (!src) {
      return;
    }

    if (/^(https?|data):/i.test(src)) {
      setResolvedSrc(src);
      setError(false);
      return;
    }

    const isWindowsAbsolute = /^[a-zA-Z]:[/\\]/.test(src) || src.startsWith("\\\\");
    let absolutePath = "";

    if (src.toLowerCase().startsWith("file:")) {
      const pathPart = src.substring(5).replace(/^\/{1,3}/, "");
      const hasDriveLetter = /^[a-zA-Z]:/.test(pathPart);
      absolutePath = (!hasDriveLetter && !pathPart.startsWith("/")) ? "/" + pathPart : pathPart;
      absolutePath = safeDecodeURIComponent(absolutePath);
    } else if (isWindowsAbsolute) {
      absolutePath = src;
    } else if (src.startsWith("/")) {
      if (projectRoot) {
        const cleanSrc = src.substring(1);
        const separator = projectRoot.includes("\\") ? "\\" : "/";
        const rootParts = projectRoot.split(separator);
        const relParts = safeDecodeURIComponent(cleanSrc).split(/[/\\]/);
        for (const part of relParts) {
          if (part === "." || part === "") continue;
          if (part === "..") {
            if (rootParts.length > 0) rootParts.pop();
          } else {
            rootParts.push(part);
          }
        }
        absolutePath = rootParts.join(separator);
      } else {
        absolutePath = src;
      }
    } else {
      if (filePath) {
        const separator = filePath.includes("\\") ? "\\" : "/";
        const dirParts = filePath.split(separator);
        dirParts.pop();

        const relParts = safeDecodeURIComponent(src).split(/[/\\]/);
        for (const part of relParts) {
          if (part === "." || part === "") continue;
          if (part === "..") {
            if (dirParts.length > 0) dirParts.pop();
          } else {
            dirParts.push(part);
          }
        }
        absolutePath = dirParts.join(separator);
      }
    }

    if (absolutePath && window.electron) {
      window.electron.agent.readFileBase64(absolutePath)
        .then((dataUrl: string) => {
          if (!active) return;
          setResolvedSrc(dataUrl);
          setError(false);
        })
        .catch((err) => {
          if (!active) return;
          console.error("Failed to read image as base64:", absolutePath, err);
          setError(true);
        });
    } else {
      setResolvedSrc(src);
      setError(false);
    }

    return () => {
      active = false;
    };
  }, [src, filePath, projectRoot]);

  if (error) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-[var(--danger)] border border-[color-mix(in_srgb,_var(--danger)_30%,_transparent)] bg-[color-mix(in_srgb,_var(--danger)_10%,_transparent)] px-2 py-1 rounded">
        Failed to load image: {alt || src}
      </span>
    );
  }

  if (!resolvedSrc) {
    return <span className="inline-block w-4 h-4 rounded animate-pulse bg-[var(--surface-2)]" />;
  }

  return (
    <img
      src={resolvedSrc}
      alt={alt}
      title={title}
      className="max-w-full h-auto rounded my-2 border border-[var(--border)]"
      {...props}
    />
  );
}

export function NoteMarkdownPreview({ content, className, filePath, projectRoot }: NoteMarkdownPreviewProps) {
  const { rehypeCaptureLatex, rehypeMergedPass } = useMemo(() => makeLatexPlugins(), []);

  if (!content.trim()) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-[var(--text-tertiary)] p-8">
        Empty file
      </div>
    );
  }

  return (
    <div className={`prose-cairn px-6 py-5 overflow-y-auto h-full ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath, remarkPromoteDisplayMath, remarkCallout, remarkObsidianEmbeds]}
        rehypePlugins={[rehypeRaw, rehypeEscapeUnknownTags, rehypeCaptureLatex, rehypeKatex, rehypeMergedPass]}
        urlTransform={urlTransform}
        components={({
          mark({ children }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
            return (
              <mark className="rounded px-0.5" style={{ background: "color-mix(in srgb, var(--accent) 22%, transparent)", color: "var(--text-primary)" }}>
                {children}
              </mark>
            );
          },
          callout({ children, ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
            const p = props as Record<string, string>;
            return (
              <Callout
                type={p["data-callout-type"] ?? "note"}
                title={p["data-title"] || undefined}
                collapsible={p["data-collapsible"] === "true"}
                defaultOpen={p["data-default-open"] !== "false"}
              >
                {children}
              </Callout>
            );
          },
          mathblock({ children, ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
            return <MathBlock renderedChildren={children} latex={(props as Record<string, string>)["data-latex"] ?? ""} />;
          },
          blockquote({ children }: React.BlockquoteHTMLAttributes<HTMLElement> & ExtraProps) {
            return <blockquote className="border-l-2 border-[var(--border)] pl-4 text-[var(--text-secondary)] my-3">{children}</blockquote>;
          },
          img({ src, alt, title, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & ExtraProps) {
            return <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} title={title} filePath={filePath} projectRoot={projectRoot} {...props} />;
          },
          pre({ children }: React.HTMLAttributes<HTMLPreElement> & ExtraProps) {
            return renderCodeFence(children);
          },
          code({ className, children }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
            return <InlineCode className={className}>{children}</InlineCode>;
          },
          h1({ children }: React.HTMLAttributes<HTMLHeadingElement> & ExtraProps) { return <h1>{children}</h1>; },
          h2({ children }: React.HTMLAttributes<HTMLHeadingElement> & ExtraProps) { return <h2>{children}</h2>; },
          h3({ children }: React.HTMLAttributes<HTMLHeadingElement> & ExtraProps) { return <h3>{children}</h3>; },
          a({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
            return <a href={href} {...props}>{children}</a>;
          },
          section({ children, ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
            if ((props.className ?? "").includes("footnotes")) {
              return <section {...props} className="footnotes mt-8 pt-4 text-[0.786rem] text-[var(--text-secondary)]" style={{ borderTop: "1px solid var(--border)" }}>{children}</section>;
            }
            return <section {...props}>{children}</section>;
          },
          table({ children }: { children?: React.ReactNode }) {
            return (
              <div className="w-full overflow-x-auto my-3 scrollbar-thin">
                <table className="min-w-full border-collapse">
                  {children}
                </table>
              </div>
            );
          },
        } as import("react-markdown").Components)}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
