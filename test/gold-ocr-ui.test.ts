import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../public/ocr-gold.js", import.meta.url), "utf8");
const windowObject: Record<string, unknown> = {};
runInNewContext(source, { window: windowObject, document: {} });

const ocr = windowObject.POE2GoldOCR as { numericCandidates(text: string): number[] };

describe("gold screenshot OCR helper", () => {
  it("extracts plausible fee candidates without silently selecting one", () => {
    expect([...ocr.numericCandidates("Gold 17,700 fee 750 stock 1,970")]).toEqual([750, 1970, 17700]);
  });

  it("ignores zeroes and implausibly large account totals", () => {
    expect([...ocr.numericCandidates("0 53 8,661,298")]).toEqual([53]);
  });
});
