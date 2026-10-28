import { Button, Check, Copy } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, For, onCleanup } from "solid-js";
import { useText } from "../../text";
import type { DataTableBlock } from "./message-content-blocks";

export type {
  ComparisonTableBlock,
  DataTableAlignment,
  DataTableBlock,
  MessageCodeBlock,
  MessageContentBlock,
  MessageTextBlock,
} from "./message-content-blocks";
export {
  cachedMessageContentBlocks,
  messageContentBlocks,
  resetCachedMessageContentBlocks,
  reuseUnchangedBlocks,
} from "./message-content-blocks";

type DataTableFormat = "markdown" | "csv";

export function DataTable(props: { table: DataTableBlock; renderCell?: (text: string) => JSX.Element }) {
  const { t } = useText();
  const [copied, setCopied] = createSignal<DataTableFormat | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  let table: HTMLTableElement | undefined;
  onCleanup(() => {
    if (copiedTimer) clearTimeout(copiedTimer);
  });

  // Markdown keeps the cells' own markdown. CSV is for a spreadsheet, so it takes the text as shown.
  const copy = async (format: DataTableFormat) => {
    const text =
      format === "markdown"
        ? dataTableMarkdown(props.table)
        : dataTableCsv([...(table?.rows ?? [])].map((row) => [...row.cells].map((cell) => cell.innerText.trim())));
    try {
      await navigator.clipboard.writeText(text);
      setCopied(format);
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => setCopied(null), 1_500);
    } catch {
      setCopied(null);
    }
  };

  const copyButton = (format: DataTableFormat, label: string) => (
    <Button type="button" variant="ghost" size="xs" class="message-code-copy" onClick={() => void copy(format)}>
      <span class="message-code-copy-icons" aria-hidden="true">
        <span data-visible={copied() !== format ? "true" : undefined}>
          <Copy />
        </span>
        <span data-visible={copied() === format ? "true" : undefined}>
          <Check />
        </span>
      </span>
      <span>{copied() === format ? t("common.copied") : label}</span>
    </Button>
  );

  return (
    <div class="message-data-table-frame">
      <section class="message-data-table-scroll" aria-label={t("chat.table.data")} tabindex="0">
        <table
          ref={(element) => (table = element)}
          class="message-data-table"
          style={`--message-data-table-columns: ${props.table.headers.length}`}
        >
          <thead>
            <tr>
              <For each={props.table.headers}>
                {(header, index) => (
                  <th scope="col" data-align={props.table.alignments[index()]}>
                    {props.renderCell?.(header) ?? header}
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={props.table.rows}>
              {(row) => (
                <tr>
                  <For each={row}>
                    {(cell, index) => (
                      <td data-align={props.table.alignments[index()]}>{props.renderCell?.(cell) ?? cell}</td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>
      <div class="message-data-table-actions">
        {copyButton("markdown", t("chat.table.copyMarkdown"))}
        {copyButton("csv", t("chat.table.copyCsv"))}
      </div>
    </div>
  );
}

/** The table as Markdown source again. A cell keeps its own markdown, with `|` escaped. */
export function dataTableMarkdown(table: Pick<DataTableBlock, "headers" | "alignments" | "rows">): string {
  const row = (cells: readonly string[]) =>
    `| ${cells.map((cell) => cell.replace(/\\(?=[\\|]|$)/gu, "\\\\").replace(/\|/gu, "\\|")).join(" | ")} |`;
  const separator = table.headers.map((_, index) => {
    const alignment = table.alignments[index];
    return alignment === "center" ? ":---:" : alignment === "right" ? "---:" : "---";
  });
  return [row(table.headers), `| ${separator.join(" | ")} |`, ...table.rows.map(row)].join("\n");
}

/** Rows as CSV (RFC 4180): a cell with a comma, a quote or a line break goes in quotes. */
export function dataTableCsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((cells) => cells.map((cell) => (/[",\r\n]/u.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join(","))
    .join("\n");
}
