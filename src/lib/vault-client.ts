import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";

export interface AgentContext {
  cloudProvider?: string; // "azure" | "aws" | "gcp"
  vaultUri?: string;
  secretName?: string;
}

/**
 * Resolve an API token for this agent at runtime.
 *
 * When the platform-orchestrator injects a `_agentContext` into the webhook
 * payload, this function retrieves the actual token from the project's cloud
 * vault using the agent's own managed identity — the raw token is never stored
 * in the payload.
 *
 * Falls back to the specified environment variable when:
 * - No `_agentContext` is present (local development)
 * - The vault lookup fails (transient error — logs a warning)
 *
 * @param agentContext  The `_agentContext` object from the incoming payload, or undefined
 * @param envFallback   Environment variable name to fall back to
 */
export async function resolveToken(
  agentContext: AgentContext | undefined,
  envFallback: string
): Promise<string | undefined> {
  if (agentContext?.vaultUri && agentContext?.secretName) {
    const provider = agentContext.cloudProvider ?? "azure";

    if (provider === "azure") {
      try {
        const client = new SecretClient(agentContext.vaultUri, new DefaultAzureCredential());
        const secret = await client.getSecret(agentContext.secretName);
        return secret.value;
      } catch (err) {
        console.warn(
          `[vault-client] Failed to retrieve secret '${agentContext.secretName}' from ${agentContext.vaultUri} — falling back to env var '${envFallback}':`,
          err instanceof Error ? err.message : err
        );
      }
    } else if (provider === "aws") {
      throw new Error("AWS Secrets Manager support not yet implemented");
    } else if (provider === "gcp") {
      throw new Error("GCP Secret Manager support not yet implemented");
    }
  }

  return process.env[envFallback];
}
