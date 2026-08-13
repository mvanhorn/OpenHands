import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import { I18nKey } from "#/i18n/declaration";
import AutomationService from "#/api/automation-service/automation-service.api";
import {
  __resetActiveStoreForTests,
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import { ActiveBackendProvider } from "#/contexts/active-backend-context";
import AutomationsList from "#/routes/automations-list";
import AutomationTemplates, {
  clientLoader as templatesLoader,
} from "#/routes/automation-templates";
import type { Backend } from "#/api/backend-registry/types";
import {
  AutomationRunStatus,
  type Automation,
  type AutomationRun,
  type AutomationRunsResponse,
} from "#/types/automation";

// Replace the published data source with the widget-themed manifest that
// declares the full sub-page surface; admission itself stays real.
vi.mock("#/manifests/manifest-sources", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("#/manifests/manifest-sources")>();
  const { createInterfaceManifestWithSubPages } =
    await import("../manifests/manifest-test-data");
  return {
    ...actual,
    AUTOMATION_INTERFACE_CANDIDATE: createInterfaceManifestWithSubPages(),
  };
});

vi.mock("#/api/automation-service/automation-service.api", () => ({
  default: {
    getAutomations: vi.fn(),
    getAutomationRuns: vi.fn(),
    checkHealth: vi.fn(),
    toggleAutomation: vi.fn(),
    updateAutomation: vi.fn(),
    deleteAutomation: vi.fn(),
    dispatchAutomation: vi.fn(),
  },
}));

const localBackend: Backend = {
  id: "local-1",
  name: "Local 1",
  host: "http://localhost:8000",
  apiKey: "session-key",
  kind: "local",
};

function createAutomation(overrides: Partial<Automation>): Automation {
  return {
    id: "a-ok",
    name: "Alpha widget",
    trigger: { type: "cron", schedule: "0 9 * * *" },
    enabled: true,
    prompt: "Watch the widgets",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function createRun(overrides: Partial<AutomationRun>): AutomationRun {
  return {
    id: "run-1",
    status: AutomationRunStatus.COMPLETED,
    conversation_id: null,
    bash_command_id: null,
    error_detail: null,
    started_at: "2026-01-02T00:00:00Z",
    completed_at: "2026-01-02T00:01:00Z",
    ...overrides,
  };
}

function createDeferredRunHistory() {
  let resolve!: (value: AutomationRunsResponse) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<AutomationRunsResponse>(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    },
  );
  return { promise, resolve, reject };
}

// Alphabetically first but least recently run, so the manifest's "name"
// default is distinguishable from the host's usual last-run ordering.
const okAutomation = createAutomation({});
const brokenAutomation = createAutomation({
  id: "a-broken",
  name: "Broken widget",
});

function renderAt(
  path: string,
  page: React.ReactElement,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  const rendered = render(
    <QueryClientProvider client={client}>
      <ActiveBackendProvider>
        <MemoryRouter initialEntries={[path]}>{page}</MemoryRouter>
      </ActiveBackendProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, client };
}

async function renderDashboardWithSettledInsights() {
  renderAt("/automations", <AutomationsList />);
  await screen.findByTestId("automation-card-a-ok");
  // The broken automation's badge carries the manifest's failing caption once
  // its runs summary settles.
  await within(
    await screen.findByTestId("automation-card-a-broken"),
  ).findByText("Broken");
}

beforeEach(() => {
  window.localStorage.clear();
  __resetActiveStoreForTests();
  vi.mocked(AutomationService.checkHealth).mockReset();
  vi.mocked(AutomationService.checkHealth).mockResolvedValue({ status: "ok" });
  vi.mocked(AutomationService.getAutomations).mockReset();
  vi.mocked(AutomationService.getAutomations).mockResolvedValue({
    automations: [okAutomation, brokenAutomation],
    total: 2,
  });
  vi.mocked(AutomationService.getAutomationRuns).mockReset();
  vi.mocked(AutomationService.getAutomationRuns).mockImplementation((id) =>
    id === "a-broken"
      ? Promise.resolve({
          runs: [
            createRun({
              status: AutomationRunStatus.FAILED,
              started_at: "2026-01-05T00:00:00Z",
              completed_at: "2026-01-05T00:00:30Z",
            }),
          ],
          total: 4,
        })
      : Promise.resolve({ runs: [createRun({})], total: 6 }),
  );
  setRegisteredBackends([localBackend]);
  setActiveSelection({ backendId: localBackend.id });
});

afterEach(() => {
  window.localStorage.clear();
  __resetActiveStoreForTests();
});

describe("AutomationsList — manifest-declared dashboard", () => {
  it("progressively loads 21 run summaries with at most three requests in flight", async () => {
    // Arrange — keep every history request open so the observed peak reflects
    // admission, not the speed of immediately resolved mock promises.
    const automations = Array.from({ length: 21 }, (_, index) =>
      createAutomation({
        id: `a-${String(index).padStart(2, "0")}`,
        name: `Widget ${String(index).padStart(2, "0")}`,
      }),
    );
    const histories = new Map<
      string,
      ReturnType<typeof createDeferredRunHistory>
    >();
    let requestsInFlight = 0;
    let peakRequestsInFlight = 0;

    vi.mocked(AutomationService.getAutomations).mockResolvedValue({
      automations,
      total: automations.length,
    });
    vi.mocked(AutomationService.getAutomationRuns).mockImplementation((id) => {
      const history = createDeferredRunHistory();
      histories.set(id, history);
      requestsInFlight += 1;
      peakRequestsInFlight = Math.max(peakRequestsInFlight, requestsInFlight);
      return history.promise.finally(() => {
        requestsInFlight -= 1;
      });
    });

    // Act — cards render from the automation list while summary requests wait.
    renderAt("/automations", <AutomationsList />);

    // Assert — the full dashboard is usable without waiting for every summary,
    // and only the first three histories have reached the service.
    expect(
      await screen.findByTestId("automation-card-a-20"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("automation-run-now-a-20")).toBeEnabled();
    await waitFor(() => {
      expect(AutomationService.getAutomationRuns).toHaveBeenCalledTimes(3);
    });
    expect(peakRequestsInFlight).toBe(3);

    // Resolve one request at a time. Each free slot admits exactly one later
    // automation, preserving progressive per-card updates and the peak bound.
    for (
      let completed = 0;
      completed < automations.length - 3;
      completed += 1
    ) {
      const automation = automations[completed];
      const history = histories.get(automation.id);
      expect(history).toBeDefined();
      await act(async () => {
        history?.resolve({
          runs: [createRun({ id: `run-${automation.id}` })],
          total: completed + 1,
        });
      });
      await waitFor(() => {
        expect(AutomationService.getAutomationRuns).toHaveBeenCalledTimes(
          completed + 4,
        );
      });
      expect(peakRequestsInFlight).toBeLessThanOrEqual(3);
    }

    await act(async () => {
      automations.slice(-3).forEach((automation, index) => {
        histories.get(automation.id)?.resolve({
          runs: [createRun({ id: `run-${automation.id}` })],
          total: automations.length - 2 + index,
        });
      });
    });

    await waitFor(() => {
      expect(
        within(screen.getByTestId("automation-card-a-20")).getByText("21"),
      ).toBeInTheDocument();
    });
    expect(AutomationService.getAutomationRuns).toHaveBeenCalledTimes(21);
    expect(peakRequestsInFlight).toBe(3);
    expect(requestsInFlight).toBe(0);
    expect(AutomationService.getAutomationRuns).toHaveBeenLastCalledWith(
      "a-20",
      20,
      0,
    );
  });

  it("keeps the concurrency bound when the dashboard remounts", async () => {
    const automations = Array.from({ length: 6 }, (_, index) =>
      createAutomation({ id: `a-${index}`, name: `Widget ${index}` }),
    );
    const histories: ReturnType<typeof createDeferredRunHistory>[] = [];
    let requestsInFlight = 0;
    let peakRequestsInFlight = 0;

    vi.mocked(AutomationService.getAutomations).mockResolvedValue({
      automations,
      total: automations.length,
    });
    vi.mocked(AutomationService.getAutomationRuns).mockImplementation(() => {
      const history = createDeferredRunHistory();
      histories.push(history);
      requestsInFlight += 1;
      peakRequestsInFlight = Math.max(peakRequestsInFlight, requestsInFlight);
      return history.promise.finally(() => {
        requestsInFlight -= 1;
      });
    });

    const firstMount = renderAt("/automations", <AutomationsList />);
    await screen.findByTestId("automation-card-a-5");
    await waitFor(() => {
      expect(AutomationService.getAutomationRuns).toHaveBeenCalledTimes(3);
    });

    firstMount.unmount();
    renderAt("/automations", <AutomationsList />, firstMount.client);
    await screen.findByTestId("automation-card-a-5");
    await act(async () => Promise.resolve());

    expect(AutomationService.getAutomationRuns).toHaveBeenCalledTimes(3);
    expect(peakRequestsInFlight).toBe(3);

    while (true) {
      const pending = histories.splice(0);
      if (pending.length === 0) break;
      await act(async () => {
        pending.forEach((history) => history.resolve({ runs: [], total: 0 }));
      });
      await act(async () => Promise.resolve());
      if (
        vi.mocked(AutomationService.getAutomationRuns).mock.calls.length ===
          9 &&
        histories.length === 0
      ) {
        break;
      }
    }

    await waitFor(() => {
      expect(requestsInFlight).toBe(0);
    });
    expect(AutomationService.getAutomationRuns).toHaveBeenCalledTimes(9);
    expect(peakRequestsInFlight).toBe(3);
  });

  it("settles a failed summary without retrying while queued summaries continue", async () => {
    // Arrange
    const automations = Array.from({ length: 6 }, (_, index) =>
      createAutomation({ id: `a-${index}`, name: `Widget ${index}` }),
    );
    const histories = new Map<
      string,
      ReturnType<typeof createDeferredRunHistory>
    >();
    vi.mocked(AutomationService.getAutomations).mockResolvedValue({
      automations,
      total: automations.length,
    });
    vi.mocked(AutomationService.getAutomationRuns).mockImplementation((id) => {
      const history = createDeferredRunHistory();
      histories.set(id, history);
      return history.promise;
    });

    const { client } = renderAt("/automations", <AutomationsList />);
    await screen.findByTestId("automation-card-a-5");
    await waitFor(() => {
      expect(AutomationService.getAutomationRuns).toHaveBeenCalledTimes(3);
    });

    // Act — a rejection frees its slot and admits the next queued summary.
    await act(async () => {
      histories.get("a-0")?.reject(new Error("automation pool unavailable"));
    });
    await waitFor(() => {
      expect(AutomationService.getAutomationRuns).toHaveBeenCalledTimes(4);
    });

    for (const id of ["a-1", "a-2", "a-3"]) {
      await act(async () => {
        histories.get(id)?.resolve({
          runs: [createRun({ id: `run-${id}` })],
          total: 1,
        });
      });
    }
    await waitFor(() => {
      expect(AutomationService.getAutomationRuns).toHaveBeenCalledTimes(6);
    });
    await act(async () => {
      histories
        .get("a-4")
        ?.resolve({ runs: [createRun({ id: "run-a-4" })], total: 1 });
      histories
        .get("a-5")
        ?.resolve({ runs: [createRun({ id: "run-a-5" })], total: 1 });
    });

    // Assert — the rejected card uses the existing unknown/error presentation,
    // other cards settle, and focus does not restart the failed query fan-out.
    await waitFor(() => {
      expect(
        within(screen.getByTestId("automation-card-a-5")).getByText("1"),
      ).toBeInTheDocument();
    });
    const failedCard = screen.getByTestId("automation-card-a-0");
    expect(within(failedCard).getByText("Looking")).toBeInTheDocument();
    expect(within(failedCard).getAllByText("—")).not.toHaveLength(0);
    expect(
      vi
        .mocked(AutomationService.getAutomationRuns)
        .mock.calls.filter(([id]) => id === "a-0"),
    ).toHaveLength(1);

    window.dispatchEvent(new Event("focus"));
    await act(async () => Promise.resolve());
    expect(AutomationService.getAutomationRuns).toHaveBeenCalledTimes(6);

    const failedQuery = client
      .getQueryCache()
      .findAll({ queryKey: ["automation-runs"] })
      .find((query) => query.queryKey[1] === "a-0");
    expect(failedQuery?.options).toMatchObject({
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: false,
    });
  });

  it("composes the manifest's sub-page surface around the list", async () => {
    // Arrange & Act
    await renderDashboardWithSettledInsights();

    // Assert — navigation, tiles, and controls all carry manifest captions;
    // the catalog launcher has moved off this page.
    const nav = screen.getByTestId("automations-navbar-desktop");
    const automationsTile = screen.getByTestId("overview-tile-automations");
    expect({
      navLabels: [
        within(nav).getByText("Widget dashboard"),
        within(nav).getByText("Widget templates"),
      ].length,
      tileCaption: within(automationsTile).getByText("Widget count"),
      tileDetail: within(automationsTile).getByText("2 live"),
      statusFilter: screen.getByLabelText("Filter widgets by state"),
      sortControl: screen.getByLabelText("Order widgets"),
      statsCaptions: screen.getAllByText("Widget wins").length,
      launcher: screen.queryByTestId("recommended-automations-section"),
    }).toMatchObject({
      navLabels: 2,
      statsCaptions: 2,
      launcher: null,
    });
  });

  it("orders the list by the manifest's declared sort default", async () => {
    // Arrange & Act — the widget manifest defaults to the name sort, while
    // the broken automation has the newer run.
    await renderDashboardWithSettledInsights();

    // Assert
    const cards = screen.getAllByTestId(/^automation-card-/);
    expect(cards.map((card) => card.getAttribute("data-testid"))).toEqual([
      "automation-card-a-ok",
      "automation-card-a-broken",
    ]);
  });

  it("narrows to latest-run failures through the status filter", async () => {
    // Arrange
    const user = userEvent.setup();
    await renderDashboardWithSettledInsights();

    // Act — pick the manifest's "failing" option.
    await user.click(
      within(screen.getByTestId("automations-filter-status")).getByTestId(
        "dropdown-trigger",
      ),
    );
    await user.click(screen.getByTestId("automations-filter-status-failing"));

    // Assert
    await waitFor(() => {
      expect(screen.queryByTestId("automation-card-a-ok")).toBeNull();
    });
    expect(screen.getByTestId("automation-card-a-broken")).toBeInTheDocument();
  });

  it("clears search and filters back to a neutral view", async () => {
    // Arrange — search something no automation matches.
    const user = userEvent.setup();
    await renderDashboardWithSettledInsights();
    const search = screen.getByLabelText(
      I18nKey.AUTOMATIONS$SEARCH_PLACEHOLDER,
    );
    await user.type(search, "gadget");
    await screen.findByTestId("automations-filtered-empty");

    // Act
    await user.click(screen.getByTestId("automations-clear-filters"));

    // Assert
    await screen.findByTestId("automation-card-a-ok");
    expect((search as HTMLInputElement).value).toBe("");
  });
});

describe("AutomationTemplates — manifest-declared templates page", () => {
  it("admits the route and renders the manifest identity above the launcher", async () => {
    // Arrange & Act
    expect(templatesLoader()).toBeNull();
    renderAt("/automations/templates", <AutomationTemplates />);

    // Assert
    expect({
      title: await screen.findByText("Widget templates", {
        selector: "h1",
      }),
      description: screen.getByText("Pick a proven widget to start from."),
      launcher: await screen.findByTestId("recommended-automations-section"),
    }).toBeTruthy();
  });
});
