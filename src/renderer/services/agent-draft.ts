/**
 * Start an agent draft for one email right now, streaming into the Agent tab.
 *
 * Shared by the Agent panel's "Regenerate" and the message view's "Write
 * draft": both ask the backend (drafts:rerun-agent) to discard any existing
 * draft and launch the background drafter immediately, then register an
 * in-memory task so the Agent tab shows the run live instead of only after it
 * finishes.
 */
import { useAppStore } from "../store";
import { DEFAULT_BACKGROUND_AGENT_PROVIDER, type IpcResponse } from "../../shared/types";
import type { AgentContext } from "../../shared/agent-types";

export async function startAgentDraftNow(
  emailId: string,
  reuse?: { prompt: string; context: AgentContext },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = useAppStore.getState();
  // Clear the in-memory draft so the list reflects the rewrite immediately.
  store.updateEmail(emailId, { draft: undefined });

  const result = (await window.api.drafts.rerunAgent(emailId)) as IpcResponse<{
    taskId: string;
    providerIds?: string[];
  }>;
  if (!result.success) return { ok: false, error: result.error };

  // The real context is built by buildAgentDraftContext on the backend — this
  // is only the store's tracking entry. Drop providerConversationIds from a
  // reused context: this is a fresh conversation (the backend deleted the old
  // trace), possibly on a different provider, and a stale id would make a
  // later follow-up skip conversation history.
  const email = useAppStore.getState().emails.find((e) => e.id === emailId);
  useAppStore.getState().startAgentTask(
    result.data.taskId,
    emailId,
    result.data.providerIds ?? [DEFAULT_BACKGROUND_AGENT_PROVIDER],
    reuse?.prompt ?? "",
    reuse
      ? { ...reuse.context, providerConversationIds: undefined }
      : {
          accountId: email?.accountId || "",
          currentEmailId: emailId,
          currentThreadId: email?.threadId || "",
          userEmail: "",
        },
  );
  return { ok: true };
}
