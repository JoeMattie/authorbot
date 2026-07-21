/**
 * Failure vocabulary (Phase 6 contract §5): every failure the wizard raises
 * carries a human-readable summary *and* the next action, so nothing reaches
 * the author as a bare stack trace.
 */

export class WizardError extends Error {
  /** One sentence telling the author what to do next. */
  readonly nextAction: string;
  /** True when the situation is recognised rather than merely unexpected. */
  readonly known: boolean;

  constructor(message: string, nextAction: string, options?: { known?: boolean }) {
    super(message);
    this.name = "WizardError";
    this.nextAction = nextAction;
    this.known = options?.known ?? true;
  }
}

/**
 * Raised when `--non-interactive` hits something that would otherwise prompt
 * (contract §2.5: "fail loudly"). Naming the missing key is the whole point —
 * a CI operator needs to know which line to add, not that "input was
 * required".
 */
export class NonInteractiveError extends WizardError {
  readonly promptId: string;

  constructor(promptId: string, what: string) {
    super(
      `Setup needs an answer for "${promptId}" (${what}) and --non-interactive forbids asking.`,
      `Add "${promptId}" to the answers section of your config file and run again.`,
    );
    this.name = "NonInteractiveError";
    this.promptId = promptId;
  }
}

/** The author declined a confirmation. Not a fault — a decision. */
export class AbortedError extends WizardError {
  constructor(what: string) {
    super(`Stopped: ${what}`, "Nothing was changed. Run the same command again when ready.");
    this.name = "AbortedError";
  }
}

export class TimeoutError extends WizardError {
  constructor(what: string, nextAction: string) {
    super(`Timed out waiting for ${what}.`, nextAction);
    this.name = "TimeoutError";
  }
}
