import { CHAT_MERMAID_FONT_FAMILY, mermaidImageUrl } from "@openbot/contracts/chat-preview";

type Mermaid = typeof import("mermaid")["default"];

let mermaid: Promise<Mermaid> | undefined;

/** Mermaid is large, so the app loads it when the first diagram shows, not at start. */
function loadMermaid(): Promise<Mermaid> {
  mermaid ??= import("mermaid").then(
    ({ default: api }) => api,
    (error: unknown) => {
      mermaid = undefined;
      throw error;
    },
  );
  return mermaid;
}

/**
 * Mermaid draws with the theme of the app scheme, so a light chat does not get dark nodes. The
 * light theme keeps the diagram's background and edge labels transparent, so the drawing sits on
 * the chat and not in a grey box. `strict` escapes the HTML in labels and turns off click handlers;
 * a diagram cannot change it. Mermaid reads its configuration when it renders, so each render sets it.
 */
function configure(api: Mermaid, appearance: DiagramAppearance): void {
  api.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: appearance === "light" ? "neutral" : "dark",
    themeVariables:
      appearance === "light" ? { background: "transparent", edgeLabelBackground: "transparent" } : undefined,
    // Edge labels keep their own fill in Mermaid's neutral theme, so the light drawing clears it here.
    themeCSS: appearance === "light" ? LIGHT_EDGE_LABEL_CSS : undefined,
    fontFamily: CHAT_MERMAID_FONT_FAMILY,
    suppressErrorRendering: true,
  });
}

type DiagramAppearance = "light" | "dark";

const LIGHT_EDGE_LABEL_CSS = ".edgeLabel rect, .labelBkg { fill: transparent; background-color: transparent; }";

/** The scheme that the root element shows, as `appearance.ts` sets it. */
function currentAppearance(): DiagramAppearance {
  return document.documentElement.dataset.appearance === "light" ? "light" : "dark";
}

/** A drawn diagram, or why Mermaid could not draw it. */
export type MermaidDiagram =
  | { status: "ready"; url: string }
  /** Mermaid did not load. A retry can work. */
  | { status: "unavailable" }
  /** Mermaid cannot parse the source. The message is Mermaid's own, such as the line of the error. */
  | { status: "invalid"; message: string };

// Settled messages render again as the list scrolls, so each diagram is drawn once. Cap the size
// so a long session cannot grow this without bound.
const DIAGRAM_CACHE_LIMIT = 100;
const diagramCache = new Map<string, Promise<MermaidDiagram>>();
let diagramCount = 0;

/**
 * The diagram of a Mermaid source as an image URL. The SVG is shown as an image, not put in the
 * page, so nothing in it can run in the app.
 */
export function mermaidDiagram(source: string): Promise<MermaidDiagram> {
  const appearance = currentAppearance();
  const key = `${appearance}\n${source}`;
  const cached = diagramCache.get(key);
  if (cached) return cached;
  diagramCount += 1;
  const id = `openbot-mermaid-${diagramCount}`;
  const diagram = drawDiagram(id, key, appearance, source);
  if (diagramCache.size >= DIAGRAM_CACHE_LIMIT) {
    const oldest = diagramCache.keys().next();
    if (!oldest.done) diagramCache.delete(oldest.value);
  }
  diagramCache.set(key, diagram);
  return diagram;
}

async function drawDiagram(
  id: string,
  key: string,
  appearance: DiagramAppearance,
  source: string,
): Promise<MermaidDiagram> {
  let api: Mermaid;
  try {
    api = await loadMermaid();
  } catch {
    // A load failure is not kept, so the next attempt loads Mermaid again.
    diagramCache.delete(key);
    return { status: "unavailable" };
  }
  try {
    configure(api, appearance);
    const { svg } = await api.render(id, source);
    return { status: "ready", url: mermaidImageUrl(svg) };
  } catch (error) {
    return { status: "invalid", message: mermaidErrorMessage(error) };
  }
}

/** Mermaid's parse message, without the blank lines around it, and at most a few lines. */
function mermaidErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.trim().split("\n").slice(0, 6).join("\n");
}
