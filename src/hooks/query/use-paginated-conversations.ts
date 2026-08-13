import { useInfiniteQuery } from "@tanstack/react-query";
import { useLocation } from "react-router";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import { useIsAuthed } from "./use-is-authed";
import { isNoBackend } from "#/api/backend-registry/active-store";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { AppConversationPage } from "#/api/conversation-service/agent-server-conversation-service.types";
import { automationListPath } from "#/manifests/automation-interface";

export const usePaginatedConversations = (limit: number = 20) => {
  const { data: userIsAuthenticated } = useIsAuthed();
  const active = useActiveBackend();
  const { pathname } = useLocation();
  const hasBackend = !isNoBackend(active.backend);
  const automationPath = automationListPath();
  const isAutomationRoute =
    pathname === automationPath || pathname.startsWith(`${automationPath}/`);

  return useInfiniteQuery({
    // Include the active backend identity so each (backend, org) pair
    // maintains its own paginated cache. Switching backends naturally
    // produces a new query and a fresh fetch — without it the previous
    // backend's conversations stay visible for staleTime.
    queryKey: [
      "user",
      "conversations",
      "paginated",
      limit,
      active.backend.id,
      active.orgId,
    ],
    queryFn: async ({ pageParam }) => {
      const result = await AgentServerConversationService.searchConversations(
        limit,
        pageParam,
      );

      return result;
    },
    enabled: !!userIsAuthenticated && hasBackend,
    getNextPageParam: (lastPage: AppConversationPage) => lastPage.next_page_id,
    initialPageParam: undefined as string | undefined,
    // Poll every 10s outside automation routes so titles, execution status,
    // and timestamps stay fresh without requiring the user to refresh. The
    // automation dashboard still gets its useful initial conversation fetch,
    // but avoids adding this recurring request to its automation-summary
    // traffic. Consumers must gate initial-load UI (e.g. skeletons) on
    // `isLoading`, not `isFetching` — `isFetching` flips back to true on every
    // background refetch, which would cause the skeleton to flicker every 10s
    // when the list is empty.
    refetchInterval: isAutomationRoute ? false : 10_000,
    refetchIntervalInBackground: false,
    // A successful fetch proves the backend is reachable. The global
    // QueryCache onSuccess handler reads this to clear any persisted
    // failure state, re-arming the status dot without user intervention.
    meta: { backendId: active.backend.id },
  });
};
