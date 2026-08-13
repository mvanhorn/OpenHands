import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import AutomationService from "#/api/automation-service/automation-service.api";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { AUTOMATION_RUNS_QUERY_KEY } from "#/hooks/query/use-automation-detail";
import {
  summarizeAutomationRuns,
  type RunSummaryState,
} from "#/manifests/automation-insights";
import type { Automation } from "#/types/automation";

/**
 * The newest runs sampled per automation. Matches the detail page's default
 * page, so both surfaces share one cache entry per automation.
 */
const RECENT_RUN_SAMPLE_SIZE = 20;

/** Keep aggregate dashboard requests below the automation service's pool size. */
const MAX_CONCURRENT_RUN_HISTORY_REQUESTS = 3;

interface QueuedRequest {
  start: () => void;
}

function createRunHistoryScheduler() {
  let activeRequests = 0;
  const queue: QueuedRequest[] = [];

  const admitNext = () => {
    while (
      activeRequests < MAX_CONCURRENT_RUN_HISTORY_REQUESTS &&
      queue.length > 0
    ) {
      queue.shift()?.start();
    }
  };

  return function schedule<T>(
    request: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const index = queue.indexOf(queuedRequest);
        if (index !== -1) queue.splice(index, 1);
        reject(signal.reason);
      };

      const queuedRequest: QueuedRequest = {
        start: () => {
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.removeEventListener("abort", onAbort);
          activeRequests += 1;
          Promise.resolve()
            .then(request)
            .then(resolve, reject)
            .finally(() => {
              activeRequests -= 1;
              admitNext();
            });
        },
      };

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      queue.push(queuedRequest);
      admitNext();
    });
  };
}

const runHistorySchedulers = new Map<
  string,
  ReturnType<typeof createRunHistoryScheduler>
>();

function getRunHistoryScheduler(
  backendId: string,
  orgId: string | null,
): ReturnType<typeof createRunHistoryScheduler> {
  const key = JSON.stringify([backendId, orgId]);
  const existing = runHistorySchedulers.get(key);
  if (existing) return existing;

  const scheduler = createRunHistoryScheduler();
  runHistorySchedulers.set(key, scheduler);
  return scheduler;
}

interface UseAutomationRunSummariesOptions {
  enabled?: boolean;
}

/**
 * One runs query per listed automation, with service calls admitted through a
 * backend-and-organization-scoped scheduler. Summaries still settle and render
 * progressively through their individual React Query cache entries.
 */
export function useAutomationRunSummaries(
  automations: readonly Automation[],
  options: UseAutomationRunSummariesOptions = {},
): Map<string, RunSummaryState> {
  const { enabled = true } = options;
  const active = useActiveBackend();
  const scheduleRunHistory = useMemo(
    () => getRunHistoryScheduler(active.backend.id, active.orgId),
    [active.backend.id, active.orgId],
  );

  return useQueries({
    queries: automations.map((automation) => ({
      queryKey: [
        ...AUTOMATION_RUNS_QUERY_KEY,
        automation.id,
        { limit: RECENT_RUN_SAMPLE_SIZE, offset: 0 },
        active.backend.id,
        active.orgId,
      ],
      queryFn: ({ signal }) =>
        scheduleRunHistory(
          () =>
            AutomationService.getAutomationRuns(
              automation.id,
              RECENT_RUN_SAMPLE_SIZE,
              0,
            ),
          signal,
        ),
      staleTime: 60 * 1000,
      enabled: enabled && !!automation.id,
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: false,
    })),
    combine: (results) => {
      const byId = new Map<string, RunSummaryState>();
      automations.forEach((automation, index) => {
        const result = results[index];
        byId.set(automation.id, {
          summary: result.data ? summarizeAutomationRuns(result.data) : null,
          isLoading: result.isLoading,
          isError: result.isError,
        });
      });
      return byId;
    },
  });
}
