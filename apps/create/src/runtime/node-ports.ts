/**
 * The remaining real-world port implementations: filesystem, clock,
 * randomness, HTTP, the browser handoff, and the loopback callback server.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type {
  BrowserOpener,
  Clock,
  FileSystemPort,
  HttpClient,
  HttpRequest,
  HttpResponse,
  LoopbackRequest,
  LoopbackResponse,
  LoopbackServer,
  LoopbackServerFactory,
  ProcessRunner,
  RandomSource,
} from "../ports.js";
import { WizardError } from "../errors.js";

export class NodeFileSystem implements FileSystemPort {
  async readFile(filePath: string): Promise<string> {
    return await readFile(filePath, "utf8");
  }

  async writeFile(filePath: string, contents: string): Promise<void> {
    await writeFile(filePath, contents, "utf8");
  }

  async mkdirp(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true });
  }

  async exists(filePath: string): Promise<boolean> {
    return existsSync(filePath);
  }

  async readDir(dirPath: string): Promise<string[]> {
    try {
      return await readdir(dirPath);
    } catch {
      return [];
    }
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}

export class CryptoRandom implements RandomSource {
  bytes(length: number): Uint8Array {
    return new Uint8Array(randomBytes(length));
  }
}

const DEFAULT_HTTP_TIMEOUT_MS = 20_000;

export class FetchHttpClient implements HttpClient {
  async request(url: string, init: HttpRequest = {}): Promise<HttpResponse> {
    const controller = new AbortController();
    // Contract §5: every network call has a timeout. Without one, a hung
    // GitHub or Cloudflare endpoint stalls the wizard with no explanation.
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: init.method ?? "GET",
        headers: { ...init.headers },
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: init.followRedirects === false ? "manual" : "follow",
        signal: controller.signal,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: response.status, headers, body: await response.text() };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new WizardError(
          `No response from ${new URL(url).host} within ${String(init.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS)}ms.`,
          "Check your network connection and whether that service is reporting an outage, then run again.",
        );
      }
      throw new WizardError(
        `Could not reach ${safeHost(url)}: ${error instanceof Error ? error.message : String(error)}`,
        "Check your network connection, then run again — finished steps are skipped.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Opens the user's browser. Failure is not fatal: the caller prints the URL,
 * and a user on a headless box pastes it into a browser elsewhere. A wizard
 * that dies because `xdg-open` is missing is a wizard that cannot be used over
 * SSH.
 */
export class SystemBrowserOpener implements BrowserOpener {
  readonly #runner: ProcessRunner;

  constructor(runner: ProcessRunner) {
    this.#runner = runner;
  }

  async open(url: string): Promise<void> {
    const [command, args] =
      process.platform === "darwin"
        ? (["open", [url]] as const)
        : process.platform === "win32"
          ? (["cmd", ["/c", "start", "", url]] as const)
          : (["xdg-open", [url]] as const);
    try {
      await this.#runner.run(command, args, { timeoutMs: 10_000 });
    } catch {
      // Ignored by design; the caller always prints the URL too.
    }
  }
}

class NodeLoopbackServer implements LoopbackServer {
  readonly origin: string;
  readonly #close: () => Promise<void>;
  #closed = false;

  constructor(origin: string, close: () => Promise<void>) {
    this.origin = origin;
    this.#close = close;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#close();
  }
}

/**
 * Loopback callback server for the GitHub App manifest flow (contract §4.1).
 *
 * Bound to `127.0.0.1` explicitly — not `localhost` (which may resolve to a
 * non-loopback address) and never `0.0.0.0`, which would expose the callback,
 * and therefore the one-time conversion code, to the local network.
 */
export class NodeLoopbackServerFactory implements LoopbackServerFactory {
  async start(
    handler: (request: LoopbackRequest) => Promise<LoopbackResponse>,
  ): Promise<LoopbackServer> {
    const server = createServer((req, res) => {
      void (async () => {
        let reply: LoopbackResponse;
        try {
          reply = await handler({ method: req.method ?? "GET", url: req.url ?? "/" });
        } catch {
          reply = {
            status: 500,
            contentType: "text/plain; charset=utf-8",
            body: "Setup could not handle this request. Return to your terminal.",
          };
        }
        res.writeHead(reply.status, {
          "content-type": reply.contentType,
          // The callback carries a one-time code; nothing about it should be
          // cached, framed, or used as a referrer for the next hop.
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-frame-options": "DENY",
        });
        res.end(reply.body);
      })();
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Port 0: the OS picks a free port, so two concurrent runs cannot
      // collide and nothing predictable is squatted.
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    const address = server.address() as AddressInfo | null;
    if (address === null) {
      server.close();
      throw new WizardError(
        "Could not start the local callback server that GitHub redirects back to.",
        "Check whether something is blocking loopback connections, then run again.",
      );
    }

    return new NodeLoopbackServer(
      `http://127.0.0.1:${String(address.port)}`,
      () =>
        new Promise<void>((resolve) => {
          // closeAllConnections: a keep-alive socket from the browser would
          // otherwise keep the process alive after the flow finishes.
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
  }
}
