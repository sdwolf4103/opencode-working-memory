/**
 * OpenCode SDK helper functions for memory plugin.
 *
 * These functions wrap OpenCode client API calls to extract:
 * - Latest user message text (for explicit memory extraction)
 * - Latest compaction summary (for memory candidate parsing)
 * - Pending todos (for compaction context)
 */

/**
 * Extract the latest user message text from a session.
 * Returns { id, text } or null if no user message found.
 */
export async function latestUserText(
  client: unknown,
  sessionID: string
): Promise<{ id: string; text: string } | null> {
  try {
    // Cast client to access session.messages API
    const api = client as {
      session: {
        messages: (params: { path: { id: string } }) => Promise<{
          data?: Array<{
            info?: {
              role?: string;
              id?: string;
            };
            parts?: Array<{
              type?: string;
              text?: string;
            }>;
          }>;
        }>;
      };
    };

    const result = await api.session.messages({ path: { id: sessionID } });
    const messages = result.data ?? [];

    // Scan backwards from most recent messages to find the latest user message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.info?.role !== "user") continue;

      // Concatenate all text parts
      const text = (msg.parts ?? [])
        .filter((p: { type?: string }) => p.type === "text")
        .map((p: { text?: string }) => p.text ?? "")
        .join("\n");

      if (text.trim()) {
        return {
          id: msg.info?.id ?? "",
          text: text.trim(),
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the latest compaction summary from a session.
 * Compaction summaries are assistant messages marked with summary=true.
 */
export async function latestCompactionSummary(
  client: unknown,
  sessionID: string
): Promise<string | null> {
  try {
    const api = client as {
      session: {
        messages: (params: { path: { id: string } }) => Promise<{
          data?: Array<{
            info?: {
              role?: string;
              summary?: boolean;
            };
            parts?: Array<{
              type?: string;
              text?: string;
            }>;
          }>;
        }>;
      };
    };

    const result = await api.session.messages({ path: { id: sessionID } });
    const messages = result.data ?? [];

    // Scan backwards to find the most recent summary (compaction)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.info?.role !== "assistant" || msg.info?.summary !== true) continue;

      const text = (msg.parts ?? [])
        .filter((p: { type?: string }) => p.type === "text")
        .map((p: { text?: string }) => p.text ?? "")
        .join("\n");

      if (text.trim()) {
        return text.trim();
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch pending todos from a session.
 * Returns todos that are not marked as completed.
 */
export async function pendingTodos(
  client: unknown,
  sessionID: string
): Promise<Array<{ content: string; status: string; priority?: string }>> {
  try {
    const api = client as {
      session: {
        todo: (params: { path: { id: string } }) => Promise<{
          data?: Array<{
            content?: string;
            status?: string;
            priority?: string;
          }>;
        }>;
      };
    };

    const result = await api.session.todo({ path: { id: sessionID } });
    const todos = result.data ?? [];

    // Filter out completed todos
    return todos
      .filter((todo: { status?: string }) => todo.status !== "completed")
      .map((todo: { content?: string; status?: string; priority?: string }) => ({
        content: todo.content ?? "",
        status: todo.status ?? "pending",
        priority: todo.priority,
      }));
  } catch {
    return [];
  }
}

/**
 * Check if a session is a sub-agent (has a parent session).
 * Sub-agents are short-lived and should not have their own memory tracking.
 */
export async function isSubAgent(
  client: unknown,
  sessionID: string
): Promise<boolean> {
  try {
    const api = client as {
      session: {
        get: (params: { path: { id: string } }) => Promise<{
          data?: {
            parentID?: string | null;
          };
        }>;
      };
    };

    const result = await api.session.get({ path: { id: sessionID } });
    return result.data?.parentID != null;
  } catch {
    // If we can't determine, assume it's NOT a sub-agent (safe default)
    return false;
  }
}