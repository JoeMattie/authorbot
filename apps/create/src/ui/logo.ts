/**
 * The Authorbot mark, for the top of a run.
 *
 * Drawn rather than fetched. Rendering the real logo would mean a terminal
 * image protocol (sixel, kitty, iTerm2) that most terminals do not have, or a
 * system binary like `timg` that most machines do not have — either way a
 * `brew install` standing between an author and their book, to show them a
 * picture. Letterforms are what block characters are for, so the wordmark
 * survives the shrink to a terminal intact.
 *
 * The mark is centred against the wordmark by measurement, not by counting
 * spaces into a string literal: the first version of this had the robot's
 * panel overhanging its own border by two columns, which is exactly the bug
 * hand-padded ASCII art always has.
 */

/** Orange for "Author", teal for "bot" — the logo's own split. */
const ORANGE = "38;5;208";
const TEAL = "38;5;37";
const NAVY = "38;5;24";
const GOLD = "38;5;221";

const WORDMARK: ReadonlyArray<readonly [string, string]> = [
  ["╔═╗ ╦ ╦ ╔╦╗ ╦ ╦ ╔═╗ ╦═╗", "  ╔╗  ╔═╗ ╔╦╗"],
  ["╠═╣ ║ ║  ║  ╠═╣ ║ ║ ╠╦╝", "  ╠╩╗ ║ ║  ║ "],
  ["╩ ╩ ╚═╝  ╩  ╩ ╩ ╚═╝ ╩╚═", "  ╚═╝ ╚═╝  ╩ "],
];

/** Inner width of each page of the book. */
const PANEL = 7;

const BORDER = `╭${"─".repeat(PANEL)}┬${"─".repeat(PANEL)}╮`;
const SPINE_LEFT = `╰${"─".repeat(PANEL - 1)}`;
const SPINE_RIGHT = `${"─".repeat(PANEL - 1)}╯`;

const FIRST_ROW = WORDMARK[0] ?? (["", ""] as const);
const WORD_WIDTH = FIRST_ROW[0].length + FIRST_ROW[1].length;
const MARK_WIDTH = [...BORDER].length;
const INDENT = " ".repeat(Math.max(0, Math.round((WORD_WIDTH - MARK_WIDTH) / 2)));

/** The one-line form, for a terminal that cannot take the rest. */
export const PLAIN_LOGO = "[=|o o]v  Authorbot";

export interface LogoOptions {
  /** False under NO_COLOR, in a pipe, or on a dumb terminal. */
  readonly colour: boolean;
  readonly unicode: boolean;
  readonly width: number;
}

/**
 * The lines to print, already styled. Returns the plain one-liner whenever the
 * terminal cannot take box characters, or is too narrow to hold the wordmark
 * without wrapping it into nonsense.
 */
export function logoLines(options: LogoOptions): readonly string[] {
  if (!options.unicode || options.width < WORD_WIDTH) {
    return [PLAIN_LOGO];
  }

  const paint = (code: string, text: string): string =>
    options.colour ? `\u001b[${code}m${text}\u001b[0m` : text;
  const dim = (text: string): string => (options.colour ? `\u001b[2m${text}\u001b[22m` : text);

  // Centre the whole block in the terminal, not just the mark over the
  // wordmark. A mark pinned to the left edge of a wide terminal looks like a
  // rendering accident rather than a decision.
  const outer = " ".repeat(Math.max(0, Math.floor((options.width - WORD_WIDTH) / 2)));
  const sparkles = `${outer}${INDENT}${" ".repeat(Math.floor(MARK_WIDTH * 0.55))}${paint(GOLD, "✦")}   ${paint(TEAL, "·")}`;

  return [
    sparkles,
    `${outer}${INDENT}${paint(NAVY, BORDER)}`,
    `${outer}${INDENT}${paint(NAVY, "│")} ${dim("───")}   ${paint(NAVY, "│")} ${paint(NAVY, "╭")}${paint(TEAL, "◉ ◉")}${paint(NAVY, "╮")} ${paint(NAVY, "│")}`,
    `${outer}${INDENT}${paint(NAVY, SPINE_LEFT)}${paint(TEAL, "╲▼╱")}${paint(NAVY, SPINE_RIGHT)}`,
    "",
    ...WORDMARK.map(([left, right]) => `${outer}${paint(ORANGE, left)}${paint(TEAL, right)}`),
  ];
}
