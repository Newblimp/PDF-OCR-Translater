/** API keys: stored, verified against the provider's model list (which also fills the model dropdown), forgotten. */
import { ApiError } from "@/lib/http/apiError";
import type { ProviderId } from "@/lib/llm/provider";
import { createProvider, PROVIDER_IDS, PROVIDERS } from "@/lib/llm/registry";
import { clearApiKey, saveApiKey } from "@/lib/storage/apiKeys";
import { missingKeys } from "../store";
import type { Runtime } from "./runtime";

/**
 * Store a key and verify it against the provider's model list (which also
 * fills the model dropdown). Returns true when the key was accepted.
 * Results are only applied if the key is still the current one when the
 * request completes (the user may have replaced or forgotten it meanwhile).
 */
export async function verifyAndSaveApiKey(rt: Runtime, provider: ProviderId, key: string): Promise<boolean> {
  rt.session.verifications.get(provider)?.abort();
  const trimmed = key.trim();
  if (!trimmed) {
    clearApiKey(provider);
    rt.dispatch({ type: "key/set", provider, key: null });
    return false;
  }
  const controller = new AbortController();
  rt.session.verifications.set(provider, controller);
  rt.dispatch({ type: "key/set", provider, key: trimmed });
  rt.dispatch({ type: "key/status", provider, status: "checking" });
  const stillCurrent = () => !controller.signal.aborted && rt.getState().keys[provider].value === trimmed;
  const remember = () => rt.getState().settings.rememberKeys;
  try {
    const options = await createProvider(provider, trimmed).listModels(controller.signal);
    if (!stillCurrent()) return false;
    rt.dispatch({ type: "models/set", provider, models: options.length ? options : [...PROVIDERS[provider].fallbackModels] });
    rt.dispatch({ type: "key/status", provider, status: "valid" });
    saveApiKey(provider, trimmed, remember());
    return true;
  } catch (err) {
    if (!stillCurrent()) return false;
    if (err instanceof ApiError && err.kind === "auth") {
      rt.dispatch({ type: "key/status", provider, status: "invalid", error: `${PROVIDERS[provider].label} rejected this key (${err.message}).` });
      return false;
    }
    // Network trouble: keep the key so the user can retry later.
    saveApiKey(provider, trimmed, remember());
    rt.dispatch({ type: "models/set", provider, models: [...PROVIDERS[provider].fallbackModels] });
    rt.dispatch({
      type: "key/status",
      provider,
      status: "unverified",
      error: `Could not verify the ${PROVIDERS[provider].label} key: ${err instanceof Error ? err.message : String(err)}. It was saved anyway.`,
    });
    return false;
  } finally {
    if (rt.session.verifications.get(provider) === controller) rt.session.verifications.delete(provider);
  }
}

/** Verify every key entered in the dialog; closes it when all required keys are accepted. */
export async function submitApiKeys(rt: Runtime, keys: Partial<Record<ProviderId, string>>): Promise<void> {
  await Promise.all(
    (Object.entries(keys) as Array<[ProviderId, string]>).map(([provider, key]) => {
      const current = rt.getState().keys[provider];
      if (key.trim() === (current.value ?? "") && current.status === "valid") return Promise.resolve(true);
      return verifyAndSaveApiKey(rt, provider, key);
    }),
  );
  const state = rt.getState();
  // Stay open while a required key is missing or rejected, or an entered optional key was rejected.
  const blocking = missingKeys(state).length > 0 || Object.values(state.keys).some((k) => k.status === "invalid" && k.value);
  if (!blocking) rt.dispatch({ type: "key/dialog", open: false });
}

export function forgetApiKeys(rt: Runtime): void {
  for (const provider of PROVIDER_IDS) {
    rt.session.verifications.get(provider)?.abort();
    clearApiKey(provider);
    rt.dispatch({ type: "key/set", provider, key: null });
    rt.dispatch({ type: "models/set", provider, models: [] });
  }
  rt.dispatch({ type: "key/dialog", open: true });
}
