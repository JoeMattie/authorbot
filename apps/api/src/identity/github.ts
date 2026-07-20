/**
 * GitHub OAuth identity provider (contract §3: implemented, exercised only
 * when configured). Uses the injected `fetch` so tests can stub GitHub.
 * The access token lives only inside `resolveCallback` and is never logged,
 * stored, or included in errors.
 */
import type { GitHubOAuthConfig } from "../deps.js";
import type { GitHubIdentityProvider, ResolvedIdentity } from "./provider.js";

const AUTHORIZE_ENDPOINT = "https://github.com/login/oauth/authorize";
const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const USER_ENDPOINT = "https://api.github.com/user";

export function createGitHubIdentityProvider(
  config: GitHubOAuthConfig,
  fetchImpl: typeof fetch = fetch,
): GitHubIdentityProvider {
  return {
    mode: "github",

    authorizeUrl(state: string): string {
      const url = new URL(AUTHORIZE_ENDPOINT);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("scope", "read:user");
      return url.toString();
    },

    async resolveCallback(code: string): Promise<ResolvedIdentity> {
      const tokenResponse = await fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: config.redirectUri,
        }),
      });
      if (!tokenResponse.ok) {
        throw new Error(`github token exchange failed with status ${tokenResponse.status}`);
      }
      const tokenBody = (await tokenResponse.json()) as { access_token?: string };
      const accessToken = tokenBody.access_token;
      if (typeof accessToken !== "string" || accessToken.length === 0) {
        throw new Error("github token exchange returned no access token");
      }

      const userResponse = await fetchImpl(USER_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "authorbot-api",
        },
      });
      if (!userResponse.ok) {
        throw new Error(`github user fetch failed with status ${userResponse.status}`);
      }
      const user = (await userResponse.json()) as { login?: string; name?: string | null };
      if (typeof user.login !== "string" || user.login.length === 0) {
        throw new Error("github user response had no login");
      }
      return {
        externalIdentity: `github:${user.login}`,
        displayName: user.name != null && user.name.length > 0 ? user.name : user.login,
      };
    },
  };
}
