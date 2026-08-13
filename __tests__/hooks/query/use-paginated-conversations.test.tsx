import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import { usePaginatedConversations } from "#/hooks/query/use-paginated-conversations";

vi.mock(
  "#/api/conversation-service/agent-server-conversation-service.api",
  () => ({
    default: { searchConversations: vi.fn() },
  }),
);

vi.mock("#/hooks/query/use-is-authed", () => ({
  useIsAuthed: () => ({ data: true }),
}));

vi.mock("#/contexts/active-backend-context", () => ({
  useActiveBackend: () => ({
    backend: {
      id: "local-1",
      name: "Local",
      host: "http://localhost:8000",
      kind: "local",
    },
    orgId: null,
  }),
}));

function renderConversations(pathname: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const rendered = renderHook(() => usePaginatedConversations(), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <MemoryRouter initialEntries={[pathname]}>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </MemoryRouter>
    ),
  });

  return { ...rendered, queryClient };
}

async function waitForRequestCount(count: number) {
  await vi.waitFor(() => {
    expect(
      AgentServerConversationService.searchConversations,
    ).toHaveBeenCalledTimes(count);
  });
}

describe("usePaginatedConversations polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(
      AgentServerConversationService.searchConversations,
    ).mockResolvedValue({ items: [], next_page_id: null });
  });

  afterEach(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it.each(["/automations", "/automations/auto-1/activity"])(
    "fetches once without polling on %s",
    async (pathname) => {
      const { queryClient, result, unmount } = renderConversations(pathname);

      await waitForRequestCount(1);
      await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(
        AgentServerConversationService.searchConversations,
      ).toHaveBeenCalledTimes(1);

      unmount();
      queryClient.clear();
    },
  );

  it("continues polling every ten seconds outside automation routes", async () => {
    const { queryClient, result, unmount } =
      renderConversations("/conversations");

    await waitForRequestCount(1);
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(
      AgentServerConversationService.searchConversations,
    ).toHaveBeenCalledTimes(2);

    unmount();
    queryClient.clear();
  });

  it("does not poll a non-automation route while the document is hidden", async () => {
    const { queryClient, result, unmount } =
      renderConversations("/conversations");

    await waitForRequestCount(1);
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(
      AgentServerConversationService.searchConversations,
    ).toHaveBeenCalledTimes(2);

    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      window.dispatchEvent(new Event("visibilitychange"));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(
      AgentServerConversationService.searchConversations,
    ).toHaveBeenCalledTimes(2);

    unmount();
    queryClient.clear();
  });
});
