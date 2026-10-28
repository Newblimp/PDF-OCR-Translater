import { describe, expect, expectTypeOf, it } from "vitest";
import { stage, STAGES, translationStages, type FollowUpStage, type TranslationPlan } from "./events";

const settings: TranslationPlan["settings"] = { structured: false, bboxAnnotations: true, blockTranslations: true, structureOriginal: "on_demand" };

describe("translationStages", () => {
  it("lists the stages a translation runs, in the status card's order", () => {
    // Translate a PDF, block by block (the default).
    expect(translationStages({ settings, withOcr: true, withBoxes: true })).toEqual(["prepare", "ocr", "bbox_annotate", "block_translate"]);
    // Pasted text: nothing to OCR, no boxes; the blocks are its paragraphs.
    expect(translationStages({ settings, withOcr: false, withBoxes: false })).toEqual(["block_translate"]);
    // With the JSON output and every follow-up.
    expect(translationStages({ settings: { ...settings, structured: true, structureOriginal: "always" }, withOcr: true, withBoxes: true })).toEqual([
      "prepare",
      "ocr",
      "infer_schema",
      "bbox_annotate",
      "translate",
      "structure_original",
      "block_translate",
    ]);
    // With the JSON output, the block translations are a follow-up that can be switched off.
    expect(
      translationStages({ settings: { ...settings, structured: true, blockTranslations: false, bboxAnnotations: false }, withOcr: false, withBoxes: true }),
    ).toEqual(["infer_schema", "translate"]);
  });

  it("never lists a stage of another job", () => {
    expect(STAGES.region_ocr).not.toHaveProperty("inTranslation");
    expect(stage("region_ocr").label).toBe("Reading the selection again (Mistral OCR)");
  });
});

describe("follow-up stages", () => {
  it("are the stages that name what they produce (a typo or a stage without a name does not compile)", () => {
    expectTypeOf<FollowUpStage>().toEqualTypeOf<"bbox_annotate" | "structure_original" | "block_translate">();
    expect(STAGES.block_translate.produces).toBe("Block translations");
  });
});
