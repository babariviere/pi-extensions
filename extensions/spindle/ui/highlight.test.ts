import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  activeShikiThemeIsLight,
  applyPiTheme,
  configureHighlighting,
  resolveShikiTheme,
} from "./highlight.ts";

const SHIPPED_THEMES = [
  "rose-pine-moon",
  "rose-pine-dawn",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "catppuccin-latte",
] as const;

describe("resolveShikiTheme", () => {
  beforeEach(() => configureHighlighting("dark-plus", true));

  it("maps each shipped Pi theme name to the matching bundled shiki theme", () => {
    for (const name of SHIPPED_THEMES) {
      assert.equal(resolveShikiTheme(name), name);
    }
  });

  it("is case-insensitive", () => {
    assert.equal(resolveShikiTheme("Rose-Pine-Moon"), "rose-pine-moon");
  });

  it("falls back to the configured shiki theme for unknown names", () => {
    configureHighlighting("github-light", true);
    assert.equal(resolveShikiTheme("not-a-real-theme"), "github-light");
  });

  it("falls back to the configured shiki theme for an undefined name", () => {
    configureHighlighting("github-dark", true);
    assert.equal(resolveShikiTheme(undefined), "github-dark");
  });

  it("does not alias built-in dark/light Pi themes over the configured theme", () => {
    configureHighlighting("github-dark", true);
    assert.equal(resolveShikiTheme("dark"), "github-dark");
    assert.equal(resolveShikiTheme("light"), "github-dark");
  });
});

describe("applyPiTheme + activeShikiThemeIsLight", () => {
  beforeEach(() => configureHighlighting("dark-plus", true));

  it("classifies light Pi themes as light", () => {
    applyPiTheme("catppuccin-latte");
    assert.equal(activeShikiThemeIsLight(), true);
    applyPiTheme("rose-pine-dawn");
    assert.equal(activeShikiThemeIsLight(), true);
  });

  it("classifies dark Pi themes as dark", () => {
    applyPiTheme("rose-pine-moon");
    assert.equal(activeShikiThemeIsLight(), false);
    applyPiTheme("catppuccin-macchiato");
    assert.equal(activeShikiThemeIsLight(), false);
  });

  it("no-ops when syntax highlighting is disabled", () => {
    configureHighlighting("dark-plus", false);
    applyPiTheme("catppuccin-latte");
    assert.equal(activeShikiThemeIsLight(), false);
  });
});
