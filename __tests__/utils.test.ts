/**
 * Tests for lib/utils.ts
 * Pure formatting utilities — no external dependencies.
 */

import { formatINR, formatVolume, formatPercent, formatTime, changeColor } from "@/lib/utils";

describe("formatINR", () => {
  it("formats a whole number", () => {
    expect(formatINR(1000)).toBe("1,000.00");
  });

  it("uses Indian number formatting for large numbers", () => {
    expect(formatINR(1234567.89)).toBe("12,34,567.89");
  });

  it("returns em-dash for non-finite values", () => {
    expect(formatINR(Infinity)).toBe("—");
    expect(formatINR(NaN)).toBe("—");
  });

  it("respects custom decimal places", () => {
    expect(formatINR(123.456, 0)).toBe("123");
    expect(formatINR(123.456, 3)).toBe("123.456");
  });
});

describe("formatVolume", () => {
  it("returns em-dash for zero volume", () => {
    expect(formatVolume(0)).toBe("—");
  });

  it("formats crore correctly", () => {
    const result = formatVolume(10_000_000);
    expect(result).toContain("Cr");
  });

  it("formats lakh correctly", () => {
    const result = formatVolume(200_000);
    expect(result).toContain("L");
  });

  it("formats small numbers without suffix", () => {
    const result = formatVolume(9999);
    expect(result).not.toContain("Cr");
    expect(result).not.toContain("L");
  });
});

describe("formatPercent", () => {
  it("adds + sign for positive values", () => {
    expect(formatPercent(2.5)).toBe("+2.50%");
  });

  it("adds - sign for negative values", () => {
    expect(formatPercent(-1.35)).toBe("-1.35%");
  });

  it("shows 0.00% for zero", () => {
    expect(formatPercent(0)).toBe("+0.00%");
  });

  it("returns em-dash for non-finite values", () => {
    expect(formatPercent(NaN)).toBe("—");
    expect(formatPercent(Infinity)).toBe("—");
  });
});

describe("changeColor", () => {
  it("returns green class for positive change", () => {
    expect(changeColor(1.5)).toContain("emerald");
  });

  it("returns red class for negative change", () => {
    expect(changeColor(-0.5)).toContain("rose");
  });

  it("returns neutral class for zero", () => {
    expect(changeColor(0)).toContain("slate");
  });
});

describe("formatTime", () => {
  it("returns em-dash for undefined", () => {
    expect(formatTime(undefined)).toBe("—");
  });

  it("returns em-dash for empty string", () => {
    expect(formatTime("")).toBe("—");
  });

  it("formats a valid ISO timestamp", () => {
    const result = formatTime("2024-10-14T10:30:00.000Z");
    expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});
