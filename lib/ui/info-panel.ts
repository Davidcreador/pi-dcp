/**
 * Generic read-only info panel rendered as an overlay.
 *
 * Used by `/dcp context` and `/dcp stats` to show structured information
 * (token usage bar, savings, active compressions, etc.) inside a centered
 * border instead of a multi-line `ui.notify` toast.
 *
 * Design constraints:
 *   - Theme-aware: ALL color application uses the `theme` argument from the
 *     `ctx.ui.custom` factory callback. DynamicBorder accepts an explicit
 *     color function for the same reason (jiti module cache makes the global
 *     pi theme undefined inside extensions).
 *   - Rebuild on invalidate so theme changes redraw correctly. The pattern is
 *     spelled out in `pi.dev/docs/latest/tui`.
 *   - Closes on esc / enter / q / ctrl+c (and triggers tui.requestRender()
 *     after state changes so the close is visible).
 *   - Falls back to `ctx.ui.notify` when `ctx.ui.custom` is unavailable —
 *     e.g. in print mode or RPC mode where there is no live TUI surface.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	matchesKey,
	Spacer,
	Text,
	visibleWidth,
} from "@earendil-works/pi-tui";

/** A `label : value` row, padded so values align in a column. */
export interface KeyValueRow {
	kind: "kv";
	label: string;
	value: string;
	/** Optional emphasis color for the value (theme.fg color name). */
	valueColor?: string;
}

/** A free-form text line, rendered as-is (already themed by the caller if needed). */
export interface TextRow {
	kind: "text";
	text: string;
}

/** Vertical gap. */
export interface SpacerRow {
	kind: "spacer";
	lines?: number;
}

export type PanelRow = KeyValueRow | TextRow | SpacerRow;

export interface PanelSection {
	/** Section heading, rendered in accent. Omit for a leading section. */
	heading?: string;
	rows: PanelRow[];
}

export interface ShowInfoPanelOptions {
	title: string;
	sections: PanelSection[];
	/** Footer hint line. Defaults to "esc/enter to close". */
	footer?: string;
}

/**
 * Render an info panel as an overlay. Resolves when the user closes it.
 *
 * If `ctx.ui.custom` is not exposed by the caller (some command contexts in
 * non-interactive modes) we fall back to a multi-line toast so the user still
 * gets the data.
 */
export async function showInfoPanel(
	ctx: ExtensionCommandContext,
	options: ShowInfoPanelOptions,
): Promise<void> {
	const ui = ctx.ui as {
		custom?: (
			factory: (
				tui: { requestRender(): void },
				theme: { fg: (color: string, text: string) => string; bold: (s: string) => string },
				keybindings: unknown,
				done: (result?: unknown) => void,
			) => Component,
			options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
		) => Promise<unknown>;
		notify: (msg: string, type?: "info" | "warning" | "error") => void;
	};

	if (typeof ui.custom !== "function") {
		// Non-interactive fallback. Best-effort: flatten the panel to a toast.
		ui.notify(flattenForToast(options), "info");
		return;
	}

	await ui.custom(
		(tui, theme, _keybindings, done) => {
			// We rebuild content on every invalidate so theme changes redraw
			// correctly. The Container's own invalidate() only clears child
			// caches — pre-baked theme strings in Text children would be stale.
			const container = new Container();

			const rebuild = () => {
				container.clear();
				container.addChild(
					new DynamicBorder((s: string) => theme.fg("borderAccent", s)),
				);
				container.addChild(
					new Text(theme.fg("accent", theme.bold(options.title)), 1, 0),
				);
				container.addChild(new Spacer(1));

				const labelWidth = computeLabelWidth(options.sections);

				for (let i = 0; i < options.sections.length; i++) {
					const section = options.sections[i];
					if (section.heading) {
						container.addChild(
							new Text(theme.fg("accent", section.heading), 1, 0),
						);
					}
					for (const row of section.rows) {
						container.addChild(renderRow(row, theme, labelWidth));
					}
					if (i < options.sections.length - 1) container.addChild(new Spacer(1));
				}

				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						theme.fg("dim", options.footer ?? "esc/enter to close"),
						1,
						0,
					),
				);
				container.addChild(
					new DynamicBorder((s: string) => theme.fg("borderAccent", s)),
				);
			};

			rebuild();

			const close = () => done(undefined);

			return {
				render: (w: number) => container.render(w),
				invalidate: () => {
					container.invalidate();
					rebuild();
				},
				handleInput: (data: string) => {
					if (
						matchesKey(data, "escape") ||
						matchesKey(data, "enter") ||
						matchesKey(data, "q") ||
						matchesKey(data, "ctrl+c")
					) {
						close();
						tui.requestRender();
					}
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				width: "70%",
				minWidth: 50,
				maxHeight: "85%",
				anchor: "center",
				margin: 2,
			},
		},
	);
}

function computeLabelWidth(sections: PanelSection[]): number {
	let max = 0;
	for (const s of sections) {
		for (const r of s.rows) {
			if (r.kind === "kv") {
				const w = visibleWidth(r.label);
				if (w > max) max = w;
			}
		}
	}
	return max;
}

function renderRow(
	row: PanelRow,
	theme: { fg: (color: string, text: string) => string },
	labelWidth: number,
): Component {
	if (row.kind === "spacer") return new Spacer(Math.max(1, row.lines ?? 1));
	if (row.kind === "text") return new Text(row.text, 2, 0);
	const padded = row.label.padEnd(labelWidth, " ");
	const labelStyled = theme.fg("muted", padded);
	const valueStyled = row.valueColor
		? theme.fg(row.valueColor, row.value)
		: row.value;
	return new Text(`${labelStyled}  ${valueStyled}`, 2, 0);
}

function flattenForToast(options: ShowInfoPanelOptions): string {
	const out: string[] = [options.title, ""];
	const labelWidth = computeLabelWidth(options.sections);
	for (const section of options.sections) {
		if (section.heading) out.push(section.heading);
		for (const row of section.rows) {
			if (row.kind === "spacer") out.push("");
			else if (row.kind === "text") out.push(`  ${row.text}`);
			else
				out.push(
					`  ${row.label.padEnd(labelWidth, " ")}  ${row.value}`,
				);
		}
		out.push("");
	}
	return out.join("\n").trimEnd();
}
