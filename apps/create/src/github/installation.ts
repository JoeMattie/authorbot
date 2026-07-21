/**
 * Installing the app on the book's repository, and waiting for it to land
 * (Phase 6 contract §4.5).
 *
 * Creating a GitHub App does not install it. Until it is installed on the
 * repository the app can authenticate nobody and write nothing, so the wizard
 * polls rather than assuming - declaring success on app *creation* would leave
 * an author with a site whose sign-in button works and whose every write
 * silently fails.
 *
 * `GET /repos/{owner}/{repo}/installation` is used rather than listing all
 * installations because it answers the question actually being asked: is this
 * app installed *on this book*. A user with the app installed on some other
 * repository would otherwise look like success.
 */
import { createSign } from "node:crypto";
import { TimeoutError, WizardError } from "../errors.js";
import type { Clock, HttpClient } from "../ports.js";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * A short-lived app JWT (RS256), signed in memory with the private key.
 *
 * `iat` is backdated by 60 seconds because GitHub rejects tokens issued in its
 * future, and a laptop clock a few seconds fast is common. `exp` is well
 * inside GitHub's 10-minute ceiling.
 */
export function createAppJwt(appId: string, pem: string, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 540,
      iss: appId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  let signature: string;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    signature = signer.sign(pem, "base64url");
  } catch {
    // The error from `sign` can quote the key material; it is never surfaced.
    throw new WizardError(
      "The private key GitHub issued for your app could not be used to sign a request.",
      "Delete the app at github.com/settings/apps and run `create-authorbot collaborate` again.",
    );
  }
  return `${signingInput}.${signature}`;
}

export interface InstallationPollOptions {
  readonly appId: string;
  readonly pem: string;
  readonly repo: string;
  readonly apiBase: string;
  readonly timeoutMs: number;
  /** Between polls. */
  readonly intervalMs?: number;
  readonly installUrl: string;
}

/**
 * Polls until the app is installed on `repo`, returning the installation id.
 *
 * The JWT is re-minted each attempt rather than once up front: the poll can
 * outlive a token's lifetime while an author reads the GitHub permissions
 * page, and an expired JWT would turn "still waiting" into "authentication
 * failed".
 */
export async function waitForInstallation(
  http: HttpClient,
  clock: Clock,
  options: InstallationPollOptions,
): Promise<string> {
  const [owner, name] = options.repo.split("/");
  if (owner === undefined || name === undefined) {
    throw new WizardError(
      `"${options.repo}" is not a GitHub repository name of the form owner/repository.`,
      "Run `create-authorbot book` to connect your book to a GitHub repository first.",
    );
  }

  const deadline = clock.now().getTime() + options.timeoutMs;
  const interval = options.intervalMs ?? 3_000;
  let lastStatus = 0;

  while (clock.now().getTime() < deadline) {
    const jwt = createAppJwt(options.appId, options.pem, Math.floor(clock.now().getTime() / 1000));
    const response = await http.request(
      `${options.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "create-authorbot",
        },
        timeoutMs: 20_000,
      },
    );
    lastStatus = response.status;

    if (response.status === 200) {
      const parsed = JSON.parse(response.body) as Record<string, unknown>;
      const id = parsed["id"];
      if (typeof id === "number" || typeof id === "string") {
        return String(id);
      }
      throw new WizardError(
        "GitHub says the app is installed but did not say which installation it is.",
        "Run `create-authorbot collaborate` again.",
      );
    }
    if (response.status === 401) {
      throw new WizardError(
        "GitHub rejected the app's own credentials while checking the installation.",
        "Delete the app at github.com/settings/apps and run `create-authorbot collaborate` again.",
      );
    }
    if (response.status === 403 || response.status === 429) {
      throw new WizardError(
        "GitHub is rate-limiting this account, so the installation could not be confirmed.",
        "Wait a few minutes, then run `create-authorbot collaborate` again - everything already done is skipped.",
      );
    }
    // 404 is the expected "not installed yet" answer; anything else 5xx-ish is
    // treated the same way, because both are resolved by waiting or by the
    // deadline expiring with a clear message.
    await clock.sleep(interval);
  }

  throw new TimeoutError(
    `the app to be installed on ${options.repo} (GitHub last said ${String(lastStatus)})`,
    `Open ${options.installUrl}, install the app on ${options.repo}, then run \`create-authorbot collaborate\` again.`,
  );
}
