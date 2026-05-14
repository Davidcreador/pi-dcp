/**
 * Bordered, dark-slab toast overlay matching the info-panel look.
 *
 * Built as a top-right anchored overlay that auto-dismisses after a short
 * timeout. Unlike `ctx.ui.notify`, this gives us full control over framing
 * and color so multi-line notifications from pi-dcp (pipeline activity,
 * command results, errors) read as a single visual unit.
 *
 * Falls back to `ctx.ui.notify` when the host doesn't expose `ctx.ui.custom`
 * (e.g. print mode), so pi-dcp still produces output in non-interactive runs.
 */
import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export type ToastType = "info" | "warning" | "error";

export interface ToastOptions {
	/** Auto-dismiss timeout in ms. Defaults to 4000; pass 0 to stay open until closed externally. */
	durationMs?: number;
	/** Max width as a number or "X%" string. Defaults to 60 cells. */
	width?: number | string;
	/** Title line shown above the message. Optional. */
	title?: string;
}

type AnyCtx = ExtensionCommandContext | ExtensionContext;

/**
 * Render a pi-dcp toast and resolve when it auto-dismisses (or the host
 * closes the overlay). Non-blocking on the caller's side: most callers do
 * not await the returned promise.
 */
export function toast(
	ctx: AnyCtx,
	message: string,
	type: ToastType = "info",
	options: ToastOptions = {},
): Promise<void> {
	const ui = ctx.ui as {
		custom?: (
			factory: (
				tui: { requestRender(): void },
				theme: {
					fg: (color: string, text: string) => string;
					bg: (color: string, text: string) => string;
					bold: (s: string) => string;
				},
				keybindings: unknown,
				done: (result?: unknown) => void,
			) => Component,
			opts?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
		) => Promise<unknown>;
		notify: (msg: string, t?: ToastType) => void;
	};

	if (typeof ui.custom !== "function") {
		ui.notify(message, type);
		return Promise.resolve();
	}

	const durationMs = options.durationMs ?? 4000;
	const widthOpt = options.width ?? 60;

	return ui
		.custom(
			(_tui, theme, _kb, done) => {
				const accentColor =
					type === "error" ? "error" : type === "warning" ? "warning" : "accent";

				// Inner container holds the optional title + wrapped message.
				const inner = new Container();
				const rebuild = (width: number) => {
					inner.clear();
					if (options.title) {
						inner.addChild(
							new Text(theme.fg(accentColor, theme.bold(options.title)), 0, 0),
						);
						inner.addChild(new Spacer(1));
					}
					// Wrap to inner width so long lines do not get ".." truncated.
					// wrapTextWithAnsi may return string OR string[] depending on version;
					// normalize to lines.
					const wrapped = wrapTextWithAnsi(message, Math.max(8, width - 4));
					const lines = Array.isArray(wrapped) ? wrapped : String(wrapped).split("\n");
					for (const line of lines) {
						inner.addChild(new Text(line, 0, 0));
					}
				};
				rebuild(typeof widthOpt === "number" ? widthOpt : 60);

				const borderColor = (s: string) => theme.fg(accentColor, s);
				// Same dark slab as info-panel for visual consistency.
				const bgColor = (s: string) => `\x1b[48;5;234m${s}\x1b[49m`;

				const close = () => done(undefined);
				if (durationMs > 0) setTimeout(close, durationMs);

				// Important: NO handleInput. Keystrokes pass through to the editor
				// so the user can keep typing while the toast is visible. Dismissal
				// is timer-driven only.
				return {
					render(width: number): string[] {
						rebuild(width);
						return drawBox(
							inner.render(Math.max(4, width - 4)),
							width,
							borderColor,
							bgColor,
						);
					},
					invalidate() {
						inner.invalidate();
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					width: widthOpt,
					anchor: "top-right",
					offsetX: -1,
					offsetY: 1,
					margin: 1,
				},
			},
		)
		.then(() => undefined);
}

/**
 * Wrap pre-rendered inner lines in a 4-sided box with a full-width dark
 * background slab. Mirrors the helper in info-panel.ts — intentionally
 * duplicated to keep the two surfaces visually independent.
 */
function drawBox(
	innerLines: string[],
	width: number,
	color: (s: string) => string,
	bg: (s: string) => string,
): string[] {
	const w = Math.max(4, width);
	const innerWidth = w - 4;
	const top = bg(color(`┌${"─".repeat(w - 2)}┐`));
	const bottom = bg(color(`└${"─".repeat(w - 2)}┘`));
	const side = color("│");
	const out: string[] = [top];
	for (const raw of innerLines) {
		const line = truncateToWidth(raw, innerWidth);
		const pad = Math.max(0, innerWidth - visibleWidth(line));
		out.push(bg(`${side} ${line}${" ".repeat(pad)} ${side}`));
	}
	out.push(bottom);
	return out;
}
