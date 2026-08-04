import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupPage } from "../../src/v6/routes/pages";

describe("setup browser initialization", () => {
  beforeEach(async () => {
    vi.resetModules();
    const html = await setupPage().text();
    const body = /<body[^>]*>([\s\S]*?)<script type="module"/u.exec(html)?.[1];
    if (body === undefined) throw new Error("Setup page body was not rendered");
    document.documentElement.removeAttribute("data-theme");
    document.body.dataset.page = "setup";
    document.body.innerHTML = body;
  });

  it("binds topic controls without exposing appearance controls outside Settings", async () => {
    await import("../src/main");

    const topics = [...document.querySelectorAll<HTMLButtonElement>("[data-topic]")].slice(0, 5);
    for (const topic of topics) topic.click();

    expect(topics.every(topic => topic.classList.contains("selected"))).toBe(true);
    expect(document.querySelector("#topicSelectionCount")?.textContent).toContain("5 selected");
    expect(document.querySelector<HTMLButtonElement>("#finishSetupButton")?.disabled).toBe(false);

    expect(document.querySelector("[data-theme-choice]")).toBeNull();
  });

  it("accepts and removes normalized custom topics", async () => {
    await import("../src/main");

    const input = document.querySelector<HTMLInputElement>("#customTopic");
    expect(input).not.toBeNull();
    if (input === null) return;
    input.value = "Machine Learning, System Design";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>("#addCustomTopic")?.click();

    const customTopics = [...document.querySelectorAll<HTMLButtonElement>("[data-custom-topic]")];
    expect(customTopics.map(topic => topic.dataset.customTopic)).toEqual([
      "machine-learning",
      "system-design",
    ]);

    customTopics[0]?.click();
    expect(document.querySelector("[data-custom-topic=machine-learning]")).toBeNull();
  });

  it("does not impose a twenty-topic ceiling and shows both import modes", async () => {
    await import("../src/main");

    const input = document.querySelector<HTMLInputElement>("#customTopic");
    expect(input).not.toBeNull();
    if (input === null) return;
    input.value = Array.from({ length: 25 }, (_, index) => `topic-${index.toString()}`).join(",");
    document.querySelector<HTMLButtonElement>("#addCustomTopic")?.click();

    expect(document.querySelectorAll("[data-custom-topic]")).toHaveLength(25);
    expect(document.querySelector("#topicSelectionCount")?.textContent).toContain("25 selected");
    expect(document.querySelector("#topicSelectionCount")?.textContent).not.toContain("maximum");
    expect(document.querySelectorAll('input[name="setupImportOption"]')).toHaveLength(2);
  });
});
