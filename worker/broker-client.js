/**
 * Credential broker client for the code agent.
 *
 * Calls the platform console credential broker to obtain a short-lived token
 * for a given project + provider combination. Credentials are never stored in
 * environment variables — every execution fetches fresh tokens.
 *
 * @param {string} projectId      - Myridius project UUID (from _agentContext.projectId)
 * @param {string} agentType      - e.g. "code"
 * @param {string} provider       - "jira" | "github" | "azure-devops"
 * @param {string} consoleUrl     - Myridius console base URL (CONSOLE_URL env var)
 * @param {string} agentSecret    - Agent callback secret (AGENT_CALLBACK_SECRET env var)
 * @param {string} [environment]  - defaults to "development"
 * @param {string} [executionId]  - optional, from _agentContext.executionId
 * @returns {Promise<{token: string, email?: string}>}
 */
export async function acquireToken(projectId, agentType, provider, consoleUrl, agentSecret, environment = "development", executionId, capabilities) {
  const defaultCapabilities = provider === "github"
    ? ["REPOSITORY_READ", "REPOSITORY_WRITE"]
    : ["ISSUE_READ", "ISSUE_WRITE"];
  const url = `${consoleUrl.replace(/\/$/, "")}/api/credentials/request`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${agentSecret}`,
    },
    body: JSON.stringify({
      projectId,
      agentType,
      provider,
      capabilities: capabilities ?? defaultCapabilities,
      environment,
      ...(executionId ? { executionId } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Credential broker request failed for project '${projectId}', provider '${provider}' (${res.status}): ${body}`);
  }
  const grant = await res.json();
  return { token: grant.token, email: grant.email, owner: grant.owner };
}
