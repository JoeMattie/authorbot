/**
 * `--non-interactive` config file (Phase 6 contract §2.5).
 *
 * Deliberately thin: it is a `directory`, an optional stage list, and an
 * `answers` map keyed by prompt id. Mirroring every prompt into a bespoke
 * typed field would create a second place for the prompt set to drift from,
 * whereas keying by prompt id means a prompt that exists is answerable and one
 * that does not is a loud "unknown key" — which is exactly the failure a CI
 * operator wants.
 *
 * JSON and YAML are both accepted because a config file for a wizard that
 * writes YAML should not insist on JSON.
 */
import { parse as parseYaml } from "yaml";
import { WizardError } from "./errors.js";
import { STAGE_NAMES, isStageName, type StageName } from "./stages/names.js";

export interface WizardConfig {
  readonly directory?: string;
  readonly stages?: readonly StageName[];
  readonly answers: Readonly<Record<string, unknown>>;
}

export function parseConfig(text: string, source: string): WizardConfig {
  let raw: unknown;
  try {
    // YAML is a superset of JSON, so one parser reads both and a `.json` file
    // with a trailing comma still produces a useful error.
    raw = parseYaml(text);
  } catch (error) {
    throw new WizardError(
      `The config file ${source} is not valid JSON or YAML: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "Fix the syntax and run again.",
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WizardError(
      `The config file ${source} must contain an object at the top level.`,
      'Use a mapping with "directory", optional "stages", and an "answers" map.',
    );
  }
  const record = raw as Record<string, unknown>;

  const known = new Set(["version", "directory", "stages", "answers"]);
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    // Loud, not lenient: a typo'd key in an unattended run would otherwise
    // silently mean "prompt for it", which non-interactive mode forbids.
    throw new WizardError(
      `The config file ${source} has unknown key(s): ${unknown.join(", ")}.`,
      `Remove them. The accepted keys are: ${[...known].join(", ")}.`,
    );
  }

  const config: { directory?: string; stages?: StageName[]; answers: Record<string, unknown> } = {
    answers: {},
  };

  const directory = record["directory"];
  if (directory !== undefined) {
    if (typeof directory !== "string" || directory.length === 0) {
      throw new WizardError(
        `The config file ${source} has a "directory" that is not a non-empty string.`,
        'Set "directory" to the path the book should live in.',
      );
    }
    config.directory = directory;
  }

  const stages = record["stages"];
  if (stages !== undefined) {
    if (!Array.isArray(stages)) {
      throw new WizardError(
        `The config file ${source} has a "stages" that is not a list.`,
        `Use a list drawn from: ${STAGE_NAMES.join(", ")}.`,
      );
    }
    const parsed: StageName[] = [];
    for (const entry of stages) {
      if (typeof entry !== "string" || !isStageName(entry)) {
        throw new WizardError(
          `The config file ${source} lists an unknown stage: ${String(entry)}.`,
          `Use only: ${STAGE_NAMES.join(", ")}.`,
        );
      }
      parsed.push(entry);
    }
    config.stages = parsed;
  }

  const answers = record["answers"];
  if (answers !== undefined) {
    if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
      throw new WizardError(
        `The config file ${source} has an "answers" that is not a mapping.`,
        'Use "answers" as a mapping of prompt id to value.',
      );
    }
    config.answers = answers as Record<string, unknown>;
  }

  return config;
}

/**
 * A commented example, printed by `create-authorbot --help` and used by the
 * documentation. Every id here is a real prompt id; a test asserts that.
 */
export const EXAMPLE_CONFIG = `# create-authorbot --non-interactive --config setup.yml
directory: ./my-book
stages: [doctor, book]
answers:
  book.title: The Hollow Creek Anomaly
  book.slug: hollow-creek-anomaly
  book.visibility: private
  book.createRemote: true
  publish.workerName: hollow-creek-anomaly
  publish.customDomain: ""
  collaborate.d1Name: authorbot
  agent.name: drafting-agent
`;
